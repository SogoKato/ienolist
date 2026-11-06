import { Hono } from "hono";
import { cors } from "hono/cors";
import { AuthError, type AuthService } from "../auth/service.ts";
import type { Config } from "../config.ts";
import { ItemError, type ItemService } from "../items/service.ts";
import { handleMcpRequest } from "../mcp/endpoint.ts";
import { OAuthError, type OAuthService } from "../oauth/service.ts";
import { RecipeError, type RecipeService } from "../recipes/service.ts";
import { authRoutes } from "./auth-routes.ts";
import { HttpError, type AppEnv } from "./http.ts";
import { itemRoutes } from "./item-routes.ts";
import { oauthErrorBody, oauthProtocolRoutes, oauthWebRoutes } from "./oauth-routes.ts";
import { recipeRoutes } from "./recipe-routes.ts";
import { sameOriginWrites, securityHeaders, sessionCookie } from "./session.ts";

export type AppDeps = { config: Config; auth: AuthService; items: ItemService; recipes: RecipeService; oauth: OAuthService };

const STATUS = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
} as const;

export function createApp({ config, auth, items, recipes, oauth }: AppDeps) {
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
  api.route("/", recipeRoutes(auth, recipes, cookie));
  api.route("/", oauthWebRoutes(auth, oauth, cookie));
  app.route("/api", api);

  // MCP clients: OAuth endpoints, and the MCP endpoint itself, which takes bearer tokens.
  app.route("/", oauthProtocolRoutes(oauth, config));
  app.use("/mcp", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "mcp-protocol-version", "mcp-method", "mcp-name"], exposeHeaders: ["www-authenticate"] }));
  // Someone who opened the address in a browser, instead of giving it to an assistant, sees how to
  // connect one; MCP clients never navigate.
  app.get("/mcp", (c, next) => (c.req.header("sec-fetch-mode") === "navigate" ? c.redirect("/assistants") : next()));
  app.all("/mcp", (c) =>
    handleMcpRequest(c.req.raw, {
      items,
      recipes,
      resourceMetadataUrl: oauth.resourceMetadataUrl,
      async authenticate(request) {
        const token = /^bearer +(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
        const grant = token ? await oauth.verifyAccessToken(token) : null;
        if (!grant) return null;
        return { actor: { householdId: grant.householdId, userId: grant.userId, source: "mcp", clientId: grant.clientId }, scopes: grant.scopes };
      },
    }),
  );

  app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : c.text("Not found", 404)));

  app.onError((error, c) => {
    if (error instanceof OAuthError) return c.json(oauthErrorBody(error), error.status, { "cache-control": "no-store", pragma: "no-cache" });
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    if (error instanceof AuthError || error instanceof ItemError || error instanceof RecipeError) return c.json({ error: error.message }, STATUS[error.code]);
    console.error("request failed", c.req.method, c.req.path, error);
    return c.json({ error: "Internal error" }, 500);
  });
  return app;
}
