import { iso } from "../items/json.ts";
import type { Cook, Recipe, RecipeSummary } from "./service.ts";

// The JSON shape of recipes and cook records, shared by the web API and the MCP tools.
// Times are ISO 8601, cook dates stay YYYY-MM-DD; the household is never exposed.
export const recipeJson = (r: Recipe | RecipeSummary) => ({
  id: r.id,
  title: r.title,
  url: r.url,
  ...("body" in r && r.body !== undefined ? { body: r.body } : {}),
  ...("cookCount" in r ? { cookCount: r.cookCount, lastCookedOn: r.lastCookedOn } : {}),
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

export const cookJson = (c: Cook) => ({
  id: c.id,
  recipeId: c.recipeId,
  title: c.title,
  cookedOn: c.cookedOn,
  note: c.note,
  source: c.source,
  recordedAt: iso(c.createdAt),
});
