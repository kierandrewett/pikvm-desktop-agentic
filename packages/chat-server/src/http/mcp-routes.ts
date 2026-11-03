/**
 * MCP connections and inspection (docs/spec/mcp-support.md):
 *   GET    /api/mcp/catalog                       the remote servers the settings page offers
 *   POST   /api/mcp/discover                      { url } probe an unsaved address: era, auth, identity, tools
 *   GET    /api/mcp/connections                   this user's OAuth connections (never tokens)
 *   POST   /api/mcp/servers/:id/connect           start OAuth sign-in; returns { url } for a popup or redirect
 *   DELETE /api/mcp/servers/:id/connection        disconnect: revoke (when the server can) and forget the tokens
 *   GET    /api/mcp/servers/:id/inventory         tools, prompts, resources and templates, with this user's sign-in
 *   GET    /api/mcp/servers/:id/resource?uri=     one resource's text
 *   GET    /api/mcp/oauth/callback                OAuth redirect target; redirects back to the server's settings page
 *   GET    /api/mcp/oauth/client.json             OAuth client ID metadata document (needs an https public URL)
 *   GET    /api/conversations/:id/mcp             per-chat server switches
 *   PUT    /api/conversations/:id/mcp             { server, enabled }
 *
 * The redirect URI is `<system.publicUrl>/api/mcp/oauth/callback`, or the browser's own origin (the Origin header of
 * the connect request, which also carries the CSRF header) when no public URL is set. Never the internal request URL,
 * which is wrong behind a reverse proxy. Plain http is only accepted for loopback hosts.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { catalogueFor } from "../mcp/catalogue.ts";
import { chatServers, setChatServer } from "../mcp/chat-servers.ts";
import {
    connectionOf,
    disconnect,
    guardFor,
    listConnections,
    resolveServer,
    saveCompleted,
    ServerUnavailable,
} from "../mcp/credentials.ts";
import { beginConnect, discover, inventory, readResource } from "../mcp/inspect.ts";
import { BlockedUrlError } from "../mcp/net.ts";
import { clientMetadataDocument, completeAuthorization, OAuthError } from "../mcp/oauth.ts";
import { hostPaths, publicUrl } from "../env.ts";
import { scrub } from "./catalog-routes.ts";
import { body, requireUser, type Ctx, type Env } from "./context.ts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function callbackFrom(origin: string): string | undefined {
    try {
        const u = new URL(origin);
        if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) return undefined;
        return `${u.origin}${hostPaths().api}/mcp/oauth/callback`;
    } catch {
        return undefined;
    }
}

export function redirectUri(c: Ctx): string {
    const uri = callbackFrom(publicUrl() || (c.req.header("origin") ?? ""));
    if (!uri)
        throw new HTTPException(400, {
            message: "Signing in to an MCP server needs an https address, or localhost. Open this app at one.",
        });
    return uri;
}

function server(c: Ctx) {
    const user = requireUser(c);
    try {
        return { user, s: resolveServer(user.id, c.req.param("id") ?? "") };
    } catch (err) {
        if (err instanceof ServerUnavailable) throw new HTTPException(err.status as 400, { message: err.message });
        throw err;
    }
}

function settingsPage(serverId: string, params: Record<string, string>): string {
    const q = new URLSearchParams({ id: serverId, ...params });
    return `${hostPaths().settings}?${q}`;
}

export const mcpRoutes = new Hono<Env>()
    .get("/mcp/catalog", (c) => {
        requireUser(c);
        return c.json(catalogueFor());
    })
    .post("/mcp/discover", async (c) => {
        const { url } = await body(c, z.object({ url: z.url() }));
        const user = requireUser(c);
        const r = await discover(user.id, url, "user");
        return c.json({ ...r, error: scrub(r.error, []) });
    })
    .get("/mcp/connections", (c) => c.json({ connections: listConnections(requireUser(c).id) }))
    .post("/mcp/servers/:id/connect", async (c) => {
        const { user, s } = server(c);
        try {
            return c.json({ url: await beginConnect(user.id, s, redirectUri(c)) });
        } catch (err) {
            if (err instanceof OAuthError || err instanceof BlockedUrlError)
                throw new HTTPException(400, { message: err.message });
            throw err;
        }
    })
    .delete("/mcp/servers/:id/connection", async (c) => {
        const user = requireUser(c);
        const id = c.req.param("id");
        let s;
        try {
            s = resolveServer(user.id, id);
        } catch {
            s = undefined;
        }
        return c.json(await disconnect(user.id, id, s));
    })
    .get("/mcp/servers/:id/connection", (c) => {
        const user = requireUser(c);
        return c.json({ connection: connectionOf(user.id, c.req.param("id")) ?? null });
    })
    .get("/mcp/servers/:id/inventory", async (c) => {
        const { user, s } = server(c);
        const r = await inventory(user.id, s);
        return c.json({ ...r, error: scrub(r.error, Object.values(s.entry.headers ?? {})) });
    })
    .get("/mcp/servers/:id/resource", async (c) => {
        const { user, s } = server(c);
        const uri = c.req.query("uri");
        if (!uri) throw new HTTPException(400, { message: "uri is required" });
        try {
            return c.json(await readResource(user.id, s, uri));
        } catch (err) {
            throw new HTTPException(502, {
                message: scrub((err as Error).message, Object.values(s.entry.headers ?? {})),
            });
        }
    })
    .get("/mcp/oauth/callback", async (c) => {
        const user = requireUser(c);
        const q = c.req.query();
        try {
            const done = await completeAuthorization(user.id, q, (serverId) => {
                try {
                    return guardFor(resolveServer(user.id, serverId));
                } catch {
                    return {};
                }
            });
            saveCompleted(done);
            return c.redirect(settingsPage(done.serverId, { oauth: "connected" }));
        } catch (err) {
            const code = err instanceof OAuthError ? err.code : "oauth_failed";
            if (!(err instanceof OAuthError)) console.warn(`[mcp] OAuth callback failed: ${(err as Error).message}`);
            const message =
                err instanceof OAuthError || err instanceof BlockedUrlError ? err.message : "Sign-in failed.";
            return c.redirect(`${hostPaths().settings}?${new URLSearchParams({ oauth: "error", code, message })}`);
        }
    })
    .get("/mcp/oauth/client.json", (c) => {
        const doc = clientMetadataDocument(`${publicUrl()}${hostPaths().api}/mcp/oauth/callback`);
        if (!doc) throw new HTTPException(404, { message: "No public https address is set" });
        return c.json(doc, 200, { "cache-control": "public, max-age=3600" });
    })
    .get("/conversations/:id/mcp", (c) => c.json({ servers: chatServers(requireUser(c).id, c.req.param("id")) }))
    .put("/conversations/:id/mcp", async (c) => {
        const user = requireUser(c);
        const { server: serverId, enabled } = await body(
            c,
            z.object({ server: z.string().regex(/^[A-Za-z0-9_-]+$/), enabled: z.boolean() }),
        );
        setChatServer(user.id, c.req.param("id"), serverId, enabled);
        return c.json({ servers: chatServers(user.id, c.req.param("id")) });
    });
