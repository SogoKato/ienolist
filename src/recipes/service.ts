import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { BODY_MAX, NOTE_MAX, PAGE_MAX, TAG_MAX, TAGS_PER_RECIPE, TITLE_MAX, URL_MAX, books, recipeCooks, recipeTags, recipes } from "../db/schema.ts";
import { atomically, type Db } from "../db/types.ts";
import type { Actor } from "../items/service.ts";
import { monotonicUlid } from "../lib/ulid.ts";

export type Recipe = typeof recipes.$inferSelect;
export type Cook = typeof recipeCooks.$inferSelect;
export type Book = typeof books.$inferSelect & { recipeCount: number };
// A recipe as listed: its book's title and its tags, how often and when it was last cooked,
// and the body only when asked for.
export type RecipeSummary = Omit<Recipe, "body"> & {
  body?: string | null;
  bookTitle: string | null;
  tags: string[];
  cookCount: number;
  lastCookedOn: string | null;
};
export type RecipeDetail = RecipeSummary & { body: string | null };

// What a recipe is made of when it is written. The book is given by its title: an existing
// book of that title is used, otherwise one is added.
export type RecipeInput = { title: string; url?: string | null; body?: string | null; book?: string | null; page?: string | null; tags?: string[] };
export type RecipePatch = Partial<RecipeInput>;

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

// A tag is one word-like label: no spaces or commas, so that a list of them can be typed in one
// field. A leading # is dropped, since people write tags that way.
function checkTag(value: unknown): string {
  const tag = typeof value === "string" ? value.trim().replace(/^#+/, "") : "";
  if (tag.length === 0 || tag.length > TAG_MAX) throw invalid(`a tag must be 1-${TAG_MAX} characters`);
  if (/[\s,、，]/.test(tag)) throw invalid(`a tag must not contain spaces or commas: ${tag}`);
  return tag;
}

function checkTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalid("tags must be a list");
  const tags = [...new Set(value.map(checkTag))];
  if (tags.length > TAGS_PER_RECIPE) throw invalid(`a recipe can have at most ${TAGS_PER_RECIPE} tags`);
  return tags;
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
  const bookTitle = sql<string | null>`(SELECT b."title" FROM "books" b WHERE b."id" = "recipes"."book_id")`;
  const tags = sql<string[]>`(SELECT json_group_array(t."tag") FROM "recipe_tags" t WHERE t."recipe_id" = "recipes"."id")`.mapWith(
    (json: string) => (JSON.parse(json) as string[]).sort(),
  );
  const hasTag = (tag: string) => sql`EXISTS (SELECT 1 FROM "recipe_tags" t WHERE t."recipe_id" = "recipes"."id" AND t."tag" = ${tag})`;
  const summaryColumns = {
    id: recipes.id,
    householdId: recipes.householdId,
    title: recipes.title,
    url: recipes.url,
    bookId: recipes.bookId,
    bookTitle,
    page: recipes.page,
    tags,
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

  const detail = (actor: Actor, id: string) =>
    db
      .select({ ...summaryColumns, body: recipes.body })
      .from(recipes)
      .where(scoped(actor, id))
      .limit(1);

  // The book's id by its title, for use inside the same batch that adds the book if needed.
  const bookIdByTitle = (actor: Actor, title: string) =>
    sql`(SELECT b."id" FROM "books" b WHERE b."household_id" = ${actor.householdId} AND b."title" = ${title})`;

  // Writes the recipe (insert or update), its book and its tags in one batch, and reads it back.
  async function write(
    actor: Actor,
    id: string,
    recipeWrite: (bookId: unknown) => BatchItem<"sqlite">,
    book: string | null | undefined,
    tagList: string[] | undefined,
    replaceTags: boolean,
  ) {
    const statements: BatchItem<"sqlite">[] = [];
    if (book) {
      statements.push(db.insert(books).values({ id: newId(), householdId: actor.householdId, title: book, createdAt: now() }).onConflictDoNothing());
    }
    statements.push(recipeWrite(book ? bookIdByTitle(actor, book) : book));
    if (tagList !== undefined) {
      if (replaceTags) statements.push(db.delete(recipeTags).where(eq(recipeTags.recipeId, id)));
      if (tagList.length > 0) statements.push(db.insert(recipeTags).values(tagList.map((tag) => ({ recipeId: id, householdId: actor.householdId, tag }))));
    }
    statements.push(detail(actor, id));
    const results = (await atomically(db, statements)) as unknown[];
    const [row] = results[results.length - 1] as RecipeDetail[];
    return row;
  }

  return {
    // Most recently changed first. `query` matches the title or the text, literally; with `tags`,
    // only recipes that have all of them; with `bookId`, only that book's.
    async list(actor: Actor, filter: { query?: string; withBody?: boolean; tags?: string[]; bookId?: string } = {}): Promise<RecipeSummary[]> {
      const query = filter.query?.trim() ?? "";
      if (query.length > QUERY_MAX) throw invalid(`query must be at most ${QUERY_MAX} characters`);
      const pattern = `%${likeEscape(query)}%`;
      const wanted = filter.tags === undefined ? [] : checkTags(filter.tags);
      return db
        .select(filter.withBody ? { ...summaryColumns, body: recipes.body } : summaryColumns)
        .from(recipes)
        .where(
          and(
            eq(recipes.householdId, actor.householdId),
            query ? sql`(${recipes.title} LIKE ${pattern} ESCAPE '\\' OR ${recipes.body} LIKE ${pattern} ESCAPE '\\')` : undefined,
            filter.bookId !== undefined ? eq(recipes.bookId, filter.bookId) : undefined,
            ...wanted.map(hasTag),
          ),
        )
        .orderBy(desc(recipes.updatedAt), desc(recipes.id));
    },

    async get(actor: Actor, id: string): Promise<RecipeDetail> {
      const [row] = await detail(actor, id);
      if (!row) throw new RecipeError("not_found", "Recipe not found");
      return row;
    },

    async create(actor: Actor, input: RecipeInput): Promise<RecipeDetail> {
      const t = now();
      const id = newId();
      const book = input.book === undefined ? null : checkText(input.book, "book", TITLE_MAX);
      const page = checkText(input.page, "page", PAGE_MAX);
      if (page && !book) throw invalid("page needs a book");
      const values = {
        id,
        householdId: actor.householdId,
        title: checkTitle(input.title),
        url: checkUrl(input.url),
        body: checkText(input.body, "body", BODY_MAX),
        page,
        addedBy: actor.userId,
        createdAt: t,
        updatedAt: t,
      };
      const tagList = input.tags === undefined ? undefined : checkTags(input.tags);
      return write(actor, id, (bookId) => db.insert(recipes).values({ ...values, bookId: (bookId ?? null) as string | null }), book, tagList, false);
    },

    // Only the given fields change; null or empty clears the URL, the text, the book or the page.
    // Tags, when given, replace the recipe's tags. Taking the book away takes the page with it.
    async update(actor: Actor, id: string, patch: RecipePatch): Promise<RecipeDetail> {
      if (Object.values(patch).every((v) => v === undefined)) {
        throw invalid("Nothing to update: give a title, url, body, book, page or tags");
      }
      const current = await find(actor, id);
      const changes: Partial<Recipe> = {};
      if (patch.title !== undefined) changes.title = checkTitle(patch.title);
      if (patch.url !== undefined) changes.url = checkUrl(patch.url);
      if (patch.body !== undefined) changes.body = checkText(patch.body, "body", BODY_MAX);
      const book = patch.book === undefined ? undefined : checkText(patch.book, "book", TITLE_MAX);
      if (patch.page !== undefined) changes.page = checkText(patch.page, "page", PAGE_MAX);
      if (book === null) changes.page = null;
      const hasBook = book === undefined ? current.bookId !== null : book !== null;
      if (changes.page && !hasBook) throw invalid("page needs a book");
      const tagList = patch.tags === undefined ? undefined : checkTags(patch.tags);
      changes.updatedAt = now();
      return write(
        actor,
        id,
        (bookId) => db.update(recipes).set(book === undefined ? changes : { ...changes, bookId: bookId as string | null }).where(scoped(actor, id)),
        book,
        tagList,
        true,
      );
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

    // --- books and tags ---

    // By title, with how many recipes come from each.
    async books(actor: Actor): Promise<Book[]> {
      return db
        .select({
          id: books.id,
          householdId: books.householdId,
          title: books.title,
          createdAt: books.createdAt,
          recipeCount: sql<number>`(SELECT COUNT(*) FROM "recipes" r WHERE r."book_id" = "books"."id")`,
        })
        .from(books)
        .where(eq(books.householdId, actor.householdId))
        .orderBy(asc(books.title));
    },

    async renameBook(actor: Actor, id: string, title: string): Promise<void> {
      const newTitle = checkTitle(title);
      const [taken] = await db
        .select({ id: books.id })
        .from(books)
        .where(and(eq(books.householdId, actor.householdId), eq(books.title, newTitle)))
        .limit(1);
      if (taken && taken.id !== id) throw invalid(`There is already a book called ${newTitle}`);
      const [row] = await db
        .update(books)
        .set({ title: newTitle })
        .where(and(eq(books.id, id), eq(books.householdId, actor.householdId)))
        .returning({ id: books.id });
      if (!row) throw new RecipeError("not_found", "Book not found");
    },

    // Its recipes stay, without the book or the page.
    async deleteBook(actor: Actor, id: string): Promise<void> {
      const results = (await atomically(db, [
        db.update(recipes).set({ bookId: null, page: null }).where(and(eq(recipes.bookId, id), eq(recipes.householdId, actor.householdId))),
        db.delete(books).where(and(eq(books.id, id), eq(books.householdId, actor.householdId))).returning({ id: books.id }),
      ])) as unknown[];
      if ((results[1] as unknown[]).length === 0) throw new RecipeError("not_found", "Book not found");
    },

    // Most used first, with how many recipes have each.
    async tags(actor: Actor): Promise<{ tag: string; recipeCount: number }[]> {
      return db
        .select({ tag: recipeTags.tag, recipeCount: sql<number>`COUNT(*)` })
        .from(recipeTags)
        .where(eq(recipeTags.householdId, actor.householdId))
        .groupBy(recipeTags.tag)
        .orderBy(desc(sql`COUNT(*)`), asc(recipeTags.tag));
    },

    // Renames a tag on every recipe that has it; renaming onto an existing tag merges the two.
    async renameTag(actor: Actor, from: string, to: string): Promise<{ recipeCount: number }> {
      const [oldTag, newTag] = [checkTag(from), checkTag(to)];
      if (oldTag === newTag) throw invalid("The new tag is the same as the old one");
      const mine = and(eq(recipeTags.householdId, actor.householdId), eq(recipeTags.tag, oldTag));
      const results = (await atomically(db, [
        db
          .insert(recipeTags)
          .select(
            db
              .select({ recipeId: recipeTags.recipeId, householdId: recipeTags.householdId, tag: sql`${newTag}`.as("tag") })
              .from(recipeTags)
              .where(mine),
          )
          .onConflictDoNothing(),
        db.delete(recipeTags).where(mine).returning({ recipeId: recipeTags.recipeId }),
      ])) as unknown[];
      const recipeCount = (results[1] as unknown[]).length;
      if (recipeCount === 0) throw new RecipeError("not_found", `No recipe has the tag ${oldTag}`);
      return { recipeCount };
    },
  };
}

export type RecipeService = ReturnType<typeof createRecipeService>;
