import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { createTestDb } from "./testing.ts";

let db: DatabaseSync;

beforeEach(() => {
  db = createTestDb().raw;
  db.exec("INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', 0), ('h2', 'Other', 0)");
  db.exec("INSERT INTO users (id, display_name, created_at) VALUES ('u1', 'A', 0)");
});

const addItem = (list: string, status: string, name = "milk", household = "h1") =>
  db
    .prepare("INSERT INTO items (id, household_id, list, status, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)")
    .run(`i-${Math.random()}`, household, list, status, name);

test("items accept each list's own statuses", () => {
  for (const [list, status] of [["shopping", "to_buy"], ["shopping", "bought"], ["fridge", "in_stock"], ["fridge", "used_up"]]) {
    addItem(list, status);
  }
});

test("items reject a status that belongs to the other list", () => {
  assert.throws(() => addItem("shopping", "in_stock"), /CHECK constraint failed: items_list_status/);
  assert.throws(() => addItem("fridge", "bought"), /CHECK constraint failed: items_list_status/);
  assert.throws(() => addItem("pantry", "to_buy"), /CHECK constraint failed/);
  assert.throws(() => addItem("fridge", "checked"), /CHECK constraint failed/);
});

test("items need a note of at most 2000 characters", () => {
  const insert = (note: string | null) =>
    db.prepare("INSERT INTO items (id, household_id, list, status, name, note, created_at, updated_at) VALUES (?, 'h1', 'fridge', 'in_stock', 'milk', ?, 0, 0)").run(`n-${Math.random()}`, note);
  insert(null);
  insert("x".repeat(2000));
  assert.throws(() => insert("x".repeat(2001)), /items_note_length/);
});

test("items need a name of 1-500 characters", () => {
  assert.throws(() => addItem("fridge", "in_stock", ""), /items_name_length/);
  assert.throws(() => addItem("fridge", "in_stock", "x".repeat(501)), /items_name_length/);
  addItem("fridge", "in_stock", "x".repeat(500));
});

test("items need an existing household and go away with it", () => {
  assert.throws(() => addItem("fridge", "in_stock", "milk", "nope"), /FOREIGN KEY/);
  addItem("fridge", "in_stock", "egg", "h2");
  db.exec("DELETE FROM households WHERE id = 'h2'");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE household_id = 'h2'").get()!.n, 0);
});

test("item events outlive the item they describe", () => {
  addItem("fridge", "in_stock");
  db.exec("INSERT INTO item_events (id, household_id, item_id, type, name, source, created_at) VALUES ('e1', 'h1', 'gone', 'deleted', 'milk', 'web', 0)");
  assert.throws(
    () => db.exec("INSERT INTO item_events (id, household_id, item_id, type, name, source, created_at) VALUES ('e2', 'h1', 'x', 'edited', 'milk', 'web', 0)"),
    /item_events_type/,
  );
  assert.throws(
    () => db.exec("INSERT INTO item_events (id, household_id, item_id, type, name, source, created_at) VALUES ('e3', 'h1', 'x', 'created', 'milk', 'cli', 0)"),
    /item_events_source/,
  );
});

test("memberships allow only admin and member, once per user and household", () => {
  db.exec("INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ('h1', 'u1', 'admin', 0)");
  assert.throws(() => db.exec("INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ('h1', 'u1', 'member', 0)"), /UNIQUE|PRIMARY KEY/);
  assert.throws(() => db.exec("INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ('h2', 'u1', 'owner', 0)"), /memberships_role/);
  db.exec("INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ('h2', 'u1', 'member', 0)");
});

test("app_meta keys are unique, so only one first-run setup can win", () => {
  db.exec("INSERT INTO app_meta (key, value) VALUES ('initialized_at', '1')");
  assert.throws(() => db.exec("INSERT INTO app_meta (key, value) VALUES ('initialized_at', '2')"), /UNIQUE|PRIMARY KEY/);
});

test("deleting an OAuth client removes its codes and tokens", () => {
  db.exec("INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES ('c1', 'Claude', '[]', 0)");
  db.exec(
    "INSERT INTO oauth_tokens (id, client_id, user_id, household_id, scope, resource, access_hash, refresh_hash, access_expires_at, refresh_expires_at, created_at) VALUES ('t1', 'c1', 'u1', 'h1', 'items:read', 'r', 'a', 'b', 1, 1, 0)",
  );
  assert.throws(
    () => db.exec("INSERT INTO oauth_tokens (id, client_id, user_id, household_id, scope, resource, access_hash, refresh_hash, access_expires_at, refresh_expires_at, created_at) VALUES ('t2', 'c1', 'u1', 'h1', 's', 'r', 'a', 'c', 1, 1, 0)"),
    /UNIQUE/,
  );
  db.exec("DELETE FROM oauth_clients WHERE client_id = 'c1'");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get()!.n, 0);
});

const count = (table: string, where = "1") => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get()!.n;

test("deleting a user removes their sign-in state but keeps the household's data", () => {
  db.exec("INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ('h1', 'u1', 'admin', 0)");
  db.exec("INSERT INTO passkeys (id, user_id, public_key, created_at) VALUES ('p1', 'u1', 'key', 0)");
  db.exec("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('s1', 'u1', 0, 1)");
  db.exec("INSERT INTO challenges (id, challenge, purpose, user_id, expires_at) VALUES ('ch1', 'x', 'register', 'u1', 1)");
  db.exec("INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES ('c1', 'Claude', '[]', 0)");
  db.exec("INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, resource, user_id, household_id, expires_at) VALUES ('code', 'c1', 'https://x', 'c', 's', 'r', 'u1', 'h1', 1)");
  db.exec("INSERT INTO oauth_tokens (id, client_id, user_id, household_id, scope, resource, access_hash, refresh_hash, access_expires_at, refresh_expires_at, created_at) VALUES ('t1', 'c1', 'u1', 'h1', 's', 'r', 'a', 'b', 1, 1, 0)");
  db.exec("INSERT INTO items (id, household_id, list, status, name, added_by, created_at, updated_at) VALUES ('i1', 'h1', 'fridge', 'in_stock', 'egg', 'u1', 0, 0)");
  db.exec("INSERT INTO item_events (id, household_id, item_id, type, name, user_id, source, created_at) VALUES ('e1', 'h1', 'i1', 'created', 'egg', 'u1', 'web', 0)");

  db.exec("DELETE FROM users WHERE id = 'u1'");

  for (const table of ["memberships", "passkeys", "sessions", "challenges", "oauth_codes", "oauth_tokens"]) {
    assert.equal(count(table), 0, table);
  }
  assert.equal(count("oauth_clients"), 1);
  assert.equal(db.prepare("SELECT added_by AS who FROM items").get()!.who, null);
  assert.equal(db.prepare("SELECT user_id AS who FROM item_events").get()!.who, null);
});

test("deleting a household removes everything in it, but not its users", () => {
  db.exec("INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ('h2', 'u1', 'member', 0)");
  db.exec("INSERT INTO invites (id, token_hash, household_id, role, created_at, expires_at) VALUES ('inv1', 'th', 'h2', 'member', 0, 1)");
  db.exec("INSERT INTO items (id, household_id, list, status, name, created_at, updated_at) VALUES ('i2', 'h2', 'fridge', 'in_stock', 'egg', 0, 0)");
  db.exec("INSERT INTO item_events (id, household_id, item_id, type, name, source, created_at) VALUES ('e2', 'h2', 'i2', 'created', 'egg', 'web', 0)");
  db.exec("DELETE FROM households WHERE id = 'h2'");
  for (const table of ["memberships", "invites", "items", "item_events"]) assert.equal(count(table), 0, table);
  assert.equal(count("users"), 1);
});

test("passkeys, sessions and invites enforce their keys and references", () => {
  db.exec("INSERT INTO passkeys (id, user_id, public_key, created_at) VALUES ('p1', 'u1', 'key', 0)");
  assert.throws(() => db.exec("INSERT INTO passkeys (id, user_id, public_key, created_at) VALUES ('p1', 'u1', 'key', 0)"), /UNIQUE|PRIMARY KEY/);
  assert.throws(() => db.exec("INSERT INTO passkeys (id, user_id, public_key, created_at) VALUES ('p2', 'nobody', 'key', 0)"), /FOREIGN KEY/);
  assert.equal(db.prepare("SELECT counter FROM passkeys WHERE id = 'p1'").get()!.counter, 0);
  assert.throws(() => db.exec("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('s1', 'nobody', 0, 1)"), /FOREIGN KEY/);
  db.exec("INSERT INTO invites (id, token_hash, household_id, role, created_at, expires_at) VALUES ('i1', 'same', 'h1', 'member', 0, 1)");
  assert.throws(() => db.exec("INSERT INTO invites (id, token_hash, household_id, role, created_at, expires_at) VALUES ('i2', 'same', 'h1', 'member', 0, 1)"), /UNIQUE/);
  assert.throws(() => db.exec("INSERT INTO invites (id, token_hash, household_id, role, created_at, expires_at) VALUES ('i3', 'other', 'h1', 'owner', 0, 1)"), /invites_role/);
  // A re-enrollment invite points at an existing member, and goes away with them.
  db.exec("INSERT INTO invites (id, token_hash, household_id, user_id, role, created_at, expires_at) VALUES ('i4', 'again', 'h1', 'u1', 'member', 0, 1)");
  db.exec("DELETE FROM users WHERE id = 'u1'");
  assert.equal(count("invites", "id = 'i4'"), 0);
});

test("challenges accept only the two ceremonies", () => {
  db.exec("INSERT INTO challenges (id, challenge, purpose, expires_at) VALUES ('a', 'x', 'register', 1), ('b', 'x', 'authenticate', 1)");
  assert.throws(() => db.exec("INSERT INTO challenges (id, challenge, purpose, expires_at) VALUES ('c', 'x', 'reset', 1)"), /challenges_purpose/);
});

test("oauth codes and tokens need a real client, user and household, and unique hashes", () => {
  db.exec("INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES ('c1', 'Claude', '[]', 0)");
  const code = (hash: string, client = "c1", user = "u1", household = "h1") =>
    db.exec(`INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, resource, user_id, household_id, expires_at) VALUES ('${hash}', '${client}', 'https://x', 'c', 's', 'r', '${user}', '${household}', 1)`);
  code("one");
  assert.throws(() => code("one"), /UNIQUE|PRIMARY KEY/);
  assert.throws(() => code("two", "nope"), /FOREIGN KEY/);
  assert.throws(() => code("two", "c1", "nobody"), /FOREIGN KEY/);
  assert.throws(() => code("two", "c1", "u1", "nope"), /FOREIGN KEY/);
  const token = (id: string, access: string, refresh: string) =>
    db.exec(`INSERT INTO oauth_tokens (id, client_id, user_id, household_id, scope, resource, access_hash, refresh_hash, access_expires_at, refresh_expires_at, created_at) VALUES ('${id}', 'c1', 'u1', 'h1', 's', 'r', '${access}', '${refresh}', 1, 1, 0)`);
  token("t1", "a1", "r1");
  assert.throws(() => token("t2", "a1", "r2"), /UNIQUE/);
  assert.throws(() => token("t2", "a2", "r1"), /UNIQUE/);
  db.exec("DELETE FROM oauth_clients WHERE client_id = 'c1'");
  assert.equal(count("oauth_codes"), 0);
});

test("item events keep a reference to deleted items and to users who are gone", () => {
  db.exec("INSERT INTO item_events (id, household_id, item_id, type, name, user_id, source, created_at) VALUES ('e1', 'h1', 'never-existed', 'deleted', 'x', 'u1', 'mcp', 0)");
  assert.throws(() => db.exec("INSERT INTO item_events (id, household_id, item_id, type, name, user_id, source, created_at) VALUES ('e2', 'h1', 'i', 'created', 'x', 'nobody', 'web', 0)"), /FOREIGN KEY/);
  assert.throws(() => db.exec("INSERT INTO item_events (id, household_id, item_id, type, name, source, created_at) VALUES ('e3', 'nope', 'i', 'created', 'x', 'web', 0)"), /FOREIGN KEY/);
});

test("the migrations leave only the tables the schema declares", () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, [
    "app_meta", "challenges", "households", "invites", "item_events", "items", "memberships",
    "oauth_clients", "oauth_codes", "oauth_tokens", "passkeys", "sessions", "users",
  ]);
});
