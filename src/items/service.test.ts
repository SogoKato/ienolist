import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { ItemError, createItemService, type Actor, type ItemService } from "./service.ts";

let raw: DatabaseSync;
let svc: ItemService;
let clock: number;
let seq: number;
const home: Actor = { householdId: "h1", userId: "u1", source: "web" };
const claude: Actor = { householdId: "h1", userId: "u1", source: "mcp", clientId: "c1" };
const other: Actor = { householdId: "h2", userId: "u2", source: "web" };

beforeEach(() => {
  const t = createTestDb();
  raw = t.raw;
  raw.exec("INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', 0), ('h2', 'Other', 0)");
  raw.exec("INSERT INTO users (id, display_name, created_at) VALUES ('u1', 'A', 0), ('u2', 'B', 0)");
  clock = 1000;
  seq = 0;
  svc = createItemService(t.db, { now: () => clock, newId: () => `id${String(++seq).padStart(3, "0")}` });
});

const rejects = (promise: Promise<unknown>, code: "not_found" | "invalid", message?: RegExp) =>
  assert.rejects(promise, (e: unknown) => e instanceof ItemError && e.code === code && (!message || message.test(e.message)));

const eventTypes = async (actor = home) => (await svc.events(actor)).map((e) => e.type).reverse();

test("create starts shopping items as to_buy and fridge items as in_stock", async () => {
  const milk = await svc.create(home, { list: "shopping", name: "  milk " });
  assert.equal(milk.name, "milk");
  assert.equal(milk.status, "to_buy");
  assert.equal(milk.addedBy, "u1");
  assert.equal((await svc.create(home, { list: "fridge", name: "egg" })).status, "in_stock");
  assert.equal((await svc.create(home, { list: "fridge", name: "tofu", status: "used_up" })).status, "used_up");
});

test("create validates list, status, name and note", async () => {
  await rejects(svc.create(home, { list: "pantry", name: "x" }), "invalid", /list must be/);
  await rejects(svc.create(home, { list: "shopping", name: "x", status: "in_stock" }), "invalid", /status for the shopping list/);
  await rejects(svc.create(home, { list: "fridge", name: "   " }), "invalid", /name must be/);
  await rejects(svc.create(home, { list: "fridge", name: "x".repeat(501) }), "invalid", /name must be/);
  await rejects(svc.create(home, { list: "fridge", name: "x", note: "n".repeat(2001) }), "invalid", /note must be/);
  assert.equal((await svc.create(home, { list: "fridge", name: "x", note: "  " })).note, null);
  assert.equal((await svc.list(home)).length, 1);
});

test("create records a created event with who and how", async () => {
  const item = await svc.create(claude, { list: "shopping", name: "milk" });
  const [event] = await svc.events(home);
  assert.deepEqual(
    { type: event.type, itemId: event.itemId, name: event.name, source: event.source, clientId: event.clientId, userId: event.userId },
    { type: "created", itemId: item.id, name: "milk", source: "mcp", clientId: "c1", userId: "u1" },
  );
  assert.deepEqual(JSON.parse(event.data!), { list: "shopping", status: "to_buy" });
});

test("list filters by list and status, in creation order", async () => {
  await svc.create(home, { list: "shopping", name: "a" });
  clock++;
  await svc.create(home, { list: "fridge", name: "b" });
  clock++;
  await svc.create(home, { list: "fridge", name: "c", status: "used_up" });
  assert.deepEqual((await svc.list(home)).map((i) => i.name), ["a", "b", "c"]);
  assert.deepEqual((await svc.list(home, { list: "fridge" })).map((i) => i.name), ["b", "c"]);
  assert.deepEqual((await svc.list(home, { list: "fridge", status: "used_up" })).map((i) => i.name), ["c"]);
  assert.deepEqual((await svc.list(home, { status: "to_buy" })).map((i) => i.name), ["a"]);
  await rejects(svc.list(home, { list: "shopping", status: "used_up" }), "invalid");
  await rejects(svc.list(home, { status: "checked" }), "invalid");
});

test("households cannot see or touch each other's items", async () => {
  const item = await svc.create(home, { list: "fridge", name: "egg" });
  assert.deepEqual(await svc.list(other), []);
  await rejects(svc.get(other, item.id), "not_found");
  await rejects(svc.update(other, item.id, { name: "x" }), "not_found");
  await rejects(svc.move(other, item.id, "shopping"), "not_found");
  await rejects(svc.delete(other, item.id), "not_found");
  assert.equal((await svc.get(home, item.id)).name, "egg");
  assert.deepEqual(await svc.events(other), []);
});

test("update records one event per changed field", async () => {
  const item = await svc.create(home, { list: "fridge", name: "milk" });
  clock = 2000;
  const updated = await svc.update(claude, item.id, { name: "soy milk", status: "used_up", note: "from the market" });
  assert.deepEqual({ name: updated.name, status: updated.status, note: updated.note, updatedAt: updated.updatedAt }, { name: "soy milk", status: "used_up", note: "from the market", updatedAt: 2000 });
  assert.deepEqual(await svc.get(home, item.id), updated);
  assert.deepEqual(await eventTypes(), ["created", "renamed", "status_changed", "note_changed"]);
  const byType = Object.fromEntries((await svc.events(home)).map((e) => [e.type, e]));
  assert.deepEqual(JSON.parse(byType.renamed.data!), { from: "milk", to: "soy milk" });
  assert.deepEqual(JSON.parse(byType.status_changed.data!), { from: "in_stock", to: "used_up" });
  assert.equal(byType.status_changed.name, "soy milk");
  assert.equal(byType.status_changed.source, "mcp");
});

test("update that changes nothing writes nothing", async () => {
  const item = await svc.create(home, { list: "fridge", name: "milk" });
  clock = 2000;
  const same = await svc.update(home, item.id, { name: " milk ", status: "in_stock", note: "" });
  assert.equal(same.updatedAt, 1000);
  assert.deepEqual(await eventTypes(), ["created"]);
  await rejects(svc.update(home, item.id, {}), "invalid", /Nothing to update/);
});

test("update validates against the item's own list and clears notes", async () => {
  const item = await svc.create(home, { list: "shopping", name: "milk", note: "2 packs" });
  await rejects(svc.update(home, item.id, { status: "used_up" }), "invalid", /status for the shopping list/);
  await rejects(svc.update(home, item.id, { name: "" }), "invalid");
  assert.equal((await svc.get(home, item.id)).status, "to_buy");
  assert.equal((await svc.update(home, item.id, { note: null })).note, null);
});

test("checking an item changes its status but never its list", async () => {
  const bought = await svc.create(home, { list: "shopping", name: "milk" });
  assert.equal((await svc.update(home, bought.id, { status: "bought" })).list, "shopping");
  const used = await svc.create(home, { list: "fridge", name: "egg" });
  assert.equal((await svc.update(home, used.id, { status: "used_up" })).list, "fridge");
  assert.deepEqual((await svc.list(home, { list: "shopping" })).map((i) => i.name), ["milk"]);
  assert.deepEqual((await svc.list(home, { list: "fridge" })).map((i) => i.name), ["egg"]);
});

test("move keeps the row and resets the status for the new list", async () => {
  const egg = await svc.create(home, { list: "fridge", name: "egg", status: "used_up" });
  clock = 3000;
  const moved = await svc.move(home, egg.id, "shopping");
  assert.deepEqual({ id: moved.id, list: moved.list, status: moved.status, updatedAt: moved.updatedAt }, { id: egg.id, list: "shopping", status: "to_buy", updatedAt: 3000 });
  assert.deepEqual(await svc.list(home, { list: "fridge" }), []);
  const bought = await svc.update(home, egg.id, { status: "bought" });
  assert.equal((await svc.move(home, bought.id, "fridge")).status, "in_stock");
  const events = await svc.events(home);
  assert.deepEqual(events.map((e) => e.type), ["moved", "status_changed", "moved", "created"]);
  assert.deepEqual(JSON.parse(events[0].data!), { from: { list: "shopping", status: "bought" }, to: { list: "fridge", status: "in_stock" } });
  assert.deepEqual(JSON.parse(events[2].data!), { from: { list: "fridge", status: "used_up" }, to: { list: "shopping", status: "to_buy" } });
  await rejects(svc.move(home, egg.id, "fridge"), "invalid", /already on the fridge list/);
  await rejects(svc.move(home, egg.id, "pantry"), "invalid");
});

test("delete removes the item but its history stays, with the name", async () => {
  const item = await svc.create(home, { list: "fridge", name: "egg" });
  await svc.delete(claude, item.id);
  await rejects(svc.get(home, item.id), "not_found");
  await rejects(svc.delete(home, item.id), "not_found");
  const [deleted] = await svc.events(home, { itemId: item.id });
  assert.deepEqual({ type: deleted.type, name: deleted.name, source: deleted.source }, { type: "deleted", name: "egg", source: "mcp" });
  assert.deepEqual(await eventTypes(), ["created", "deleted"]);
});

test("events come newest first and can be filtered", async () => {
  const a = await svc.create(home, { list: "fridge", name: "a" });
  clock = 2000;
  const b = await svc.create(home, { list: "fridge", name: "b" });
  clock = 3000;
  await svc.update(home, a.id, { status: "used_up" });
  assert.deepEqual((await svc.events(home)).map((e) => e.type), ["status_changed", "created", "created"]);
  assert.deepEqual((await svc.events(home, { itemId: a.id })).map((e) => e.type), ["status_changed", "created"]);
  assert.deepEqual((await svc.events(home, { since: 2000 })).map((e) => e.itemId), [a.id, b.id]);
  assert.equal((await svc.events(home, { limit: 1 })).length, 1);
  assert.equal((await svc.events(home, { limit: 0 })).length, 1);
});

test("a failed event write rolls the item change back", async () => {
  const item = await svc.create(home, { list: "fridge", name: "milk" });
  // The event's user_id foreign key fails, after the item update already ran in the batch.
  const ghost: Actor = { householdId: "h1", userId: "nobody", source: "web" };
  await assert.rejects(svc.update(ghost, item.id, { status: "used_up" }));
  assert.equal((await svc.get(home, item.id)).status, "in_stock");
  assert.deepEqual(await eventTypes(), ["created"]);
});

// The tests above fix ids and time; these use the service's real defaults.
test("with real ids, items and events made in the same instant keep their order", async () => {
  const t = createTestDb();
  t.raw.exec("INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', 0)");
  const real = createItemService(t.db);
  const actor: Actor = { householdId: "h1", userId: null, source: "web" };
  const names = Array.from({ length: 50 }, (_, i) => `item ${String(i).padStart(2, "0")}`);
  for (const name of names) await real.create(actor, { list: "shopping", name });
  assert.deepEqual((await real.list(actor)).map((i) => i.name), names);

  const [first] = await real.list(actor);
  await real.update(actor, first.id, { name: "renamed", status: "bought", note: "n" });
  const types = (await real.events(actor, { itemId: first.id })).map((e) => e.type);
  assert.deepEqual(types, ["note_changed", "status_changed", "renamed", "created"]);
});

test("japanese names are stored as written, with full-width spaces trimmed", async () => {
  const item = await svc.create(home, { list: "fridge", name: "　牛乳（成分無調整）　", note: "特売 🥛" });
  assert.equal(item.name, "牛乳（成分無調整）");
  assert.equal((await svc.get(home, item.id)).note, "特売 🥛");
  assert.equal((await svc.create(home, { list: "fridge", name: "あ".repeat(500) })).name.length, 500);
  await rejects(svc.create(home, { list: "fridge", name: "あ".repeat(501) }), "invalid", /name must be/);
});

test("items created in the same second list in creation order", async () => {
  for (const name of ["c", "a", "b"]) await svc.create(home, { list: "shopping", name });
  assert.deepEqual((await svc.list(home)).map((i) => i.name), ["c", "a", "b"]);
});

test("get reports unknown ids as not found", async () => {
  await rejects(svc.get(home, "nope"), "not_found", /Item not found/);
});

test("events never return more than 500 at once", async () => {
  for (let i = 0; i < 501; i++) await svc.create(home, { list: "fridge", name: `item ${i}` });
  assert.equal((await svc.events(home, { limit: 10_000 })).length, 500);
  assert.equal((await svc.events(home)).length, 100);
});
