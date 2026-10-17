import { Hono } from "hono";
import { cors } from "hono/cors";
import * as z from "zod/mini";
import type { AuthService } from "../auth/service.ts";
import type { Config } from "../config.ts";
import { OAuthError, type Authorization, type OAuthService, type Params } from "../oauth/service.ts";
import { HttpError, readJson, type AppEnv } from "./http.ts";
import { requireUser, type SessionCookie } from "./session.ts";

const noStore = { "cache-control": "no-store", pragma: "no-cache" };

// Query and form values as plain strings (the first one, if repeated).
const strings = (entries: Iterable<[string, unknown]>): Params => {
  const out: Params = {};
  for (const [key, value] of entries) if (typeof value === "string" && !(key in out)) out[key] = value;
  return out;
};

// The OAuth endpoints MCP clients talk to. Browsers on other origins (MCP Inspector, web
// clients) call them too, so they allow any origin; none of them uses cookies.
export function oauthProtocolRoutes(oauth: OAuthService, config: Config) {
  const app = new Hono();
  app.use("/.well-known/*", cors());
  for (const path of ["/oauth/register", "/oauth/token", "/oauth/revoke"]) app.use(path, cors());

  app.get("/.well-known/oauth-authorization-server", (c) => c.json(oauth.authorizationServerMetadata()));
  // RFC 9728: the resource's metadata lives at the well-known path with the resource's path appended.
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(oauth.protectedResourceMetadata(config.rp.name)));
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(oauth.protectedResourceMetadata(config.rp.name)));

  app.post("/oauth/register", async (c) => {
    const body = await c.req.json().catch(() => null);
    return c.json(await oauth.register(body), 201, noStore);
  });

  app.post("/oauth/token", async (c) => {
    const form = strings(Object.entries(await c.req.parseBody()));
    return c.json(await oauth.token(form), 200, noStore);
  });

  app.post("/oauth/revoke", async (c) => {
    await oauth.revoke(strings(Object.entries(await c.req.parseBody())).token);
    return c.body(null, 200, noStore);
  });

  // Where the client sends the person's browser. Mistakes in the request are dealt with here;
  // a good request goes on to the app's own consent screen, which needs the signed-in person.
  app.get("/oauth/authorize", async (c) => {
    const result = await oauth.parseAuthorization(strings(Object.entries(c.req.query())));
    if (result.kind === "fatal") return c.text(result.message, 400, noStore);
    if (result.kind === "redirect") return c.redirect(result.redirectTo, 302);
    return c.redirect(`/authorize${new URL(c.req.url).search}`, 302);
  });

  return app;
}

// What the web app needs to ask the signed-in person to allow a client, and to manage what is connected.
export function oauthWebRoutes(auth: AuthService, oauth: OAuthService, cookie: SessionCookie) {
  const app = new Hono<AppEnv>();
  const user = requireUser(auth, cookie);
  app.use("/oauth/*", user);
  app.use("/connections/*", user);

  const unusable = (result: Extract<Authorization, { kind: "fatal" }>) => new HttpError(400, result.message);

  // The consent screen's facts. The client's name is its own claim, so the host the person
  // will be sent back to is shown beside it.
  app.get("/oauth/authorization", async (c) => {
    const result = await oauth.parseAuthorization(strings(Object.entries(c.req.query())));
    if (result.kind === "fatal") throw unusable(result);
    if (result.kind === "redirect") return c.json({ redirectTo: result.redirectTo });
    const { request } = result;
    return c.json({
      clientName: request.clientName,
      redirectHost: new URL(request.redirectUri).host,
      scopes: request.scope.split(" "),
    });
  });

  app.post("/oauth/authorize", async (c) => {
    const body = await readJson(c, z.object({ params: z.record(z.string(), z.string()), decision: z.enum(["allow", "deny"]) }));
    const result = await oauth.parseAuthorization(body.params);
    if (result.kind === "fatal") throw unusable(result);
    if (result.kind === "redirect") return c.json({ redirectTo: result.redirectTo });
    const redirectTo = body.decision === "allow" ? await oauth.approve(c.get("principal"), result.request) : oauth.deny(result.request);
    return c.json({ redirectTo });
  });

  app.get("/connections", async (c) => c.json({ connections: await oauth.listConnections(c.get("principal")) }));

  app.delete("/connections/:id", async (c) => {
    if (!(await oauth.disconnect(c.get("principal"), c.req.param("id")))) throw new HttpError(404, "Connection not found");
    return c.body(null, 204);
  });

  return app;
}

export const oauthErrorBody = (error: OAuthError) => ({ error: error.error, error_description: error.message });
