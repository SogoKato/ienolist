import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { createItemService, type Actor, type ItemService } from "../items/service.ts";
import { handleMcpRequest, type McpDeps } from "./endpoint.ts";

// Response.json() is typed unknown; the tests inspect arbitrary JSON-RPC payloads.
declare global {
  interface Response {
    json(): Promise<any>;
  }
}

const claude: Actor = { householdId: "h1", userId: "u1", source: "mcp", clientId: "c1" };
const ALL = ["items:read", "items:write"];
let items: ItemService;
let deps: McpDeps;
let principal: { actor: Actor; scopes: string[] } | null;

beforeEach(() => {
  const t = createTestDb();
  t.raw.exec("INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', 0), ('h2', 'Other', 0)");
  t.raw.exec("INSERT INTO users (id, display_name, created_at) VALUES ('u1', 'A', 0), ('u2', 'B', 0)");
  items = createItemService(t.db);
  principal = { actor: claude, scopes: ALL };
  deps = { authenticate: async () => principal, resourceMetadataUrl: () => "https://app.test/.well-known/oauth-protected-resource/mcp", items };
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
  assert.deepEqual(list.tools.map((t: { name: string }) => t.name), ["list_items", "get_item", "create_item", "update_item", "delete_item", "move_item", "list_events"]);
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
  assert.equal(list.tools.length, 7);
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
  const broken: McpDeps = { ...deps, items: { ...items, list: async () => { throw new Error("SQLITE_CORRUPT: secret detail"); } } };
  const quiet = console.error;
  console.error = () => {};
  try {
    const r = await (await handleMcpRequest(new Request("https://app.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": V, "mcp-method": "tools/call", "mcp-name": "list_items" },
      body: JSON.stringify(rpc(1, "tools/call", { name: "list_items", arguments: {}, ...meta })),
    }), broken)).json();
    assert.deepEqual(r.result.content, [{ type: "text", text: "Internal error" }]);
    assert.equal(r.result.isError, true);
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
