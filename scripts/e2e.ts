// End-to-end check of a running instance over real HTTP: the first person sets the app up with a
// (software) passkey, an MCP client registers, gets approval, and uses the lists, refreshes and is cut off.
//
//   pnpm e2e                                   starts the Node entry point on a temporary database
//   BASE_URL=http://localhost:8787 pnpm e2e    checks an instance that is already running (e.g. wrangler dev);
//                                              its PUBLIC_URL must be that same URL, and it must have no household yet
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, setUpHousehold, signIn } from "../src/http/testing.ts";
import { randomToken, sha256 } from "../src/lib/token.ts";

let base = process.env.BASE_URL;
let server: ReturnType<typeof spawn> | undefined;
let dir: string | undefined;

if (!base) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://localhost:${port}`;
  dir = mkdtempSync(join(tmpdir(), "household-e2e-"));
  server = spawn("node", ["src/node.ts"], {
    env: { ...process.env, PUBLIC_URL: base, PORT: String(port), DATABASE_PATH: join(dir, "app.db") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("exit", (code) => reject(new Error(`server exited with ${code}`)));
    server!.stdout!.on("data", (chunk) => String(chunk).includes("Listening") && resolve());
  });
}

const handle = (url: string, init: RequestInit) => fetch(url, { ...init, redirect: "manual" });
const steps: string[] = [];
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await run();
  steps.push(`${(performance.now() - started).toFixed(0).padStart(5)} ms  ${name}`);
  return result;
}

try {
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  const person = new Browser(handle, base);
  const { me, device } = await step("set up with a passkey", () => setUpHousehold(person));
  assert.equal(me.user.role, "admin");

  // An MCP client, with no cookies, from another origin.
  const client = async (method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) =>
    fetch(`${base}${path}`, { method, redirect: "manual", headers: { origin: "https://claude.ai", ...init.headers }, body: init.body });

  const unauthorized = await step("MCP without a token", () => client("POST", "/mcp", { headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(unauthorized.status, 401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(unauthorized.headers.get("www-authenticate") ?? "")?.[1];
  assert.equal(metadataUrl, `${base}/.well-known/oauth-protected-resource/mcp`);
  const resource = await (await client("GET", new URL(metadataUrl!).pathname)).json();
  const server_ = await (await client("GET", "/.well-known/oauth-authorization-server")).json();
  assert.equal(resource.authorization_servers[0], server_.issuer);

  const registered = await step("register a client", async () => {
    const res = await client("POST", "/oauth/register", { headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "E2E client", redirect_uris: [redirect] }) });
    assert.equal(res.status, 201);
    return res.json();
  });

  const verifier = randomToken(32);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: redirect,
    code_challenge: await sha256(verifier),
    code_challenge_method: "S256",
    state: "e2e",
    resource: `${base}/mcp`,
  });
  const code = await step("authorize and approve", async () => {
    const start = await client("GET", `/oauth/authorize?${query}`);
    assert.equal(start.status, 302);
    assert.equal(start.headers.get("location"), `/authorize?${query}`);
    const info = await (await person.get(`/api/oauth/authorization?${query}`)).json();
    assert.deepEqual([info.clientName, info.redirectHost], ["E2E client", "claude.ai"]);
    const decision = await person.post("/api/oauth/authorize", { params: Object.fromEntries(query), decision: "allow" });
    return new URL((await decision.json()).redirectTo).searchParams.get("code")!;
  });

  const tokens = await step("trade the code for tokens", async () => {
    const res = await client("POST", "/oauth/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: registered.client_id, redirect_uri: redirect }).toString(),
    });
    assert.equal(res.status, 200);
    return res.json();
  });

  const V = "2026-07-28";
  const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} } };
  const rpc = (token: string, method: string, params: object = {}, name?: string) =>
    client("POST", "/mcp", {
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "mcp-protocol-version": V, "mcp-method": method, ...(name ? { "mcp-name": name } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, ...meta } }),
    });
  const call = async (token: string, name: string, args: object = {}) => {
    const res = await rpc(token, "tools/call", { name, arguments: args }, name);
    assert.equal(res.status, 200);
    const result = (await res.json()).result;
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };

  const names = await step("tools/list", async () => ((await (await rpc(tokens.access_token, "tools/list")).json()).result.tools as { name: string }[]).map((t) => t.name));
  assert.ok(names.includes("create_item") && names.includes("list_items"));

  const created = await step("create_item over MCP", () => call(tokens.access_token, "create_item", { list: "shopping", name: "卵", note: "10個入り" }));
  const seen = await step("the web API sees it", async () => (await (await person.get("/api/items")).json()).items);
  assert.deepEqual(seen.map((i: { id: string }) => i.id), [created.id]);
  await step("update_item and list_items over MCP", async () => {
    await call(tokens.access_token, "update_item", { id: created.id, status: "bought" });
    assert.equal((await call(tokens.access_token, "list_items", { list: "shopping" })).items[0].status, "bought");
  });
  const events = (await (await person.get(`/api/events?itemId=${created.id}`)).json()).events;
  assert.deepEqual(events.map((e: { source: string }) => e.source), ["mcp", "mcp"]);

  const refreshed = await step("refresh the token", async () => {
    const res = await client("POST", "/oauth/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: registered.client_id }).toString(),
    });
    assert.equal(res.status, 200);
    return res.json();
  });
  assert.equal((await rpc(tokens.access_token, "tools/list")).status, 401);

  await step("sign out and back in with the passkey", async () => {
    assert.equal((await person.post("/api/logout")).status, 204);
    assert.equal((await person.get("/api/me")).status, 401);
    assert.equal((await signIn(person, device)).status, 200);
  });

  const [connection] = (await (await person.get("/api/connections")).json()).connections;
  assert.equal(connection.clientName, "E2E client");
  await step("disconnect the client", async () => assert.equal((await person.delete(`/api/connections/${connection.id}`)).status, 204));
  assert.equal((await rpc(refreshed.access_token, "tools/list")).status, 401);

  console.log(steps.join("\n"));
  console.log("\nAll end-to-end checks passed.");
} finally {
  server?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
}
