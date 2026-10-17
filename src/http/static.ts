import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

// What the server itself answers; everything else is the web app's files.
export const API_PREFIXES = ["/api/", "/oauth/", "/mcp", "/.well-known/"] as const;
export const isApiPath = (path: string) => API_PREFIXES.some((prefix) => (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`)));

// Kept in step with web/public/_headers, which does the same job for Cloudflare's static assets.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// The built web app (Vite's output) for the Node entry point: files as they are, and index.html
// for any other page, so that the app's own routes (/settings, /join/…) work when opened directly.
export function staticApp(dir: string) {
  const app = new Hono();
  app.use(async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "same-origin");
    c.header("Content-Security-Policy", CSP);
    // Built files have hashed names; the entry page and the service worker must always be re-checked.
    c.header("Cache-Control", c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  });
  app.use(serveStatic({ root: dir }));
  app.get("*", (c, next) => (c.req.path.startsWith("/assets/") ? c.text("Not found", 404) : next()));
  app.get("*", serveStatic({ root: dir, path: "index.html" }));
  app.notFound((c) => c.text("Not found", 404));
  return app;
}
