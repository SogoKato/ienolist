import { DatabaseSync } from "node:sqlite";
import { readMigrations, createSqliteDb } from "./sqlite.ts";
import type { Db } from "./types.ts";

// An in-memory SQLite with the shipped migrations applied, exposed like D1.
export function createTestDb(): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(":memory:");
  for (const { statements } of readMigrations()) for (const statement of statements) raw.exec(statement);
  return { raw, db: createSqliteDb(raw) };
}
