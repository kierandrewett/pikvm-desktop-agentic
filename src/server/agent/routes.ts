import type { IncomingMessage, ServerResponse } from "node:http";
import {
    AGENT_ACTIVITY_PATH,
    AGENT_APPROVAL_PATH,
    AGENT_APPROVALS_PATH,
    AGENT_HANDBACK_PATH,
    AGENT_STOP_PATH,
    AgentApprovalAnswer,
    type AgentApprovalResult,
    type AgentHandBackResult,
    type AgentStopResult,
} from "@pikvm/contracts/api";
import { Schema } from "effect";
import { json, readBody } from "../http";
import type { SignedIn } from "../web-auth";
import type { ActivityFeed } from "./activity";
import type { ApprovalQueue } from "./approvals";

/**
 * The KVM tab's agent routes: what the agent is doing (server-sent events), Stop, Hand back, and the actions an
 * outside MCP client is waiting to do (a stream of the waiting list, and the person's answer).
 *
 * They sit behind the gate like everything under /app, and the POSTs need a JSON body (the route table checks
 * the content type), so a page on another origin cannot press Stop or Allow for the person.
 */

export interface AgentControls {
    /** The person pressed Stop: control is taken from every run, and the running responses are cancelled. */
    stop(): void;
    /** The person gave control back; how many runs got it. */
    handBack(): number;
}

export const AGENT_PATHS: ReadonlySet<string> = new Set([
    AGENT_ACTIVITY_PATH,
    AGENT_APPROVALS_PATH,
    AGENT_APPROVAL_PATH,
    AGENT_STOP_PATH,
    AGENT_HANDBACK_PATH,
]);

/** A keep-alive comment this often, so a proxy that closes idle streams does not close this one. */
export const ACTIVITY_KEEPALIVE_MS = 15_000;

const MAX_ANSWER = 1024;
const decodeAnswer = Schema.decodeUnknownSync(AgentApprovalAnswer);

export interface AgentRoutes {
    handles(path: string): boolean;
    /** `signedIn` is how the web host's sign-in let the request in (absent on the desktop and where there is no sign-in). */
    handle(req: IncomingMessage, res: ServerResponse, path: string, signedIn?: SignedIn): void;
}

/**
 * Only a person at a browser answers an approval. A script that holds the access token, or a Basic header, is the kind
 * of caller an outside agent could be, so its answer would be the agent approving itself. An MCP client's own token
 * never reaches /app/api at all (web-auth: its audience is the MCP endpoint). The desktop app's device token and the
 * browser's cookie session both pass.
 */
export function mayAnswerApprovals(signedIn: SignedIn | undefined): boolean {
    return !signedIn || (signedIn.method !== "bearer" && signedIn.method !== "basic");
}

export function createAgentRoutes(
    feed: ActivityFeed,
    controls: AgentControls,
    approvals: ApprovalQueue,
    keepAliveMs = ACTIVITY_KEEPALIVE_MS,
): AgentRoutes {
    function stream<T>(
        req: IncomingMessage,
        res: ServerResponse,
        current: () => T,
        subscribe: (listener: (value: T) => void) => () => void,
    ): void {
        res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            connection: "keep-alive",
            // A proxy in front must not buffer a stream the page waits on.
            "x-accel-buffering": "no",
        });
        const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
        send(current());
        const off = subscribe(send);
        const timer = setInterval(() => res.write(": keep-alive\n\n"), keepAliveMs);
        timer.unref();
        req.on("close", () => {
            off();
            clearInterval(timer);
        });
    }

    async function answer(req: IncomingMessage, res: ServerResponse, signedIn: SignedIn | undefined): Promise<void> {
        if (!mayAnswerApprovals(signedIn)) {
            return json(res, 403, { error: "Answer this in the app, signed in with your browser. A script's credentials cannot approve for an agent." });
        }
        let body: AgentApprovalAnswer;
        try {
            body = decodeAnswer(JSON.parse(await readBody(req, MAX_ANSWER)));
        } catch {
            return json(res, 400, { error: "Send {id, decision} with decision approved or denied." });
        }
        if (!approvals.answer(body.id, body.decision)) {
            return json(res, 404, { error: "That request is not waiting any more. It was answered, it timed out, or the agent went away." });
        }
        json(res, 200, { answered: true } satisfies typeof AgentApprovalResult.Type);
    }

    return {
        handles: (path) => AGENT_PATHS.has(path),
        handle(req, res, path, signedIn) {
            const method = req.method ?? "GET";
            if (path === AGENT_ACTIVITY_PATH) {
                if (method !== "GET") return json(res, 405, { error: "GET only" });
                return stream(req, res, feed.current, feed.subscribe);
            }
            if (path === AGENT_APPROVALS_PATH) {
                if (method !== "GET") return json(res, 405, { error: "GET only" });
                return stream(req, res, approvals.pending, approvals.subscribe);
            }
            if (method !== "POST") return json(res, 405, { error: "POST only" });
            if (path === AGENT_APPROVAL_PATH) return void answer(req, res, signedIn);
            if (path === AGENT_STOP_PATH) {
                controls.stop();
                return json(res, 200, { stopped: true } satisfies typeof AgentStopResult.Type);
            }
            return json(res, 200, { handedBack: controls.handBack() } satisfies typeof AgentHandBackResult.Type);
        },
    };
}
