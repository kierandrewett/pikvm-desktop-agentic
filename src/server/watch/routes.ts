import type { IncomingMessage, ServerResponse } from "node:http";
import { WATCH_PATH as WATCH_BASE, type WatchZone } from "@pikvm/contracts/watch";
import { json } from "../http";
import { WatchRefusal, type WatchService } from "./service";

/**
 * `/app/api/v1/watch/*`: the Settings page's side of the screen watch.
 *
 *   GET   /app/api/v1/watch              the settings, whether it can be switched on, push state, limits
 *   PATCH /app/api/v1/watch              { enabled?, rule?, visionModel?, fastAlerts?, fastSummary?, summaryModel?, alertZone? }
 *   POST  /app/api/v1/watch/subscribe    { subscription } from the browser's PushManager
 *   POST  /app/api/v1/watch/unsubscribe  { endpoint }
 *   POST  /app/api/v1/watch/test         send a test notification to every subscribed device
 *   GET   /app/api/v1/watch/checks       the check log, newest first (?limit=, at most 100)
 *
 * Everything is the one operator's: the host has no sign-in of its own (the proxy in front is it), and the route table
 * has already required a JSON body on every write, so a page on another site cannot send one.
 */

export interface WatchRoutes {
    handles(path: string): boolean;
    handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>;
}

const MAX_BODY = 16 * 1024;

async function readJson(req: IncomingMessage): Promise<object> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) throw new WatchRefusal("That request is too large.", 400);
        chunks.push(chunk as Buffer);
    }
    try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        return parsed;
    } catch {
        throw new WatchRefusal("The request body is not a JSON object.", 400);
    }
}

/** The origin the app was opened at, as the proxy in front passes it on: it names this sender to the push service. */
function originOf(req: IncomingMessage): string | undefined {
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    if (typeof host !== "string" || host === "") return undefined;
    const proto = req.headers["x-forwarded-proto"];
    const scheme = typeof proto === "string" && proto !== "" ? proto.split(",")[0]!.trim() : "https";
    return `${scheme}://${host.split(",")[0]!.trim()}`;
}

export function createWatchRoutes(service: WatchService, userId: string): WatchRoutes {
    async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
        const method = req.method ?? "GET";
        const rest = path.slice(WATCH_BASE.length);

        if (rest === "") {
            if (method === "GET") return json(res, 200, service.view(userId));
            if (method === "PATCH") {
                const body = await readJson(req);
                const field = (key: string): unknown => Reflect.get(body, key);
                if (field("enabled") !== undefined && typeof field("enabled") !== "boolean") throw new WatchRefusal("enabled must be true or false.", 400);
                if (field("rule") !== undefined && typeof field("rule") !== "string") throw new WatchRefusal("rule must be text.", 400);
                if (field("visionModel") !== undefined && typeof field("visionModel") !== "string") throw new WatchRefusal("visionModel must be text.", 400);
                if (field("fastAlerts") !== undefined && typeof field("fastAlerts") !== "boolean") throw new WatchRefusal("fastAlerts must be true or false.", 400);
                const alertZone = field("alertZone");
                if (alertZone !== undefined && (alertZone === null || typeof alertZone !== "object" || Array.isArray(alertZone))) {
                    throw new WatchRefusal("alertZone must be an object with x0, y0, x1 and y1.", 400);
                }
                if (field("fastSummary") !== undefined && typeof field("fastSummary") !== "boolean") throw new WatchRefusal("fastSummary must be true or false.", 400);
                if (field("summaryModel") !== undefined && typeof field("summaryModel") !== "string") throw new WatchRefusal("summaryModel must be text.", 400);
                const fastSummary = field("fastSummary");
                const summaryModel = field("summaryModel");
                const fastAlerts = field("fastAlerts");
                const enabled = field("enabled");
                const rule = field("rule");
                const visionModel = field("visionModel");
                return json(
                    res,
                    200,
                    service.update(userId, {
                        ...(typeof enabled === "boolean" ? { enabled } : {}),
                        ...(typeof rule === "string" ? { rule } : {}),
                        ...(typeof visionModel === "string" ? { visionModel } : {}),
                        ...(typeof fastAlerts === "boolean" ? { fastAlerts } : {}),
                        ...(typeof fastSummary === "boolean" ? { fastSummary } : {}),
                        ...(typeof summaryModel === "string" ? { summaryModel } : {}),
                        ...(alertZone !== undefined ? { alertZone: alertZone as WatchZone } : {}),
                    }),
                );
            }
            return json(res, 405, { error: "GET or PATCH only" });
        }

        if (rest === "/checks") {
            if (method !== "GET") return json(res, 405, { error: "GET only" });
            const asked = Number(new URL(req.url ?? "/", "http://x").searchParams.get("limit") ?? 20);
            const limit = Number.isFinite(asked) ? Math.min(100, Math.max(1, Math.floor(asked))) : 20;
            return json(res, 200, { checks: service.checks(userId, limit) });
        }

        if (method !== "POST") return json(res, 405, { error: "POST only" });

        if (rest === "/subscribe") {
            const body = await readJson(req);
            const userAgent = req.headers["user-agent"];
            const origin = originOf(req);
            service.subscribe(userId, Reflect.get(body, "subscription"), { userAgent, origin });
            return json(res, 200, { subscribed: true });
        }
        if (rest === "/unsubscribe") {
            const body = await readJson(req);
            const endpoint = Reflect.get(body, "endpoint");
            if (typeof endpoint !== "string") throw new WatchRefusal("endpoint must be text.", 400);
            return json(res, 200, { removed: service.unsubscribe(userId, endpoint) });
        }
        if (rest === "/test") {
            const result = await service.test(userId);
            return json(res, 200, { sent: result.sent, removed: result.removed, failed: result.failed });
        }
        return json(res, 404, { error: "Not found" });
    }

    return {
        handles: (path) => path === WATCH_BASE || path.startsWith(`${WATCH_BASE}/`),
        async handle(req, res, path) {
            try {
                await route(req, res, path);
            } catch (error) {
                if (error instanceof WatchRefusal) return json(res, error.status, { error: error.message });
                console.error("[watch] route failed:", error);
                json(res, 500, { error: "Internal error" });
            }
        },
    };
}
