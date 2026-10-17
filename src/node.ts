import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { ConfigError } from "./config.ts";
import { openDatabase } from "./db/sqlite.ts";
import { isApiPath, staticApp } from "./http/static.ts";
import { buildApp } from "./main.ts";

// The Node entry point: SQLite in a file, settings from environment variables
// (PUBLIC_URL, SETUP_TOKEN, APP_NAME, OAUTH_CLIENTS, DATABASE_PATH, PORT, WEB_DIR).
// It serves the built web app (pnpm build) as well as the API..
const databasePath = process.env.DATABASE_PATH ?? "./data/app.db";
mkdirSync(dirname(databasePath), { recursive: true });
const { db } = openDatabase(databasePath);
let app: ReturnType<typeof buildApp>;
try {
  app = buildApp(db, process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8787);
const web = staticApp(process.env.WEB_DIR ?? "./dist/web");
serve({ fetch: (request) => (isApiPath(new URL(request.url).pathname) ? app.fetch(request) : web.fetch(request)), port }, () => console.log(`Listening on port ${port}`));
