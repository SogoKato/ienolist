import * as z from "zod/mini";
import { FRIDGE_STATUSES, LISTS, NAME_MAX, NOTE_MAX, SHOPPING_STATUSES } from "../db/schema.ts";
import { eventJson, itemJson } from "../items/json.ts";
import { ItemError, type Actor, type ItemService } from "../items/service.ts";
import { defineTool, type ToolDef, type ToolResult } from "./registry.ts";

export type Ctx = { items: ItemService; actor: Actor };

export const SCOPE_READ = "items:read";
export const SCOPE_WRITE = "items:write";

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

export const tools = [listItems, getItem, createItem, updateItem, deleteItem, moveItem, listEvents] as ToolDef<Ctx>[];

// Only deliberate item errors are shown to the client; anything else is "Internal error".
export const userFacingError = (error: unknown) => (error instanceof ItemError ? error.message : null);
