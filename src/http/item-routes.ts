import { Hono } from "hono";
import * as z from "zod/mini";
import type { AuthService, Principal } from "../auth/service.ts";
import { eventJson, itemJson } from "../items/json.ts";
import type { Actor, ItemService } from "../items/service.ts";
import { readJson, type AppEnv } from "./http.ts";
import { requireUser, type SessionCookie } from "./session.ts";

const actorOf = (p: Principal): Actor => ({ householdId: p.householdId, userId: p.userId, source: "web" });

// The lists, for the signed-in household. Validation of names, statuses and lists is the
// item service's; the shapes here only keep the types honest.
export function itemRoutes(auth: AuthService, items: ItemService, cookie: SessionCookie) {
  const app = new Hono<AppEnv>();
  const user = requireUser(auth, cookie);
  app.use("/items", user);
  app.use("/items/*", user);
  app.use("/events", user);

  app.get("/items", async (c) => {
    const list = await items.list(actorOf(c.get("principal")), { list: c.req.query("list"), status: c.req.query("status") });
    return c.json({ items: list.map(itemJson) });
  });

  app.post("/items", async (c) => {
    const body = await readJson(c, z.object({ list: z.string(), name: z.string(), note: z.optional(z.nullable(z.string())), status: z.optional(z.string()) }));
    return c.json(itemJson(await items.create(actorOf(c.get("principal")), body)), 201);
  });

  app.get("/items/:id", async (c) => c.json(itemJson(await items.get(actorOf(c.get("principal")), c.req.param("id")))));

  app.patch("/items/:id", async (c) => {
    const body = await readJson(c, z.object({ name: z.optional(z.string()), status: z.optional(z.string()), note: z.optional(z.nullable(z.string())) }));
    return c.json(itemJson(await items.update(actorOf(c.get("principal")), c.req.param("id"), body)));
  });

  app.post("/items/:id/move", async (c) => {
    const body = await readJson(c, z.object({ to: z.string() }));
    return c.json(itemJson(await items.move(actorOf(c.get("principal")), c.req.param("id"), body.to)));
  });

  app.delete("/items/:id", async (c) => {
    await items.delete(actorOf(c.get("principal")), c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/events", async (c) => {
    const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
    const events = await items.events(actorOf(c.get("principal")), {
      itemId: c.req.query("itemId"),
      since: num(c.req.query("since")),
      limit: num(c.req.query("limit")),
    });
    return c.json({ events: events.map(eventJson) });
  });

  return app;
}
