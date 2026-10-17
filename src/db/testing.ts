import { DatabaseSync } from "node:sqlite";
import { readMigrations, createSqliteDb } from "./sqlite.ts";
import type { Db } from "./types.ts";

// An in-memory SQLite with the shipped migrations applied, exposed like D1. `statements` records
// the SQL of everything run afterwards (a batch counts each of its statements): on D1 every
// round trip costs CPU time, so tests can pin how many a request makes.
export function createTestDb(): { raw: DatabaseSync; db: Db; statements: string[] } {
  const raw = new DatabaseSync(":memory:");
  for (const { statements } of readMigrations()) for (const statement of statements) raw.exec(statement);
  const statements: string[] = [];
  const prepare = raw.prepare.bind(raw);
  raw.prepare = (sql: string) => (statements.push(sql), prepare(sql));
  return { raw, db: createSqliteDb(raw), statements };
}
