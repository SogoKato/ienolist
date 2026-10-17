import { defineConfig } from "drizzle-kit";

// Migrations are plain SQL, usable as wrangler's migrations_dir (D1) and by
// drizzle's migrator (Docker + SQLite).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
