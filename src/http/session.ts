import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AuthService } from "../auth/service.ts";
import type { Config } from "../config.ts";
import { HttpError, type AppEnv } from "./http.ts";

const MAX_AGE = 30 * 24 * 60 * 60;

// The session cookie: HttpOnly, Lax (so following a link from claude.ai to the consent
// page still carries it), and on https bound to this exact host by the __Host- prefix.
export function sessionCookie(config: Config) {
  const name = config.secureCookies ? "__Host-session" : "session";
  const options = { path: "/", httpOnly: true, secure: config.secureCookies, sameSite: "Lax" } as const;
  return {
    name,
    read: (c: Context) => getCookie(c, name) ?? null,
    set: (c: Context, token: string) => setCookie(c, name, token, { ...options, maxAge: MAX_AGE }),
    clear: (c: Context) => deleteCookie(c, name, options),
  };
}
export type SessionCookie = ReturnType<typeof sessionCookie>;

// Everything below needs a signed-in person.
export const requireUser = (auth: AuthService, cookie: SessionCookie): MiddlewareHandler<AppEnv> => async (c, next) => {
  const token = cookie.read(c);
  const principal = await auth.authenticate(token);
  if (!token || !principal) throw new HttpError(401, "Sign in first");
  c.set("principal", principal);
  c.set("sessionToken", token);
  await next();
};

// Cookies ride along on cross-site requests, so anything that changes state must come
// from this app's own origin. Browsers always send Origin on such requests.
export const sameOriginWrites = (config: Config): MiddlewareHandler => async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("origin") !== config.origin) {
    throw new HttpError(403, "Cross-site request refused");
  }
  await next();
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header("Content-Security-Policy", "frame-ancestors 'none'");
  c.header("X-Frame-Options", "DENY");
};
