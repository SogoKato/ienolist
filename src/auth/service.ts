import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  ROLES,
  appMeta,
  challenges,
  households,
  invites,
  memberships,
  oauthTokens,
  passkeys,
  sessions,
  users,
} from "../db/schema.ts";
import { atomically, type Db } from "../db/types.ts";
import { ulid } from "../lib/ulid.ts";
import { randomToken, safeEqual, sha256 } from "../lib/token.ts";
import {
  authenticationOptions,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type RelyingParty,
  type VerifiedRegistration,
} from "./webauthn.ts";

export type Role = (typeof ROLES)[number];

// Who is signed in, and for which household.
export type Principal = { userId: string; displayName: string; householdId: string; role: Role };

export class AuthError extends Error {
  readonly code: "invalid" | "unauthorized" | "forbidden" | "conflict" | "not_found";
  constructor(code: AuthError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const CHALLENGE_TTL = 5 * 60;
const SESSION_TTL = 30 * 24 * 60 * 60;
const INVITE_TTL = 7 * 24 * 60 * 60;
const NAME_LIMIT = 100;
const INITIALIZED = "initialized_at";

export type AuthConfig = {
  rp: RelyingParty;
  // When set, whoever first sets the app up must know it.
  setupToken?: string;
  now?: () => number;
  newId?: () => string;
};

type Pending =
  | { kind: "setup"; userId: string; displayName: string; householdName: string }
  | { kind: "invite"; inviteId: string; userId: string; displayName: string; recovery: boolean }
  | { kind: "add" };

function cleanName(value: unknown, what: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0 || name.length > NAME_LIMIT) throw new AuthError("invalid", `${what} must be 1-${NAME_LIMIT} characters`);
  return name;
}

const cleanDevice = (value: unknown): string | null => {
  const name = typeof value === "string" ? value.trim().slice(0, NAME_LIMIT) : "";
  return name === "" ? null : name;
};

export function createAuthService(db: Db, config: AuthConfig) {
  const { rp } = config;
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const newId = config.newId ?? ulid;

  // --- challenges: one ceremony each, single use ---------------------------

  async function issueChallenge(purpose: "register" | "authenticate", challenge: string, data: Pending | null, userId?: string) {
    await db.delete(challenges).where(lt(challenges.expiresAt, now()));
    const id = randomToken();
    await db.insert(challenges).values({
      id,
      challenge,
      purpose,
      userId: userId ?? null,
      data: data ? JSON.stringify(data) : null,
      expiresAt: now() + CHALLENGE_TTL,
    });
    return id;
  }

  // Deleting is how a challenge is spent, so it cannot be answered twice.
  async function takeChallenge(id: unknown, purpose: "register" | "authenticate") {
    const expired = new AuthError("invalid", "This attempt expired or was already used. Start again.");
    if (typeof id !== "string") throw expired;
    const [row] = await db
      .delete(challenges)
      .where(and(eq(challenges.id, id), eq(challenges.purpose, purpose), gt(challenges.expiresAt, now())))
      .returning();
    if (!row) throw expired;
    return { challenge: row.challenge, userId: row.userId, data: row.data ? (JSON.parse(row.data) as Pending) : null };
  }

  async function checkRegistration(response: RegistrationResponseJSON, challenge: string): Promise<VerifiedRegistration> {
    let verified: VerifiedRegistration | null = null;
    try {
      verified = await verifyRegistration(rp, response, challenge);
    } catch {
      // Malformed or mismatching responses are all the same to the caller.
    }
    if (!verified) throw new AuthError("invalid", "The passkey could not be verified");
    return verified;
  }

  const passkeyInsert = (userId: string, passkey: VerifiedRegistration, deviceName: string | null) =>
    db.insert(passkeys).values({
      id: passkey.credentialId,
      userId,
      publicKey: passkey.publicKey,
      counter: passkey.counter,
      transports: passkey.transports ? JSON.stringify(passkey.transports) : null,
      deviceName,
      createdAt: now(),
    });

  // --- sessions -------------------------------------------------------------

  async function sessionInsert(userId: string) {
    const token = randomToken();
    const statement = db.insert(sessions).values({
      tokenHash: await sha256(token),
      userId,
      createdAt: now(),
      expiresAt: now() + SESSION_TTL,
    });
    return { token, statement };
  }

  async function principalFor(userId: string): Promise<Principal | null> {
    const [row] = await db
      .select({ userId: users.id, displayName: users.displayName, householdId: memberships.householdId, role: memberships.role })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(eq(users.id, userId))
      .orderBy(asc(memberships.createdAt), asc(memberships.householdId))
      .limit(1);
    return row ?? null;
  }

  async function isInitialized() {
    const [row] = await db.select().from(appMeta).where(eq(appMeta.key, INITIALIZED)).limit(1);
    return row !== undefined;
  }

  async function validInvite(token: unknown) {
    if (typeof token !== "string" || token === "") throw new AuthError("not_found", "This invite link is not valid");
    const [invite] = await db
      .select()
      .from(invites)
      .where(and(eq(invites.tokenHash, await sha256(token)), isNull(invites.usedAt), gt(invites.expiresAt, now())))
      .limit(1);
    if (!invite) throw new AuthError("not_found", "This invite link is not valid, or it has expired or been used");
    return invite;
  }

  return {
    // --- first run ----------------------------------------------------------

    async setupStatus() {
      return { initialized: await isInitialized(), needsSetupToken: config.setupToken !== undefined };
    },

    // The first person to finish this becomes the household's admin.
    async beginSetup(input: { displayName: string; householdName: string; setupToken?: string }) {
      const displayName = cleanName(input.displayName, "Your name");
      const householdName = cleanName(input.householdName, "The household name");
      if (await isInitialized()) throw new AuthError("conflict", "This app is already set up");
      if (config.setupToken !== undefined && !(typeof input.setupToken === "string" && (await safeEqual(input.setupToken, config.setupToken)))) {
        throw new AuthError("forbidden", "The setup token is wrong");
      }
      const userId = newId();
      const options = await registrationOptions(rp, { id: userId, name: displayName }, []);
      const challengeId = await issueChallenge("register", options.challenge, { kind: "setup", userId, displayName, householdName });
      return { challengeId, options };
    },

    async finishSetup(input: { challengeId: string; response: RegistrationResponseJSON; deviceName?: string }) {
      const pending = await takeChallenge(input.challengeId, "register");
      if (pending.data?.kind !== "setup") throw new AuthError("invalid", "This attempt was not a setup");
      const { userId, displayName, householdName } = pending.data;
      const passkey = await checkRegistration(input.response, pending.challenge);
      const householdId = newId();
      const session = await sessionInsert(userId);
      try {
        // The app_meta row goes first: if another person won the race it fails
        // on the unique key and nothing else is written.
        await atomically(db, [
          db.insert(appMeta).values({ key: INITIALIZED, value: String(now()) }),
          db.insert(households).values({ id: householdId, name: householdName, createdAt: now() }),
          db.insert(users).values({ id: userId, displayName, createdAt: now() }),
          db.insert(memberships).values({ householdId, userId, role: "admin", createdAt: now() }),
          passkeyInsert(userId, passkey, cleanDevice(input.deviceName)),
          session.statement,
        ]);
      } catch (error) {
        if (await isInitialized()) throw new AuthError("conflict", "Someone else finished setting this app up first");
        throw error;
      }
      return { sessionToken: session.token, principal: { userId, displayName, householdId, role: "admin" as const } };
    },

    // --- invites and recovery -----------------------------------------------

    // Admins only. With `forUserId`, a re-enrollment link for a member who lost
    // their passkeys; redeeming it replaces all of that member's sign-in state.
    async createInvite(actor: Principal, input: { role?: Role; forUserId?: string } = {}) {
      if (actor.role !== "admin") throw new AuthError("forbidden", "Only admins can invite people");
      let role: Role = input.role ?? "member";
      if (!ROLES.includes(role)) throw new AuthError("invalid", `role must be one of: ${ROLES.join(", ")}`);
      if (input.forUserId !== undefined) {
        const [member] = await db
          .select()
          .from(memberships)
          .where(and(eq(memberships.householdId, actor.householdId), eq(memberships.userId, input.forUserId)))
          .limit(1);
        if (!member) throw new AuthError("not_found", "That person is not in this household");
        role = member.role;
      }
      const token = randomToken();
      const expiresAt = now() + INVITE_TTL;
      await db.insert(invites).values({
        id: newId(),
        tokenHash: await sha256(token),
        householdId: actor.householdId,
        userId: input.forUserId ?? null,
        role,
        createdBy: actor.userId,
        createdAt: now(),
        expiresAt,
      });
      return { token, expiresAt };
    },

    // What the join page shows before the person registers.
    async inspectInvite(token: string) {
      const invite = await validInvite(token);
      const [household] = await db.select().from(households).where(eq(households.id, invite.householdId)).limit(1);
      const [member] = invite.userId ? await db.select().from(users).where(eq(users.id, invite.userId)).limit(1) : [];
      return { householdName: household.name, recovery: invite.userId !== null, displayName: member?.displayName ?? null };
    },

    async beginJoin(input: { token: string; displayName?: string }) {
      const invite = await validInvite(input.token);
      let userId = newId();
      let displayName: string;
      let existing: string[] = [];
      if (invite.userId) {
        const [member] = await db.select().from(users).where(eq(users.id, invite.userId)).limit(1);
        userId = invite.userId;
        displayName = member.displayName;
        existing = (await db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, userId))).map((p) => p.id);
      } else {
        displayName = cleanName(input.displayName, "Your name");
      }
      const options = await registrationOptions(rp, { id: userId, name: displayName }, existing);
      const challengeId = await issueChallenge(
        "register",
        options.challenge,
        { kind: "invite", inviteId: invite.id, userId, displayName, recovery: invite.userId !== null },
      );
      return { challengeId, options };
    },

    async finishJoin(input: { challengeId: string; response: RegistrationResponseJSON; deviceName?: string }) {
      const pending = await takeChallenge(input.challengeId, "register");
      if (pending.data?.kind !== "invite") throw new AuthError("invalid", "This attempt was not an invite");
      const { inviteId, userId, displayName, recovery } = pending.data;
      const passkey = await checkRegistration(input.response, pending.challenge);

      // Spend the invite first: of two people racing on one link, only one gets past this.
      const [spent] = await db
        .update(invites)
        .set({ usedAt: now() })
        .where(and(eq(invites.id, inviteId), isNull(invites.usedAt), gt(invites.expiresAt, now())))
        .returning();
      if (!spent) throw new AuthError("not_found", "This invite link is not valid, or it has expired or been used");

      const session = await sessionInsert(userId);
      const device = cleanDevice(input.deviceName);
      const statements: BatchItem<"sqlite">[] = recovery
        ? [
            db.delete(passkeys).where(eq(passkeys.userId, userId)),
            db.delete(sessions).where(eq(sessions.userId, userId)),
            db.update(oauthTokens).set({ revokedAt: now() }).where(and(eq(oauthTokens.userId, userId), isNull(oauthTokens.revokedAt))),
            passkeyInsert(userId, passkey, device),
            session.statement,
          ]
        : [
            db.insert(users).values({ id: userId, displayName, createdAt: now() }),
            db.insert(memberships).values({ householdId: spent.householdId, userId, role: spent.role, createdAt: now() }),
            passkeyInsert(userId, passkey, device),
            session.statement,
          ];
      try {
        await atomically(db, statements);
      } catch (error) {
        await db.update(invites).set({ usedAt: null }).where(eq(invites.id, inviteId));
        throw error;
      }
      const principal = await principalFor(userId);
      if (!principal) throw new AuthError("unauthorized", "This account has no household");
      return { sessionToken: session.token, principal };
    },

    // --- signing in ---------------------------------------------------------

    // Sign-in names nobody: the device offers the passkeys it has for this site.
    async beginLogin() {
      const options = await authenticationOptions(rp);
      const challengeId = await issueChallenge("authenticate", options.challenge, null);
      return { challengeId, options };
    },

    async finishLogin(input: { challengeId: string; response: AuthenticationResponseJSON }) {
      const pending = await takeChallenge(input.challengeId, "authenticate");
      const denied = new AuthError("unauthorized", "Sign-in failed");
      const credentialId = input.response?.id;
      if (typeof credentialId !== "string") throw denied;
      const [passkey] = await db.select().from(passkeys).where(eq(passkeys.id, credentialId)).limit(1);
      if (!passkey) throw denied;
      let counter: number | null = null;
      try {
        counter = await verifyAuthentication(rp, input.response, pending.challenge, passkey);
      } catch {
        // A bad signature, origin, challenge or counter all end the same way.
      }
      if (counter === null) throw denied;
      const principal = await principalFor(passkey.userId);
      if (!principal) throw denied;
      const session = await sessionInsert(passkey.userId);
      await atomically(db, [
        db.update(passkeys).set({ counter, lastUsedAt: now() }).where(eq(passkeys.id, passkey.id)),
        db.delete(sessions).where(and(eq(sessions.userId, passkey.userId), lt(sessions.expiresAt, now()))),
        session.statement,
      ]);
      return { sessionToken: session.token, principal };
    },

    async authenticate(sessionToken: string | null | undefined): Promise<Principal | null> {
      if (!sessionToken) return null;
      const [session] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.tokenHash, await sha256(sessionToken)), gt(sessions.expiresAt, now())))
        .limit(1);
      return session ? principalFor(session.userId) : null;
    },

    async logout(sessionToken: string) {
      await db.delete(sessions).where(eq(sessions.tokenHash, await sha256(sessionToken)));
    },

    // --- a signed-in person's passkeys --------------------------------------

    async listPasskeys(actor: Principal) {
      const rows = await db.select().from(passkeys).where(eq(passkeys.userId, actor.userId)).orderBy(asc(passkeys.createdAt), asc(passkeys.id));
      return rows.map((p) => ({ id: p.id, deviceName: p.deviceName, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt }));
    },

    async beginAddPasskey(actor: Principal) {
      const existing = await db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, actor.userId));
      const options = await registrationOptions(rp, { id: actor.userId, name: actor.displayName }, existing.map((p) => p.id));
      const challengeId = await issueChallenge("register", options.challenge, { kind: "add" }, actor.userId);
      return { challengeId, options };
    },

    async finishAddPasskey(actor: Principal, input: { challengeId: string; response: RegistrationResponseJSON; deviceName?: string }) {
      const pending = await takeChallenge(input.challengeId, "register");
      if (pending.data?.kind !== "add" || pending.userId !== actor.userId) throw new AuthError("invalid", "This attempt was not started by you");
      const passkey = await checkRegistration(input.response, pending.challenge);
      await passkeyInsert(actor.userId, passkey, cleanDevice(input.deviceName));
    },

    // The last passkey cannot be removed: that would lock the person out.
    async removePasskey(actor: Principal, passkeyId: string) {
      const [removed] = await db
        .delete(passkeys)
        .where(
          and(
            eq(passkeys.id, passkeyId),
            eq(passkeys.userId, actor.userId),
            sql`(SELECT COUNT(*) FROM ${passkeys} WHERE ${passkeys.userId} = ${actor.userId}) > 1`,
          ),
        )
        .returning({ id: passkeys.id });
      if (removed) return;
      const [own] = await db.select({ id: passkeys.id }).from(passkeys).where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, actor.userId)));
      throw own ? new AuthError("conflict", "You cannot remove your only passkey") : new AuthError("not_found", "Passkey not found");
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
