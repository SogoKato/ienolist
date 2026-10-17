import type { Item, ItemEvent } from "./service.ts";

// The JSON shape of items and events, shared by the web API and the MCP tools.
// Times are ISO 8601; the household is never exposed.
export const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export const itemJson = (i: Item) => ({
  id: i.id,
  list: i.list,
  status: i.status,
  name: i.name,
  note: i.note,
  createdAt: iso(i.createdAt),
  updatedAt: iso(i.updatedAt),
});

export const eventJson = (e: ItemEvent) => ({
  id: e.id,
  itemId: e.itemId,
  type: e.type,
  name: e.name,
  data: e.data === null ? null : JSON.parse(e.data),
  source: e.source,
  at: iso(e.createdAt),
});
