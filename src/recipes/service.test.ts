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

test("a recipe names its book by title: an existing book is reused, a new one is added", async () => {
  const a = await svc.create(home, { title: "唐揚げ", book: " 茅乃舎 レシピ冊子 ", page: "12" });
  const b = await svc.create(home, { title: "肉じゃが", book: "茅乃舎 レシピ冊子", page: "3-4" });
  const c = await svc.create(other, { title: "炒飯", book: "茅乃舎 レシピ冊子" });
  assert.equal(a.bookTitle, "茅乃舎 レシピ冊子");
  assert.equal(a.bookId, b.bookId);
  assert.notEqual(a.bookId, c.bookId);
  assert.equal(b.page, "3-4");
  assert.deepEqual((await svc.books(home)).map((x) => [x.title, x.recipeCount]), [["茅乃舎 レシピ冊子", 2]]);
  assert.deepEqual((await svc.list(home, { bookId: a.bookId! })).map((r) => r.title).sort(), ["唐揚げ", "肉じゃが"]);
});

test("a page needs a book, and taking the book away takes the page", async () => {
  await rejects(svc.create(home, { title: "x", page: "12" }), "invalid", /page needs a book/);
  const plain = await svc.create(home, { title: "x" });
  await rejects(svc.update(home, plain.id, { page: "12" }), "invalid", /page needs a book/);
  const r = await svc.create(home, { title: "y", book: "本", page: "12" });
  assert.equal((await svc.update(home, r.id, { page: "13" })).page, "13");
  const moved = await svc.update(home, r.id, { book: "別の本" });
  assert.deepEqual([moved.bookTitle, moved.page], ["別の本", "13"]);
  const cleared = await svc.update(home, r.id, { book: null });
  assert.deepEqual([cleared.bookId, cleared.page], [null, null]);
  await rejects(svc.create(home, { title: "z", book: "本", page: "x".repeat(21) }), "invalid", /page must be at most/);
});

test("tags are cleaned up, kept unique, replaced as a whole, and filter with AND", async () => {
  const r = await svc.create(home, { title: "ラタトゥイユ", tags: [" 副菜", "#作り置き", "副菜", "夏"] });
  assert.deepEqual(r.tags, ["作り置き", "副菜", "夏"].sort());
  await svc.create(home, { title: "唐揚げ", tags: ["主菜", "作り置き"] });
  await svc.create(home, { title: "味噌汁" });
  assert.deepEqual((await svc.list(home, { tags: ["作り置き"] })).length, 2);
  assert.deepEqual((await svc.list(home, { tags: ["作り置き", "夏"] })).map((x) => x.title), ["ラタトゥイユ"]);
  assert.deepEqual((await svc.list(home)).find((x) => x.title === "味噌汁")!.tags, []);

  const updated = await svc.update(home, r.id, { tags: ["副菜"] });
  assert.deepEqual(updated.tags, ["副菜"]);
  assert.deepEqual((await svc.update(home, r.id, { title: "ラタトゥイユ（改）" })).tags, ["副菜"]);
  assert.deepEqual(await svc.tags(home), [
    { tag: "主菜", recipeCount: 1 },
    { tag: "作り置き", recipeCount: 1 },
    { tag: "副菜", recipeCount: 1 },
  ]);
  assert.deepEqual(await svc.tags(other), []);

  await rejects(svc.create(home, { title: "x", tags: ["作り 置き"] }), "invalid", /spaces or commas/);
  await rejects(svc.create(home, { title: "x", tags: ["a、b"] }), "invalid", /spaces or commas/);
  await rejects(svc.create(home, { title: "x", tags: ["x".repeat(31)] }), "invalid", /1-30/);
  await rejects(svc.create(home, { title: "x", tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }), "invalid", /at most 20/);
});

test("renaming a tag changes it everywhere and merges into an existing one", async () => {
  const a = await svc.create(home, { title: "a", tags: ["鶏", "主菜"] });
  await svc.create(home, { title: "b", tags: ["鶏肉"] });
  await svc.create(other, { title: "c", tags: ["鶏"] });
  assert.deepEqual(await svc.renameTag(home, "鶏", "鶏肉"), { recipeCount: 1 });
  assert.deepEqual((await svc.get(home, a.id)).tags, ["主菜", "鶏肉"]);
  assert.deepEqual((await svc.tags(home)).find((t) => t.tag === "鶏肉")?.recipeCount, 2);
  assert.deepEqual((await svc.tags(other)).map((t) => t.tag), ["鶏"]);
  await rejects(svc.renameTag(home, "鶏", "x"), "not_found");
  await rejects(svc.renameTag(home, "鶏肉", "#鶏肉"), "invalid", /same/);
});

test("books can be renamed and deleted, and only the household's own", async () => {
  const r = await svc.create(home, { title: "a", book: "本A", page: "1" });
  await svc.create(home, { title: "b", book: "本B" });
  await svc.renameBook(home, r.bookId!, "本A 改訂版");
  assert.equal((await svc.get(home, r.id)).bookTitle, "本A 改訂版");
  await rejects(svc.renameBook(home, r.bookId!, "本B"), "invalid", /already a book/);
  await rejects(svc.renameBook(other, r.bookId!, "x"), "not_found");
  await rejects(svc.deleteBook(other, r.bookId!), "not_found");
  await svc.deleteBook(home, r.bookId!);
  const after = await svc.get(home, r.id);
  assert.deepEqual([after.bookId, after.page], [null, null]);
  assert.deepEqual((await svc.books(home)).map((b) => b.title), ["本B"]);
});

test("another household's recipe cannot be given tags or a book", async () => {
  const mine = await svc.create(home, { title: "a" });
  await rejects(svc.update(other, mine.id, { tags: ["x"], book: "本" }), "not_found");
  assert.deepEqual((await svc.get(home, mine.id)).tags, []);
  assert.deepEqual(await svc.books(other), []);
});
