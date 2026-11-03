import type { IncomingMessage, ServerResponse } from "node:http";
import { AGENT_ACTIVITY_PATH, AGENT_HANDBACK_PATH, AGENT_STOP_PATH, type AgentHandBackResult, type AgentStopResult } from "@pikvm/contracts/api";
import { json } from "../http";
import type { ActivityFeed } from "./activity";

/**
 * The KVM tab's three agent routes: what the agent is doing (server-sent events), Stop, and Hand back.
 *
 * They sit behind the gate like everything under /app, and the two POSTs need a JSON body (the route table checks
 * the content type), so a page on another origin cannot press Stop for the person.
 */

export interface AgentControls {
    /** The person pressed Stop: control is taken from every run, and the running responses are cancelled. */
    stop(): void;
    /** The person gave control back; how many runs got it. */
    handBack(): number;
}

export const AGENT_PATHS: ReadonlySet<string> = new Set([AGENT_ACTIVITY_PATH, AGENT_STOP_PATH, AGENT_HANDBACK_PATH]);

/** A keep-alive comment this often, so a proxy that closes idle streams does not close this one. */
export const ACTIVITY_KEEPALIVE_MS = 15_000;

export interface AgentRoutes {
    handles(path: string): boolean;
    handle(req: IncomingMessage, res: ServerResponse, path: string): void;
}

export function createAgentRoutes(feed: ActivityFeed, controls: AgentControls, keepAliveMs = ACTIVITY_KEEPALIVE_MS): AgentRoutes {
    function stream(req: IncomingMessage, res: ServerResponse): void {
        res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            connection: "keep-alive",
            // A proxy in front must not buffer a stream the page waits on.
            "x-accel-buffering": "no",
        });
        const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
        send(feed.current());
        const off = feed.subscribe(send);
        const timer = setInterval(() => res.write(": keep-alive\n\n"), keepAliveMs);
        timer.unref();
        req.on("close", () => {
            off();
            clearInterval(timer);
        });
    }

    return {
        handles: (path) => AGENT_PATHS.has(path),
        handle(req, res, path) {
            const method = req.method ?? "GET";
            if (path === AGENT_ACTIVITY_PATH) {
                if (method !== "GET") return json(res, 405, { error: "GET only" });
                return stream(req, res);
            }
            if (method !== "POST") return json(res, 405, { error: "POST only" });
            if (path === AGENT_STOP_PATH) {
                controls.stop();
                return json(res, 200, { stopped: true } satisfies typeof AgentStopResult.Type);
            }
            return json(res, 200, { handedBack: controls.handBack() } satisfies typeof AgentHandBackResult.Type);
        },
    };
}
