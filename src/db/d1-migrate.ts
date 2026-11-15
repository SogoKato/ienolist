import type { D1Database } from "@cloudflare/workers-types";
import { MIGRATIONS } from "./migrations.generated.ts";

// Brings a D1 database up to date when the Worker starts, so deploying (or updating) needs no
// separate `wrangler d1 migrations apply`. It keeps wrangler's own record, the d1_migrations table
// with one row per applied file, so the two agree and either can be used.

type Migration = { name: string; statements: string[] };

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;
const LIST = "SELECT name FROM d1_migrations";

// Applies the migrations not yet recorded, each in one batch (all or nothing), and returns their names.
export async function migrateD1(d1: Pick<D1Database, "prepare" | "batch">, migrations: Migration[] = MIGRATIONS): Promise<string[]> {
  // One round trip when there is nothing to do, which is every start but the first after an update.
  const [, listed] = await d1.batch<{ name: string }>([d1.prepare(CREATE_TABLE), d1.prepare(LIST)]);
  const done = new Set(listed!.results.map((r) => r.name));
  const applied: string[] = [];
  for (const { name, statements } of migrations) {
    if (done.has(name)) continue;
    try {
      await d1.batch([...statements.map((s) => d1.prepare(s)), d1.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name)]);
    } catch (error) {
      // Two isolates can start at once: if the other one applied it, its batch rolled ours back.
      const now = await d1.prepare(LIST).all<{ name: string }>();
      if (now.results.some((r) => r.name === name)) continue;
      throw error;
    }
    applied.push(name);
  }
  return applied;
}
