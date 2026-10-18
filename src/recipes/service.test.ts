import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import type { Actor } from "../items/service.ts";
import { RecipeError, checkDate, createRecipeService, type RecipeService } from "./service.ts";

let raw: DatabaseSync;
let svc: RecipeService;
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
  svc = createRecipeService(t.db, { now: () => clock, newId: () => `id${String(++seq).padStart(3, "0")}` });
});

const rejects = (promise: Promise<unknown>, code: "not_found" | "invalid", message?: RegExp) =>
  assert.rejects(promise, (e: unknown) => e instanceof RecipeError && e.code === code && (!message || message.test(e.message)));

test("create keeps a title with an optional link and text", async () => {
  const curry = await svc.create(home, { title: "  チキンカレー ", url: " https://example.com/curry ", body: "玉ねぎを炒める\n" });
  assert.deepEqual(
    { title: curry.title, url: curry.url, body: curry.body, addedBy: curry.addedBy },
    { title: "チキンカレー", url: "https://example.com/curry", body: "玉ねぎを炒める", addedBy: "u1" },
  );
  const plain = await svc.create(home, { title: "味噌汁", url: "", body: "  " });
  assert.equal(plain.url, null);
  assert.equal(plain.body, null);
});

test("create validates the title, the link and the text", async () => {
  await rejects(svc.create(home, { title: "  " }), "invalid", /title must be/);
  await rejects(svc.create(home, { title: "x".repeat(201) }), "invalid", /title must be/);
  await rejects(svc.create(home, { title: "x", url: "javascript:alert(1)" }), "invalid", /http or https/);
  await rejects(svc.create(home, { title: "x", url: "not a url" }), "invalid", /http or https/);
  await rejects(svc.create(home, { title: "x", url: `https://e.com/${"a".repeat(2000)}` }), "invalid", /at most 2000/);
  await rejects(svc.create(home, { title: "x", body: "b".repeat(20001) }), "invalid", /body must be at most/);
  assert.equal((await svc.list(home)).length, 0);
});

test("list is newest change first, without the text unless asked, and searches title and text literally", async () => {
  await svc.create(home, { title: "カレー", body: "鶏肉 100%" });
  clock = 2000;
  await svc.create(home, { title: "鶏ハム", body: "胸肉" });
  clock = 3000;
  await svc.create(home, { title: "味噌汁" });

  const all = await svc.list(home);
  assert.deepEqual(all.map((r) => r.title), ["味噌汁", "鶏ハム", "カレー"]);
  assert.equal("body" in all[0], false);
  assert.equal((await svc.list(home, { withBody: true }))[1].body, "胸肉");

  assert.deepEqual((await svc.list(home, { query: "鶏" })).map((r) => r.title), ["鶏ハム", "カレー"]);
  assert.deepEqual((await svc.list(home, { query: "%" })).map((r) => r.title), ["カレー"]);
  assert.deepEqual((await svc.list(home, { query: "_" })).map((r) => r.title), []);
  await rejects(svc.list(home, { query: "x".repeat(201) }), "invalid", /query must be/);
});

test("update changes only what is given and moves the recipe to the top", async () => {
  const a = await svc.create(home, { title: "A", url: "https://e.com/a", body: "text" });
  await svc.create(home, { title: "B" });
  clock = 5000;
  const updated = await svc.update(home, a.id, { body: null });
  assert.deepEqual({ title: updated.title, url: updated.url, body: updated.body, updatedAt: updated.updatedAt }, { title: "A", url: "https://e.com/a", body: null, updatedAt: 5000 });
  assert.equal((await svc.list(home))[0].id, a.id);
  await rejects(svc.update(home, a.id, {}), "invalid", /Nothing to update/);
  await rejects(svc.update(home, a.id, { url: "ftp://e.com" }), "invalid", /http or https/);
});

test("cooks are recorded by date, counted on the recipe, and listed newest first", async () => {
  const curry = await svc.create(home, { title: "カレー" });
  const soup = await svc.create(home, { title: "味噌汁" });
  await svc.recordCook(home, { recipeId: curry.id, cookedOn: "2026-10-01" });
  const second = await svc.recordCook(claude, { recipeId: curry.id, cookedOn: "2026-10-15", note: " 辛口 " });
  await svc.recordCook(home, { recipeId: soup.id, cookedOn: "2026-10-10" });

  assert.deepEqual(
    { title: second.title, note: second.note, source: second.source, clientId: second.clientId, userId: second.userId },
    { title: "カレー", note: "辛口", source: "mcp", clientId: "c1", userId: "u1" },
  );
  const got = await svc.get(home, curry.id);
  assert.deepEqual({ cookCount: got.cookCount, lastCookedOn: got.lastCookedOn }, { cookCount: 2, lastCookedOn: "2026-10-15" });
  const listed = await svc.list(home);
  assert.deepEqual(listed.map((r) => [r.title, r.cookCount, r.lastCookedOn]), [["味噌汁", 1, "2026-10-10"], ["カレー", 2, "2026-10-15"]]);

  assert.deepEqual((await svc.cooks(home)).map((c) => c.cookedOn), ["2026-10-15", "2026-10-10", "2026-10-01"]);
  assert.deepEqual((await svc.cooks(home, { recipeId: curry.id, since: "2026-10-02" })).map((c) => c.cookedOn), ["2026-10-15"]);
  assert.equal((await svc.cooks(home, { limit: 1 })).length, 1);
});

test("a cook needs a real date and a recipe of the same household", async () => {
  const curry = await svc.create(home, { title: "カレー" });
  for (const cookedOn of ["2026-02-30", "2026-13-01", "26-10-01", "2026/10/01", "2026-10-01T00:00:00Z"]) {
    await rejects(svc.recordCook(home, { recipeId: curry.id, cookedOn }), "invalid", /cookedOn must be a date/);
  }
  await rejects(svc.recordCook(home, { recipeId: curry.id, cookedOn: "2026-10-01", note: "n".repeat(2001) }), "invalid", /note must be/);
  await rejects(svc.recordCook(other, { recipeId: curry.id, cookedOn: "2026-10-01" }), "not_found");
  await rejects(svc.recordCook(home, { recipeId: "nope", cookedOn: "2026-10-01" }), "not_found");
  await rejects(svc.cooks(home, { since: "yesterday" }), "invalid", /since must be a date/);
});

test("deleting a recipe keeps its cook records, with the title they were cooked under", async () => {
  const curry = await svc.create(home, { title: "カレー" });
  await svc.recordCook(home, { recipeId: curry.id, cookedOn: "2026-10-01" });
  await svc.update(home, curry.id, { title: "チキンカレー" });
  await svc.delete(home, curry.id);
  await rejects(svc.get(home, curry.id), "not_found");
  const [cook] = await svc.cooks(home);
  assert.deepEqual({ recipeId: cook.recipeId, title: cook.title }, { recipeId: null, title: "カレー" });
});

test("cook records can be removed, one at a time", async () => {
  const curry = await svc.create(home, { title: "カレー" });
  const cook = await svc.recordCook(home, { recipeId: curry.id, cookedOn: "2026-10-01" });
  await rejects(svc.deleteCook(other, cook.id), "not_found");
  await svc.deleteCook(home, cook.id);
  assert.equal((await svc.cooks(home)).length, 0);
  assert.equal((await svc.get(home, curry.id)).cookCount, 0);
  await rejects(svc.deleteCook(home, cook.id), "not_found");
});

test("another household sees none of it", async () => {
  const curry = await svc.create(home, { title: "カレー", body: "秘伝" });
  await svc.recordCook(home, { recipeId: curry.id, cookedOn: "2026-10-01" });
  assert.deepEqual(await svc.list(other), []);
  assert.deepEqual(await svc.list(other, { query: "秘伝" }), []);
  assert.deepEqual(await svc.cooks(other), []);
  await rejects(svc.get(other, curry.id), "not_found");
  await rejects(svc.update(other, curry.id, { title: "x" }), "not_found");
  await rejects(svc.delete(other, curry.id), "not_found");
  assert.equal((await svc.get(home, curry.id)).title, "カレー");
});

test("checkDate accepts real calendar dates only", () => {
  assert.equal(checkDate("2024-02-29"), "2024-02-29");
  assert.throws(() => checkDate("2025-02-29"), RecipeError);
  assert.throws(() => checkDate(20261001), RecipeError);
});
