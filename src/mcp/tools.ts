import * as z from "zod/mini";
import { BODY_MAX, FRIDGE_STATUSES, LISTS, NAME_MAX, NOTE_MAX, PAGE_MAX, SHOPPING_STATUSES, TAG_MAX, TAGS_PER_RECIPE, TITLE_MAX, URL_MAX } from "../db/schema.ts";
import { eventJson, itemJson } from "../items/json.ts";
import { ItemError, type Actor, type ItemService } from "../items/service.ts";
import { bookJson, cookJson, recipeJson } from "../recipes/json.ts";
import { QUERY_MAX, RecipeError, type RecipeService } from "../recipes/service.ts";
import { defineTool, type ToolDef, type ToolResult } from "./registry.ts";

export type Ctx = { items: ItemService; recipes: RecipeService; actor: Actor };

export const SCOPE_READ = "items:read";
export const SCOPE_WRITE = "items:write";
export const SCOPE_RECIPES_READ = "recipes:read";
export const SCOPE_RECIPES_WRITE = "recipes:write";

const result = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const list = z.enum(LISTS);
const status = z.enum([...SHOPPING_STATUSES, ...FRIDGE_STATUSES]);
const id = z.string().check(z.minLength(1), z.maxLength(64), z.describe("Item id, as returned by list_items or create_item."));

const STATUS_HELP =
  "Statuses: shopping list = to_buy (still to buy) or bought (already in the cart, kept on the list so the remaining items stay visible); " +
  "fridge = in_stock (at home) or used_up (finished). Changing a status never moves an item to the other list; use move_item for that.";

const listItems = defineTool<Ctx, any>({
  name: "list_items",
  description:
    "List the household's items, oldest first. Two lists: 'shopping' (what to buy) and 'fridge' (what is at home, to avoid buying it twice). " +
    STATUS_HELP,
  scope: SCOPE_READ,
  annotations: { readOnlyHint: true },
  input: z.object({
    list: z.optional(list.check(z.describe("Only this list. Omit for both."))),
    status: z.optional(status.check(z.describe("Only this status. Must belong to the list, when one is given."))),
  }),
  async handler(args, { items, actor }) {
    return result({ items: (await items.list(actor, args)).map(itemJson) });
  },
});

const getItem = defineTool<Ctx, any>({
  name: "get_item",
  description: "Get one item by id.",
  scope: SCOPE_READ,
  annotations: { readOnlyHint: true },
  input: z.object({ id }),
  async handler(args, { items, actor }) {
    return result(itemJson(await items.get(actor, args.id)));
  },
});

const createItem = defineTool<Ctx, any>({
  name: "create_item",
  description:
    "Add an item to a list. It starts as to_buy (shopping) or in_stock (fridge) unless a status is given. " +
    "Before adding to the shopping list, check the fridge with list_items so nothing is bought twice. " +
    STATUS_HELP,
  scope: SCOPE_WRITE,
  annotations: { destructiveHint: false },
  input: z.object({
    list,
    name: z.string().check(z.minLength(1), z.maxLength(NAME_MAX), z.describe("What the item is, e.g. the product name.")),
    note: z.optional(z.string().check(z.maxLength(NOTE_MAX), z.describe("Free text, e.g. a recipe name or URL this is for."))),
    status: z.optional(status.check(z.describe("Initial status. Defaults to to_buy / in_stock."))),
  }),
  async handler(args, { items, actor }) {
    return result(itemJson(await items.create(actor, args)));
  },
});

const updateItem = defineTool<Ctx, any>({
  name: "update_item",
  description:
    "Change an item's name, status or note; only the given fields change. The previous values stay in the history (list_events). " +
    "Use this to check things off (shopping: bought) or mark them finished (fridge: used_up). " +
    STATUS_HELP,
  scope: SCOPE_WRITE,
  annotations: { destructiveHint: false },
  input: z.object({
    id,
    name: z.optional(z.string().check(z.minLength(1), z.maxLength(NAME_MAX))),
    status: z.optional(status.check(z.describe("Must be a status of the list the item is on."))),
    note: z.optional(z.nullable(z.string().check(z.maxLength(NOTE_MAX))).check(z.describe("New note. null or empty clears it."))),
  }),
  async handler({ id, ...patch }, { items, actor }) {
    return result(itemJson(await items.update(actor, id, patch)));
  },
});

const deleteItem = defineTool<Ctx, any>({
  name: "delete_item",
  description: "Delete an item permanently. Its history (list_events) is kept.",
  scope: SCOPE_WRITE,
  annotations: { destructiveHint: true },
  input: z.object({ id }),
  async handler(args, { items, actor }) {
    await items.delete(actor, args.id);
    return result({ deleted: args.id });
  },
});

const moveItem = defineTool<Ctx, any>({
  name: "move_item",
  description:
    "Move an item to the other list, e.g. a used-up fridge item you want to buy again goes to the shopping list (as to_buy), " +
    "or something bought goes into the fridge (as in_stock). It is the same item, with its history. Checking an item off never moves it.",
  scope: SCOPE_WRITE,
  annotations: { destructiveHint: false },
  input: z.object({ id, to: list.check(z.describe("The list to move it to.")) }),
  async handler(args, { items, actor }) {
    return result(itemJson(await items.move(actor, args.id, args.to)));
  },
});

const listEvents = defineTool<Ctx, any>({
  name: "list_events",
  description:
    "The history of changes (created, renamed, status_changed, note_changed, moved, deleted), newest first. " +
    "Useful for what is bought often, what ran out, or who changed what. Deleted items keep their events.",
  scope: SCOPE_READ,
  annotations: { readOnlyHint: true },
  input: z.object({
    itemId: z.optional(z.string().check(z.describe("Only the history of this item."))),
    since: z.optional(z.iso.datetime().check(z.describe("Only events at or after this time, ISO 8601, e.g. 2026-10-01T00:00:00Z."))),
    limit: z.optional(z.int().check(z.minimum(1), z.maximum(500), z.describe("Default 100."))),
  }),
  async handler({ itemId, since, limit }, { items, actor }) {
    const events = await items.events(actor, {
      itemId,
      since: since === undefined ? undefined : Math.floor(Date.parse(since) / 1000),
      limit,
    });
    return result({ events: events.map(eventJson) });
  },
});

// --- recipes -------------------------------------------------------------------

const RECIPE_HELP =
  "Recipes are the household's own collection: a title with a link and/or free text (ingredients, steps, notes, as they wrote them; nothing is structured), " +
  "where it came from (the link, or a book and page), and tags. The app never fetches the link.";
const TAG_HELP =
  "Tags are the household's own labels; reuse the ones they have (list_tags) rather than inventing near-duplicates. " +
  "They are for the kind of dish (e.g. 主菜, 副菜, 汁物, 主食, おやつ), the effort or method (時短, レンジ, オーブン, 揚げ物, 煮込み), " +
  "keeping (作り置き, 冷凍可, 弁当) and season (夏, 冬). Ingredients and seasonings are not tags: search the text for them instead.";
const tag = z.string().check(z.minLength(1), z.maxLength(TAG_MAX));
const tagList = (description: string) => z.array(tag).check(z.maxLength(TAGS_PER_RECIPE), z.describe(description));
const book = z.string().check(z.maxLength(TITLE_MAX));
const page = z.string().check(z.maxLength(PAGE_MAX));
const bookId = z.string().check(z.minLength(1), z.maxLength(64), z.describe("Book id, as returned by list_books or in a recipe's book."));
const recipeId = z.string().check(z.minLength(1), z.maxLength(64), z.describe("Recipe id, as returned by list_recipes or create_recipe."));
const date = (description: string) => z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/), z.describe(description));

const listRecipes = defineTool<Ctx, any>({
  name: "list_recipes",
  description:
    "List the household's recipes, most recently changed first, with how many times each was cooked and when last (lastCookedOn). " +
    "The text is left out unless withBody is true; use get_recipe for one. " +
    RECIPE_HELP,
  scope: SCOPE_RECIPES_READ,
  annotations: { readOnlyHint: true },
  input: z.object({
    query: z.optional(z.string().check(z.maxLength(QUERY_MAX), z.describe("Only recipes whose title or text contains this, e.g. an ingredient."))),
    tags: z.optional(tagList("Only recipes that have all of these tags.")),
    bookId: z.optional(bookId.check(z.describe("Only recipes from this book."))),
    withBody: z.optional(z.boolean().check(z.describe("Include each recipe's text, e.g. to match ingredients against the fridge. Default false."))),
  }),
  async handler(args, { recipes, actor }) {
    return result({ recipes: (await recipes.list(actor, args)).map(recipeJson) });
  },
});

const getRecipe = defineTool<Ctx, any>({
  name: "get_recipe",
  description: "Get one recipe with its text, link or book and page, tags, and how often and when it was last cooked.",
  scope: SCOPE_RECIPES_READ,
  annotations: { readOnlyHint: true },
  input: z.object({ id: recipeId }),
  async handler(args, { recipes, actor }) {
    return result(recipeJson(await recipes.get(actor, args.id)));
  },
});

const createRecipe = defineTool<Ctx, any>({
  name: "create_recipe",
  description:
    "Add a recipe. " +
    RECIPE_HELP +
    " When saving one from a web page, keep the link as the source and write only what the household wants to remember (their changes, a short summary); do not copy the whole page." +
    " When saving one from a book (e.g. from a photo of a page), give the book's title and the page, reusing the exact title of a book they already have (list_books); the text can hold what is needed to cook it. " +
    TAG_HELP,
  scope: SCOPE_RECIPES_WRITE,
  annotations: { destructiveHint: false },
  input: z.object({
    title: z.string().check(z.minLength(1), z.maxLength(TITLE_MAX), z.describe("The dish, e.g. チキンカレー.")),
    url: z.optional(z.string().check(z.maxLength(URL_MAX), z.describe("Where the recipe is, http or https."))),
    body: z.optional(z.string().check(z.maxLength(BODY_MAX), z.describe("Free text: ingredients, steps, notes."))),
    book: z.optional(book.check(z.describe("The book (or booklet, magazine) it is from, by title. A new title adds a book."))),
    page: z.optional(page.check(z.describe("The page in the book, e.g. 42 or 42-43. Needs a book."))),
    tags: z.optional(tagList("Tags, each without spaces or commas.")),
  }),
  async handler(args, { recipes, actor }) {
    return result(recipeJson(await recipes.create(actor, args)));
  },
});

const updateRecipe = defineTool<Ctx, any>({
  name: "update_recipe",
  description:
    "Change a recipe; only the given fields change. A new text replaces the old one entirely, and new tags replace all of its tags " +
    "(to add one, give the current tags plus the new one). Removing the book removes the page. " +
    TAG_HELP,
  scope: SCOPE_RECIPES_WRITE,
  annotations: { destructiveHint: false },
  input: z.object({
    id: recipeId,
    title: z.optional(z.string().check(z.minLength(1), z.maxLength(TITLE_MAX))),
    url: z.optional(z.nullable(z.string().check(z.maxLength(URL_MAX))).check(z.describe("New link. null or empty removes it."))),
    body: z.optional(z.nullable(z.string().check(z.maxLength(BODY_MAX))).check(z.describe("New text. null or empty clears it."))),
    book: z.optional(z.nullable(book).check(z.describe("The book it is from, by title (a new title adds a book). null removes it."))),
    page: z.optional(z.nullable(page).check(z.describe("The page in the book. null removes it."))),
    tags: z.optional(tagList("All of its tags from now on. [] removes them all.")),
  }),
  async handler({ id, ...patch }, { recipes, actor }) {
    return result(recipeJson(await recipes.update(actor, id, patch)));
  },
});

const deleteRecipe = defineTool<Ctx, any>({
  name: "delete_recipe",
  description: "Delete a recipe permanently. Its cook records stay (list_cooks), under the title they were cooked as.",
  scope: SCOPE_RECIPES_WRITE,
  annotations: { destructiveHint: true },
  input: z.object({ id: recipeId }),
  async handler(args, { recipes, actor }) {
    await recipes.delete(actor, args.id);
    return result({ deleted: args.id });
  },
});

const recordCook = defineTool<Ctx, any>({
  name: "record_cook",
  description:
    "Record that the household cooked a recipe on a day. Several records per recipe are normal; they show what is made again and again. " +
    "Use the household's local date (if they cooked it today, today's date where they are).",
  scope: SCOPE_RECIPES_WRITE,
  annotations: { destructiveHint: false },
  input: z.object({
    recipeId,
    cookedOn: date("The day it was cooked, YYYY-MM-DD."),
    note: z.optional(z.string().check(z.maxLength(NOTE_MAX), z.describe("e.g. what was changed this time, or how it turned out."))),
  }),
  async handler(args, { recipes, actor }) {
    return result(cookJson(await recipes.recordCook(actor, args)));
  },
});

const listCooks = defineTool<Ctx, any>({
  name: "list_cooks",
  description:
    "What was cooked when, newest day first. Records of deleted recipes stay, with recipeId null. " +
    "Useful for what was made recently, what is a regular, or what has not been made for a while.",
  scope: SCOPE_RECIPES_READ,
  annotations: { readOnlyHint: true },
  input: z.object({
    recipeId: z.optional(recipeId.check(z.describe("Only this recipe."))),
    since: z.optional(date("Only days on or after this one, YYYY-MM-DD.")),
    limit: z.optional(z.int().check(z.minimum(1), z.maximum(500), z.describe("Default 100."))),
  }),
  async handler(args, { recipes, actor }) {
    return result({ cooks: (await recipes.cooks(actor, args)).map(cookJson) });
  },
});

const deleteCook = defineTool<Ctx, any>({
  name: "delete_cook",
  description: "Delete one cook record, e.g. one recorded by mistake.",
  scope: SCOPE_RECIPES_WRITE,
  annotations: { destructiveHint: true },
  input: z.object({ id: z.string().check(z.minLength(1), z.maxLength(64), z.describe("Cook record id, as returned by record_cook or list_cooks.")) }),
  async handler(args, { recipes, actor }) {
    await recipes.deleteCook(actor, args.id);
    return result({ deleted: args.id });
  },
});

const listTags = defineTool<Ctx, any>({
  name: "list_tags",
  description: "The tags in use, most used first, with how many recipes have each. " + TAG_HELP,
  scope: SCOPE_RECIPES_READ,
  annotations: { readOnlyHint: true },
  input: z.object({}),
  async handler(_args, { recipes, actor }) {
    return result({ tags: await recipes.tags(actor) });
  },
});

const renameTag = defineTool<Ctx, any>({
  name: "rename_tag",
  description: "Rename a tag on every recipe that has it, e.g. to fix a spelling or merge near-duplicates: renaming onto a tag in use merges the two.",
  scope: SCOPE_RECIPES_WRITE,
  annotations: { destructiveHint: false },
  input: z.object({ from: tag.check(z.describe("The tag now.")), to: tag.check(z.describe("What it becomes.")) }),
  async handler(args, { recipes, actor }) {
    return result({ ...args, ...(await recipes.renameTag(actor, args.from, args.to)) });
  },
});

const listBooks = defineTool<Ctx, any>({
  name: "list_books",
  description: "The books (and booklets, magazines) the household's recipes come from, by title, with how many recipes each has.",
  scope: SCOPE_RECIPES_READ,
  annotations: { readOnlyHint: true },
  input: z.object({}),
  async handler(_args, { recipes, actor }) {
    return result({ books: (await recipes.books(actor)).map(bookJson) });
  },
});

const renameBook = defineTool<Ctx, any>({
  name: "rename_book",
  description: "Change a book's title; every recipe from it shows the new title.",
  scope: SCOPE_RECIPES_WRITE,
  annotations: { destructiveHint: false },
  input: z.object({ id: bookId, title: z.string().check(z.minLength(1), z.maxLength(TITLE_MAX)) }),
  async handler(args, { recipes, actor }) {
    await recipes.renameBook(actor, args.id, args.title);
    return result({ id: args.id, title: args.title.trim() });
  },
});

const deleteBook = defineTool<Ctx, any>({
  name: "delete_book",
  description: "Delete a book. Its recipes stay, without the book and page.",
  scope: SCOPE_RECIPES_WRITE,
  annotations: { destructiveHint: true },
  input: z.object({ id: bookId }),
  async handler(args, { recipes, actor }) {
    await recipes.deleteBook(actor, args.id);
    return result({ deleted: args.id });
  },
});

export const tools = [
  listItems, getItem, createItem, updateItem, deleteItem, moveItem, listEvents,
  listRecipes, getRecipe, createRecipe, updateRecipe, deleteRecipe, recordCook, listCooks, deleteCook,
  listTags, renameTag, listBooks, renameBook, deleteBook,
] as ToolDef<Ctx>[];

// Only deliberate item and recipe errors are shown to the client; anything else is "Internal error".
export const userFacingError = (error: unknown) => (error instanceof ItemError || error instanceof RecipeError ? error.message : null);
