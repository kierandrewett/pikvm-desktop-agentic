/**
 * Settings helpers for providers and MCP servers:
 *   GET  /api/providers/catalog   curated providers with logos and "get a key" links
 *   (the MCP catalogue moved to http/mcp-routes.ts)
 *   POST /api/providers/test      try a provider config (lists its models)
 *   POST /api/mcp/test            try an http/sse MCP server (initialize + tools/list, see agent/mcp-probe.ts)
 *   GET  /api/providers/:id/models?scope=user|global   one provider's models, including turned-off ones
 *   POST /api/models/refresh      list the user's models again now
 * Tests take { id, value, scope: "user" | "global" }. A masked secret ("********") is filled from the
 * stored entry of that scope, so testing a saved provider never needs the key again. Global scope is
 * admin only. Every error text is scrubbed of the entry's secret values before it is returned, because upstream
 * error bodies can echo a key back.
 */
import {
    SECRET_MASK,
    customProviderPreset,
    getDef,
    McpServer,
    Provider,
    providerPresets,
    unmask,
    userKey,
    type ProviderTestResult,
} from "@pikvm/chat-protocol";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { probeRemote } from "../agent/mcp-probe.ts";
import { authHeaderFor, resolveEndpoint } from "../agent/providers.ts";
import { catalog } from "../models/catalog.ts";
import { Matcher } from "../models/match.ts";
import { providerModels, refreshModels } from "../models/service.ts";
import { getRow } from "../settings/store.ts";
import { body, requireAdmin, requireUser, type Ctx, type Env } from "./context.ts";

const TestBody = z.object({
    id: z.string().min(1),
    value: z.unknown(),
    scope: z.enum(["user", "global"]).default("user"),
});
const TIMEOUT_MS = 15_000;

function stored(c: Ctx, key: "agent.providers" | "agent.mcp", scope: "user" | "global", id: string): unknown {
    if (scope === "global") {
        requireAdmin(c);
        return (getRow(key)?.value as Record<string, unknown> | undefined)?.[id];
    }
    const user = requireUser(c);
    return (getRow(userKey(user.id, key))?.value as Record<string, unknown> | undefined)?.[id];
}

/** Restore masked secrets in one entry from the stored entry with the same id. */
function withSecrets<T>(key: "agent.providers" | "agent.mcp", id: string, value: unknown, prev: unknown): T {
    const def = getDef(key)!;
    return (unmask(def, { [id]: value }, { [id]: prev }) as Record<string, T>)[id]!;
}

async function testProvider(id: string, p: Provider): Promise<ProviderTestResult> {
    const started = performance.now();
    const ep = resolveEndpoint(id, p);
    if (!ep) return { ok: false, latencyMs: 0, models: [], error: "Add a base URL and API type for a custom provider" };
    const headers: Record<string, string> = { ...(p.headers ?? {}) };
    if (p.apiKey) Object.assign(headers, authHeaderFor(ep.api, p.apiKey));
    if (ep.api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
    // System One providers store the API root (docs/spec/model-roles.md 9.2), so their list is under /v1.
    const path = ep.api === "anthropic-messages" || ep.api === "systemone" ? "/v1/models" : "/models";
    try {
        const res = await fetch(`${ep.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const latencyMs = Math.round(performance.now() - started);
        if (!res.ok) {
            const text = (await res.text()).slice(0, 300);
            const hint =
                res.status === 401 || res.status === 403 ? "The key was rejected" : `The server answered ${res.status}`;
            return { ok: false, status: res.status, latencyMs, models: [], error: `${hint}${text ? `: ${text}` : ""}` };
        }
        const json = (await res.json().catch(() => ({}))) as {
            data?: { id?: string; name?: string }[];
            models?: { name?: string; id?: string }[];
        };
        const list = json.data ?? json.models ?? [];
        const models = list.map((m) => (m.id ?? m.name ?? "").replace(/^models\//, "")).filter(Boolean);
        return { ok: true, status: res.status, latencyMs, models };
    } catch (err) {
        return {
            ok: false,
            latencyMs: Math.round(performance.now() - started),
            models: [],
            error: `Could not reach ${ep.baseUrl}: ${(err as Error).message}`,
        };
    }
}

/** Secret values of one entry: key, header values and env values. */
function secretsOf(entry: {
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
}): string[] {
    return [entry.apiKey, ...Object.values(entry.headers ?? {}), ...Object.values(entry.env ?? {})].filter(
        (v): v is string => typeof v === "string" && v.length >= 4,
    );
}

/**
 * Remove secret values from text that goes back to the browser. Also covers a bearer value without its prefix and
 * the first 12 characters of a long key, which some APIs echo in "invalid key" messages.
 */
export function scrub(text: string | undefined, secrets: string[]): string | undefined {
    if (!text) return text;
    let out = text;
    const parts = secrets.flatMap((s) => {
        const bare = s.replace(/^bearer\s+/i, "");
        return [s, bare, ...(bare.length >= 16 ? [bare.slice(0, 12)] : [])];
    });
    for (const p of [...new Set(parts)].sort((x, y) => y.length - x.length)) {
        if (p.length >= 4) out = out.split(p).join(SECRET_MASK);
    }
    return out;
}

const ScopeQuery = z.enum(["user", "global"]).default("user");

export const catalogRoutes = new Hono<Env>()
    .get("/providers/catalog", (c) => {
        requireUser(c);
        const m = new Matcher(catalog());
        const cat = catalog();
        const enrich = (p: (typeof providerPresets)[number]) => {
            const dev = m.devProvider(p.id);
            return {
                ...p,
                logo: `/api/models/logos/${dev ?? p.id}.svg`,
                docs: dev ? (cat[dev] as { doc?: string } | undefined)?.doc : undefined,
            };
        };
        return c.json({ presets: providerPresets.map(enrich), custom: customProviderPreset });
    })
    .post("/providers/test", async (c) => {
        const { id, value, scope } = await body(c, TestBody);
        const p = Provider.parse(
            withSecrets<unknown>("agent.providers", id, value, stored(c, "agent.providers", scope, id)),
        );
        const r = await testProvider(id, p);
        return c.json({ ...r, error: scrub(r.error, secretsOf(p)) });
    })
    .post("/mcp/test", async (c) => {
        const { id, value, scope } = await body(c, TestBody);
        const parsed = McpServer.safeParse(
            withSecrets<unknown>("agent.mcp", id, value, stored(c, "agent.mcp", scope, id)),
        );
        if (!parsed.success) throw new HTTPException(400, { message: "Invalid server settings" });
        const r = await probeRemote(parsed.data);
        return c.json({ ...r, error: scrub(r.error, secretsOf(parsed.data)) });
    })
    .get("/providers/:id/models", async (c) => {
        const scope = ScopeQuery.parse(c.req.query("scope"));
        // Global entries are listed through the administrator's own account, which sees every global provider.
        const user = scope === "global" ? requireAdmin(c) : requireUser(c);
        return c.json(await providerModels(user.id, c.req.param("id")));
    })
    .post("/models/refresh", async (c) => {
        const user = requireUser(c);
        try {
            await refreshModels(user.id);
        } catch (err) {
            // The last good listing stays in use; the page shows why this one failed.
            return c.json({ ok: false, error: (err as Error).message });
        }
        return c.json({ ok: true });
    });
