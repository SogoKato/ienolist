import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { createAuthService } from "../auth/service.ts";
import { loadConfig } from "../config.ts";
import { createTestDb } from "../db/testing.ts";
import { createItemService } from "../items/service.ts";
import { createRecipeService } from "../recipes/service.ts";
import { randomToken, sha256 } from "../lib/token.ts";
import { missingScope } from "../mcp/tools.ts";
import { createOAuthService } from "../oauth/service.ts";
import { createApp } from "./app.ts";
import { Browser, ORIGIN, setUpHousehold } from "./testing.ts";

// Response.json() is typed unknown; the tests inspect arbitrary payloads.
declare global {
  interface Response {
    json(): Promise<any>;
  }
}

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
let raw: DatabaseSync;
let app: ReturnType<typeof createApp>;
let clock: number;

beforeEach(() => {
  clock = 1_000_000;
  const t = createTestDb();
  raw = t.raw;
  const config = loadConfig({ PUBLIC_URL: ORIGIN });
  app = createApp({
    config,
    auth: createAuthService(t.db, { rp: config.rp, now: () => clock }),
    items: createItemService(t.db, { now: () => clock }),
    recipes: createRecipeService(t.db, { now: () => clock }),
    oauth: createOAuthService(t.db, { origin: config.origin, now: () => clock }),
  });
});

const newBrowser = () => new Browser((url, init) => app.request(url, init));
const signedIn = async (name = "Aki") => (await setUpHousehold(newBrowser(), name)).browser;

// The MCP client: no cookies, talks to the OAuth endpoints and /mcp from its own origin.
const request = (method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) =>
  app.request(`${ORIGIN}${path}`, { method, headers: { origin: "https://claude.ai", ...init.headers }, body: init.body });
const form = (path: string, fields: Record<string, string>) =>
  request("POST", path, { headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

async function registerClient() {
  const res = await request("POST", "/oauth/register", { headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) });
  assert.equal(res.status, 201);
  return (await res.json()).client_id as string;
}

async function authorizeQuery(clientId: string, extra: Record<string, string> = {}) {
  const verifier = randomToken(32);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await sha256(verifier),
    code_challenge_method: "S256",
    state: "s1",
    resource: `${ORIGIN}/mcp`,
    ...extra,
  }).toString();
  return { verifier, query };
}

// The whole connection: register, send the person to the consent step, allow, trade the code.
async function connect(browser: Browser, extra: Record<string, string> = {}, readOnly = false) {
  const clientId = await registerClient();
  const { verifier, query } = await authorizeQuery(clientId, extra);
  const start = await request("GET", `/oauth/authorize?${query}`);
  assert.equal(start.status, 302);
  assert.equal(start.headers.get("location"), `/authorize?${query}`);
  const params = Object.fromEntries(new URLSearchParams(query));
  const decision = await browser.post("/api/oauth/authorize", { params, decision: "allow", readOnly });
  assert.equal(decision.status, 200);
  const back = new URL((await decision.json()).redirectTo);
  assert.equal(back.searchParams.get("state"), "s1");
  const res = await form("/oauth/token", { grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
  assert.equal(res.status, 200);
  return { clientId, tokens: await res.json() };
}

const V = "2026-07-28";
const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} } };
const callTool = (token: string | null, name: string, args: object = {}) =>
  request("POST", "/mcp", {
    headers: { "content-type": "application/json", "mcp-protocol-version": V, "mcp-method": "tools/call", "mcp-name": name, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, ...meta } }),
  });
const toolData = async (res: Response) => {
  const result = (await res.json()).result;
  return { isError: result.isError, data: JSON.parse(result.content[0].text) };
};

// --- discovery -------------------------------------------------------------------------------

test("the metadata is public, readable from any origin, and names this app", async () => {
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const res = await request("GET", path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("access-control-allow-origin"), "*", path);
  }
  const server = await (await request("GET", "/.well-known/oauth-authorization-server")).json();
  assert.equal(server.issuer, ORIGIN);
  assert.equal(server.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  const resource = await (await request("GET", "/.well-known/oauth-protected-resource/mcp")).json();
  assert.deepEqual([resource.resource, resource.authorization_servers], [`${ORIGIN}/mcp`, [ORIGIN]]);
});

test("an unauthenticated MCP call is told where to find the metadata", async () => {
  const res = await callTool(null, "list_items");
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  assert.match(res.headers.get("access-control-expose-headers") ?? "", /www-authenticate/i);
  for (const authorization of ["Bearer", "Bearer nonsense", "Basic abc", "bearer  x y"]) {
    assert.equal((await request("POST", "/mcp", { headers: { authorization, "content-type": "application/json" }, body: "{}" })).status, 401, authorization);
  }
});

test("browsers on other origins may preflight the MCP endpoint", async () => {
  const res = await request("OPTIONS", "/mcp", { headers: { "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,mcp-protocol-version" } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /authorization/i);
});

// --- registration and the authorization endpoint -------------------------------------------------

test("registration works from any origin without a session and rejects bad input as JSON", async () => {
  const bad = await request("POST", "/oauth/register", { headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://example.com/cb"] }) });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "invalid_redirect_uri", error_description: "redirect_uris must be 1-10 https or loopback http URIs without a fragment" });
  assert.equal(bad.headers.get("access-control-allow-origin"), "*");
  assert.equal((await request("POST", "/oauth/register", { body: "not json" })).status, 400);
  const ok = await request("POST", "/oauth/register", { headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) });
  assert.equal(ok.status, 201);
  assert.equal(ok.headers.get("cache-control"), "no-store");
});

test("the authorization endpoint sends good requests on to the consent screen and bad ones to the right place", async () => {
  const clientId = await registerClient();
  const { query } = await authorizeQuery(clientId);
  const good = await request("GET", `/oauth/authorize?${query}`);
  assert.equal(good.headers.get("location"), `/authorize?${query}`);

  // The client or redirect URI is wrong: say so here, never redirect.
  const unknown = await request("GET", `/oauth/authorize?${(await authorizeQuery("nobody")).query}`);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.get("location"), null);
  const evil = await request("GET", `/oauth/authorize?${(await authorizeQuery(clientId, { redirect_uri: "https://evil.example/cb" })).query}`);
  assert.equal(evil.status, 400);
  assert.equal(evil.headers.get("location"), null);

  // The rest goes back to the client.
  const noPkce = await request("GET", `/oauth/authorize?${(await authorizeQuery(clientId, { code_challenge_method: "plain" })).query}`);
  const back = new URL(noPkce.headers.get("location")!);
  assert.equal(noPkce.status, 302);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("error"), "invalid_request");
  assert.equal(back.searchParams.get("state"), "s1");
});

// --- the consent step (needs the signed-in person) ---------------------------------------------------

test("the consent API needs a signed-in person and the app's own origin", async () => {
  const clientId = await registerClient();
  const { query } = await authorizeQuery(clientId);
  const params = Object.fromEntries(new URLSearchParams(query));
  const anon = newBrowser();
  assert.equal((await anon.get(`/api/oauth/authorization?${query}`)).status, 401);
  assert.equal((await anon.post("/api/oauth/authorize", { params, decision: "allow" })).status, 401);
  assert.equal((await anon.get("/api/connections")).status, 401);
  assert.equal((await anon.delete("/api/connections/x")).status, 401);

  const browser = await signedIn();
  browser.origin = "https://claude.ai";
  assert.equal((await browser.post("/api/oauth/authorize", { params, decision: "allow" })).status, 403);
  browser.origin = null;
  assert.equal((await browser.post("/api/oauth/authorize", { params, decision: "allow" })).status, 403);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()!.n, 0);
});

test("the consent screen is told who is asking and where the person will be sent back", async () => {
  const browser = await signedIn();
  const clientId = await registerClient();
  const { query } = await authorizeQuery(clientId, { scope: "read" });
  const res = await browser.get(`/api/oauth/authorization?${query}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { clientName: "Claude", redirectHost: "claude.ai", scopes: ["read"] });

  const unknown = await browser.get(`/api/oauth/authorization?${(await authorizeQuery("nobody")).query}`);
  assert.equal(unknown.status, 400);
  const mistaken = await browser.get(`/api/oauth/authorization?${(await authorizeQuery(clientId, { response_type: "token" })).query}`);
  assert.equal(new URL((await mistaken.json()).redirectTo).searchParams.get("error"), "unsupported_response_type");
});

test("denying sends the client back with access_denied and issues nothing", async () => {
  const browser = await signedIn();
  const clientId = await registerClient();
  const { query } = await authorizeQuery(clientId);
  const res = await browser.post("/api/oauth/authorize", { params: Object.fromEntries(new URLSearchParams(query)), decision: "deny" });
  const back = new URL((await res.json()).redirectTo);
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("state"), "s1");
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()!.n, 0);
});

test("the decision is checked again: bad bodies and bad requests are refused", async () => {
  const browser = await signedIn();
  const clientId = await registerClient();
  const params = Object.fromEntries(new URLSearchParams((await authorizeQuery(clientId)).query));
  assert.equal((await browser.post("/api/oauth/authorize", { params, decision: "maybe" })).status, 400);
  assert.equal((await browser.post("/api/oauth/authorize", { decision: "allow" })).status, 400);
  assert.equal((await browser.post("/api/oauth/authorize", { params: { ...params, redirect_uri: "https://evil.example/cb" }, decision: "allow" })).status, 400);
  assert.equal((await browser.post("/api/oauth/authorize", { params: { ...params, client_id: "nobody" }, decision: "allow" })).status, 400);
  const mistaken = await browser.post("/api/oauth/authorize", { params: { ...params, code_challenge_method: "plain" }, decision: "allow" });
  assert.equal(new URL((await mistaken.json()).redirectTo).searchParams.get("error"), "invalid_request");
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()!.n, 0);
});

// --- the token endpoint -------------------------------------------------------------------------------

test("token errors are OAuth errors, readable cross-origin, and never cached", async () => {
  const res = await form("/oauth/token", { grant_type: "authorization_code", code: "nope", code_verifier: "v".repeat(43), client_id: "nobody", redirect_uri: REDIRECT });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_grant", error_description: "The authorization code is invalid or expired" });
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("pragma"), "no-cache");
  assert.equal((await (await form("/oauth/token", { grant_type: "implicit" })).json()).error, "unsupported_grant_type");
});

test("tokens are issued with no-store and refresh and revoke work over HTTP", async () => {
  const browser = await signedIn();
  const { clientId, tokens } = await connect(browser);
  assert.deepEqual(Object.keys(tokens).sort(), ["access_token", "expires_in", "refresh_token", "scope", "token_type"]);

  const refreshed = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.headers.get("cache-control"), "no-store");
  const next = await refreshed.json();
  assert.equal((await callTool(tokens.access_token, "list_items")).status, 401);
  assert.equal((await callTool(next.access_token, "list_items")).status, 200);

  const revoked = await form("/oauth/revoke", { token: next.refresh_token });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.headers.get("access-control-allow-origin"), "*");
  assert.equal((await callTool(next.access_token, "list_items")).status, 401);
  assert.equal((await form("/oauth/revoke", { token: "unknown" })).status, 200);
  assert.equal((await form("/oauth/revoke", {})).status, 200);
});

// --- the MCP endpoint with real tokens -------------------------------------------------------------------

test("an MCP client reads and writes the household's lists, and the web sees who did it", async () => {
  const browser = await signedIn();
  const { clientId, tokens } = await connect(browser);

  const created = await toolData(await callTool(tokens.access_token, "create_item", { list: "shopping", name: "卵" }));
  assert.equal(created.isError, undefined);
  assert.equal(created.data.name, "卵");
  const listed = await toolData(await callTool(tokens.access_token, "list_items"));
  assert.deepEqual(listed.data.items.map((i: { name: string }) => i.name), ["卵"]);

  // The person sees it in the web app, and the history says it came from the connected client.
  assert.deepEqual((await (await browser.get("/api/items")).json()).items.map((i: { name: string }) => i.name), ["卵"]);
  const [event] = (await (await browser.get(`/api/events?itemId=${created.data.id}`)).json()).events;
  assert.equal(event.source, "mcp");
  const me = await (await browser.get("/api/me")).json();
  assert.deepEqual({ ...raw.prepare("SELECT user_id, client_id FROM item_events WHERE id = ?").get(event.id)! }, { user_id: me.user.id, client_id: clientId });
});

test("a client the person allowed to read only cannot write, though it asked for more", async () => {
  const browser = await signedIn();
  const { tokens } = await connect(browser, {}, true);
  assert.equal(tokens.scope, "read");
  await browser.post("/api/items", { list: "fridge", name: "牛乳" });
  assert.equal((await toolData(await callTool(tokens.access_token, "list_items"))).data.items.length, 1);
  const denied = await (await callTool(tokens.access_token, "create_item", { list: "fridge", name: "卵" })).json();
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.content[0].text, missingScope());
  assert.equal((await (await browser.get("/api/items")).json()).items.length, 1);
});

// --- what a person has connected ---------------------------------------------------------------------------

test("connections can be listed and disconnected, which cuts the client off", async () => {
  const browser = await signedIn();
  const { tokens } = await connect(browser);
  const { connections } = await (await browser.get("/api/connections")).json();
  assert.equal(connections.length, 1);
  assert.deepEqual([connections[0].clientName, connections[0].scopes, connections[0].createdAt], ["Claude", ["read", "write"], clock]);
  assert.deepEqual(Object.keys(connections[0]).sort(), ["clientName", "createdAt", "id", "scopes"]);

  assert.equal((await browser.delete(`/api/connections/${connections[0].id}`)).status, 204);
  assert.equal((await browser.delete(`/api/connections/${connections[0].id}`)).status, 404);
  assert.equal((await callTool(tokens.access_token, "list_items")).status, 401);
  assert.deepEqual((await (await browser.get("/api/connections")).json()).connections, []);
});

test("another person cannot see or cut off someone else's connection", async () => {
  const aki = await signedIn("Aki");
  const { tokens } = await connect(aki);
  const [connection] = (await (await aki.get("/api/connections")).json()).connections;

  const path = (await (await aki.post("/api/invites", { role: "member" })).json()).path.replace("/join/", "");
  const bo = newBrowser();
  const { VirtualAuthenticator } = await import("../auth/virtual-authenticator.ts");
  const device = await VirtualAuthenticator.create();
  const start = await (await bo.post(`/api/invites/${path}/options`, { displayName: "Bo" })).json();
  assert.equal((await bo.post("/api/join/finish", { challengeId: start.challengeId, response: await device.register(start.options, ORIGIN) })).status, 201);

  assert.deepEqual((await (await bo.get("/api/connections")).json()).connections, []);
  assert.equal((await bo.delete(`/api/connections/${connection.id}`)).status, 404);
  assert.equal((await callTool(tokens.access_token, "list_items")).status, 200);
});
