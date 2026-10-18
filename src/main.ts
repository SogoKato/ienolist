import { createAuthService } from "./auth/service.ts";
import { loadConfig } from "./config.ts";
import type { Db } from "./db/types.ts";
import { createApp } from "./http/app.ts";
import { createItemService } from "./items/service.ts";
import { createOAuthService } from "./oauth/service.ts";
import { createRecipeService } from "./recipes/service.ts";

// Wires the services together for one deployment. Both entry points (Cloudflare Workers
// and Node) call this with their database and settings.
export function buildApp(db: Db, env: Record<string, string | undefined>) {
  const config = loadConfig(env);
  return createApp({
    config,
    auth: createAuthService(db, { rp: config.rp, setupToken: config.setupToken }),
    items: createItemService(db),
    recipes: createRecipeService(db),
    oauth: createOAuthService(db, { origin: config.origin, clients: config.oauthClients }),
  });
}
