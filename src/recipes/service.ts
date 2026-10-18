import { and, desc, eq, gte, sql } from "drizzle-orm";
import { BODY_MAX, NOTE_MAX, TITLE_MAX, URL_MAX, recipeCooks, recipes } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import type { Actor } from "../items/service.ts";
import { monotonicUlid } from "../lib/ulid.ts";

export type Recipe = typeof recipes.$inferSelect;
export type Cook = typeof recipeCooks.$inferSelect;
// A recipe as listed: how often and when it was last cooked, and the body only when asked for.
export type RecipeSummary = Omit<Recipe, "body"> & { body?: string | null; cookCount: number; lastCookedOn: string | null };

export class RecipeError extends Error {
  readonly code: "not_found" | "invalid";
  constructor(code: "not_found" | "invalid", message: string) {
    super(message);
    this.code = code;
  }
}
const invalid = (message: string) => new RecipeError("invalid", message);

export const QUERY_MAX = 200;

function checkTitle(title: unknown): string {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (trimmed.length === 0 || trimmed.length > TITLE_MAX) throw invalid(`title must be 1-${TITLE_MAX} characters`);
  return trimmed;
}

// Empty and null both clear the URL. Only web pages: http or https.
function checkUrl(url: unknown): string | null {
  if (url === null || url === undefined) return null;
  if (typeof url !== "string") throw invalid("url must be text or null");
  const trimmed = url.trim();
  if (trimmed === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw invalid("url must be an http or https URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw invalid("url must be an http or https URL");
  if (trimmed.length > URL_MAX) throw invalid(`url must be at most ${URL_MAX} characters`);
  return trimmed;
}

// Empty and null both clear the text.
function checkText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalid(`${field} must be text or null`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(`${field} must be at most ${max} characters`);
  return trimmed === "" ? null : trimmed;
}

// A real calendar date, YYYY-MM-DD.
export function checkDate(value: unknown, field = "cookedOn"): string {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (match) {
    const [y, m, d] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) return value as string;
  }
  throw invalid(`${field} must be a date, YYYY-MM-DD`);
}

// For LIKE ... ESCAPE '\': the search text is matched literally.
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export type Deps = { now?: () => number; newId?: () => string };

export function createRecipeService(db: Db, deps: Deps = {}) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const newId = deps.newId ?? monotonicUlid();

  const scoped = (actor: Actor, id: string) => and(eq(recipes.id, id), eq(recipes.householdId, actor.householdId));
  // Spelled out: in a single-table select drizzle leaves column names unqualified, and an
  // unqualified "id" inside the subquery would be recipe_cooks.id.
  const cookCount = sql<number>`(SELECT COUNT(*) FROM "recipe_cooks" c WHERE c."recipe_id" = "recipes"."id")`;
  const lastCookedOn = sql<string | null>`(SELECT MAX(c."cooked_on") FROM "recipe_cooks" c WHERE c."recipe_id" = "recipes"."id")`;
  const summaryColumns = {
    id: recipes.id,
    householdId: recipes.householdId,
    title: recipes.title,
    url: recipes.url,
    addedBy: recipes.addedBy,
    createdAt: recipes.createdAt,
    updatedAt: recipes.updatedAt,
    cookCount,
    lastCookedOn,
  };

  async function find(actor: Actor, id: string): Promise<Recipe> {
    const [row] = await db.select().from(recipes).where(scoped(actor, id)).limit(1);
    if (!row) throw new RecipeError("not_found", "Recipe not found");
    return row;
  }

  return {
    // Most recently changed first. `query` matches the title or the text, literally.
    async list(actor: Actor, filter: { query?: string; withBody?: boolean } = {}): Promise<RecipeSummary[]> {
      const query = filter.query?.trim() ?? "";
      if (query.length > QUERY_MAX) throw invalid(`query must be at most ${QUERY_MAX} characters`);
      const pattern = `%${likeEscape(query)}%`;
      return db
        .select(filter.withBody ? { ...summaryColumns, body: recipes.body } : summaryColumns)
        .from(recipes)
        .where(
          and(
            eq(recipes.householdId, actor.householdId),
            query ? sql`(${recipes.title} LIKE ${pattern} ESCAPE '\\' OR ${recipes.body} LIKE ${pattern} ESCAPE '\\')` : undefined,
          ),
        )
        .orderBy(desc(recipes.updatedAt), desc(recipes.id));
    },

    async get(actor: Actor, id: string): Promise<Recipe & { cookCount: number; lastCookedOn: string | null }> {
      const [row] = await db
        .select({ ...summaryColumns, body: recipes.body })
        .from(recipes)
        .where(scoped(actor, id))
        .limit(1);
      if (!row) throw new RecipeError("not_found", "Recipe not found");
      return row;
    },

    async create(actor: Actor, input: { title: string; url?: string | null; body?: string | null }): Promise<Recipe> {
      const t = now();
      const recipe: Recipe = {
        id: newId(),
        householdId: actor.householdId,
        title: checkTitle(input.title),
        url: checkUrl(input.url),
        body: checkText(input.body, "body", BODY_MAX),
        addedBy: actor.userId,
        createdAt: t,
        updatedAt: t,
      };
      await db.insert(recipes).values(recipe);
      return recipe;
    },

    // Only the given fields change; null or empty clears the URL or the text.
    async update(actor: Actor, id: string, patch: { title?: string; url?: string | null; body?: string | null }): Promise<Recipe> {
      if (patch.title === undefined && patch.url === undefined && patch.body === undefined) {
        throw invalid("Nothing to update: give a title, url or body");
      }
      const changes: Partial<Recipe> = {};
      if (patch.title !== undefined) changes.title = checkTitle(patch.title);
      if (patch.url !== undefined) changes.url = checkUrl(patch.url);
      if (patch.body !== undefined) changes.body = checkText(patch.body, "body", BODY_MAX);
      changes.updatedAt = now();
      const [row] = await db.update(recipes).set(changes).where(scoped(actor, id)).returning();
      if (!row) throw new RecipeError("not_found", "Recipe not found");
      return row;
    },

    // The cook records stay, without the link to the recipe.
    async delete(actor: Actor, id: string): Promise<void> {
      const [row] = await db.delete(recipes).where(scoped(actor, id)).returning({ id: recipes.id });
      if (!row) throw new RecipeError("not_found", "Recipe not found");
    },

    async recordCook(actor: Actor, input: { recipeId: string; cookedOn: string; note?: string | null }): Promise<Cook> {
      const cookedOn = checkDate(input.cookedOn);
      const note = checkText(input.note, "note", NOTE_MAX);
      const recipe = await find(actor, input.recipeId);
      const cook: Cook = {
        id: newId(),
        householdId: actor.householdId,
        recipeId: recipe.id,
        title: recipe.title,
        cookedOn,
        note,
        userId: actor.userId,
        source: actor.source,
        clientId: actor.clientId ?? null,
        createdAt: now(),
      };
      await db.insert(recipeCooks).values(cook);
      return cook;
    },

    // Newest first (by the day cooked, then by when it was recorded).
    async cooks(actor: Actor, filter: { recipeId?: string; since?: string; limit?: number } = {}): Promise<Cook[]> {
      const since = filter.since === undefined ? undefined : checkDate(filter.since, "since");
      const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), 500);
      return db
        .select()
        .from(recipeCooks)
        .where(
          and(
            eq(recipeCooks.householdId, actor.householdId),
            filter.recipeId !== undefined ? eq(recipeCooks.recipeId, filter.recipeId) : undefined,
            since !== undefined ? gte(recipeCooks.cookedOn, since) : undefined,
          ),
        )
        .orderBy(desc(recipeCooks.cookedOn), desc(recipeCooks.id))
        .limit(limit);
    },

    async deleteCook(actor: Actor, id: string): Promise<void> {
      const [row] = await db
        .delete(recipeCooks)
        .where(and(eq(recipeCooks.id, id), eq(recipeCooks.householdId, actor.householdId)))
        .returning({ id: recipeCooks.id });
      if (!row) throw new RecipeError("not_found", "Cook record not found");
    },
  };
}

export type RecipeService = ReturnType<typeof createRecipeService>;
