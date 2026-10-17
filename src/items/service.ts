import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "../db/types.ts";
import {
  FRIDGE_STATUSES,
  LISTS,
  NAME_MAX,
  NOTE_MAX,
  SHOPPING_STATUSES,
  itemEvents,
  items,
} from "../db/schema.ts";
import { monotonicUlid } from "../lib/ulid.ts";

export type List = (typeof LISTS)[number];
export type Item = typeof items.$inferSelect;
export type ItemEvent = typeof itemEvents.$inferSelect;
type EventType = ItemEvent["type"];

// Who is acting, and for which household. Every query is scoped by householdId.
export type Actor = {
  householdId: string;
  userId: string | null;
  source: "web" | "mcp";
  clientId?: string | null;
};

export class ItemError extends Error {
  readonly code: "not_found" | "invalid";
  constructor(code: "not_found" | "invalid", message: string) {
    super(message);
    this.code = code;
  }
}
const invalid = (message: string) => new ItemError("invalid", message);
const notFound = () => new ItemError("not_found", "Item not found");

const STATUSES: Record<List, readonly string[]> = { shopping: SHOPPING_STATUSES, fridge: FRIDGE_STATUSES };
// A new or moved item starts here: still to buy, or in stock.
const INITIAL_STATUS: Record<List, Item["status"]> = { shopping: "to_buy", fridge: "in_stock" };

function checkList(list: unknown): List {
  if (!(LISTS as readonly unknown[]).includes(list)) throw invalid(`list must be one of: ${LISTS.join(", ")}`);
  return list as List;
}

function checkStatus(list: List, status: unknown): Item["status"] {
  if (!STATUSES[list].includes(status as string)) {
    throw invalid(`status for the ${list} list must be one of: ${STATUSES[list].join(", ")}`);
  }
  return status as Item["status"];
}

function checkName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) throw invalid(`name must be 1-${NAME_MAX} characters`);
  return trimmed;
}

// Empty and null both clear the note.
function checkNote(note: unknown): string | null {
  if (note === null || note === undefined) return null;
  if (typeof note !== "string") throw invalid("note must be text or null");
  const trimmed = note.trim();
  if (trimmed.length > NOTE_MAX) throw invalid(`note must be at most ${NOTE_MAX} characters`);
  return trimmed === "" ? null : trimmed;
}

export type Deps = { now?: () => number; newId?: () => string };

export function createItemService(db: Db, deps: Deps = {}) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const newId = deps.newId ?? monotonicUlid();

  const scoped = (actor: Actor, id: string) => and(eq(items.id, id), eq(items.householdId, actor.householdId));

  async function find(actor: Actor, id: string): Promise<Item> {
    const [row] = await db.select().from(items).where(scoped(actor, id)).limit(1);
    if (!row) throw notFound();
    return row;
  }

  const eventRow = (actor: Actor, item: Pick<Item, "id" | "name">, type: EventType, data?: unknown) =>
    db.insert(itemEvents).values({
      id: newId(),
      householdId: actor.householdId,
      itemId: item.id,
      type,
      name: item.name,
      data: data === undefined ? null : JSON.stringify(data),
      userId: actor.userId,
      source: actor.source,
      clientId: actor.clientId ?? null,
      createdAt: now(),
    });

  // The item change and its events are written in one atomic batch.
  const write = (statements: BatchItem<"sqlite">[]) => db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  return {
    async list(actor: Actor, filter: { list?: string; status?: string } = {}): Promise<Item[]> {
      const list = filter.list === undefined ? undefined : checkList(filter.list);
      if (filter.status !== undefined) {
        if (list) checkStatus(list, filter.status);
        else if (!LISTS.some((l) => STATUSES[l].includes(filter.status as string))) throw invalid("Unknown status");
      }
      return db
        .select()
        .from(items)
        .where(
          and(
            eq(items.householdId, actor.householdId),
            list ? eq(items.list, list) : undefined,
            filter.status !== undefined ? eq(items.status, filter.status as Item["status"]) : undefined,
          ),
        )
        .orderBy(asc(items.createdAt), asc(items.id));
    },

    get: find,

    async create(actor: Actor, input: { list: string; name: string; note?: string | null; status?: string }): Promise<Item> {
      const list = checkList(input.list);
      const t = now();
      const item: Item = {
        id: newId(),
        householdId: actor.householdId,
        list,
        status: input.status === undefined ? INITIAL_STATUS[list] : checkStatus(list, input.status),
        name: checkName(input.name),
        note: checkNote(input.note),
        addedBy: actor.userId,
        createdAt: t,
        updatedAt: t,
      };
      await write([
        db.insert(items).values(item),
        eventRow(actor, item, "created", { list: item.list, status: item.status }),
      ]);
      return item;
    },

    // Changing a status never moves the item to the other list; use move() for that.
    async update(actor: Actor, id: string, patch: { name?: string; status?: string; note?: string | null }): Promise<Item> {
      if (patch.name === undefined && patch.status === undefined && patch.note === undefined) {
        throw invalid("Nothing to update: give a name, status or note");
      }
      const current = await find(actor, id);
      const next = { ...current };
      const events: BatchItem<"sqlite">[] = [];

      if (patch.name !== undefined) {
        const name = checkName(patch.name);
        if (name !== current.name) {
          next.name = name;
          events.push(eventRow(actor, next, "renamed", { from: current.name, to: name }));
        }
      }
      if (patch.status !== undefined) {
        const status = checkStatus(current.list, patch.status);
        if (status !== current.status) {
          next.status = status;
          events.push(eventRow(actor, next, "status_changed", { from: current.status, to: status }));
        }
      }
      if (patch.note !== undefined) {
        const note = checkNote(patch.note);
        if (note !== current.note) {
          next.note = note;
          events.push(eventRow(actor, next, "note_changed", { from: current.note, to: note }));
        }
      }
      if (events.length === 0) return current;

      next.updatedAt = now();
      await write([
        db.update(items).set({ name: next.name, status: next.status, note: next.note, updatedAt: next.updatedAt }).where(scoped(actor, id)),
        ...events,
      ]);
      return next;
    },

    // Moves the same row to the other list with that list's initial status.
    async move(actor: Actor, id: string, to: string): Promise<Item> {
      const target = checkList(to);
      const current = await find(actor, id);
      if (current.list === target) throw invalid(`Item is already on the ${target} list`);
      const next: Item = { ...current, list: target, status: INITIAL_STATUS[target], updatedAt: now() };
      await write([
        db.update(items).set({ list: next.list, status: next.status, updatedAt: next.updatedAt }).where(scoped(actor, id)),
        eventRow(actor, next, "moved", {
          from: { list: current.list, status: current.status },
          to: { list: next.list, status: next.status },
        }),
      ]);
      return next;
    },

    async delete(actor: Actor, id: string): Promise<void> {
      const current = await find(actor, id);
      await write([db.delete(items).where(scoped(actor, id)), eventRow(actor, current, "deleted")]);
    },

    // Newest first.
    async events(actor: Actor, filter: { itemId?: string; since?: number; limit?: number } = {}): Promise<ItemEvent[]> {
      const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), 500);
      return db
        .select()
        .from(itemEvents)
        .where(
          and(
            eq(itemEvents.householdId, actor.householdId),
            filter.itemId !== undefined ? eq(itemEvents.itemId, filter.itemId) : undefined,
            filter.since !== undefined ? gte(itemEvents.createdAt, filter.since) : undefined,
          ),
        )
        .orderBy(desc(itemEvents.id))
        .limit(limit);
    },
  };
}

export type ItemService = ReturnType<typeof createItemService>;
