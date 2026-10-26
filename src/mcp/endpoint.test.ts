import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { createItemService, type Actor, type ItemService } from "../items/service.ts";
import { createRecipeService } from "../recipes/service.ts";
import { handleMcpRequest, type McpDeps } from "./endpoint.ts";

// Response.json() is typed unknown; the tests inspect arbitrary JSON-RPC payloads.
declare global {
  interface Response {
    json(): Promise<any>;
  }
}

const claude: Actor = { householdId: "h1", userId: "u1", source: "mcp", clientId: "c1" };
const ALL = ["items:read", "items:write", "recipes:read", "recipes:write"];
let raw: DatabaseSync;
let items: ItemService;
let deps: McpDeps;
let principal: { actor: Actor; scopes: string[] } | null;

beforeEach(() => {
  const t = createTestDb();
  raw = t.raw;
  raw.exec("INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', 0), ('h2', 'Other', 0)");
  raw.exec("INSERT INTO users (id, display_name, created_at) VALUES ('u1', 'A', 0), ('u2', 'B', 0)");
  items = createItemService(t.db);
  principal = { actor: claude, scopes: ALL };
  deps = { authenticate: async () => principal, resourceMetadataUrl: () => "https://app.test/.well-known/oauth-protected-resource/mcp", items, recipes: createRecipeService(t.db) };
});

const V = "2026-07-28";
const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} } };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  handleMcpRequest(new Request("https://app.test/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), deps);
const rpc = (id: number, method: string, params: object = {}) => ({ jsonrpc: "2.0", id, method, params });

// Modern era: _meta in the body, mirrored in headers.
const modern = (method: string, params: object = {}, name?: string) =>
  post(rpc(1, method, { ...params, ...meta }), { "mcp-protocol-version": V, "mcp-method": method, ...(name ? { "mcp-name": name } : {}) });
const modernCall = async (name: string, args: object = {}) => {
  const res = await (await modern("tools/call", { name, arguments: args }, name)).json();
  return res.result as { content: { text: string }[]; isError?: boolean; resultType?: string };
};
const legacyCall = async (name: string, args: object = {}) => ((await (await post(rpc(2, "tools/call", { name, arguments: args }))).json()).result);
const data = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

test("requests without a valid principal get 401 pointing at the resource metadata", async () => {
  principal = null;
  const res = await post(rpc(1, "tools/list"));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), 'Bearer resource_metadata="https://app.test/.well-known/oauth-protected-resource/mcp"');
});

test("GET is not allowed on the stateless endpoint", async () => {
  const res = await handleMcpRequest(new Request("https://app.test/mcp"), deps);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("modern: server/discover and tools/list", async () => {
  const discover = (await (await modern("server/discover")).json()).result;
  assert.equal(discover.resultType, "complete");
  assert.deepEqual(discover.supportedVersions.slice(0, 2), ["2026-07-28", "2025-11-25"]);
  const list = (await (await modern("tools/list")).json()).result;
  assert.equal(list.resultType, "complete");
  assert.equal(list.cacheScope, "private");
  assert.deepEqual(list.tools.map((t: { name: string }) => t.name), [
    "list_items", "get_item", "create_item", "update_item", "delete_item", "move_item", "list_events",
    "list_recipes", "get_recipe", "create_recipe", "update_recipe", "delete_recipe", "record_cook", "list_cooks", "delete_cook",
    "list_tags", "rename_tag", "list_books", "rename_book", "delete_book",
  ]);
  const byName = Object.fromEntries(list.tools.map((t: { name: string }) => [t.name, t]));
  assert.deepEqual(byName.list_items.annotations, { readOnlyHint: true });
  assert.deepEqual(byName.delete_item.annotations, { destructiveHint: true });
  assert.deepEqual(byName.create_item.annotations, { destructiveHint: false });
  assert.deepEqual(byName.create_item.inputSchema.required, ["list", "name"]);
  assert.deepEqual(byName.create_item.inputSchema.properties.list.enum, ["shopping", "fridge"]);
  assert.match(byName.create_item.inputSchema.properties.name.description, /product name/);
  assert.match(byName.list_items.description, /never moves an item/);
  assert.deepEqual(byName.update_item.inputSchema.properties.note.anyOf.map((s: { type: string }) => s.type), ["string", "null"]);
  assert.match(byName.update_item.inputSchema.properties.note.description, /clears it/);
});

test("legacy: initialize, notifications and tools/list without resultType", async () => {
  const init = (await (await post(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }))).json()).result;
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.equal(init.serverInfo.name, "household-lists");
  const unknown = (await (await post(rpc(1, "initialize", { protocolVersion: "1999-01-01" }))).json()).result;
  assert.equal(unknown.protocolVersion, "2025-11-25");
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = (await (await post(rpc(2, "tools/list"))).json()).result;
  assert.equal(list.resultType, undefined);
  assert.equal(list.tools.length, 20);
});

test("modern protocol errors", async () => {
  const mismatch = async (headers: Record<string, string>, body = rpc(1, "tools/list", meta)) => {
    const res = await post(body, headers);
    return [res.status, (await res.json()).error?.code];
  };
  assert.deepEqual(await mismatch({ "mcp-method": "tools/list" }), [400, -32020]);
  assert.deepEqual(await mismatch({ "mcp-protocol-version": V, "mcp-method": "tools/call" }), [400, -32020]);
  assert.deepEqual(
    await mismatch({ "mcp-protocol-version": V, "mcp-method": "tools/call", "mcp-name": "get_item" }, rpc(1, "tools/call", { name: "list_items", ...meta })),
    [400, -32020],
  );
  const old = { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } };
  assert.deepEqual(await mismatch({ "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/list" }, rpc(1, "tools/list", old)), [400, -32022]);
  assert.deepEqual(await mismatch({ "mcp-protocol-version": V, "mcp-method": "initialize" }, rpc(1, "initialize", meta)), [404, -32601]);
  assert.deepEqual(await mismatch({ "mcp-protocol-version": V, "mcp-method": "resources/list" }, rpc(1, "resources/list", meta)), [404, -32601]);
  assert.equal((await post("[]")).status, 400);
  assert.equal((await handleMcpRequest(new Request("https://app.test/mcp", { method: "POST", body: "{" }), deps)).status, 400);
});

test("tools work end to end in the modern protocol", async () => {
  const created = data(await modernCall("create_item", { list: "fridge", name: "egg", note: "for the omelette" }));
  assert.deepEqual({ list: created.list, status: created.status, name: created.name, note: created.note }, { list: "fridge", status: "in_stock", name: "egg", note: "for the omelette" });
  assert.match(created.createdAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal("householdId" in created, false);

  const used = data(await modernCall("update_item", { id: created.id, status: "used_up", note: null }));
  assert.deepEqual({ status: used.status, note: used.note }, { status: "used_up", note: null });
  assert.equal(data(await modernCall("get_item", { id: created.id })).status, "used_up");

  const moved = data(await modernCall("move_item", { id: created.id, to: "shopping" }));
  assert.deepEqual({ list: moved.list, status: moved.status }, { list: "shopping", status: "to_buy" });
  assert.deepEqual(data(await modernCall("list_items", { list: "shopping" })).items.map((i: { id: string }) => i.id), [created.id]);
  assert.deepEqual(data(await modernCall("list_items", { list: "fridge" })).items, []);

  const events = data(await modernCall("list_events", { itemId: created.id })).events;
  assert.deepEqual(events.map((e: { type: string }) => e.type), ["moved", "note_changed", "status_changed", "created"]);
  assert.equal(events[0].source, "mcp");
  assert.deepEqual(events[0].data.to, { list: "shopping", status: "to_buy" });
  assert.equal(data(await modernCall("list_events", { since: "2999-01-01T00:00:00Z" })).events.length, 0);

  assert.deepEqual(data(await modernCall("delete_item", { id: created.id })), { deleted: created.id });
  assert.equal(data(await modernCall("list_events", { limit: 1 })).events[0].type, "deleted");
});

test("tools also work in the legacy protocol", async () => {
  const created = data(await legacyCall("create_item", { list: "shopping", name: "milk" }));
  assert.equal(created.status, "to_buy");
  assert.equal(data(await legacyCall("list_items")).items.length, 1);
});

test("tool errors are reported as tool results the model can act on", async () => {
  const err = async (name: string, args: object) => {
    const r = await modernCall(name, args);
    assert.equal(r.isError, true, `${name} should fail`);
    return r.content[0].text;
  };
  assert.match(await err("create_item", { list: "pantry", name: "x" }), /^Invalid arguments: list/);
  assert.match(await err("create_item", { list: "fridge" }), /^Invalid arguments: name/);
  assert.match(await err("create_item", { list: "fridge", name: "x", status: "bought" }), /status for the fridge list must be one of: in_stock, used_up/);
  assert.match(await err("update_item", { id: "nope", name: "x" }), /^Item not found$/);
  assert.match(await err("update_item", { id: "nope" }), /Nothing to update/);
  assert.match(await err("list_events", { since: "yesterday" }), /^Invalid arguments: since/);
  assert.match(await err("list_events", { limit: 0 }), /^Invalid arguments: limit/);
  const item = data(await modernCall("create_item", { list: "fridge", name: "egg" }));
  assert.match(await err("move_item", { id: item.id, to: "fridge" }), /already on the fridge list/);
});

test("unknown tools are protocol errors; unexpected failures stay generic", async () => {
  const res = await (await modern("tools/call", { name: "drop_tables", arguments: {} }, "drop_tables")).json();
  assert.equal(res.error.code, -32602);
  // A real database failure: the table is gone, so SQLite's own error is thrown, not an ItemError.
  raw.exec("DROP TABLE items");
  const logged: unknown[][] = [];
  const quiet = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    const r = await modernCall("list_items");
    assert.deepEqual(r.content, [{ type: "text", text: "Internal error" }]);
    assert.equal(r.isError, true);
    assert.doesNotMatch(JSON.stringify(r), /no such table/);
    assert.equal(logged.length, 1);
  } finally {
    console.error = quiet;
  }
});

test("scopes: read-only principals cannot call write tools", async () => {
  const created = data(await modernCall("create_item", { list: "fridge", name: "egg" }));
  principal = { actor: claude, scopes: ["items:read"] };
  assert.equal(data(await modernCall("list_items")).items.length, 1);
  assert.equal(data(await modernCall("list_events")).events.length, 1);
  for (const [name, args] of [["create_item", { list: "fridge", name: "x" }], ["update_item", { id: created.id, name: "x" }], ["move_item", { id: created.id, to: "shopping" }], ["delete_item", { id: created.id }]] as const) {
    const r = await modernCall(name, args);
    assert.deepEqual([r.isError, r.content[0].text], [true, "Missing scope: items:write"], name);
  }
  assert.equal(data(await modernCall("get_item", { id: created.id })).name, "egg");
  principal = { actor: claude, scopes: [] };
  assert.equal((await modernCall("list_items")).isError, true);
});

test("a household's tokens only reach its own items", async () => {
  const mine = data(await modernCall("create_item", { list: "fridge", name: "egg" }));
  principal = { actor: { householdId: "h2", userId: "u2", source: "mcp", clientId: "c2" }, scopes: ALL };
  assert.deepEqual(data(await modernCall("list_items")).items, []);
  assert.equal((await modernCall("get_item", { id: mine.id })).content[0].text, "Item not found");
  assert.equal((await modernCall("delete_item", { id: mine.id })).isError, true);
  assert.deepEqual(data(await modernCall("list_events")).events, []);
});

test("only POST reaches the tools", async () => {
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const res = await handleMcpRequest(new Request("https://app.test/mcp", { method }), deps);
    assert.equal(res.status, 405, method);
  }
});

test("authentication is checked before the body is read", async () => {
  principal = null;
  const res = await handleMcpRequest(new Request("https://app.test/mcp", { method: "POST", body: "{" }), deps);
  assert.equal(res.status, 401);
});

test("input limits are enforced on the way in", async () => {
  const err = async (name: string, args: object) => {
    const r = await modernCall(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args).slice(0, 60)}`);
    return r.content[0].text;
  };
  assert.match(await err("create_item", { list: "fridge", name: "" }), /^Invalid arguments: name/);
  assert.match(await err("create_item", { list: "fridge", name: "x".repeat(501) }), /^Invalid arguments: name/);
  assert.match(await err("create_item", { list: "fridge", name: "x", note: "n".repeat(2001) }), /^Invalid arguments: note/);
  assert.match(await err("get_item", { id: "x".repeat(65) }), /^Invalid arguments: id/);
  assert.match(await err("get_item", { id: "" }), /^Invalid arguments: id/);
  assert.match(await err("list_events", { limit: 501 }), /^Invalid arguments: limit/);
  assert.match(await err("list_events", { limit: 1.5 }), /^Invalid arguments: limit/);
  assert.match(await err("move_item", { id: "x", to: "pantry" }), /^Invalid arguments: to/);
  // Whitespace passes the schema but not the service, which trims first.
  assert.match(await err("create_item", { list: "fridge", name: "   " }), /^name must be 1-500 characters$/);
  const egg = data(await modernCall("create_item", { list: "fridge", name: "egg" }));
  assert.match(await err("update_item", { id: egg.id, name: "   " }), /^name must be/);
});

test("list_items filters by list and status, and rejects a status of the other list", async () => {
  await modernCall("create_item", { list: "shopping", name: "milk" });
  const bread = data(await modernCall("create_item", { list: "shopping", name: "bread" }));
  await modernCall("update_item", { id: bread.id, status: "bought" });
  await modernCall("create_item", { list: "fridge", name: "egg" });
  const names = async (args: object) => data(await modernCall("list_items", args)).items.map((i: { name: string }) => i.name);
  assert.deepEqual(await names({}), ["milk", "bread", "egg"]);
  assert.deepEqual(await names({ list: "shopping", status: "bought" }), ["bread"]);
  assert.deepEqual(await names({ status: "in_stock" }), ["egg"]);
  const bad = await modernCall("list_items", { list: "fridge", status: "bought" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /status for the fridge list must be one of: in_stock, used_up/);
});

test("items added in quick succession come back in the order they were added", async () => {
  const names = Array.from({ length: 20 }, (_, i) => `item ${i}`);
  for (const name of names) await modernCall("create_item", { list: "shopping", name });
  assert.deepEqual(data(await modernCall("list_items")).items.map((i: { name: string }) => i.name), names);
});

test("japanese names and notes survive the round trip", async () => {
  const created = data(await modernCall("create_item", { list: "fridge", name: "牛乳", note: "特売 🥛 2本" }));
  const fetched = data(await modernCall("get_item", { id: created.id }));
  assert.deepEqual([fetched.name, fetched.note], ["牛乳", "特売 🥛 2本"]);
  assert.equal(data(await modernCall("list_events")).events[0].name, "牛乳");
});

test("the history records which client made each change", async () => {
  const created = data(await modernCall("create_item", { list: "fridge", name: "egg" }));
  principal = { actor: { ...claude, clientId: "other-client" }, scopes: ALL };
  await modernCall("update_item", { id: created.id, status: "used_up" });
  const clients = raw.prepare("SELECT client_id AS c FROM item_events ORDER BY id").all().map((r) => r.c);
  assert.deepEqual(clients, ["c1", "other-client"]);
});

// --- recipes ---------------------------------------------------------------------------------------------

test("recipes: save one, find it by an ingredient, record cooking it, and see it counted", async () => {
  const curry = data(await modernCall("create_recipe", { title: "チキンカレー", url: "https://example.com/curry", body: "鶏もも肉 300g\n玉ねぎ 2個" }));
  assert.deepEqual([curry.title, curry.url, curry.body], ["チキンカレー", "https://example.com/curry", "鶏もも肉 300g\n玉ねぎ 2個"]);
  await modernCall("create_recipe", { title: "味噌汁" });

  const found = data(await modernCall("list_recipes", { query: "玉ねぎ" })).recipes;
  assert.deepEqual(found.map((r: { title: string }) => r.title), ["チキンカレー"]);
  assert.equal(found[0].body, undefined);
  assert.equal(data(await modernCall("list_recipes", { query: "玉ねぎ", withBody: true })).recipes[0].body, "鶏もも肉 300g\n玉ねぎ 2個");

  const cook = data(await modernCall("record_cook", { recipeId: curry.id, cookedOn: "2026-10-18", note: "辛口" }));
  assert.deepEqual([cook.recipeId, cook.title, cook.cookedOn, cook.note, cook.source], [curry.id, "チキンカレー", "2026-10-18", "辛口", "mcp"]);
  const got = data(await modernCall("get_recipe", { id: curry.id }));
  assert.deepEqual([got.cookCount, got.lastCookedOn], [1, "2026-10-18"]);
  assert.deepEqual(data(await modernCall("list_cooks", { since: "2026-10-01" })).cooks.map((c: { id: string }) => c.id), [cook.id]);

  assert.equal(data(await modernCall("update_recipe", { id: curry.id, url: null })).url, null);
  assert.deepEqual(data(await modernCall("delete_cook", { id: cook.id })), { deleted: cook.id });
  assert.deepEqual(data(await modernCall("delete_recipe", { id: curry.id })), { deleted: curry.id });
  assert.equal((await modernCall("get_recipe", { id: curry.id })).content[0].text, "Recipe not found");
});

test("recipes: bad dates and links come back as errors the model can fix", async () => {
  const curry = data(await modernCall("create_recipe", { title: "カレー" }));
  const badDate = await modernCall("record_cook", { recipeId: curry.id, cookedOn: "10/18" });
  assert.equal(badDate.isError, true);
  assert.match(badDate.content[0].text, /^Invalid arguments: cookedOn/);
  const notADay = await modernCall("record_cook", { recipeId: curry.id, cookedOn: "2026-02-30" });
  assert.deepEqual([notADay.isError, notADay.content[0].text], [true, "cookedOn must be a date, YYYY-MM-DD"]);
  const badUrl = await modernCall("create_recipe", { title: "x", url: "javascript:alert(1)" });
  assert.deepEqual([badUrl.isError, badUrl.content[0].text], [true, "url must be an http or https URL"]);
});

test("recipes: from a book photo, with tags, then tidied up", async () => {
  const a = data(await modernCall("create_recipe", { title: "唐揚げ", book: "茅乃舎 レシピ冊子", page: "12", tags: ["主菜", "揚げ物"], body: "鶏もも肉 300g" }));
  assert.deepEqual([a.book.title, a.page, a.tags], ["茅乃舎 レシピ冊子", "12", ["主菜", "揚げ物"]]);
  const b = data(await modernCall("create_recipe", { title: "ラタトゥイユ", book: "茅乃舎 レシピ冊子", page: "20", tags: ["副菜", "作りおき"] }));
  assert.equal(b.book.id, a.book.id);

  assert.deepEqual(data(await modernCall("list_books")).books.map((x: { title: string; recipeCount: number }) => [x.title, x.recipeCount]), [["茅乃舎 レシピ冊子", 2]]);
  assert.deepEqual(data(await modernCall("rename_tag", { from: "作りおき", to: "作り置き" })), { from: "作りおき", to: "作り置き", recipeCount: 1 });
  assert.deepEqual(data(await modernCall("list_recipes", { tags: ["作り置き"] })).recipes.map((r: { title: string }) => r.title), ["ラタトゥイユ"]);
  assert.deepEqual(data(await modernCall("list_recipes", { bookId: a.book.id })).recipes.length, 2);
  assert.equal(data(await modernCall("list_tags")).tags.length, 4);

  // Adding a tag means giving the current ones too.
  assert.deepEqual(data(await modernCall("update_recipe", { id: a.id, tags: [...a.tags, "弁当"] })).tags, ["主菜", "弁当", "揚げ物"].sort());
  const bad = await modernCall("update_recipe", { id: a.id, tags: ["作り 置き"] });
  assert.deepEqual([bad.isError, bad.content[0].text], [true, "a tag must not contain spaces or commas: 作り 置き"]);

  assert.deepEqual(data(await modernCall("rename_book", { id: a.book.id, title: "茅乃舎の冊子" })), { id: a.book.id, title: "茅乃舎の冊子" });
  assert.equal(data(await modernCall("get_recipe", { id: b.id })).book.title, "茅乃舎の冊子");
  assert.deepEqual(data(await modernCall("delete_book", { id: a.book.id })), { deleted: a.book.id });
  assert.deepEqual(data(await modernCall("get_recipe", { id: a.id })).book, null);
});

test("scopes: a token for the lists alone cannot reach the recipes, and recipes:read cannot write", async () => {
  const curry = data(await modernCall("create_recipe", { title: "カレー" }));
  // What claude.ai and ChatGPT hold from before recipes existed.
  principal = { actor: claude, scopes: ["items:read", "items:write"] };
  assert.deepEqual((await modernCall("list_recipes")).content[0].text, "Missing scope: recipes:read");
  assert.deepEqual((await modernCall("list_cooks")).content[0].text, "Missing scope: recipes:read");
  assert.equal((await modernCall("list_items")).isError, undefined);

  principal = { actor: claude, scopes: ["recipes:read"] };
  assert.equal(data(await modernCall("list_recipes")).recipes.length, 1);
  for (const [name, args] of [
    ["create_recipe", { title: "x" }], ["update_recipe", { id: curry.id, title: "x" }], ["delete_recipe", { id: curry.id }],
    ["record_cook", { recipeId: curry.id, cookedOn: "2026-10-18" }], ["delete_cook", { id: "x" }],
    ["rename_tag", { from: "a", to: "b" }], ["rename_book", { id: "x", title: "y" }], ["delete_book", { id: "x" }],
  ] as const) {
    const r = await modernCall(name, args);
    assert.deepEqual([r.isError, r.content[0].text], [true, "Missing scope: recipes:write"], name);
  }
  assert.equal((await modernCall("list_items")).content[0].text, "Missing scope: items:read");
});

test("a household's tokens only reach its own recipes and cook records", async () => {
  const curry = data(await modernCall("create_recipe", { title: "カレー", body: "秘伝" }));
  const cook = data(await modernCall("record_cook", { recipeId: curry.id, cookedOn: "2026-10-18" }));
  principal = { actor: { householdId: "h2", userId: "u2", source: "mcp", clientId: "c2" }, scopes: ALL };
  assert.deepEqual(data(await modernCall("list_recipes", { query: "秘伝" })).recipes, []);
  assert.deepEqual(data(await modernCall("list_cooks")).cooks, []);
  assert.equal((await modernCall("get_recipe", { id: curry.id })).content[0].text, "Recipe not found");
  assert.equal((await modernCall("record_cook", { recipeId: curry.id, cookedOn: "2026-10-18" })).isError, true);
  assert.equal((await modernCall("delete_cook", { id: cook.id })).isError, true);
  assert.equal((await modernCall("delete_recipe", { id: curry.id })).isError, true);
});
