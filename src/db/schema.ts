import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Ids are ULIDs; times are Unix seconds. See docs/design.md.
// Foreign keys need PRAGMA foreign_keys = ON on plain SQLite (D1 enforces them).

export const LISTS = ["shopping", "fridge"] as const;
export const SHOPPING_STATUSES = ["to_buy", "bought"] as const;
export const FRIDGE_STATUSES = ["in_stock", "used_up"] as const;
export const ROLES = ["admin", "member"] as const;
export const CHALLENGE_PURPOSES = ["register", "authenticate"] as const;
export const EVENT_TYPES = ["created", "renamed", "status_changed", "note_changed", "moved", "deleted"] as const;
export const EVENT_SOURCES = ["web", "mcp"] as const;

export const NAME_MAX = 500;
export const NOTE_MAX = 2000;
export const TITLE_MAX = 200;
export const URL_MAX = 2000;
export const BODY_MAX = 20000;
export const PAGE_MAX = 20;
export const TAG_MAX = 30;
export const TAGS_PER_RECIPE = 20;

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

// --- households and people -------------------------------------------------

export const households = sqliteTable("households", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // also the WebAuthn user handle
  displayName: text("display_name").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const memberships = sqliteTable(
  "memberships",
  {
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ROLES }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.householdId, t.userId] }),
    index("memberships_user").on(t.userId),
    check("memberships_role", sql`${t.role} IN (${quoted(ROLES)})`),
  ],
);

// --- passkeys, sessions, invites -------------------------------------------

export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(), // credential id, base64url
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(), // COSE key, base64url
    counter: integer("counter").notNull().default(0),
    transports: text("transports"), // JSON array
    deviceName: text("device_name"),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (t) => [index("passkeys_user").on(t.userId)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

// Join links for new members; with user_id set, a re-enrollment link for an
// existing member who lost their passkeys.
export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ROLES }).notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
  },
  (t) => [check("invites_role", sql`${t.role} IN (${quoted(ROLES)})`)],
);

// Short-lived WebAuthn challenges (registration and sign-in ceremonies).
export const challenges = sqliteTable(
  "challenges",
  {
    id: text("id").primaryKey(),
    challenge: text("challenge").notNull(),
    purpose: text("purpose", { enum: CHALLENGE_PURPOSES }).notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    // What a registration is for (JSON), kept server-side until the ceremony finishes:
    // the first admin's household, or the invite being redeemed.
    data: text("data"),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [check("challenges_purpose", sql`${t.purpose} IN (${quoted(CHALLENGE_PURPOSES)})`)],
);

// Key/value state; "initialized_at" is inserted once to decide who sets the app up first.
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// --- OAuth authorization server --------------------------------------------

export const oauthClients = sqliteTable("oauth_clients", {
  clientId: text("client_id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").notNull(), // JSON array
  createdAt: integer("created_at").notNull(),
});

export const oauthCodes = sqliteTable("oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id").notNull().references(() => oauthClients.clientId, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  scope: text("scope").notNull(),
  resource: text("resource").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at").notNull(),
});

// One row per grant; a refresh rotates the hashes in place.
export const oauthTokens = sqliteTable(
  "oauth_tokens",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    resource: text("resource").notNull(),
    accessHash: text("access_hash").notNull().unique(),
    refreshHash: text("refresh_hash").notNull().unique(),
    accessExpiresAt: integer("access_expires_at").notNull(),
    refreshExpiresAt: integer("refresh_expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("oauth_tokens_user").on(t.userId), index("oauth_tokens_client").on(t.clientId)],
);

// --- items and their history ------------------------------------------------

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    list: text("list", { enum: LISTS }).notNull(),
    status: text("status", { enum: [...SHOPPING_STATUSES, ...FRIDGE_STATUSES] }).notNull(),
    name: text("name").notNull(),
    note: text("note"),
    addedBy: text("added_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("items_household_list_status").on(t.householdId, t.list, t.status),
    check("items_name_length", sql`length(${t.name}) BETWEEN 1 AND ${sql.raw(String(NAME_MAX))}`),
    check("items_note_length", sql`${t.note} IS NULL OR length(${t.note}) <= ${sql.raw(String(NOTE_MAX))}`),
    check(
      "items_list_status",
      sql`(${t.list} = 'shopping' AND ${t.status} IN (${quoted(SHOPPING_STATUSES)})) OR (${t.list} = 'fridge' AND ${t.status} IN (${quoted(FRIDGE_STATUSES)}))`,
    ),
  ],
);

// Append-only. No foreign key on item_id: events outlive deleted items, which is
// why the item name is snapshotted.
export const itemEvents = sqliteTable(
  "item_events",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    type: text("type", { enum: EVENT_TYPES }).notNull(),
    name: text("name").notNull(),
    data: text("data"), // JSON, e.g. {"from":"in_stock","to":"used_up"}
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    source: text("source", { enum: EVENT_SOURCES }).notNull(),
    clientId: text("client_id"), // the MCP client, when source = 'mcp'
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("item_events_household_time").on(t.householdId, t.createdAt),
    index("item_events_item").on(t.itemId),
    check("item_events_type", sql`${t.type} IN (${quoted(EVENT_TYPES)})`),
    check("item_events_source", sql`${t.source} IN (${quoted(EVENT_SOURCES)})`),
  ],
);

// --- recipes and when they were cooked ---------------------------------------

// A book (or booklet, magazine) recipes come from. Recipes point at it with a page, so the
// household can see what they took from one book and go back to the page.
export const books = sqliteTable(
  "books",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("books_household_title").on(t.householdId, t.title),
    check("books_title_length", sql`length(${t.title}) BETWEEN 1 AND ${sql.raw(String(TITLE_MAX))}`),
  ],
);

// A link and/or free text, and where it came from: the link, or a book and page.
// Nothing is fetched from the URL on the server.
export const recipes = sqliteTable(
  "recipes",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url"),
    body: text("body"),
    // Length checked by the service: a CHECK added to an existing table means rebuilding it.
    bookId: text("book_id").references(() => books.id, { onDelete: "set null" }),
    page: text("page"),
    addedBy: text("added_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("recipes_book").on(t.bookId),
    index("recipes_household_updated").on(t.householdId, t.updatedAt),
    check("recipes_title_length", sql`length(${t.title}) BETWEEN 1 AND ${sql.raw(String(TITLE_MAX))}`),
    check(
      "recipes_url",
      sql`${t.url} IS NULL OR (length(${t.url}) <= ${sql.raw(String(URL_MAX))} AND (${t.url} LIKE 'https://%' OR ${t.url} LIKE 'http://%'))`,
    ),
    check("recipes_body_length", sql`${t.body} IS NULL OR length(${t.body}) <= ${sql.raw(String(BODY_MAX))}`),
  ],
);

// Free labels, e.g. 主菜, 作り置き, 冬. A tag exists while some recipe has it.
export const recipeTags = sqliteTable(
  "recipe_tags",
  {
    recipeId: text("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recipeId, t.tag] }),
    index("recipe_tags_household_tag").on(t.householdId, t.tag),
    check("recipe_tags_tag_length", sql`length(${t.tag}) BETWEEN 1 AND ${sql.raw(String(TAG_MAX))}`),
  ],
);

// One row per time a recipe was cooked. The record outlives the recipe (recipe_id becomes
// NULL), so the title is snapshotted. cooked_on is the cook's calendar date, YYYY-MM-DD.
export const recipeCooks = sqliteTable(
  "recipe_cooks",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    recipeId: text("recipe_id").references(() => recipes.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    cookedOn: text("cooked_on").notNull(),
    note: text("note"),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    source: text("source", { enum: EVENT_SOURCES }).notNull(),
    clientId: text("client_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("recipe_cooks_household_date").on(t.householdId, t.cookedOn),
    index("recipe_cooks_recipe").on(t.recipeId),
    check("recipe_cooks_date", sql`${t.cookedOn} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'`),
    check("recipe_cooks_note_length", sql`${t.note} IS NULL OR length(${t.note}) <= ${sql.raw(String(NOTE_MAX))}`),
    check("recipe_cooks_source", sql`${t.source} IN (${quoted(EVENT_SOURCES)})`),
  ],
);
