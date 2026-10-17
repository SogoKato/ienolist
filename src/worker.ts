import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import { ConfigError } from "./config.ts";
import * as schema from "./db/schema.ts";
import type { Db } from "./db/types.ts";
import { buildApp } from "./main.ts";

// The Cloudflare Workers entry point. Settings are the Worker's vars and secrets
// (PUBLIC_URL, SETUP_TOKEN, APP_NAME, OAUTH_CLIENTS); the database is the D1 binding DB.
type Env = { DB: D1Database } & Record<string, string | D1Database | undefined>;

let app: ReturnType<typeof buildApp> | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      app ??= buildApp(drizzle(env.DB, { schema }) as unknown as Db, env as Record<string, string | undefined>);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      console.error("configuration error:", error.message);
      return new Response(`Configuration error: ${error.message}\n`, { status: 500 });
    }
    return app.fetch(request);
  },
};
