import { Hono } from "hono";
import * as z from "zod/mini";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "../auth/webauthn.ts";
import type { AuthService, Principal } from "../auth/service.ts";
import { ROLES } from "../db/schema.ts";
import { ceremony, readJson, type AppEnv } from "./http.ts";
import { requireUser, type SessionCookie } from "./session.ts";

const publicPerson = (p: Principal) => ({
  user: { id: p.userId, displayName: p.displayName, role: p.role },
  household: { id: p.householdId, name: p.householdName },
});

// Signing up, signing in and managing one's own passkeys. Every ceremony is two calls:
// one for the options the browser needs, one for its answer.
export function authRoutes(auth: AuthService, cookie: SessionCookie) {
  const app = new Hono<AppEnv>();
  const user = requireUser(auth, cookie);

  app.get("/setup", async (c) => c.json(await auth.setupStatus()));

  app.post("/setup/options", async (c) => {
    const body = await readJson(c, z.object({ displayName: z.string(), householdName: z.string(), setupToken: z.optional(z.string()) }));
    return c.json(await auth.beginSetup(body));
  });

  app.post("/setup/finish", async (c) => {
    const body = await readJson(c, ceremony);
    const { sessionToken, principal } = await auth.finishSetup({ ...body, response: body.response as unknown as RegistrationResponseJSON });
    cookie.set(c, sessionToken);
    return c.json(publicPerson(principal), 201);
  });

  app.get("/invites/:token", async (c) => c.json(await auth.inspectInvite(c.req.param("token"))));

  app.post("/invites/:token/options", async (c) => {
    const body = await readJson(c, z.object({ displayName: z.optional(z.string()) }));
    return c.json(await auth.beginJoin({ token: c.req.param("token"), displayName: body.displayName }));
  });

  app.post("/join/finish", async (c) => {
    const body = await readJson(c, ceremony);
    const { sessionToken, principal } = await auth.finishJoin({ ...body, response: body.response as unknown as RegistrationResponseJSON });
    cookie.set(c, sessionToken);
    return c.json(publicPerson(principal), 201);
  });

  app.post("/login/options", async (c) => c.json(await auth.beginLogin()));

  app.post("/login/finish", async (c) => {
    const body = await readJson(c, z.object({ challengeId: z.string(), response: z.record(z.string(), z.unknown()) }));
    const { sessionToken, principal } = await auth.finishLogin({ ...body, response: body.response as unknown as AuthenticationResponseJSON });
    cookie.set(c, sessionToken);
    return c.json(publicPerson(principal));
  });

  app.post("/logout", user, async (c) => {
    await auth.logout(c.get("sessionToken"));
    cookie.clear(c);
    return c.body(null, 204);
  });

  app.get("/me", user, (c) => c.json(publicPerson(c.get("principal"))));

  // Admins create invite links; with `forUserId` it is a recovery link for that member.
  app.post("/invites", user, async (c) => {
    const body = await readJson(c, z.object({ role: z.optional(z.enum(ROLES)), forUserId: z.optional(z.string()) }));
    const { token, expiresAt } = await auth.createInvite(c.get("principal"), body);
    return c.json({ path: `/join/${token}`, expiresAt }, 201);
  });

  app.get("/members", user, async (c) => c.json({ members: await auth.listMembers(c.get("principal")) }));

  app.get("/passkeys", user, async (c) => c.json({ passkeys: await auth.listPasskeys(c.get("principal")) }));

  app.post("/passkeys/options", user, async (c) => c.json(await auth.beginAddPasskey(c.get("principal"))));

  app.post("/passkeys/finish", user, async (c) => {
    const body = await readJson(c, ceremony);
    await auth.finishAddPasskey(c.get("principal"), { ...body, response: body.response as unknown as RegistrationResponseJSON });
    return c.json({ passkeys: await auth.listPasskeys(c.get("principal")) }, 201);
  });

  app.delete("/passkeys/:id", user, async (c) => {
    await auth.removePasskey(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
