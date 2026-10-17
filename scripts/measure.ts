// Drives the heavier requests many times, slowly, against a fresh instance (no household yet),
// so that `wrangler tail --format json` can record each one's CPU time.
//
//   wrangler tail <worker> --format json > tail.jsonl &
//   BASE_URL=https://<worker>.workers.dev ROUNDS=20 node scripts/measure.ts
//   node scripts/measure.ts summarize tail.jsonl
import { readFileSync } from "node:fs";
import { Browser, setUpHousehold, signIn } from "../src/http/testing.ts";
import { randomToken, sha256 } from "../src/lib/token.ts";

if (process.argv[2] === "summarize") {
  const text = readFileSync(process.argv[3], "utf8");
  const events: any[] = [];
  for (let depth = 0, start = 0, i = 0; i < text.length; i++) {
    if (text[i] === "{" && depth++ === 0) start = i;
    else if (text[i] === "}" && --depth === 0) events.push(JSON.parse(text.slice(start, i + 1)));
  }
  const groups = new Map<string, number[]>();
  const bad: string[] = [];
  for (const e of events) {
    const url = new URL(e.event?.request?.url ?? "http://x/?");
    const key = `${e.event?.request?.method} ${url.pathname.replace(/\/[0-9A-Z]{26}$/, "/:id")}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e.cpuTime);
    if (e.outcome !== "ok") bad.push(`${key}: ${e.outcome}`);
  }
  const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  console.log(`${events.length} requests`);
  console.log("n".padStart(4), "p50".padStart(4), "p90".padStart(4), "max".padStart(4), ">10", " request");
  for (const [key, values] of [...groups].sort()) {
    const sorted = values.sort((a, b) => a - b);
    const over = sorted.filter((v) => v > 10).length;
    console.log(String(sorted.length).padStart(4), String(pct(sorted, 0.5)).padStart(4), String(pct(sorted, 0.9)).padStart(4), String(sorted.at(-1)).padStart(4), String(over).padStart(3), ` ${key}`);
  }
  console.log(bad.length ? `\nNot ok:\n${bad.join("\n")}` : "\nEvery request finished with outcome ok.");
  process.exit(0);
}

const base = process.env.BASE_URL;
if (!base) throw new Error("Set BASE_URL");
const rounds = Number(process.env.ROUNDS ?? 20);
const pause = () => new Promise((r) => setTimeout(r, Number(process.env.PAUSE_MS ?? 400)));
const handle = (url: string, init: RequestInit) => fetch(url, { ...init, redirect: "manual" });
const redirect = "https://claude.ai/api/mcp/auth_callback";

const person = new Browser(handle, base);
const { device } = await setUpHousehold(person);
const V = "2026-07-28";
const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientInfo": { name: "m", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} } };
const form = (path: string, fields: Record<string, string>) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://claude.ai" }, body: new URLSearchParams(fields).toString() });

for (let round = 1; round <= rounds; round++) {
  await pause();
  await person.post("/api/logout");
  await pause();
  const start = await (await person.post("/api/login/options")).json();
  await pause();
  const login = await person.post("/api/login/finish", { challengeId: start.challengeId, response: await device.authenticate(start.options, base) });
  if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
  await pause();
  const reg = await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Measure", redirect_uris: [redirect] }) })).json();
  const verifier = randomToken(32);
  const params = { response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: await sha256(verifier), code_challenge_method: "S256", state: "m", resource: `${base}/mcp` };
  await pause();
  const decision = await person.post("/api/oauth/authorize", { params, decision: "allow" });
  const code = new URL((await decision.json()).redirectTo).searchParams.get("code")!;
  await pause();
  const tokens = await (await form("/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect })).json();
  await pause();
  const call = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}`, "mcp-protocol-version": V, "mcp-method": "tools/call", "mcp-name": "create_item" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_item", arguments: { list: "shopping", name: `item ${round}` }, ...meta } }),
  });
  if (call.status !== 200) throw new Error(`mcp failed: ${call.status}`);
  await pause();
  await form("/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id });
  await pause();
  await person.get("/api/items");
  process.stdout.write(`${round} `);
}
console.log("\ndone");
