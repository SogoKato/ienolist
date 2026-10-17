import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { createAuthService } from "../auth/service.ts";
import { VirtualAuthenticator } from "../auth/virtual-authenticator.ts";
import { loadConfig, type Config } from "../config.ts";
import { createTestDb } from "../db/testing.ts";
import { createItemService } from "../items/service.ts";
import { sha256 } from "../lib/token.ts";
import { createOAuthService } from "../oauth/service.ts";
import { createApp } from "./app.ts";
import { Browser as Shared, ORIGIN, setUpHousehold, signIn } from "./testing.ts";

// Response.json() is typed unknown; the tests inspect arbitrary payloads.
declare global {
  interface Response {
    json(): Promise<any>;
  }
}

let raw: DatabaseSync;
let config: Config;
let app: ReturnType<typeof createApp>;
let clock: number;

function build(env: Record<string, string> = {}) {
  const t = createTestDb();
  raw = t.raw;
  config = loadConfig({ PUBLIC_URL: ORIGIN, ...env });
  const auth = createAuthService(t.db, { rp: config.rp, setupToken: config.setupToken, now: () => clock });
  app = createApp({ config, auth, items: createItemService(t.db, { now: () => clock }), oauth: createOAuthService(t.db, { origin: config.origin, now: () => clock }) });
}

beforeEach(() => {
  clock = 1_000_000;
  build();
});

// The browser helper, bound to this file's app.
class Browser extends Shared {
  constructor() {
    super((url, init) => app.request(url, init), ORIGIN);
  }
}

const setUp = (browser = new Browser(), name = "Aki") => setUpHousehold(browser, name);

async function invite(admin: Browser, body: object = {}) {
  const res = await admin.post("/api/invites", body);
  assert.equal(res.status, 201);
  return (await res.json()).path.replace("/join/", "") as string;
}

async function join(token: string, name: string) {
  const browser = new Browser();
  const device = await VirtualAuthenticator.create();
  const start = await (await browser.post(`/api/invites/${token}/options`, { displayName: name })).json();
  const res = await browser.post("/api/join/finish", { challengeId: start.challengeId, response: await device.register(start.options, ORIGIN) });
  return { browser, device, res };
}

// --- the whole journey ------------------------------------------------------------------

test("set up, use the lists, sign out and back in", async () => {
  const anon = new Browser();
  assert.deepEqual(await (await anon.get("/api/setup")).json(), { initialized: false, needsSetupToken: false });

  const { browser, device, me } = await setUp();
  assert.deepEqual(me, { user: { id: me.user.id, displayName: "Aki", role: "admin" }, household: { id: me.household.id, name: "Home" } });
  assert.deepEqual(await (await browser.get("/api/me")).json(), me);

  const created = await (await browser.post("/api/items", { list: "fridge", name: "牛乳", note: "特売" })).json();
  assert.deepEqual([created.list, created.status, created.name], ["fridge", "in_stock", "牛乳"]);
  const patched = await (await browser.patch(`/api/items/${created.id}`, { status: "used_up" })).json();
  assert.equal(patched.status, "used_up");
  const moved = await (await browser.post(`/api/items/${created.id}/move`, { to: "shopping" })).json();
  assert.deepEqual([moved.list, moved.status], ["shopping", "to_buy"]);
  assert.deepEqual((await (await browser.get("/api/items?list=shopping")).json()).items.map((i: { name: string }) => i.name), ["牛乳"]);
  assert.equal((await (await browser.get(`/api/items/${created.id}`)).json()).name, "牛乳");
  const events = (await (await browser.get(`/api/events?itemId=${created.id}`)).json()).events;
  assert.deepEqual(events.map((e: { type: string }) => e.type), ["moved", "status_changed", "created"]);
  assert.equal(events[0].source, "web");
  assert.equal((await browser.delete(`/api/items/${created.id}`)).status, 204);
  assert.equal((await browser.get(`/api/items/${created.id}`)).status, 404);

  assert.equal((await browser.post("/api/logout")).status, 204);
  assert.equal((await browser.get("/api/me")).status, 401);
  assert.equal((await signIn(browser, device)).status, 200);
  assert.deepEqual(await (await browser.get("/api/me")).json(), me);
});

// --- the cookie ---------------------------------------------------------------------------

test("the session cookie is host-bound, secure, HttpOnly and lax on https", async () => {
  const browser = new Browser();
  const device = await VirtualAuthenticator.create();
  const start = await (await browser.post("/api/setup/options", { displayName: "A", householdName: "H" })).json();
  const res = await browser.post("/api/setup/finish", { challengeId: start.challengeId, response: await device.register(start.options, ORIGIN) });
  const [cookie] = res.headers.getSetCookie();
  assert.match(cookie, /^__Host-session=[A-Za-z0-9_-]{43};/);
  for (const attribute of [/Path=\/(;|$)/, /HttpOnly/, /Secure/, /SameSite=Lax/, /Max-Age=2592000/]) assert.match(cookie, attribute);
  assert.doesNotMatch(cookie, /Domain=/i);
});

test("on localhost over http the cookie drops the prefix and Secure so it can work", async () => {
  const local = "http://localhost:8787";
  const t = createTestDb();
  const cfg = loadConfig({ PUBLIC_URL: local });
  app = createApp({ config: cfg, auth: createAuthService(t.db, { rp: cfg.rp }), items: createItemService(t.db), oauth: createOAuthService(t.db, { origin: cfg.origin }) });
  const device = await VirtualAuthenticator.create();
  const post = (path: string, body: unknown) =>
    app.request(`${local}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: local }, body: JSON.stringify(body) });
  const start = await (await post("/api/setup/options", { displayName: "A", householdName: "H" })).json();
  const res = await post("/api/setup/finish", { challengeId: start.challengeId, response: await device.register(start.options, local) });
  assert.equal(res.status, 201);
  const [cookie] = res.headers.getSetCookie();
  assert.match(cookie, /^session=/);
  assert.doesNotMatch(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
});

test("sessions stop working after 30 days, and garbage cookies are just signed out", async () => {
  const { browser } = await setUp();
  assert.equal((await browser.get("/api/me")).status, 200);
  clock += 31 * 24 * 60 * 60;
  assert.equal((await browser.get("/api/me")).status, 401);
  browser.cookies.set("__Host-session", "garbage");
  assert.equal((await browser.get("/api/me")).status, 401);
  browser.cookies.clear();
  assert.equal((await browser.get("/api/me")).status, 401);
});

test("logging out removes the cookie and ends the session on the server", async () => {
  const { browser } = await setUp();
  const stolen = new Map(browser.cookies);
  const res = await browser.post("/api/logout");
  assert.match(res.headers.getSetCookie()[0], /Max-Age=0/);
  assert.equal(browser.cookies.size, 0);
  const thief = new Browser();
  thief.cookies = stolen;
  assert.equal((await thief.get("/api/me")).status, 401);
});

// --- cross-site requests ----------------------------------------------------------------------

test("writes must come from the app's own origin", async () => {
  const { browser } = await setUp();
  const attempts: [string | null, number][] = [[ORIGIN, 201], ["https://evil.example.com", 403], ["null", 403], [null, 403], ["http://lists.example.com", 403], [`${ORIGIN}.evil.com`, 403]];
  for (const [origin, expected] of attempts) {
    browser.origin = origin;
    const res = await browser.post("/api/items", { list: "fridge", name: "egg" });
    assert.equal(res.status, expected, String(origin));
  }
  assert.equal((await new Browser().get("/api/setup")).status, 200);
  browser.origin = "https://evil.example.com";
  assert.equal((await browser.patch("/api/items/x", { name: "y" })).status, 403);
  assert.equal((await browser.delete("/api/items/x")).status, 403);
  assert.equal((await browser.post("/api/logout")).status, 403);
  assert.equal((await browser.get("/api/me")).status, 200);
  browser.origin = ORIGIN;
  assert.equal((await browser.get("/api/items")).status, 200);
  assert.equal((await browser.get("/api/items")).headers.get("cache-control"), "no-store");
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM items").get()!.n, 1);
});

test("bodies must be JSON objects of the right shape", async () => {
  const { browser } = await setUp();
  const form = await browser.fetch("POST", "/api/items", "list=fridge&name=egg", { "content-type": "application/x-www-form-urlencoded" });
  assert.equal(form.status, 415);
  const plain = await browser.fetch("POST", "/api/items", '{"list":"fridge","name":"egg"}', { "content-type": "text/plain" });
  assert.equal(plain.status, 415);
  assert.equal((await browser.post("/api/items", "{broken")).status, 400);
  const missing = await browser.post("/api/items", { list: "fridge" });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /^Invalid request: name/);
  assert.equal((await browser.post("/api/items", [])).status, 400);
  assert.equal((await browser.post("/api/items", { list: "fridge", name: 5 })).status, 400);
  assert.equal((await browser.post("/api/items", { list: "pantry", name: "x" })).status, 400);
});

test("every response carries the framing and sniffing protections", async () => {
  const res = await new Browser().get("/api/setup");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
  const missing = await new Browser().get("/api/nothing-here");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Not found" });
  assert.equal(missing.headers.get("x-frame-options"), "DENY");
});

// --- setup over HTTP ----------------------------------------------------------------------------

test("a second setup is refused with 409", async () => {
  await setUp();
  const res = await new Browser().post("/api/setup/options", { displayName: "Mallory", householdName: "Mine" });
  assert.equal(res.status, 409);
});

test("with a setup token configured the first call must carry it", async () => {
  build({ SETUP_TOKEN: "let-me-in" });
  const browser = new Browser();
  assert.deepEqual(await (await browser.get("/api/setup")).json(), { initialized: false, needsSetupToken: true });
  assert.equal((await browser.post("/api/setup/options", { displayName: "A", householdName: "H" })).status, 403);
  assert.equal((await browser.post("/api/setup/options", { displayName: "A", householdName: "H", setupToken: "nope" })).status, 403);
  assert.equal((await browser.post("/api/setup/options", { displayName: "A", householdName: "H", setupToken: "let-me-in" })).status, 200);
});

test("a wrong passkey answer is a 400 and sets no cookie", async () => {
  const browser = new Browser();
  const device = await VirtualAuthenticator.create();
  const start = await (await browser.post("/api/setup/options", { displayName: "A", householdName: "H" })).json();
  const res = await browser.post("/api/setup/finish", { challengeId: start.challengeId, response: await device.register(start.options, "https://evil.example.com") });
  assert.equal(res.status, 400);
  assert.equal(res.headers.getSetCookie().length, 0);
  assert.equal((await browser.post("/api/setup/finish", { challengeId: "x", response: {} })).status, 400);
  assert.equal((await browser.post("/api/setup/finish", { challengeId: "x" })).status, 400);
});

test("a failed sign-in is 401 and sets no cookie", async () => {
  await setUp();
  const stranger = await VirtualAuthenticator.create();
  const res = await signIn(new Browser(), stranger);
  assert.equal(res.status, 401);
  assert.equal(res.headers.getSetCookie().length, 0);
});

// --- invites over HTTP ----------------------------------------------------------------------------

test("an admin invites a member, who joins and shares the household's lists", async () => {
  const { browser: admin } = await setUp();
  await admin.post("/api/items", { list: "fridge", name: "egg" });
  const token = await invite(admin);
  const page = await new Browser().get(`/api/invites/${token}`);
  assert.deepEqual(await page.json(), { householdName: "Home", recovery: false, displayName: null });

  const { browser: ben, res } = await join(token, "Ben");
  assert.equal(res.status, 201);
  assert.equal((await res.json()).user.role, "member");
  assert.deepEqual((await (await ben.get("/api/items")).json()).items.map((i: { name: string }) => i.name), ["egg"]);
  assert.equal((await new Browser().get(`/api/invites/${token}`)).status, 404);
  assert.equal((await ben.post("/api/invites")).status, 403);
});

test("everyone in the household can see who is in it, and nobody else can", async () => {
  const { browser: admin, me } = await setUp();
  const { browser: ben, res } = await join(await invite(admin), "Ben");
  const benId = (await res.json()).user.id;
  const expected = [
    { id: me.user.id, displayName: "Aki", role: "admin" },
    { id: benId, displayName: "Ben", role: "member" },
  ];
  assert.deepEqual((await (await admin.get("/api/members")).json()).members, expected);
  assert.deepEqual((await (await ben.get("/api/members")).json()).members, expected);
  assert.equal((await new Browser().get("/api/members")).status, 401);
});

test("members cannot reach the admin-only calls", async () => {
  const { browser: admin, me } = await setUp();
  const { browser: ben } = await join(await invite(admin), "Ben");
  assert.equal((await ben.post("/api/invites", { forUserId: me.user.id })).status, 403);
  assert.equal((await new Browser().post("/api/invites")).status, 401);
  assert.equal((await admin.post("/api/invites", { role: "owner" })).status, 400);
});

test("a recovery link signs the member back in with a new passkey and cuts off the old ones", async () => {
  const { browser: admin } = await setUp();
  const { browser: ben, device: oldPhone, res } = await join(await invite(admin), "Ben");
  const benId = (await res.json()).user.id;
  const token = await invite(admin, { forUserId: benId });
  assert.deepEqual(await (await new Browser().get(`/api/invites/${token}`)).json(), { householdName: "Home", recovery: true, displayName: "Ben" });
  const { browser: again, res: recovered } = await join(token, "ignored");
  assert.equal((await recovered.json()).user.id, benId);
  assert.equal((await ben.get("/api/me")).status, 401);
  assert.equal((await again.get("/api/me")).status, 200);
  assert.equal((await signIn(new Browser(), oldPhone)).status, 401);
});

// --- passkeys ---------------------------------------------------------------------------------------

test("a person manages their own passkeys", async () => {
  const { browser, device: phone } = await setUp();
  const listed = (await (await browser.get("/api/passkeys")).json()).passkeys;
  assert.deepEqual(listed.map((p: { deviceName: string }) => p.deviceName), ["Phone"]);

  const laptop = await VirtualAuthenticator.create();
  const start = await (await browser.post("/api/passkeys/options")).json();
  clock += 60;
  const added = await browser.post("/api/passkeys/finish", { challengeId: start.challengeId, response: await laptop.register(start.options, ORIGIN), deviceName: "Laptop" });
  assert.equal(added.status, 201);
  assert.equal((await added.json()).passkeys.length, 2);

  assert.equal((await browser.delete(`/api/passkeys/${phone.credentialId}`)).status, 204);
  assert.equal((await browser.delete(`/api/passkeys/${laptop.credentialId}`)).status, 409);
  assert.equal((await browser.delete("/api/passkeys/unknown")).status, 404);
  assert.equal((await signIn(new Browser(), phone)).status, 401);
  assert.equal((await signIn(new Browser(), laptop)).status, 200);
});

// --- the lists are private to a household ---------------------------------------------------------------

test("signed-out visitors cannot touch the lists", async () => {
  const { browser } = await setUp();
  const item = await (await browser.post("/api/items", { list: "fridge", name: "egg" })).json();
  const anon = new Browser();
  for (const [method, path, body] of [
    ["GET", "/api/items"], ["POST", "/api/items", { list: "fridge", name: "x" }], ["GET", `/api/items/${item.id}`],
    ["PATCH", `/api/items/${item.id}`, { name: "x" }], ["DELETE", `/api/items/${item.id}`], ["POST", `/api/items/${item.id}/move`, { to: "shopping" }],
    ["GET", "/api/events"], ["GET", "/api/passkeys"], ["GET", "/api/me"],
  ] as const) {
    const res = await anon.fetch(method, path, body);
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: "Sign in first" });
  }
});

test("a household's lists are invisible to another household", async () => {
  const { browser: aki } = await setUp();
  const item = await (await aki.post("/api/items", { list: "fridge", name: "egg" })).json();
  // A second household, created directly: the app has a single household per install for now.
  raw.exec("INSERT INTO households (id, name, created_at) VALUES ('h2', 'Other', 0)");
  raw.exec("INSERT INTO users (id, display_name, created_at) VALUES ('u2', 'Eve', 0)");
  raw.exec("INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ('h2', 'u2', 'admin', 0)");
  const eve = new Browser();
  eve.cookies.set("__Host-session", "eves-session");
  raw.exec(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('${await sha256("eves-session")}', 'u2', 0, ${clock + 1000})`);
  assert.equal((await eve.get("/api/me")).status, 200);
  assert.deepEqual((await (await eve.get("/api/items")).json()).items, []);
  assert.equal((await eve.get(`/api/items/${item.id}`)).status, 404);
  assert.equal((await eve.patch(`/api/items/${item.id}`, { name: "mine" })).status, 404);
  assert.equal((await eve.delete(`/api/items/${item.id}`)).status, 404);
  assert.deepEqual((await (await eve.get("/api/events")).json()).events, []);
  assert.equal((await (await aki.get(`/api/items/${item.id}`)).json()).name, "egg");
});

// --- errors ---------------------------------------------------------------------------------------------

test("unexpected failures are a plain 500 that reveals nothing", async () => {
  const { browser } = await setUp();
  raw.exec("DROP TABLE items");
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    const res = await browser.get("/api/items");
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal error" });
    assert.equal(logged.length, 1);
  } finally {
    console.error = original;
  }
});
