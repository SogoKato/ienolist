import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema.ts";
import type { Db } from "./types.ts";

// Plain SQLite through node:sqlite, for running the app without Cloudflare and for tests.

const migrationsDir = new URL("../../drizzle/", import.meta.url);

// The generated SQL migrations in order: each a list of statements.
export function readMigrations(dir: URL = migrationsDir): { name: string; statements: string[] }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, statements: readFileSync(new URL(name, dir), "utf8").split("--> statement-breakpoint") }));
}

// Applies the migrations that have not run yet (remembered in `_migrations`), each all or nothing.
export function migrate(raw: DatabaseSync): string[] {
  raw.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set(raw.prepare("SELECT name FROM _migrations").all().map((r) => r.name));
  const applied: string[] = [];
  for (const { name, statements } of readMigrations()) {
    if (done.has(name)) continue;
    raw.exec("BEGIN");
    try {
      for (const statement of statements) raw.exec(statement);
      raw.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, Math.floor(Date.now() / 1000));
      raw.exec("COMMIT");
    } catch (error) {
      raw.exec("ROLLBACK");
      throw error;
    }
    applied.push(name);
  }
  return applied;
}

type Method = "run" | "all" | "values" | "get";

function execute(stmt: StatementSync, params: unknown[], method: Method): { rows: unknown } {
  stmt.setReturnArrays(true);
  const args = params as never[];
  if (method === "run") {
    stmt.run(...args);
    return { rows: [] };
  }
  if (method === "get") return { rows: stmt.get(...args) };
  return { rows: stmt.all(...args) };
}

// Drizzle over a SQLite handle, async with an atomic batch like D1. Foreign keys are switched on.
// The batch runs without awaiting, so no other request's statements can land inside its transaction.
export function createSqliteDb(raw: DatabaseSync): Db {
  raw.exec("PRAGMA foreign_keys = ON");
  return drizzle(
    async (sql, params, method) => execute(raw.prepare(sql), params, method) as { rows: never },
    async (queries) => {
      raw.exec("BEGIN");
      try {
        const results = queries.map((q) => execute(raw.prepare(q.sql), q.params, q.method));
        raw.exec("COMMIT");
        return results as { rows: never }[];
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
    { schema },
  ) as unknown as Db;
}

export function openDatabase(path: string): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL");
  migrate(raw);
  return { raw, db: createSqliteDb(raw) };
}
