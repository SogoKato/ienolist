import { and, asc, desc, eq, gt, isNotNull, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { oauthClients, oauthCodes, oauthTokens } from "../db/schema.ts";
import { atomically, type Db } from "../db/types.ts";
import type { Principal } from "../auth/service.ts";
import { ulid } from "../lib/ulid.ts";
import { randomToken, safeEqual, sha256 } from "../lib/token.ts";
import { SCOPE_READ, SCOPE_WRITE } from "../mcp/tools.ts";

export const SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;

const CODE_TTL = 5 * 60;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;
// A client registered but never connected is forgotten after this long.
const UNUSED_CLIENT_TTL = 7 * 24 * 60 * 60;
// Registration needs no login, so the number of clients is capped.
const MAX_CLIENTS = 100;
const NAME_LIMIT = 100;

export type PreregisteredClient = { clientId: string; name: string; redirectUris: string[] };

export type OAuthConfig = {
  // The app's origin: the issuer, and the base of the MCP resource.
  origin: string;
  // Clients known in advance (from settings), kept in sync with the database on use.
  clients?: PreregisteredClient[];
  now?: () => number;
  newId?: () => string;
};

// An error in the shape OAuth defines (RFC 6749 5.2, RFC 7591 3.2.2).
export class OAuthError extends Error {
  readonly error: string;
  readonly status: 400 | 401;
  constructor(error: string, description: string, status: 400 | 401 = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }
}

// What the authorization endpoint found in the request.
export type AuthorizationRequest = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state: string | null;
  resource: string;
};

// Errors about the client or redirect URI must never be sent to that redirect URI
// (RFC 6749 4.1.2.1); the rest go back to the client as an `error` parameter.
export type Authorization =
  | { kind: "fatal"; message: string }
  | { kind: "redirect"; redirectTo: string }
  | { kind: "ok"; request: AuthorizationRequest };

export type Params = Record<string, string | undefined>;

const trimSlash = (s: string) => s.replace(/\/+$/, "");

// https anywhere, plain http only for a loopback address (native apps), never a fragment.
function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

// The client's redirect URI with the answer in its query (RFC 9207: plus the issuer).
function redirectWith(issuer: string, uri: string, state: string | null, extra: Record<string, string>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  if (state) url.searchParams.set("state", state);
  url.searchParams.set("iss", issuer);
  return url.toString();
}

export function createOAuthService(db: Db, config: OAuthConfig) {
  const origin = trimSlash(config.origin);
  const resource = `${origin}/mcp`;
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const newId = config.newId ?? ulid;
  const preregistered = new Map((config.clients ?? []).map((c) => [c.clientId, c]));

  // --- clients ---------------------------------------------------------------

  async function findClient(clientId: string): Promise<{ clientId: string; name: string; redirectUris: string[] } | null> {
    const known = preregistered.get(clientId);
    if (known) {
      // Tokens and codes point at the client row, so a configured client gets one, updated to match the settings.
      await db
        .insert(oauthClients)
        .values({ clientId, name: known.name, redirectUris: JSON.stringify(known.redirectUris), createdAt: now() })
        .onConflictDoUpdate({ target: oauthClients.clientId, set: { name: known.name, redirectUris: JSON.stringify(known.redirectUris) } });
      return known;
    }
    const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
    return row ? { clientId, name: row.name, redirectUris: JSON.parse(row.redirectUris) as string[] } : null;
  }

  // The statements that forget tokens that can no longer be used, and clients that never got a token.
  const sweepStatements = () => {
    const t = now();
    return [
      db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, t)),
      db.delete(oauthTokens).where(or(lt(oauthTokens.refreshExpiresAt, t), isNotNull(oauthTokens.revokedAt))),
      db.delete(oauthClients).where(and(lt(oauthClients.createdAt, t - UNUSED_CLIENT_TTL), unused())),
    ];
  };

  const unused = () =>
    and(
      notExists(db.select({ one: sql`1` }).from(oauthTokens).where(eq(oauthTokens.clientId, oauthClients.clientId))),
      notExists(db.select({ one: sql`1` }).from(oauthCodes).where(eq(oauthCodes.clientId, oauthClients.clientId))),
    );

  // --- tokens ----------------------------------------------------------------

  const tokenResponse = (access: string, refresh: string, scope: string) => ({
    access_token: access,
    token_type: "Bearer" as const,
    expires_in: ACCESS_TTL,
    refresh_token: refresh,
    scope,
  });

  async function exchangeCode(form: Params) {
    const { code, code_verifier: verifier, client_id: clientId } = form;
    if (!code || !clientId || !verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      throw new OAuthError("invalid_request", "code, client_id and a valid code_verifier are required");
    }
    const t = now();
    // Single use: the row is gone whether or not the checks below pass.
    const [row] = await db.delete(oauthCodes).where(eq(oauthCodes.codeHash, await sha256(code))).returning();
    if (!row || row.expiresAt < t || row.clientId !== clientId || form.redirect_uri !== row.redirectUri) {
      throw new OAuthError("invalid_grant", "The authorization code is invalid or expired");
    }
    if (form.resource && trimSlash(form.resource) !== row.resource) throw new OAuthError("invalid_target", "Unknown resource");
    if (!(await safeEqual(await sha256(verifier), row.codeChallenge))) throw new OAuthError("invalid_grant", "PKCE verification failed");

    const access = randomToken();
    const refresh = randomToken();
    await db.insert(oauthTokens).values({
      id: newId(),
      clientId,
      userId: row.userId,
      householdId: row.householdId,
      scope: row.scope,
      resource: row.resource,
      accessHash: await sha256(access),
      refreshHash: await sha256(refresh),
      accessExpiresAt: t + ACCESS_TTL,
      refreshExpiresAt: t + REFRESH_TTL,
      createdAt: t,
    });
    return tokenResponse(access, refresh, row.scope);
  }

  async function refreshGrant(form: Params) {
    const { refresh_token: presented, client_id: clientId } = form;
    if (!presented || !clientId) throw new OAuthError("invalid_request", "refresh_token and client_id are required");
    const t = now();
    const oldHash = await sha256(presented);
    const invalid = new OAuthError("invalid_grant", "The refresh token is invalid or expired");
    const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.refreshHash, oldHash)).limit(1);
    if (!row || row.revokedAt !== null || row.refreshExpiresAt < t || row.clientId !== clientId) throw invalid;

    const access = randomToken();
    const refresh = randomToken();
    // Guarded on the old hash, so two concurrent refreshes cannot both succeed.
    const rotated = await db
      .update(oauthTokens)
      .set({ accessHash: await sha256(access), refreshHash: await sha256(refresh), accessExpiresAt: t + ACCESS_TTL, refreshExpiresAt: t + REFRESH_TTL })
      .where(and(eq(oauthTokens.id, row.id), eq(oauthTokens.refreshHash, oldHash), isNull(oauthTokens.revokedAt)))
      .returning({ id: oauthTokens.id });
    if (rotated.length !== 1) throw invalid;
    return tokenResponse(access, refresh, row.scope);
  }

  return {
    resource,

    // --- discovery -----------------------------------------------------------

    authorizationServerMetadata: () => ({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...SCOPES],
      authorization_response_iss_parameter_supported: true,
    }),

    protectedResourceMetadata: (resourceName: string) => ({
      resource,
      authorization_servers: [origin],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: resourceName,
    }),

    // Where a client that was refused can find the metadata (RFC 9728 3.1).
    resourceMetadataUrl: () => `${origin}/.well-known/oauth-protected-resource/mcp`,

    // --- dynamic client registration (RFC 7591), public clients only ----------

    async register(body: unknown) {
      const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
      const uris = input.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirectUri)) {
        throw new OAuthError("invalid_redirect_uri", "redirect_uris must be 1-10 https or loopback http URIs without a fragment");
      }
      const name = (typeof input.client_name === "string" ? input.client_name.trim() : "").slice(0, NAME_LIMIT) || "MCP client";

      await atomically(db, sweepStatements());
      const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(oauthClients);
      if (n >= MAX_CLIENTS) {
        // Full: make room by dropping the oldest client that never got a token, if there is one.
        const [oldest] = await db.select({ clientId: oauthClients.clientId }).from(oauthClients).where(unused()).orderBy(asc(oauthClients.createdAt)).limit(1);
        if (!oldest) throw new OAuthError("invalid_client_metadata", "Too many registered clients");
        await db.delete(oauthClients).where(eq(oauthClients.clientId, oldest.clientId));
      }

      const clientId = randomToken(16);
      const issuedAt = now();
      await db.insert(oauthClients).values({ clientId, name, redirectUris: JSON.stringify(uris), createdAt: issuedAt });
      return {
        client_id: clientId,
        client_id_issued_at: issuedAt,
        client_name: name,
        redirect_uris: uris as string[],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },

    // --- authorization -------------------------------------------------------

    async parseAuthorization(params: Params): Promise<Authorization> {
      const clientId = params.client_id;
      const client = clientId ? await findClient(clientId) : null;
      if (!clientId || !client) return { kind: "fatal", message: "Unknown client." };
      const redirectUri = params.redirect_uri;
      if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
        return { kind: "fatal", message: "The redirect URI is not registered for this client." };
      }
      const state = params.state ?? null;
      const fail = (error: string, description: string): Authorization => ({
        kind: "redirect",
        redirectTo: redirectWith(origin, redirectUri, state, { error, error_description: description }),
      });

      if (params.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
      const challenge = params.code_challenge;
      if (params.code_challenge_method !== "S256" || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
        return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
      }
      if (params.resource && trimSlash(params.resource) !== resource) return fail("invalid_target", "Unknown resource");

      const requested = (params.scope ?? "").split(/\s+/).filter(Boolean);
      const scopes = requested.filter((s) => (SCOPES as readonly string[]).includes(s));
      if (requested.length > 0 && scopes.length === 0) return fail("invalid_scope", "No supported scope requested");
      return {
        kind: "ok",
        request: {
          clientId,
          clientName: client.name,
          redirectUri,
          codeChallenge: challenge,
          scope: (scopes.length ? scopes : SCOPES).join(" "),
          state,
          resource,
        },
      };
    },

    // The signed-in person said yes: the URL to send the client back to, carrying a one-time code.
    async approve(principal: Principal, request: AuthorizationRequest): Promise<string> {
      const code = randomToken();
      await atomically(db, [
        ...sweepStatements(),
        db.insert(oauthCodes).values({
          codeHash: await sha256(code),
          clientId: request.clientId,
          redirectUri: request.redirectUri,
          codeChallenge: request.codeChallenge,
          scope: request.scope,
          resource: request.resource,
          userId: principal.userId,
          householdId: principal.householdId,
          expiresAt: now() + CODE_TTL,
        }),
      ]);
      return sendBack(request, { code });
    },

    deny: (request: AuthorizationRequest): string => sendBack(request, { error: "access_denied" }),

    // --- token endpoint ------------------------------------------------------

    async token(form: Params) {
      if (form.grant_type === "authorization_code") return exchangeCode(form);
      if (form.grant_type === "refresh_token") return refreshGrant(form);
      throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    },

    // RFC 7009: unknown tokens are not an error.
    async revoke(token: string | undefined) {
      if (!token) return;
      const hash = await sha256(token);
      await db
        .update(oauthTokens)
        .set({ revokedAt: now() })
        .where(and(or(eq(oauthTokens.accessHash, hash), eq(oauthTokens.refreshHash, hash)), isNull(oauthTokens.revokedAt)));
    },

    // --- the resource side ---------------------------------------------------

    async verifyAccessToken(token: string) {
      const [row] = await db
        .select()
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.accessHash, await sha256(token)),
            isNull(oauthTokens.revokedAt),
            gt(oauthTokens.accessExpiresAt, now()),
            eq(oauthTokens.resource, resource),
          ),
        )
        .limit(1);
      return row ? { userId: row.userId, householdId: row.householdId, clientId: row.clientId, scopes: row.scope.split(" ") } : null;
    },

    // --- what a person has connected -------------------------------------------

    async listConnections(principal: Principal) {
      const rows = await db
        .select({ id: oauthTokens.id, clientName: oauthClients.name, scope: oauthTokens.scope, createdAt: oauthTokens.createdAt })
        .from(oauthTokens)
        .innerJoin(oauthClients, eq(oauthClients.clientId, oauthTokens.clientId))
        .where(and(eq(oauthTokens.userId, principal.userId), isNull(oauthTokens.revokedAt), gt(oauthTokens.refreshExpiresAt, now())))
        .orderBy(desc(oauthTokens.createdAt), desc(oauthTokens.id));
      return rows.map((r) => ({ id: r.id, clientName: r.clientName, scopes: r.scope.split(" "), createdAt: r.createdAt }));
    },

    // Returns whether something was disconnected. Only the person's own connections can be.
    async disconnect(principal: Principal, id: string): Promise<boolean> {
      const revoked = await db
        .update(oauthTokens)
        .set({ revokedAt: now() })
        .where(and(eq(oauthTokens.id, id), eq(oauthTokens.userId, principal.userId), isNull(oauthTokens.revokedAt)))
        .returning({ id: oauthTokens.id });
      return revoked.length === 1;
    },
  };

  function sendBack(request: AuthorizationRequest, extra: Record<string, string>): string {
    return redirectWith(origin, request.redirectUri, request.state, extra);
  }
}

export type OAuthService = ReturnType<typeof createOAuthService>;
