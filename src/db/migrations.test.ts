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
