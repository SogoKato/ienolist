import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { toBase64Url } from "../lib/token.ts";
import { AuthError, createAuthService, type AuthService, type Principal } from "./service.ts";
import { VirtualAuthenticator } from "./virtual-authenticator.ts";
import type { RelyingParty } from "./webauthn.ts";

const rp: RelyingParty = { id: "lists.example.com", name: "Household lists", origin: "https://lists.example.com" };
const DAY = 24 * 60 * 60;

let raw: DatabaseSync;
let auth: AuthService;
let clock: number;

beforeEach(() => {
  const t = createTestDb();
  raw = t.raw;
  clock = 1_000_000;
  auth = createAuthService(t.db, { rp, now: () => clock });
});

const rejects = (promise: Promise<unknown>, code: AuthError["code"], message?: RegExp) =>
  assert.rejects(promise, (e: unknown) => e instanceof AuthError && e.code === code && (!message || message.test(e.message)), `expected ${code}`);

const count = (table: string, where = "1") => raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get()!.n;

async function setup(name = "Aki", household = "Home") {
  const device = await VirtualAuthenticator.create();
  const { challengeId, options } = await auth.beginSetup({ displayName: name, householdName: household });
  const result = await auth.finishSetup({ challengeId, response: await device.register(options, rp.origin), deviceName: "Phone" });
  return { device, ...result };
}

async function login(device: VirtualAuthenticator) {
  const { challengeId, options } = await auth.beginLogin();
  return auth.finishLogin({ challengeId, response: await device.authenticate(options, rp.origin) });
}

async function join(token: string, name: string) {
  const device = await VirtualAuthenticator.create();
  const { challengeId, options } = await auth.beginJoin({ token, displayName: name });
  const result = await auth.finishJoin({ challengeId, response: await device.register(options, rp.origin) });
  return { device, ...result };
}

const invite = async (admin: Principal, input?: Parameters<AuthService["createInvite"]>[1]) => (await auth.createInvite(admin, input)).token;

// --- first run -----------------------------------------------------------------

test("the first person to finish setup becomes the household's admin and is signed in", async () => {
  assert.deepEqual(await auth.setupStatus(), { initialized: false, needsSetupToken: false });
  const { principal, sessionToken, device } = await setup("Aki", "Home");
  assert.deepEqual({ name: principal.displayName, role: principal.role }, { name: "Aki", role: "admin" });
  assert.deepEqual(await auth.authenticate(sessionToken), principal);
  assert.deepEqual(await auth.setupStatus(), { initialized: true, needsSetupToken: false });
  assert.equal(count("households"), 1);
  assert.equal(raw.prepare("SELECT name FROM households").get()!.name, "Home");
  assert.deepEqual(await auth.listPasskeys(principal), [{ id: device.credentialId, deviceName: "Phone", createdAt: clock, lastUsedAt: null }]);
});

test("once set up, nobody else can start setup", async () => {
  await setup();
  await rejects(auth.beginSetup({ displayName: "Mallory", householdName: "Mine" }), "conflict", /already set up/);
});

test("when two people race to set up, one wins and nothing of the other is written", async () => {
  const first = await VirtualAuthenticator.create();
  const second = await VirtualAuthenticator.create();
  const a = await auth.beginSetup({ displayName: "Aki", householdName: "A" });
  const b = await auth.beginSetup({ displayName: "Mallory", householdName: "B" });
  const winner = await auth.finishSetup({ challengeId: a.challengeId, response: await first.register(a.options, rp.origin) });
  await rejects(auth.finishSetup({ challengeId: b.challengeId, response: await second.register(b.options, rp.origin) }), "conflict");
  assert.equal(winner.principal.displayName, "Aki");
  assert.equal(count("users"), 1);
  assert.equal(count("households"), 1);
  assert.equal(count("passkeys"), 1);
  assert.equal(count("sessions"), 1);
});

test("a setup token, when configured, is required to begin setup", async () => {
  auth = createAuthService(createTestDb().db, { rp, now: () => clock, setupToken: "let-me-in" });
  assert.deepEqual(await auth.setupStatus(), { initialized: false, needsSetupToken: true });
  await rejects(auth.beginSetup({ displayName: "A", householdName: "H" }), "forbidden", /setup token/);
  await rejects(auth.beginSetup({ displayName: "A", householdName: "H", setupToken: "let-me-out" }), "forbidden");
  await rejects(auth.beginSetup({ displayName: "A", householdName: "H", setupToken: "" }), "forbidden");
  const { challengeId, options } = await auth.beginSetup({ displayName: "A", householdName: "H", setupToken: "let-me-in" });
  const device = await VirtualAuthenticator.create();
  await auth.finishSetup({ challengeId, response: await device.register(options, rp.origin) });
  assert.equal((await auth.setupStatus()).initialized, true);
});

test("setup needs sensible names", async () => {
  await rejects(auth.beginSetup({ displayName: "  ", householdName: "H" }), "invalid", /Your name/);
  await rejects(auth.beginSetup({ displayName: "A", householdName: "" }), "invalid", /household name/);
  await rejects(auth.beginSetup({ displayName: "x".repeat(101), householdName: "H" }), "invalid");
  const { principal } = await setup("  あき  ", "うち");
  assert.equal(principal.displayName, "あき");
});

// --- ceremonies: single use, expiry, wrong answers --------------------------------

test("a ceremony can be answered only once", async () => {
  const device = await VirtualAuthenticator.create();
  const { challengeId, options } = await auth.beginSetup({ displayName: "A", householdName: "H" });
  const response = await device.register(options, rp.origin);
  await auth.finishSetup({ challengeId, response });
  await rejects(auth.finishSetup({ challengeId, response }), "invalid", /expired or was already used/);
});

test("a ceremony expires after five minutes", async () => {
  const device = await VirtualAuthenticator.create();
  const { challengeId, options } = await auth.beginSetup({ displayName: "A", householdName: "H" });
  clock += 5 * 60 + 1;
  await rejects(auth.finishSetup({ challengeId, response: await device.register(options, rp.origin) }), "invalid", /expired/);
  assert.equal((await auth.setupStatus()).initialized, false);
});

test("a failed answer spends the ceremony but leaves the app ready for a correct attempt", async () => {
  const device = await VirtualAuthenticator.create();
  const { challengeId, options } = await auth.beginSetup({ displayName: "A", householdName: "H" });
  await rejects(auth.finishSetup({ challengeId, response: await device.register(options, "https://evil.example.com") }), "invalid", /could not be verified/);
  assert.equal(count("users"), 0);
  assert.equal((await auth.setupStatus()).initialized, false);
  await setup();
});

test("garbage in place of a passkey response is refused, not crashed on", async () => {
  const { challengeId } = await auth.beginSetup({ displayName: "A", householdName: "H" });
  await rejects(auth.finishSetup({ challengeId, response: { nonsense: true } as never }), "invalid");
  const bogus = await auth.beginLogin();
  await rejects(auth.finishLogin({ challengeId: bogus.challengeId, response: { nonsense: true } as never }), "unauthorized");
  await rejects(auth.finishSetup({ challengeId: undefined as never, response: {} as never }), "invalid");
  await rejects(auth.finishLogin({ challengeId: 5 as never, response: {} as never }), "invalid");
});

test("a ceremony of one kind cannot be used for another", async () => {
  const { device, principal } = await setup();
  const loginStart = await auth.beginLogin();
  await rejects(auth.finishSetup({ challengeId: loginStart.challengeId, response: {} as never }), "invalid");
  const add = await auth.beginAddPasskey(principal);
  const other = await VirtualAuthenticator.create();
  await rejects(auth.finishJoin({ challengeId: add.challengeId, response: await other.register(add.options, rp.origin) }), "invalid", /not an invite/);
  const sign = await auth.beginLogin();
  await rejects(auth.finishAddPasskey(principal, { challengeId: sign.challengeId, response: {} as never }), "invalid");
  await login(device);
});

test("expired ceremonies are cleaned up when new ones start", async () => {
  await auth.beginLogin();
  await auth.beginLogin();
  assert.equal(count("challenges"), 2);
  clock += 10 * 60;
  await auth.beginLogin();
  assert.equal(count("challenges"), 1);
});

// --- signing in --------------------------------------------------------------------

test("signing in with a registered passkey gives a new session and records the use", async () => {
  const { device, principal, sessionToken } = await setup();
  clock += 100;
  const signedIn = await login(device);
  assert.deepEqual(signedIn.principal, principal);
  assert.notEqual(signedIn.sessionToken, sessionToken);
  assert.deepEqual(await auth.authenticate(signedIn.sessionToken), principal);
  const [passkey] = await auth.listPasskeys(principal);
  assert.equal(passkey.lastUsedAt, clock);
  assert.equal(raw.prepare("SELECT counter FROM passkeys").get()!.counter, 1);
  await login(device);
  assert.equal(raw.prepare("SELECT counter FROM passkeys").get()!.counter, 2);
});

test("sign-in asks for no user name", async () => {
  const { options } = await auth.beginLogin();
  assert.equal(options.allowCredentials, undefined);
  assert.equal(options.userVerification, "required");
});

test("sign-in is refused for unknown passkeys, replays, wrong answers, unverified users and cloned counters", async () => {
  const { device } = await setup();
  const stranger = await VirtualAuthenticator.create();
  const start = await auth.beginLogin();
  await rejects(auth.finishLogin({ challengeId: start.challengeId, response: await stranger.authenticate(start.options, rp.origin) }), "unauthorized");

  const replayed = await auth.beginLogin();
  const answer = await device.authenticate(replayed.options, rp.origin);
  await auth.finishLogin({ challengeId: replayed.challengeId, response: answer });
  await rejects(auth.finishLogin({ challengeId: replayed.challengeId, response: answer }), "invalid");

  const wrongSite = await auth.beginLogin();
  await rejects(auth.finishLogin({ challengeId: wrongSite.challengeId, response: await device.authenticate(wrongSite.options, "https://evil.example.com") }), "unauthorized");

  const wrongChallenge = await auth.beginLogin();
  await rejects(
    auth.finishLogin({ challengeId: wrongChallenge.challengeId, response: await device.authenticate(wrongChallenge.options, rp.origin, { challenge: toBase64Url(new Uint8Array(32)) }) }),
    "unauthorized",
  );

  device.userVerifies = false;
  const unverified = await auth.beginLogin();
  await rejects(auth.finishLogin({ challengeId: unverified.challengeId, response: await device.authenticate(unverified.options, rp.origin) }), "unauthorized");
  device.userVerifies = true;

  // A copy of the passkey that lags behind the stored counter is a sign of cloning.
  raw.exec("UPDATE passkeys SET counter = 500");
  const cloned = await auth.beginLogin();
  await rejects(auth.finishLogin({ challengeId: cloned.challengeId, response: await device.authenticate(cloned.options, rp.origin) }), "unauthorized");

  assert.equal(count("sessions"), 2); // setup's, and the one valid sign-in above
});

// --- sessions ----------------------------------------------------------------------

test("sessions are stored hashed, expire after 30 days, and end on logout", async () => {
  const { sessionToken, principal } = await setup();
  assert.equal(count("sessions", `token_hash = '${sessionToken}'`), 0);
  assert.deepEqual(await auth.authenticate(sessionToken), principal);
  assert.equal(await auth.authenticate("nope"), null);
  assert.equal(await auth.authenticate(""), null);
  assert.equal(await auth.authenticate(null), null);
  assert.equal(await auth.authenticate(undefined), null);

  clock += 30 * DAY - 1;
  assert.deepEqual(await auth.authenticate(sessionToken), principal);
  clock += 2;
  assert.equal(await auth.authenticate(sessionToken), null);

  clock = 1_000_000;
  await auth.logout(sessionToken);
  assert.equal(await auth.authenticate(sessionToken), null);
});

test("signing in clears that person's expired sessions", async () => {
  const { device } = await setup();
  clock += 31 * DAY;
  await login(device);
  assert.equal(count("sessions"), 1);
});

// --- invites ----------------------------------------------------------------------

test("an admin invites someone, who joins as a member of the same household", async () => {
  const { principal: admin } = await setup("Aki", "Home");
  const token = await invite(admin);
  assert.deepEqual(await auth.inspectInvite(token), { householdName: "Home", recovery: false, displayName: null });
  const { principal, sessionToken } = await join(token, "Ben");
  assert.deepEqual({ name: principal.displayName, role: principal.role, household: principal.householdId }, { name: "Ben", role: "member", household: admin.householdId });
  assert.deepEqual(await auth.authenticate(sessionToken), principal);
  assert.equal(count("users"), 2);
  assert.equal(count("households"), 1);
});

test("an invite link works once, and only for a week", async () => {
  const { principal: admin } = await setup();
  const once = await invite(admin);
  await join(once, "Ben");
  await rejects(auth.inspectInvite(once), "not_found");
  await rejects(auth.beginJoin({ token: once, displayName: "Eve" }), "not_found");

  const stale = await invite(admin);
  clock += 7 * DAY + 1;
  await rejects(auth.beginJoin({ token: stale, displayName: "Eve" }), "not_found");
  for (const bad of ["", "nonsense", undefined as never]) await rejects(auth.inspectInvite(bad), "not_found");
});

test("two people racing on one invite: the second is refused and writes nothing", async () => {
  const { principal: admin } = await setup();
  const token = await invite(admin);
  const [d1, d2] = [await VirtualAuthenticator.create(), await VirtualAuthenticator.create()];
  const a = await auth.beginJoin({ token, displayName: "Ben" });
  const b = await auth.beginJoin({ token, displayName: "Eve" });
  await auth.finishJoin({ challengeId: a.challengeId, response: await d1.register(a.options, rp.origin) });
  await rejects(auth.finishJoin({ challengeId: b.challengeId, response: await d2.register(b.options, rp.origin) }), "not_found");
  assert.equal(count("users"), 2);
  assert.equal(count("passkeys"), 2);
});

test("a join that fails while writing gives the invite back", async () => {
  const { principal: admin } = await setup();
  const device = await VirtualAuthenticator.create();
  const first = await invite(admin);
  const a = await auth.beginJoin({ token: first, displayName: "Ben" });
  await auth.finishJoin({ challengeId: a.challengeId, response: await device.register(a.options, rp.origin) });

  // The same passkey cannot be registered twice: the write fails after the invite was spent.
  const second = await invite(admin);
  const b = await auth.beginJoin({ token: second, displayName: "Eve" });
  await assert.rejects(auth.finishJoin({ challengeId: b.challengeId, response: await device.register(b.options, rp.origin) }));
  assert.equal(count("users"), 2);
  assert.equal(count("memberships"), 2);
  assert.deepEqual(await auth.inspectInvite(second), { householdName: "Home", recovery: false, displayName: null });
  await join(second, "Eve");
});

test("only admins invite; invite roles are checked; tokens are stored hashed", async () => {
  const { principal: admin } = await setup();
  const token = await invite(admin);
  const { principal: member } = await join(token, "Ben");
  await rejects(auth.createInvite(member), "forbidden", /Only admins/);
  await rejects(auth.createInvite(admin, { role: "owner" as never }), "invalid");
  const adminToken = await invite(admin, { role: "admin" });
  const { principal: second } = await join(adminToken, "Cleo");
  assert.equal(second.role, "admin");
  assert.equal(count("invites", `token_hash = '${token}'`), 0);
});

test("joining needs a name", async () => {
  const { principal: admin } = await setup();
  const token = await invite(admin);
  await rejects(auth.beginJoin({ token, displayName: " " }), "invalid", /Your name/);
  await rejects(auth.beginJoin({ token }), "invalid");
});

// --- recovery ----------------------------------------------------------------------

test("a recovery link replaces everything a member signed in with", async () => {
  const { principal: admin } = await setup("Aki");
  const { principal: ben, device: lostPhone, sessionToken: lostSession } = await join(await invite(admin), "Ben");
  raw.exec(`INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES ('c1', 'Claude', '[]', 0)`);
  raw.exec(
    `INSERT INTO oauth_tokens (id, client_id, user_id, household_id, scope, resource, access_hash, refresh_hash, access_expires_at, refresh_expires_at, created_at) VALUES ('t1', 'c1', '${ben.userId}', '${ben.householdId}', 's', 'r', 'a', 'b', 1, 1, 0)`,
  );

  const token = await invite(admin, { forUserId: ben.userId });
  assert.deepEqual(await auth.inspectInvite(token), { householdName: "Home", recovery: true, displayName: "Ben" });
  const newPhone = await VirtualAuthenticator.create();
  const { challengeId, options } = await auth.beginJoin({ token });
  assert.equal(options.user.name, "Ben");
  assert.deepEqual(options.excludeCredentials?.map((c) => c.id), [lostPhone.credentialId]);
  const { principal, sessionToken } = await auth.finishJoin({ challengeId, response: await newPhone.register(options, rp.origin) });

  assert.deepEqual(principal, ben);
  assert.equal(count("users"), 2);
  assert.equal(await auth.authenticate(lostSession), null);
  assert.deepEqual(await auth.authenticate(sessionToken), ben);
  assert.notEqual(raw.prepare("SELECT revoked_at FROM oauth_tokens").get()!.revoked_at, null);
  await rejects(login(lostPhone), "unauthorized");
  assert.deepEqual((await login(newPhone)).principal, ben);
  assert.equal(count("passkeys", `user_id = '${ben.userId}'`), 1);
  assert.equal(count("passkeys"), 2); // Aki's is untouched
});

test("recovery links are for members of the admin's own household", async () => {
  const { principal: admin } = await setup();
  await rejects(auth.createInvite(admin, { forUserId: "nobody" }), "not_found");
  raw.exec("INSERT INTO households (id, name, created_at) VALUES ('h2', 'Other', 0)");
  raw.exec("INSERT INTO users (id, display_name, created_at) VALUES ('stranger', 'S', 0)");
  raw.exec("INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ('h2', 'stranger', 'member', 0)");
  await rejects(auth.createInvite(admin, { forUserId: "stranger" }), "not_found");
  const { principal: member } = await join(await invite(admin), "Ben");
  await rejects(auth.createInvite(member, { forUserId: admin.userId }), "forbidden");
});

// --- a signed-in person's passkeys -------------------------------------------------

test("a person can add a second passkey and sign in with either", async () => {
  const { principal, device: phone } = await setup();
  const laptop = await VirtualAuthenticator.create();
  clock += 60;
  const { challengeId, options } = await auth.beginAddPasskey(principal);
  assert.deepEqual(options.excludeCredentials?.map((c) => c.id), [phone.credentialId]);
  await auth.finishAddPasskey(principal, { challengeId, response: await laptop.register(options, rp.origin), deviceName: "Laptop" });
  assert.deepEqual((await auth.listPasskeys(principal)).map((p) => p.deviceName), ["Phone", "Laptop"]);
  assert.deepEqual((await login(laptop)).principal, principal);
  assert.deepEqual((await login(phone)).principal, principal);
});

test("adding a passkey only works for the person who started it", async () => {
  const { principal: admin } = await setup();
  const { principal: ben } = await join(await invite(admin), "Ben");
  const started = await auth.beginAddPasskey(admin);
  const device = await VirtualAuthenticator.create();
  await rejects(auth.finishAddPasskey(ben, { challengeId: started.challengeId, response: await device.register(started.options, rp.origin) }), "invalid", /not started by you/);
  assert.equal(count("passkeys"), 2);
});

test("a person can remove a passkey but never their last one, nor anyone else's", async () => {
  const { principal: admin, device: phone } = await setup();
  const { principal: ben, device: bensPhone } = await join(await invite(admin), "Ben");
  await rejects(auth.removePasskey(admin, phone.credentialId), "conflict", /only passkey/);
  await rejects(auth.removePasskey(admin, bensPhone.credentialId), "not_found");
  await rejects(auth.removePasskey(admin, "nothing"), "not_found");

  const laptop = await VirtualAuthenticator.create();
  const { challengeId, options } = await auth.beginAddPasskey(admin);
  await auth.finishAddPasskey(admin, { challengeId, response: await laptop.register(options, rp.origin) });
  await auth.removePasskey(admin, phone.credentialId);
  assert.deepEqual((await auth.listPasskeys(admin)).map((p) => p.id), [laptop.credentialId]);
  await rejects(login(phone), "unauthorized");
  assert.deepEqual((await login(bensPhone)).principal, ben);
});
