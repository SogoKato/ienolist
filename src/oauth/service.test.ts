import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import type { Principal } from "../auth/service.ts";
import { createTestDb } from "../db/testing.ts";
import { randomToken, sha256 } from "../lib/token.ts";
import { createOAuthService, OAuthError, type OAuthService, type Params, type PreregisteredClient } from "./service.ts";

const ORIGIN = "https://lists.example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const DAY = 24 * 60 * 60;

let raw: DatabaseSync;
let oauth: OAuthService;
let clock: number;
let aki: Principal;
let bo: Principal;

function build(clients?: PreregisteredClient[]) {
  const t = createTestDb();
  raw = t.raw;
  raw.exec("INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', 0), ('h2', 'Other', 0)");
  raw.exec("INSERT INTO users (id, display_name, created_at) VALUES ('u1', 'Aki', 0), ('u2', 'Bo', 0)");
  oauth = createOAuthService(t.db, { origin: ORIGIN, clients, now: () => clock });
}

beforeEach(() => {
  clock = 1_000_000;
  build();
  aki = { userId: "u1", displayName: "Aki", householdId: "h1", householdName: "Home", role: "admin" };
  bo = { userId: "u2", displayName: "Bo", householdId: "h2", householdName: "Other", role: "admin" };
});

const registerClient = async (name = "Claude", redirectUris = [REDIRECT]) => (await oauth.register({ client_name: name, redirect_uris: redirectUris })).client_id;

async function pkce() {
  const verifier = randomToken(32);
  return { verifier, challenge: await sha256(verifier) };
}

const authParams = (clientId: string, challenge: string, extra: Params = {}): Params => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "xyz",
  ...extra,
});

// Registers, asks for approval as `who`, and trades the code in: a connected client.
async function connect(who: Principal = aki, scope?: string) {
  const clientId = await registerClient();
  const { verifier, challenge } = await pkce();
  const parsed = await oauth.parseAuthorization(authParams(clientId, challenge, scope ? { scope } : {}));
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") throw new Error("unreachable");
  const back = new URL(await oauth.approve(who, parsed.request));
  const tokens = await oauth.token({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
  return { clientId, tokens, verifier, request: parsed.request };
}

const rejected = async (promise: Promise<unknown>, error: string) => {
  await assert.rejects(promise, (e) => e instanceof OAuthError && e.error === error);
};

// --- registration -------------------------------------------------------------------------

test("registering a client returns public-client metadata and stores the client", async () => {
  const client = await oauth.register({ client_name: "  Claude  ", redirect_uris: [REDIRECT, "http://localhost:3118/callback", "http://[::1]:5000/cb"] });
  assert.match(client.client_id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(client.client_name, "Claude");
  assert.equal(client.token_endpoint_auth_method, "none");
  assert.deepEqual(client.grant_types, ["authorization_code", "refresh_token"]);
  assert.equal(client.client_id_issued_at, clock);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get()!.n, 1);
});

test("clients get a default name and a bounded one", async () => {
  assert.equal((await oauth.register({ redirect_uris: [REDIRECT] })).client_name, "MCP client");
  assert.equal((await oauth.register({ client_name: "   ", redirect_uris: [REDIRECT] })).client_name, "MCP client");
  assert.equal((await oauth.register({ client_name: "x".repeat(500), redirect_uris: [REDIRECT] })).client_name.length, 100);
});

test("redirect URIs must be https or loopback http, without a fragment", async () => {
  const bad: unknown[] = [
    undefined,
    [],
    "https://claude.ai/cb",
    [123],
    ["not a url"],
    ["http://example.com/cb"],
    ["javascript:alert(1)"],
    ["data:text/html,hi"],
    ["myapp://callback"],
    ["https://claude.ai/cb#frag"],
    ["https://claude.ai/" + "a".repeat(2000)],
    [REDIRECT, "http://example.com/cb"],
    Array.from({ length: 11 }, (_, i) => `https://claude.ai/cb${i}`),
  ];
  for (const redirect_uris of bad) await rejected(oauth.register({ redirect_uris }), "invalid_redirect_uri");
  await rejected(oauth.register(null), "invalid_redirect_uri");
  await rejected(oauth.register("nonsense"), "invalid_redirect_uri");
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get()!.n, 0);
});

test("when the registry is full the oldest client that never connected makes room", async () => {
  const first = await registerClient("first");
  for (let i = 1; i < 100; i++) {
    clock++;
    await registerClient(`c${i}`);
  }
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get()!.n, 100);
  clock++;
  await registerClient("newcomer");
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get()!.n, 100);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM oauth_clients WHERE client_id = ?").get(first)!.n, 0);
});

test("when every client is in use the registry refuses a new one", async () => {
  for (let i = 0; i < 100; i++) {
    const clientId = `client${i}`;
    raw.prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?, 'x', '[]', ?)").run(clientId, clock);
    raw.prepare(
      "INSERT INTO oauth_tokens (id, client_id, user_id, household_id, scope, resource, access_hash, refresh_hash, access_expires_at, refresh_expires_at, created_at) VALUES (?, ?, 'u1', 'h1', 'read', ?, ?, ?, ?, ?, ?)",
    ).run(`t${i}`, clientId, `${ORIGIN}/mcp`, `a${i}`, `r${i}`, clock + 3600, clock + 30 * DAY, clock);
  }
  await rejected(oauth.register({ redirect_uris: [REDIRECT] }), "invalid_client_metadata");
});

test("clients that never connected are forgotten after a week; connected ones stay", async () => {
  const idle = await registerClient("idle");
  const { clientId: connected } = await connect();
  clock += 7 * DAY + 1;
  await registerClient("fresh");
  const ids = raw.prepare("SELECT client_id FROM oauth_clients").all().map((r) => r.client_id);
  assert.ok(!ids.includes(idle));
  assert.ok(ids.includes(connected));
  assert.equal(ids.length, 2);
});

// --- the authorization request --------------------------------------------------------------

test("a good request is accepted with every scope by default", async () => {
  const clientId = await registerClient("Claude");
  const { challenge } = await pkce();
  const parsed = await oauth.parseAuthorization(authParams(clientId, challenge));
  assert.deepEqual(parsed, {
    kind: "ok",
    request: { clientId, clientName: "Claude", redirectUri: REDIRECT, codeChallenge: challenge, scope: "read write", state: "xyz", resource: `${ORIGIN}/mcp` },
  });
});

test("scopes are narrowed to the supported ones, write comes with read, and read may come alone", async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const only = async (scope: string) => {
    const parsed = await oauth.parseAuthorization(authParams(clientId, challenge, { scope }));
    return parsed.kind === "ok" ? parsed.request.scope : parsed;
  };
  assert.equal(await only("read"), "read");
  assert.equal(await only("read admin offline_access"), "read");
  assert.equal(await only("write"), "read write");
  // Scopes from before the two levels are no longer known.
  assert.equal(((await only("items:read items:write")) as { kind: string }).kind, "redirect");
  const none = await oauth.parseAuthorization(authParams(clientId, challenge, { scope: "admin" }));
  assert.equal(none.kind, "redirect");
  assert.equal(new URL((none as { redirectTo: string }).redirectTo).searchParams.get("error"), "invalid_scope");
});

test("an unknown client or unregistered redirect URI is never redirected to", async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  assert.equal((await oauth.parseAuthorization(authParams("nobody", challenge))).kind, "fatal");
  assert.equal((await oauth.parseAuthorization({ ...authParams(clientId, challenge), client_id: undefined })).kind, "fatal");
  for (const redirect_uri of ["https://evil.example/cb", `${REDIRECT}/`, `${REDIRECT}?x=1`, "https://claude.ai/api/mcp/auth_callback#", undefined]) {
    assert.equal((await oauth.parseAuthorization(authParams(clientId, challenge, { redirect_uri }))).kind, "fatal", String(redirect_uri));
  }
});

test("other mistakes are sent back to the client with state and issuer", async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const cases: [Params, string][] = [
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ response_type: undefined }, "unsupported_response_type"],
    [{ code_challenge: undefined }, "invalid_request"],
    [{ code_challenge: "short" }, "invalid_request"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge_method: undefined }, "invalid_request"],
    [{ resource: "https://other.example/mcp" }, "invalid_target"],
  ];
  for (const [change, error] of cases) {
    const parsed = await oauth.parseAuthorization({ ...authParams(clientId, challenge), ...change });
    assert.equal(parsed.kind, "redirect", error);
    const url = new URL((parsed as { redirectTo: string }).redirectTo);
    assert.equal(url.origin + url.pathname, REDIRECT);
    assert.equal(url.searchParams.get("error"), error);
    assert.equal(url.searchParams.get("state"), "xyz");
    assert.equal(url.searchParams.get("iss"), ORIGIN);
  }
});

test("the resource may be named with or without a trailing slash, but only ours", async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  for (const resource of [`${ORIGIN}/mcp`, `${ORIGIN}/mcp/`, undefined]) {
    assert.equal((await oauth.parseAuthorization(authParams(clientId, challenge, { resource }))).kind, "ok", String(resource));
  }
  assert.equal((await oauth.parseAuthorization(authParams(clientId, challenge, { resource: ORIGIN }))).kind, "redirect");
});

test("approving and denying send the person back to the client", async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const parsed = await oauth.parseAuthorization(authParams(clientId, challenge));
  if (parsed.kind !== "ok") throw new Error("unreachable");
  const allowed = new URL(await oauth.approve(aki, parsed.request));
  assert.equal(allowed.origin + allowed.pathname, REDIRECT);
  assert.match(allowed.searchParams.get("code")!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(allowed.searchParams.get("state"), "xyz");
  assert.equal(allowed.searchParams.get("iss"), ORIGIN);
  const denied = new URL(oauth.deny(parsed.request));
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.get("state"), "xyz");
  assert.equal(denied.searchParams.get("code"), null);
});

test("a redirect URI that already has a query keeps it", async () => {
  const clientId = await registerClient("App", ["https://app.example/cb?tenant=1"]);
  const { challenge } = await pkce();
  const parsed = await oauth.parseAuthorization({ ...authParams(clientId, challenge), redirect_uri: "https://app.example/cb?tenant=1" });
  if (parsed.kind !== "ok") throw new Error("unreachable");
  const back = new URL(await oauth.approve(aki, parsed.request));
  assert.equal(back.searchParams.get("tenant"), "1");
  assert.ok(back.searchParams.get("code"));
});

test("codes are stored hashed", async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const parsed = await oauth.parseAuthorization(authParams(clientId, challenge));
  if (parsed.kind !== "ok") throw new Error("unreachable");
  const code = new URL(await oauth.approve(aki, parsed.request)).searchParams.get("code")!;
  assert.deepEqual(raw.prepare("SELECT code_hash FROM oauth_codes").all().map((r) => r.code_hash), [await sha256(code)]);
});

// --- the token endpoint ----------------------------------------------------------------------

test("a code and its verifier are traded for tokens that work as a grant for this person and household", async () => {
  const { clientId, tokens } = await connect();
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 3600);
  assert.equal(tokens.scope, "read write");
  assert.deepEqual(await oauth.verifyAccessToken(tokens.access_token), { userId: "u1", householdId: "h1", clientId, scopes: ["read", "write"] });
  // Only hashes are kept.
  const stored = { ...raw.prepare("SELECT access_hash, refresh_hash FROM oauth_tokens").get()! };
  assert.deepEqual(stored, { access_hash: await sha256(tokens.access_token), refresh_hash: await sha256(tokens.refresh_token) });
});

test("the person may allow reading only, whatever the client asked for", async () => {
  const clientId = await registerClient();
  const { verifier, challenge } = await pkce();
  const parsed = await oauth.parseAuthorization(authParams(clientId, challenge));
  if (parsed.kind !== "ok") throw new Error("unreachable");
  const code = new URL(await oauth.approve(aki, parsed.request, { readOnly: true })).searchParams.get("code")!;
  const tokens = await oauth.token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
  assert.equal(tokens.scope, "read");
  assert.deepEqual((await oauth.verifyAccessToken(tokens.access_token))?.scopes, ["read"]);
});

test("a grant for a person in another household is scoped to that household", async () => {
  const { clientId, tokens } = await connect(bo, "read");
  assert.deepEqual(await oauth.verifyAccessToken(tokens.access_token), { userId: "u2", householdId: "h2", clientId, scopes: ["read"] });
});

test("a code works once, even when the first try failed", async () => {
  const clientId = await registerClient();
  const { verifier, challenge } = await pkce();
  const parsed = await oauth.parseAuthorization(authParams(clientId, challenge));
  if (parsed.kind !== "ok") throw new Error("unreachable");
  const code = new URL(await oauth.approve(aki, parsed.request)).searchParams.get("code")!;
  const form = { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT };
  await rejected(oauth.token({ ...form, code_verifier: "w".repeat(43) }), "invalid_grant");
  await rejected(oauth.token(form), "invalid_grant");

  const second = await oauth.parseAuthorization(authParams(clientId, challenge));
  if (second.kind !== "ok") throw new Error("unreachable");
  const code2 = new URL(await oauth.approve(aki, second.request)).searchParams.get("code")!;
  await oauth.token({ ...form, code: code2 });
  await rejected(oauth.token({ ...form, code: code2 }), "invalid_grant");
});

test("a code is bound to its client, redirect URI, resource and PKCE verifier", async () => {
  const clientId = await registerClient();
  const other = await registerClient("Other");
  const { verifier, challenge } = await pkce();
  const issue = async () => {
    const parsed = await oauth.parseAuthorization(authParams(clientId, challenge));
    if (parsed.kind !== "ok") throw new Error("unreachable");
    return new URL(await oauth.approve(aki, parsed.request)).searchParams.get("code")!;
  };
  const form = (code: string, change: Params = {}): Params => ({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, ...change });
  await rejected(oauth.token(form(await issue(), { client_id: other })), "invalid_grant");
  await rejected(oauth.token(form(await issue(), { redirect_uri: "https://claude.ai/other" })), "invalid_grant");
  await rejected(oauth.token(form(await issue(), { redirect_uri: undefined })), "invalid_grant");
  await rejected(oauth.token(form(await issue(), { resource: "https://other.example/mcp" })), "invalid_target");
  await rejected(oauth.token(form(await issue(), { code_verifier: (await pkce()).verifier })), "invalid_grant");
  // The right everything still works, with or without naming the resource.
  assert.ok((await oauth.token(form(await issue(), { resource: `${ORIGIN}/mcp` }))).access_token);
  assert.ok((await oauth.token(form(await issue()))).access_token);
});

test("a code expires after five minutes", async () => {
  const clientId = await registerClient();
  const { verifier, challenge } = await pkce();
  const parsed = await oauth.parseAuthorization(authParams(clientId, challenge));
  if (parsed.kind !== "ok") throw new Error("unreachable");
  const code = new URL(await oauth.approve(aki, parsed.request)).searchParams.get("code")!;
  clock += 5 * 60 + 1;
  await rejected(oauth.token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }), "invalid_grant");
});

test("incomplete or malformed token requests are invalid_request", async () => {
  const clientId = await registerClient();
  const good = { grant_type: "authorization_code", code: "c", code_verifier: "v".repeat(43), client_id: clientId };
  await rejected(oauth.token({ ...good, code: undefined }), "invalid_request");
  await rejected(oauth.token({ ...good, client_id: undefined }), "invalid_request");
  await rejected(oauth.token({ ...good, code_verifier: undefined }), "invalid_request");
  await rejected(oauth.token({ ...good, code_verifier: "short" }), "invalid_request");
  await rejected(oauth.token({ ...good, code_verifier: "v".repeat(129) }), "invalid_request");
  await rejected(oauth.token({ ...good, code_verifier: "v".repeat(42) + "!" }), "invalid_request");
  await rejected(oauth.token({ grant_type: "refresh_token", client_id: clientId }), "invalid_request");
  await rejected(oauth.token({ grant_type: "refresh_token", refresh_token: "r" }), "invalid_request");
  await rejected(oauth.token({ grant_type: "password" }), "unsupported_grant_type");
  await rejected(oauth.token({}), "unsupported_grant_type");
});

// --- refreshing, expiry and revocation ----------------------------------------------------------

test("a refresh rotates both tokens and the old ones stop working", async () => {
  const { clientId, tokens } = await connect();
  clock += 100;
  const next = await oauth.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
  assert.notEqual(next.access_token, tokens.access_token);
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.equal(next.scope, tokens.scope);
  assert.equal(await oauth.verifyAccessToken(tokens.access_token), null);
  assert.ok(await oauth.verifyAccessToken(next.access_token));
  await rejected(oauth.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }), "invalid_grant");
  // Still one grant, not a new one per refresh.
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get()!.n, 1);
  assert.equal((await oauth.listConnections(aki)).length, 1);
});

test("a refresh token belongs to its client", async () => {
  const { tokens } = await connect();
  const other = await registerClient("Other");
  await rejected(oauth.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: other }), "invalid_grant");
  await rejected(oauth.token({ grant_type: "refresh_token", refresh_token: "nonsense", client_id: other }), "invalid_grant");
});

test("two refreshes at once cannot both succeed", async () => {
  const { clientId, tokens } = await connect();
  const attempts = await Promise.allSettled([1, 2, 3].map(() => oauth.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId })));
  assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
  for (const failed of attempts.filter((a) => a.status === "rejected")) assert.ok(failed.reason instanceof OAuthError && failed.reason.error === "invalid_grant");
});

test("access tokens last an hour; refresh tokens thirty days, renewed by each refresh", async () => {
  const { clientId, tokens } = await connect();
  clock += 3600 - 1;
  assert.ok(await oauth.verifyAccessToken(tokens.access_token));
  clock += 2;
  assert.equal(await oauth.verifyAccessToken(tokens.access_token), null);

  const next = await oauth.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
  assert.ok(await oauth.verifyAccessToken(next.access_token));
  clock += 30 * DAY - 1;
  const again = await oauth.token({ grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: clientId });
  clock += 30 * DAY + 1;
  await rejected(oauth.token({ grant_type: "refresh_token", refresh_token: again.refresh_token, client_id: clientId }), "invalid_grant");
});

test("revoking works with either token and does not complain about unknown ones", async () => {
  const a = await connect();
  const b = await connect();
  await oauth.revoke(a.tokens.access_token);
  assert.equal(await oauth.verifyAccessToken(a.tokens.access_token), null);
  await rejected(oauth.token({ grant_type: "refresh_token", refresh_token: a.tokens.refresh_token, client_id: a.clientId }), "invalid_grant");
  await oauth.revoke(b.tokens.refresh_token);
  assert.equal(await oauth.verifyAccessToken(b.tokens.access_token), null);
  await oauth.revoke("never issued");
  await oauth.revoke(undefined);
  await oauth.revoke("");
  assert.deepEqual(await oauth.listConnections(aki), []);
});

test("a token for another resource is not accepted", async () => {
  const { tokens } = await connect();
  raw.exec("UPDATE oauth_tokens SET resource = 'https://other.example/mcp'");
  assert.equal(await oauth.verifyAccessToken(tokens.access_token), null);
});

test("revoked and expired grants are swept away later", async () => {
  const a = await connect();
  await connect();
  await oauth.revoke(a.tokens.access_token);
  clock += 31 * DAY;
  await registerClient("trigger a sweep");
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get()!.n, 0);
});

// --- connections -------------------------------------------------------------------------------

test("a person sees only their own connections, newest first, and can disconnect them", async () => {
  const first = await connect(aki, "read");
  clock++;
  const second = await connect(aki);
  await connect(bo);

  const mine = await oauth.listConnections(aki);
  assert.deepEqual(mine.map((c) => c.scopes), [["read", "write"], ["read"]]);
  assert.deepEqual(mine.map((c) => c.clientName), ["Claude", "Claude"]);
  assert.equal(mine[0].createdAt, clock);
  assert.equal((await oauth.listConnections(bo)).length, 1);

  // Someone else's connection cannot be disconnected, nor can an unknown one.
  assert.equal(await oauth.disconnect(bo, mine[0].id), false);
  assert.equal(await oauth.disconnect(aki, "unknown"), false);
  assert.ok(await oauth.verifyAccessToken(second.tokens.access_token));

  assert.equal(await oauth.disconnect(aki, mine[0].id), true);
  assert.equal(await oauth.disconnect(aki, mine[0].id), false);
  assert.equal(await oauth.verifyAccessToken(second.tokens.access_token), null);
  assert.ok(await oauth.verifyAccessToken(first.tokens.access_token));
  assert.equal((await oauth.listConnections(aki)).length, 1);
});

// --- configured clients, metadata -----------------------------------------------------------------

test("clients from the settings work without registering, and follow the settings", async () => {
  build([{ clientId: "my-app", name: "My app", redirectUris: ["https://app.example/cb"] }]);
  const { verifier, challenge } = await pkce();
  const params = { ...authParams("my-app", challenge), redirect_uri: "https://app.example/cb" };
  const parsed = await oauth.parseAuthorization(params);
  if (parsed.kind !== "ok") throw new Error("unreachable");
  assert.equal(parsed.request.clientName, "My app");
  const code = new URL(await oauth.approve(aki, parsed.request)).searchParams.get("code")!;
  const tokens = await oauth.token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: "my-app", redirect_uri: "https://app.example/cb" });
  assert.ok(await oauth.verifyAccessToken(tokens.access_token));
  assert.equal((await oauth.listConnections(aki))[0].clientName, "My app");

  // Settings changed: the new redirect URI applies, the old one no longer does.
  const t = createTestDb();
  raw = t.raw;
  raw.exec("INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', 0)");
  raw.exec("INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES ('my-app', 'Old name', '[\"https://old.example/cb\"]', 0)");
  oauth = createOAuthService(t.db, { origin: ORIGIN, clients: [{ clientId: "my-app", name: "New name", redirectUris: ["https://new.example/cb"] }], now: () => clock });
  assert.equal((await oauth.parseAuthorization({ ...params, redirect_uri: "https://old.example/cb" })).kind, "fatal");
  assert.equal((await oauth.parseAuthorization({ ...params, redirect_uri: "https://new.example/cb" })).kind, "ok");
  assert.equal(raw.prepare("SELECT name FROM oauth_clients WHERE client_id = 'my-app'").get()!.name, "New name");
});

test("the metadata points at this app's endpoints", () => {
  assert.deepEqual(oauth.authorizationServerMetadata(), {
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/oauth/authorize`,
    token_endpoint: `${ORIGIN}/oauth/token`,
    registration_endpoint: `${ORIGIN}/oauth/register`,
    revocation_endpoint: `${ORIGIN}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read", "write"],
    authorization_response_iss_parameter_supported: true,
  });
  assert.deepEqual(oauth.protectedResourceMetadata("Home lists"), {
    resource: `${ORIGIN}/mcp`,
    authorization_servers: [ORIGIN],
    scopes_supported: ["read", "write"],
    bearer_methods_supported: ["header"],
    resource_name: "Home lists",
  });
  assert.equal(oauth.resourceMetadataUrl(), `${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
});
