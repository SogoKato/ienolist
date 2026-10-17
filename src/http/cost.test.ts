import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { buildApp } from "../main.ts";
import { randomToken, sha256 } from "../lib/token.ts";
import { Browser, ORIGIN, setUpHousehold } from "./testing.ts";

// On Cloudflare's free plan a request gets about 10 ms of CPU, and every database round trip
// spends some of it. These tests pin how many statements the common requests make, so a change
// that quietly doubles them (as a middleware once ran twice) shows up here.

let statements: string[];
let app: ReturnType<typeof buildApp>;
let person: Browser;
let accessToken: string;

beforeEach(async () => {
  const t = createTestDb();
  statements = t.statements;
  app = buildApp(t.db, { PUBLIC_URL: ORIGIN });
  person = new Browser((url, init) => app.request(url, init));
  await setUpHousehold(person);

  const redirect = "https://claude.ai/cb";
  const reg = await (await app.request(`${ORIGIN}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect] }) })).json();
  const verifier = randomToken(32);
  const params = { response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: await sha256(verifier), code_challenge_method: "S256" };
  const code = new URL((await (await person.post("/api/oauth/authorize", { params, decision: "allow" })).json()).redirectTo).searchParams.get("code")!;
  const tokens = await (
    await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect }).toString(),
    })
  ).json();
  accessToken = tokens.access_token;
});

// Runs a request and says how many statements it made.
async function cost(run: () => Response | Promise<Response>): Promise<number> {
  statements.length = 0;
  const res = await run();
  await res.arrayBuffer();
  assert.ok(res.status < 400, `unexpected status ${res.status}`);
  return statements.length;
}

const V = "2026-07-28";
const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} } };
const mcp = (name: string, args: object = {}) =>
  app.request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}`, "mcp-protocol-version": V, "mcp-method": "tools/call", "mcp-name": name },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, ...meta } }),
  });

test("a signed-in page load is one lookup for who you are and one for the data", async () => {
  assert.equal(await cost(() => person.get("/api/me")), 1);
  assert.equal(await cost(() => person.get("/api/items")), 2);
  assert.equal(await cost(() => person.get("/api/members")), 2);
  assert.equal(await cost(() => person.get("/api/connections")), 2);
  assert.equal(await cost(() => person.get("/api/passkeys")), 2);
  assert.equal(await cost(() => person.get("/api/events")), 2);
});

test("changing an item is the lookup plus one write batch", async () => {
  const created = await (await person.post("/api/items", { list: "shopping", name: "牛乳" })).json();
  assert.ok(await cost(() => person.post("/api/items", { list: "shopping", name: "卵" })) <= 4);
  assert.ok(await cost(() => person.patch(`/api/items/${created.id}`, { status: "bought" })) <= 5);
  assert.ok(await cost(() => person.post(`/api/items/${created.id}/move`, { to: "fridge" })) <= 5);
});

test("an assistant's call is one lookup for the token plus the work", async () => {
  assert.equal(await cost(() => mcp("list_items")), 2);
  assert.equal(await cost(() => mcp("create_item", { list: "shopping", name: "x" })), 3);
});

test("the consent decision does not sweep the database one table at a time", async () => {
  const reg = await (await app.request(`${ORIGIN}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://claude.ai/cb"] }) })).json();
  const params = { response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/cb", code_challenge: await sha256("v"), code_challenge_method: "S256" };
  // who you are (1), the client (1), then the cleanup and the code together.
  assert.ok(await cost(() => person.post("/api/oauth/authorize", { params, decision: "allow" })) <= 6);
});
