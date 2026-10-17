// A rough look at where a request's CPU goes, on Node with an in-memory SQLite:
// each request is timed the first time (a Worker isolate runs mostly cold code) and again warm.
//   node scripts/profile.ts            (add --jitless to approximate code that has not been optimised)
import { VirtualAuthenticator } from "../src/auth/virtual-authenticator.ts";
import { createTestDb } from "../src/db/testing.ts";
import { buildApp } from "../src/main.ts";
import { Browser, setUpHousehold } from "../src/http/testing.ts";
import { randomToken, sha256 } from "../src/lib/token.ts";

const ORIGIN = "https://lists.example.com";
const { db, raw } = createTestDb();
let statements = 0;
const originalPrepare = raw.prepare.bind(raw);
raw.prepare = ((sql: string) => (statements++, process.env.SQL && console.log("   sql:", sql.replace(/\s+/g, " ").slice(0, 150)), originalPrepare(sql))) as typeof raw.prepare;
const app = buildApp(db, { PUBLIC_URL: ORIGIN });
const person = new Browser((url, init) => app.request(url, init));
await setUpHousehold(person);
void VirtualAuthenticator;

// An assistant's token, made the way the app makes it.
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

const V = "2026-07-28";
const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientInfo": { name: "p", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} } };
const mcp = (name: string, args: object) =>
  app.request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}`, "mcp-protocol-version": V, "mcp-method": "tools/call", "mcp-name": name },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, ...meta } }),
  });

const cases: [string, () => Response | Promise<Response>][] = [
  ["GET /api/items", () => person.get("/api/items")],
  ["POST /mcp list_items", () => mcp("list_items", {})],
  ["POST /mcp create_item", () => mcp("create_item", { list: "shopping", name: "x" })],
  ["GET /api/items (again)", () => person.get("/api/items")],
];
for (const [name, run] of cases) {
  for (const label of ["first", "warm "]) {
    statements = 0;
    const cpu = process.cpuUsage();
    const started = performance.now();
    const res = await run();
    await res.arrayBuffer();
    const used = process.cpuUsage(cpu);
    console.log(`${label} ${((used.user + used.system) / 1000).toFixed(2).padStart(7)} ms cpu  ${(performance.now() - started).toFixed(2).padStart(7)} ms wall  ${String(statements).padStart(2)} statements  ${name}`);
  }
}
