import { Hono } from "hono";
import { AuthError, type AuthService } from "../auth/service.ts";
import type { Config } from "../config.ts";
import { ItemError, type ItemService } from "../items/service.ts";
import { authRoutes } from "./auth-routes.ts";
import { HttpError, type AppEnv } from "./http.ts";
import { itemRoutes } from "./item-routes.ts";
import { sameOriginWrites, securityHeaders, sessionCookie } from "./session.ts";

export type AppDeps = { config: Config; auth: AuthService; items: ItemService };

const STATUS = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
} as const;

export function createApp({ config, auth, items }: AppDeps) {
  const cookie = sessionCookie(config);
  const app = new Hono<AppEnv>();
  app.use(securityHeaders);

  // The web API: same-origin only, never cached.
  const api = new Hono<AppEnv>();
  api.use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  api.use(sameOriginWrites(config));
  api.route("/", authRoutes(auth, cookie));
  api.route("/", itemRoutes(auth, items, cookie));
  app.route("/api", api);

  app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : c.text("Not found", 404)));

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    if (error instanceof AuthError || error instanceof ItemError) return c.json({ error: error.message }, STATUS[error.code]);
    console.error("request failed", c.req.method, c.req.path, error);
    return c.json({ error: "Internal error" }, 500);
  });
  return app;
}
