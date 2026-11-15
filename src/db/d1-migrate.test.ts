import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { D1Database } from "@cloudflare/workers-types";
import { migrateD1 } from "./d1-migrate.ts";
import { MIGRATIONS } from "./migrations.generated.ts";
import { readMigrations } from "./sqlite.ts";

// D1 itself only runs inside workerd, so these tests put the slice of its API that migrateD1 uses
// (prepare, bind, all, batch as one transaction) over a real in-memory SQLite. Every call yields to
// the event loop first, as D1's round trips do, so two migrations started together interleave.
function fakeD1(raw: DatabaseSync): Pick<D1Database, "prepare" | "batch"> {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const statement = (sql: string, params: never[] = []) => ({
    sql,
    params,
    bind: (...args: never[]) => statement(sql, args),
    all: async () => (await tick(), { results: raw.prepare(sql).all(...params) }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReturnType<typeof statement>[]) => {
      await tick();
      raw.exec("BEGIN");
      try {
        const results = statements.map((s) => ({ results: raw.prepare(s.sql).all(...s.params) }));
        raw.exec("COMMIT");
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  } as never;
}

const names = MIGRATIONS.map((m) => m.name);
const recorded = (raw: DatabaseSync) => raw.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((r) => r.name);

test("migrations.generated.ts is up to date (run pnpm gen after adding a migration)", () => {
  assert.deepEqual(MIGRATIONS, readMigrations());
});

test("a new database gets every migration once, recorded the way wrangler records them", async () => {
  const raw = new DatabaseSync(":memory:");
  const d1 = fakeD1(raw);
  assert.deepEqual(await migrateD1(d1), names);
  assert.deepEqual(recorded(raw), names);
  raw.exec("INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', 0)");

  assert.deepEqual(await migrateD1(d1), []);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM households").get()!.n, 1);
});

test("a database migrated by wrangler gets only the migrations it lacks", async () => {
  const raw = new DatabaseSync(":memory:");
  // What `wrangler d1 migrations apply` leaves behind after the first migration.
  raw.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  for (const s of MIGRATIONS[0]!.statements) raw.exec(s);
  raw.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(names[0]!);

  assert.deepEqual(await migrateD1(fakeD1(raw)), names.slice(1));
  assert.deepEqual(recorded(raw), names);
});

test("a failing migration leaves nothing behind and stops the ones after it", async () => {
  const raw = new DatabaseSync(":memory:");
  const broken = [
    { name: "0000_a.sql", statements: ["CREATE TABLE a (x)"] },
    { name: "0001_b.sql", statements: ["CREATE TABLE b (x)", "NOT SQL"] },
    { name: "0002_c.sql", statements: ["CREATE TABLE c (x)"] },
  ];
  await assert.rejects(migrateD1(fakeD1(raw), broken));
  assert.deepEqual(recorded(raw), ["0000_a.sql"]);
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('a', 'b', 'c')").all().map((r) => r.name);
  assert.deepEqual(tables, ["a"]);
});

test("two isolates starting at once both come up, and each migration runs once", async () => {
  const raw = new DatabaseSync(":memory:");
  const d1 = fakeD1(raw);
  const [first, second] = await Promise.all([migrateD1(d1), migrateD1(d1)]);
  assert.deepEqual([...first, ...second].sort(), names);
  assert.deepEqual(recorded(raw), names);
});
