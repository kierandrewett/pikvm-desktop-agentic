/**
 * Which remote MCP server a user means, and that user's credential for it.
 *
 * - `resolveServer` reads the user's effective `agent.mcp` entry (global entries win on an id collision, so a user
 *   cannot point an organisation server somewhere else) and applies the personal-server policies.
 * - Tokens live in `mcp_credentials`, sealed with crypto.ts. The sealing names user, server, resource and issuer.
 * - `accessToken` refreshes a token that ends within REFRESH_MARGIN_MS. One refresh runs per credential at a time;
 *   every caller waits on the same promise, so a rotated refresh token is never used twice.
 * - A token is only handed out while the entry still points at the resource it was issued for.
 */
import { RESERVED_MCP_SERVER_IDS, type McpConnection, type McpServer } from "@pikvm/chat-protocol";
import { and, eq } from "drizzle-orm";
import { db, now, schema } from "../db/index.ts";
import { resolveSetting } from "../settings/store.ts";
import { open, seal } from "./crypto.ts";
import type { GuardOptions } from "./net.ts";
import {
    canonicalResource,
    clientAgain,
    withinResource,
    refreshTokens,
    revokeToken,
    type Completed,
    type TokenSet,
} from "./oauth.ts";

const REFRESH_MARGIN_MS = 60_000;

/** Server ids the gateway never serves: built-in endpoints use them (declared in the protocol package). */
export const RESERVED_SERVER_IDS = RESERVED_MCP_SERVER_IDS;

export interface ResolvedServer {
    id: string;
    entry: McpServer;
    owner: "global" | "user";
}

export class ServerUnavailable extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

/** Every configured server is the operator's own. Kept as a function so callers read as they do in ~/dev/chat. */
export function personalServerAllowed(_userId: string, _entry: McpServer): boolean {
    return true;
}

/** The user's effective entry for `id`, or a ServerUnavailable with the HTTP status to answer. */
export function resolveServer(userId: string, id: string): ResolvedServer {
    if (RESERVED_SERVER_IDS.has(id)) throw new ServerUnavailable("Reserved server name", 404);
    const r = resolveSetting("agent.mcp", userId);
    const entry = (r.value as Record<string, McpServer>)[id];
    if (!entry) throw new ServerUnavailable(`No MCP server ${id}`, 404);
    if (entry.enabled === false) throw new ServerUnavailable(`MCP server ${id} is turned off`, 403);
    if (entry.type !== "http" || !entry.url)
        throw new ServerUnavailable(`MCP server ${id} is not a remote server`, 400);
    return { id, entry, owner: "user" };
}

/** SSRF options for one server: an administrator's server may use its own (possibly private) origin. */
export function guardFor(s: ResolvedServer): GuardOptions {
    return s.owner === "global" && s.entry.url ? { trustedOrigin: new URL(s.entry.url).origin } : {};
}

type Row = typeof schema.mcpCredentials.$inferSelect;

const aad = (r: Pick<Row, "userId" | "serverId" | "resource" | "issuer">, field: string) =>
    `mcp|user:${r.userId}|server:${r.serverId}|resource:${r.resource}|issuer:${r.issuer}|${field}`;

const where = (userId: string, serverId: string) =>
    and(eq(schema.mcpCredentials.userId, userId), eq(schema.mcpCredentials.serverId, serverId));

function row(userId: string, serverId: string): Row | undefined {
    return db.select().from(schema.mcpCredentials).where(where(userId, serverId)).get();
}

export function saveCompleted(c: Completed): void {
    const base = { userId: c.userId, serverId: c.serverId, resource: c.resource, issuer: c.issuer };
    const values = {
        ...base,
        clientId: c.clientId,
        accessToken: seal(c.tokens.accessToken, aad(base, "access")),
        refreshToken: c.tokens.refreshToken ? seal(c.tokens.refreshToken, aad(base, "refresh")) : null,
        scope: c.tokens.scope,
        missingScope: null,
        expiresAt: c.tokens.expiresAt ?? null,
        status: "connected" as const,
        account: c.tokens.account ?? null,
        connectedAt: now(),
        updatedAt: now(),
    };
    db.insert(schema.mcpCredentials)
        .values(values)
        .onConflictDoUpdate({ target: [schema.mcpCredentials.userId, schema.mcpCredentials.serverId], set: values })
        .run();
}

function storeRefreshed(r: Row, t: TokenSet): void {
    db.update(schema.mcpCredentials)
        .set({
            accessToken: seal(t.accessToken, aad(r, "access")),
            refreshToken: t.refreshToken ? seal(t.refreshToken, aad(r, "refresh")) : null,
            scope: t.scope || r.scope,
            expiresAt: t.expiresAt ?? null,
            status: "connected",
            updatedAt: now(),
        })
        .where(where(r.userId, r.serverId))
        .run();
}

export function markExpired(userId: string, serverId: string): void {
    db.update(schema.mcpCredentials).set({ status: "expired", updatedAt: now() }).where(where(userId, serverId)).run();
}

/** Remember the scopes a 403 insufficient_scope asked for, so Reconnect asks for them too. */
export function markMissingScope(userId: string, serverId: string, scope: string): void {
    const r = row(userId, serverId);
    if (!r) return;
    const have = new Set(r.scope.split(/\s+/).filter(Boolean));
    const missing = [...new Set(scope.split(/\s+/).filter((s) => s && !have.has(s)))];
    db.update(schema.mcpCredentials)
        .set({ missingScope: missing.join(" ") || null, updatedAt: now() })
        .where(where(userId, serverId))
        .run();
}

/** Scopes a reconnect should ask for beyond the challenge: what the user had plus what was missing. */
export function stepUpScope(userId: string, serverId: string): string | undefined {
    const r = row(userId, serverId);
    if (!r) return undefined;
    return [r.scope, r.missingScope ?? ""].join(" ").trim() || undefined;
}

const refreshing = new Map<string, Promise<string | undefined>>();

/**
 * A current access token for this user and server, or undefined when there is no usable connection. `force` refreshes
 * even when the token looks valid (the server answered 401).
 */
export async function accessToken(s: ResolvedServer, userId: string, force = false): Promise<string | undefined> {
    const r = row(userId, s.id);
    if (!r || r.status !== "connected") return undefined;
    // The entry moved to another address since the user signed in: the token is not for it.
    if (!withinResource(s.entry.url!, r.resource)) return undefined;
    const token = open(r.accessToken, aad(r, "access"));
    if (!token) return undefined;
    const fresh = !r.expiresAt || r.expiresAt - Date.now() > REFRESH_MARGIN_MS;
    if (fresh && !force) return token;
    const key = `${userId}\u0000${s.id}`;
    const running = refreshing.get(key);
    if (running) return running;
    const job = (async () => {
        const latest = row(userId, s.id);
        if (!latest) return undefined;
        // Another caller refreshed while this one waited for the lock.
        if (latest.updatedAt !== r.updatedAt && latest.status === "connected")
            return open(latest.accessToken, aad(latest, "access"));
        const refresh = open(latest.refreshToken, aad(latest, "refresh"));
        if (!refresh) {
            if (latest.expiresAt && latest.expiresAt < Date.now()) markExpired(userId, s.id);
            return latest.expiresAt && latest.expiresAt < Date.now() ? undefined : token;
        }
        try {
            const client = await clientAgain(latest.issuer, latest.clientId, s.entry);
            const t = await refreshTokens(latest.issuer, client, refresh, latest.resource, latest.scope, guardFor(s));
            storeRefreshed(latest, t);
            return t.accessToken;
        } catch (err) {
            console.warn(`[mcp] ${s.id}: token refresh failed for one user: ${(err as Error).message}`);
            markExpired(userId, s.id);
            return undefined;
        }
    })().finally(() => refreshing.delete(key));
    refreshing.set(key, job);
    return job;
}

export function connectionOf(userId: string, serverId: string): McpConnection | undefined {
    const r = row(userId, serverId);
    if (!r) return undefined;
    return {
        server: r.serverId,
        status: r.status === "expired" ? "expired" : r.missingScope ? "needs_more_access" : "connected",
        account: r.account ?? undefined,
        scopes: r.scope.split(/\s+/).filter(Boolean),
        missingScopes: r.missingScope ? r.missingScope.split(/\s+/) : undefined,
        issuer: r.issuer,
        expiresAt: r.expiresAt ?? undefined,
        connectedAt: r.connectedAt,
    };
}

export function listConnections(userId: string): McpConnection[] {
    return db
        .select({ serverId: schema.mcpCredentials.serverId })
        .from(schema.mcpCredentials)
        .where(eq(schema.mcpCredentials.userId, userId))
        .all()
        .map((r) => connectionOf(userId, r.serverId)!)
        .filter(Boolean);
}

/** When the user connected, or 0. Rendered into mcp.json so a new connection restarts the runtime's MCP session. */
export function connectionEpoch(userId: string, serverId: string): number {
    return row(userId, serverId)?.connectedAt ?? 0;
}

/** Revoke (best effort) and delete. True when there was a connection. */
export async function disconnect(
    userId: string,
    serverId: string,
    s: ResolvedServer | undefined,
): Promise<{ removed: boolean; revoked: boolean }> {
    const r = row(userId, serverId);
    if (!r) return { removed: false, revoked: false };
    let revoked = false;
    try {
        const client = await clientAgain(r.issuer, r.clientId, s?.entry);
        const guard = s ? guardFor(s) : {};
        const refresh = open(r.refreshToken, aad(r, "refresh"));
        const access = open(r.accessToken, aad(r, "access"));
        if (refresh) revoked = await revokeToken(r.issuer, client, refresh, "refresh_token", guard);
        if (access) revoked = (await revokeToken(r.issuer, client, access, "access_token", guard)) || revoked;
    } catch {
        // Revocation is best effort; the row goes either way.
    }
    db.delete(schema.mcpCredentials).where(where(userId, serverId)).run();
    return { removed: true, revoked };
}
