import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { BatchItem } from "drizzle-orm/batch";
import type * as schema from "./schema.ts";

// The async SQLite surface shared by D1 (drizzle-orm/d1) and the proxy driver
// used for plain SQLite and tests. D1 has no interactive transactions, so
// multi-statement writes go through batch(), which is atomic on both.
export type Db = BaseSQLiteDatabase<"async", unknown, typeof schema> & {
  batch(queries: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]): Promise<unknown>;
};

// All of these statements are written, or none are.
export const atomically = (db: Db, statements: BatchItem<"sqlite">[]) =>
  db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
