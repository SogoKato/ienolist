import { Hono } from "hono";
import * as z from "zod/mini";
import type { AuthService, Principal } from "../auth/service.ts";
import type { Actor } from "../items/service.ts";
import { cookJson, recipeJson } from "../recipes/json.ts";
import type { RecipeService } from "../recipes/service.ts";
import { readJson, type AppEnv } from "./http.ts";
import { requireUser, type SessionCookie } from "./session.ts";

const actorOf = (p: Principal): Actor => ({ householdId: p.householdId, userId: p.userId, source: "web" });

// The recipe collection and what was cooked when, for the signed-in household.
// Validation is the recipe service's; the shapes here only keep the types honest.
export function recipeRoutes(auth: AuthService, recipes: RecipeService, cookie: SessionCookie) {
  const app = new Hono<AppEnv>();
  const user = requireUser(auth, cookie);
  // "/recipes/*" also matches "/recipes"; mounting both would look the session up twice.
  app.use("/recipes/*", user);
  app.use("/cooks/*", user);

  app.get("/recipes", async (c) => {
    const list = await recipes.list(actorOf(c.get("principal")), { query: c.req.query("q") });
    return c.json({ recipes: list.map(recipeJson) });
  });

  app.post("/recipes", async (c) => {
    const body = await readJson(c, z.object({ title: z.string(), url: z.optional(z.nullable(z.string())), body: z.optional(z.nullable(z.string())) }));
    return c.json(recipeJson(await recipes.create(actorOf(c.get("principal")), body)), 201);
  });

  app.get("/recipes/:id", async (c) => c.json(recipeJson(await recipes.get(actorOf(c.get("principal")), c.req.param("id")))));

  app.patch("/recipes/:id", async (c) => {
    const body = await readJson(c, z.object({ title: z.optional(z.string()), url: z.optional(z.nullable(z.string())), body: z.optional(z.nullable(z.string())) }));
    return c.json(recipeJson(await recipes.update(actorOf(c.get("principal")), c.req.param("id"), body)));
  });

  app.delete("/recipes/:id", async (c) => {
    await recipes.delete(actorOf(c.get("principal")), c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/recipes/:id/cooks", async (c) => {
    const cooks = await recipes.cooks(actorOf(c.get("principal")), { recipeId: c.req.param("id") });
    return c.json({ cooks: cooks.map(cookJson) });
  });

  // The date is the browser's local day, so it is sent rather than taken from the server clock.
  app.post("/recipes/:id/cooks", async (c) => {
    const body = await readJson(c, z.object({ cookedOn: z.string(), note: z.optional(z.nullable(z.string())) }));
    const cook = await recipes.recordCook(actorOf(c.get("principal")), { recipeId: c.req.param("id"), ...body });
    return c.json(cookJson(cook), 201);
  });

  app.delete("/cooks/:id", async (c) => {
    await recipes.deleteCook(actorOf(c.get("principal")), c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
