import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import { ConfigError, LOCAL_HOSTS } from "./config.ts";
import { migrateD1 } from "./db/d1-migrate.ts";
import * as schema from "./db/schema.ts";
import type { Db } from "./db/types.ts";
import { buildApp } from "./main.ts";

// The Cloudflare Workers entry point. Settings are the Worker's vars and secrets
// (PUBLIC_URL, SETUP_TOKEN, APP_NAME, OAUTH_CLIENTS); the database is the D1 binding DB,
// brought up to date by the first request each isolate serves.
type Env = { DB: D1Database } & Record<string, string | D1Database | undefined>;

// Which site a request belongs to. With PUBLIC_URL set there is just that one. Without it, each hostname the
// Worker answers on is a site of its own (passkeys and sign-ins do not cross between them; the data is shared).
// That is safe here and not on Node: Cloudflare only hands a Worker requests for the hostnames bound to it, so
// the request's URL names a real one, where behind a proxy the Host header says whatever the sender likes.
export function siteFor(requestUrl: string, publicUrl: string | undefined): { origin?: string; redirect?: string } {
  if (publicUrl?.trim()) return {};
  const url = new URL(requestUrl);
  if (url.protocol === "http:" && !LOCAL_HOSTS.includes(url.hostname)) {
    url.protocol = "https:";
    return { redirect: url.href };
  }
  return { origin: url.origin };
}

const apps = new Map<string, ReturnType<typeof buildApp>>();
let migrated: Promise<unknown> | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const site = siteFor(request.url, env.PUBLIC_URL as string | undefined);
    if (site.redirect) return Response.redirect(site.redirect, 308);
    const key = site.origin ?? "";
    let app = apps.get(key);
    try {
      if (!app) {
        const settings = { ...(env as Record<string, string | undefined>), ...(site.origin ? { PUBLIC_URL: site.origin } : {}) };
        app = buildApp(drizzle(env.DB, { schema }) as unknown as Db, settings);
        apps.set(key, app);
      }
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      console.error("configuration error:", error.message);
      return new Response(`Configuration error: ${error.message}\n`, { status: 500 });
    }
    migrated ??= migrateD1(env.DB).then((applied) => applied.length && console.log("applied migrations:", applied.join(", ")));
    try {
      await migrated;
    } catch (error) {
      migrated = undefined; // try again on the next request
      console.error("migration failed:", error);
      return new Response("Database migration failed; see the Worker's logs.\n", { status: 500 });
    }
    return app.fetch(request);
  },
};
