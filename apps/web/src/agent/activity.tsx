/**
 * What the agent is doing with the PiKVM, as the server says it. The server is the only witness: it sees the
 * agent's tool calls, a person's input at the proxy, Stop and the lease, so the page asks nothing of the person's
 * pointer and decides nothing about who has control.
 *
 * One server-sent-events stream per page, opened while the host has a chat server and shared through context by the
 * KVM tab (the banner, the outline, the agent's pointer) and the tab bar (an approval is waiting).
 */

import {
    AGENT_ACTIVITY_PATH,
    AGENT_APPROVAL_PATH,
    AGENT_APPROVALS_PATH,
    AGENT_HANDBACK_PATH,
    AGENT_STOP_PATH,
    AgentActivity,
    AgentApprovalResult,
    AgentHandBackResult,
    AgentStopResult,
    PendingApproval,
} from "@pikvm/contracts/api";
import { Schema } from "effect";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

const decode = Schema.decodeUnknownSync(AgentActivity);
const decodeApprovals = Schema.decodeUnknownSync(Schema.Array(PendingApproval));

/** A stream of activity: each message is one AgentActivity. Exposed for tests. */
export function parseActivity(data: string): AgentActivity | undefined {
    try {
        return decode(JSON.parse(data));
    } catch {
        return undefined;
    }
}

/** A stream of waiting approvals: each message is the whole list. Exposed for tests. */
export function parseApprovals(data: string): readonly PendingApproval[] | undefined {
    try {
        return decodeApprovals(JSON.parse(data));
    } catch {
        return undefined;
    }
}

const AgentContext = createContext<AgentActivity | undefined>(undefined);
const ApprovalsContext = createContext<readonly PendingApproval[]>([]);

/** Open the stream while `enabled`. Its reconnects are the browser's own; a message this page cannot read is ignored. */
export function AgentActivityProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
    const [activity, setActivity] = useState<AgentActivity | undefined>(undefined);
    const [approvals, setApprovals] = useState<readonly PendingApproval[]>([]);

    useEffect(() => {
        if (!enabled || typeof EventSource === "undefined") return;
        const source = new EventSource(AGENT_ACTIVITY_PATH);
        source.onmessage = (event: MessageEvent<string>) => {
            const next = parseActivity(event.data);
            if (next) setActivity(next);
        };
        // Between a drop and the reconnect nobody knows; say nothing rather than something stale.
        source.onerror = () => setActivity(undefined);
        // What outside MCP clients are waiting to do: a person answers them here.
        const waiting = new EventSource(AGENT_APPROVALS_PATH);
        waiting.onmessage = (event: MessageEvent<string>) => {
            const next = parseApprovals(event.data);
            if (next) setApprovals(next);
        };
        waiting.onerror = () => setApprovals([]);
        return () => {
            source.close();
            waiting.close();
            setActivity(undefined);
            setApprovals([]);
        };
    }, [enabled]);

    return (
        <AgentContext.Provider value={activity}>
            <ApprovalsContext.Provider value={approvals}>{children}</ApprovalsContext.Provider>
        </AgentContext.Provider>
    );
}

/** The agent's current activity, or undefined when there is no stream (no chat, or between reconnects). */
export function useAgentActivity(): AgentActivity | undefined {
    return useContext(AgentContext);
}

/** What outside MCP clients are waiting to do, oldest first. Empty when nothing waits or there is no stream. */
export function useAgentApprovals(): readonly PendingApproval[] {
    return useContext(ApprovalsContext);
}

async function post<A>(path: string, decodeBody: (body: unknown) => A): Promise<A> {
    // JSON, so a page on another origin cannot send it without a preflight, which the server never answers.
    const reply = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!reply.ok) throw new Error(`The server answered ${reply.status}.`);
    return decodeBody(await reply.json());
}

/** The person pressed Stop. */
export const stopAgent = () => post(AGENT_STOP_PATH, Schema.decodeUnknownSync(AgentStopResult));

/** The person gives control back to the run that lost it. */
export const handBackToAgent = () => post(AGENT_HANDBACK_PATH, Schema.decodeUnknownSync(AgentHandBackResult));

/** The person's answer to one waiting action. Throws the server's sentence when it is no longer waiting or may not be answered here. */
export async function answerApproval(id: string, decision: "approved" | "denied"): Promise<void> {
    const reply = await fetch(AGENT_APPROVAL_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, decision }) });
    if (reply.ok) {
        Schema.decodeUnknownSync(AgentApprovalResult)(await reply.json());
        return;
    }
    const body = (await reply.json().catch(() => undefined)) as { error?: unknown } | undefined;
    throw new Error(typeof body?.error === "string" ? body.error : `The server answered ${reply.status}.`);
}

const ACTIONS: Readonly<Record<string, string>> = {
    screenshot: "Looking at the screen",
    screen_info: "Checking the screen",
    read_text: "Reading text on the screen",
    mouse_move: "Moving the pointer",
    click: "Clicking",
    drag: "Dragging",
    scroll: "Scrolling",
    type_text: "Typing",
    key: "Pressing keys",
    wait: "Waiting for the screen",
    power: "Using the power control",
};

/** What a tool call is, in words for a person. An unknown tool is shown as its name. */
export function actionLabel(tool: string | undefined): string {
    if (!tool) return "Working";
    return ACTIONS[tool] ?? tool.replaceAll("_", " ");
}
