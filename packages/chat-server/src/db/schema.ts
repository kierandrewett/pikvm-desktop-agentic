/**
 * Relational schema. Settings are the only key/value table; everything else is normal tables.
 * Change this file, then run `yarn workspace @pikvm/chat-server db:generate` to write the migration.
 */
import { relations, sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const ms = (name: string) => integer(name, { mode: "number" });
const createdAt = () =>
    ms("created_at")
        .notNull()
        .default(sql`(unixepoch() * 1000)`);

/** One seeded row, `operator`, so every foreign key to a user holds. There is no sign-up. */
export const users = sqliteTable("users", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: createdAt(),
});

/** The settings key/value store. `value` is JSON. See packages/chat-protocol/src/settings.ts. */
export const settings = sqliteTable("settings", {
    key: text("key").primaryKey(),
    value: text("value", { mode: "json" }).notNull(),
    source: text("source", { enum: ["db", "file"] }).notNull(),
    updatedAt: ms("updated_at").notNull(),
    updatedBy: text("updated_by"),
});

export const conversations = sqliteTable(
    "conversations",
    {
        id: text("id").primaryKey(),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        title: text("title").notNull().default(""),
        titleSource: text("title_source", { enum: ["auto", "user"] })
            .notNull()
            .default("auto"),
        model: text("model").notNull().default(""),
        thinking: text("thinking").notNull().default(""),
        /** Agent session JSONL, relative to the user's conversation directory. */
        sessionFile: text("session_file"),
        pinnedAt: ms("pinned_at"),
        archivedAt: ms("archived_at"),
        /**
         * URL short id, from the UUID's random tail and unique per user (docs/spec/chat-urls.md). Nullable so
         * rows inserted outside the service still insert; startup fills them (conversations/slug.ts).
         */
        shortId: text("short_id"),
        /**
         * The conversation this one was forked from (conversations/branching.ts), null for every other chat.
         * Deliberately no foreign key: SQLite can only add one by rebuilding the table, and a fork whose source
         * was deleted keeps the id (the client then shows the source as deleted).
         */
        forkedFrom: text("forked_from"),
        /**
         * Plain-text start of the last assistant message (conversations/snippet.ts), at most 200 characters. The sidebar's
         * expanded rows show it under the title. Null until the chat finishes a turn. This is
         * also the place a generated summary would go (docs/spec/sidebar-views.md): the column holds whichever is newer.
         */
        snippet: text("snippet"),
        /** A turn of this chat carried an attachment (image or uploaded file). Never reset; the sidebar filters on it. */
        hasAttachments: integer("has_attachments", { mode: "boolean" }).notNull().default(false),
        createdAt: createdAt(),
        updatedAt: ms("updated_at").notNull(),
    },
    (t) => [
        index("conversations_user_updated").on(t.userId, t.updatedAt),
        uniqueIndex("conversations_user_short").on(t.userId, t.shortId),
    ],
);

/**
 * Every title slug a conversation has had, so an old `/c/<slug>-<short>` URL still resolves after a rename
 * (docs/spec/chat-urls.md). Neutral slugs and temporary chats are never recorded.
 */
export const conversationSlugs = sqliteTable(
    "conversation_slugs",
    {
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        conversationId: text("conversation_id")
            .notNull()
            .references(() => conversations.id, { onDelete: "cascade" }),
        slug: text("slug").notNull(),
        /** The last time the conversation took this slug; the newest holder wins a slug-only lookup. */
        createdAt: ms("created_at").notNull(),
    },
    (t) => [
        primaryKey({ columns: [t.userId, t.slug, t.conversationId] }),
        index("conversation_slugs_lookup").on(t.userId, t.slug, t.createdAt),
        index("conversation_slugs_conversation").on(t.conversationId),
    ],
);

export const uploads = sqliteTable(
    "uploads",
    {
        id: text("id").primaryKey(),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
        name: text("name").notNull(),
        mime: text("mime").notNull(),
        size: integer("size").notNull(),
        createdAt: createdAt(),
    },
    (t) => [index("uploads_user").on(t.userId)],
);

/**
 * Unsent composer drafts, so a prompt typed on one device is there on another (the browser keeps its own
 * copy in localStorage too; see apps/web/src/lib/drafts.ts). One row per user and scope: `conv:<id>`, `home`
 * or `home:<projectId>`. Conversation drafts carry the conversation id, so deleting the conversation deletes
 * the draft (cascade). Temporary chats never get a row.
 */
export const drafts = sqliteTable(
    "drafts",
    {
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        scope: text("scope").notNull(),
        conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
        text: text("text").notNull().default(""),
        /** JSON array of image attachments ({ id, kind: "image", name, url }). */
        attachments: text("attachments").notNull().default("[]"),
        updatedAt: ms("updated_at").notNull(),
    },
    (t) => [primaryKey({ columns: [t.userId, t.scope] }), index("drafts_conversation").on(t.conversationId)],
);

/**
 * One OAuth connection of one user to one MCP server (an `agent.mcp` record id), made through the Chat MCP gateway
 * (src/mcp/). Tokens and the client secret are sealed with src/mcp/crypto.ts; the sealing names the user, server,
 * resource and issuer, so a value copied to another row does not open. `resource` and `issuer` bind the token: the
 * gateway sends it only to that resource, and only while the server entry still points there.
 */
export const mcpCredentials = sqliteTable(
    "mcp_credentials",
    {
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        serverId: text("server_id").notNull(),
        /** Canonical server URI the token was issued for (RFC 8707 `resource`). */
        resource: text("resource").notNull(),
        issuer: text("issuer").notNull(),
        /** The OAuth client the token belongs to (needed to refresh and revoke). */
        clientId: text("client_id").notNull(),
        accessToken: text("access_token").notNull(),
        refreshToken: text("refresh_token"),
        /** Space-separated granted scopes. */
        scope: text("scope").notNull().default(""),
        /** Space-separated scopes a 403 insufficient_scope asked for and the token lacks. */
        missingScope: text("missing_scope"),
        expiresAt: ms("expires_at"),
        /** "connected", or "expired" once a refresh failed. */
        status: text("status", { enum: ["connected", "expired"] })
            .notNull()
            .default("connected"),
        /** Who the user signed in as, when known. Shown in settings; never used for decisions. */
        account: text("account"),
        connectedAt: ms("connected_at").notNull(),
        updatedAt: ms("updated_at").notNull(),
    },
    (t) => [primaryKey({ columns: [t.userId, t.serverId] })],
);

/**
 * OAuth clients Chat registered with an authorisation server (dynamic registration), or a metadata-document client
 * id, per issuer and redirect URI. Shared by every user: a registration names Chat, not a person.
 */
export const mcpOauthClients = sqliteTable(
    "mcp_oauth_clients",
    {
        issuer: text("issuer").notNull(),
        redirectUri: text("redirect_uri").notNull(),
        clientId: text("client_id").notNull(),
        /** Sealed; absent for public clients. */
        clientSecret: text("client_secret"),
        method: text("method", { enum: ["dynamic", "metadata"] }).notNull(),
        createdAt: createdAt(),
    },
    (t) => [primaryKey({ columns: [t.issuer, t.redirectUri] })],
);

/** Per-chat MCP server switches: a row turns one server off (or back on) for one conversation. */
export const mcpChatServers = sqliteTable(
    "mcp_chat_servers",
    {
        conversationId: text("conversation_id")
            .notNull()
            .references(() => conversations.id, { onDelete: "cascade" }),
        serverId: text("server_id").notNull(),
        enabled: integer("enabled", { mode: "boolean" }).notNull(),
        updatedAt: ms("updated_at").notNull(),
    },
    (t) => [primaryKey({ columns: [t.conversationId, t.serverId] })],
);

export const usersRelations = relations(users, ({ many }) => ({
    conversations: many(conversations),
    uploads: many(uploads),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
    user: one(users, { fields: [conversations.userId], references: [users.id] }),
    uploads: many(uploads),
}));

export const uploadsRelations = relations(uploads, ({ one }) => ({
    user: one(users, { fields: [uploads.userId], references: [users.id] }),
    conversation: one(conversations, { fields: [uploads.conversationId], references: [conversations.id] }),
}));
