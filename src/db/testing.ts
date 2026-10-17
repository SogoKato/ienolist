import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema.ts";
import type { Db } from "./types.ts";

const migrationsDir = new URL("../../drizzle/", import.meta.url);

// Applies the generated SQL migrations, so tests run against the schema that ships.
export function applyMigrations(raw: DatabaseSync): void {
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(new URL(file, migrationsDir), "utf8").split("--> statement-breakpoint")) {
      raw.exec(statement);
    }
  }
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

// An in-memory SQLite with foreign keys on, exposed through Drizzle's proxy
// driver (async, with an atomic batch) like D1.
export function createTestDb(): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  applyMigrations(raw);
  const db = drizzle(
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
  return { raw, db };
}
