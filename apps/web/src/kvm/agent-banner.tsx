/**
 * The KVM tab's agent banner: who has control, what the agent is doing, Stop, and Hand back. It is a chip over
 * the picture, not a bar, so the picture keeps its size. The agent's pointer is drawn separately (AgentPointer).
 *
 * Control is the server's: a person's mouse or keys at the target take it back (state `released`, reason
 * `operator`), and only Hand back, or a new message in Chat, gives it again.
 */

import { Link, useRouter } from "@tanstack/react-router";
import { EXTERNAL_PREFIX, type AgentActivity, type PendingApproval } from "@pikvm/contracts/api";
import { useState } from "react";
import { actionLabel, answerApproval, handBackToAgent, stopAgent, useAgentActivity, useAgentApprovals } from "../agent/activity";

interface Words {
    readonly title: string;
    readonly detail?: string;
}

export function describeActivity(activity: AgentActivity): Words | null {
    switch (activity.state) {
        case "idle":
            return null;
        case "working":
            return { title: "Agent is working", detail: actionLabel(activity.tool) };
        case "waiting_approval":
            return { title: "Needs your approval", detail: actionLabel(activity.tool) };
        case "released":
            switch (activity.reason) {
                case "operator":
                    return { title: "You have control", detail: "The agent is waiting for you to hand it back." };
                case "lease_timeout":
                    return { title: "Agent control timed out", detail: "Send it another message to continue." };
                default:
                    return { title: "Agent stopped" };
            }
    }
}

/** The approval a link named (`/kvm?approve=<id>`), when it still waits. The server makes the id; it grants nothing, answering needs a signed-in person. */
function linkedApproval(approvals: readonly PendingApproval[], search: unknown): PendingApproval | undefined {
    const id = typeof search === "object" && search !== null ? (search as Record<string, unknown>)["approve"] : undefined;
    return typeof id === "string" ? approvals.find((approval) => approval.id === id) : undefined;
}

export function AgentBanner() {
    const activity = useAgentActivity();
    const approvals = useAgentApprovals();
    // The screen is also drawn without a router (its own tests, a host page): then no link names anything. Opening a link loads the page
    // fresh, and every change in the waiting list draws the banner again, so the router's state at that moment is the link's.
    const search = useRouter({ warn: false })?.state.location.search;
    const [failed, setFailed] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // An outside client is waiting on the person: that comes before everything else the chip could say. First in, first
    // shown (the server lists them in the order they asked), unless a link named one.
    const waiting = linkedApproval(approvals, search) ?? approvals[0];
    if (waiting) return <ApprovalCard approval={waiting} more={approvals.length - 1} />;
    if (!activity) return null;
    const words = describeActivity(activity);
    if (!words) return null;

    const run = (action: () => Promise<unknown>) => {
        setBusy(true);
        setFailed(null);
        action()
            .catch((error: unknown) => setFailed(error instanceof Error ? error.message : "That did not work."))
            .finally(() => setBusy(false));
    };
    const working = activity.state === "working" || activity.state === "waiting_approval";

    return (
        <div className="kvm-agent" data-state={activity.state} data-reason={activity.reason} role="status" aria-live="polite" data-kvm-ui="">
            <span className="kvm-agent-dot" aria-hidden="true" />
            <span className="kvm-agent-text">
                <strong>{words.title}</strong>
                {words.detail ? <span>{words.detail}</span> : null}
                {failed ? <span className="kvm-agent-error">{failed}</span> : null}
            </span>
            {/* Chat's own approvals are cards in the conversation. An outside MCP client has none: its card is the one above, so there is nothing to open. */}
            {activity.state === "waiting_approval" && !activity.conversationId?.startsWith(EXTERNAL_PREFIX) ? (
                <Link to="/chat" className="kvm-btn primary">
                    Open Chat
                </Link>
            ) : null}
            {working ? (
                <button type="button" className="kvm-btn" disabled={busy} onClick={() => run(stopAgent)}>
                    Stop
                </button>
            ) : null}
            {activity.state === "released" && activity.reason === "operator" ? (
                <button type="button" className="kvm-btn primary" disabled={busy} onClick={() => run(handBackToAgent)}>
                    Hand back
                </button>
            ) : null}
        </div>
    );
}

/**
 * One action an outside MCP client (Claude Code, Codex, Executor) wants to do and the person has not yet allowed. It
 * says who asks, what, and why it asks, and holds the client's call open until Allow or Deny, or the server drops it.
 * Nothing else here can answer for the person: the server refuses an answer from a script's credentials.
 */
function ApprovalCard({ approval, more }: { approval: PendingApproval; more: number }) {
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const answer = (decision: "approved" | "denied") => {
        setBusy(true);
        setFailed(null);
        answerApproval(approval.id, decision)
            .catch((error: unknown) => setFailed(error instanceof Error ? error.message : "That did not work."))
            .finally(() => setBusy(false));
    };
    return (
        <div className="kvm-agent kvm-agent-approval" data-state="waiting_approval" role="group" aria-label="Approval needed" data-kvm-ui="">
            <span className="kvm-agent-dot" aria-hidden="true" />
            <span className="kvm-agent-text">
                <strong>{approval.client} needs your approval</strong>
                <span>{approval.title}</span>
                <span className="kvm-agent-summary">{approval.summary}</span>
                {approval.reasons.length ? <span>Asking because {approval.reasons.join("; ")}.</span> : null}
                {more > 0 ? <span>{more} more waiting.</span> : null}
                {failed ? <span className="kvm-agent-error">{failed}</span> : null}
            </span>
            <button type="button" className="kvm-btn primary" disabled={busy} onClick={() => answer("approved")}>
                Allow
            </button>
            <button type="button" className="kvm-btn" disabled={busy} onClick={() => answer("denied")}>
                Deny
            </button>
        </div>
    );
}

/**
 * Where the agent's pointer is, over the picture. The box has the picture's aspect ratio and is centred, which is
 * exactly where the picture's `object-fit: contain` draws it, so the fractions the server sends land on the same
 * pixel on any screen. Not drawn while the picture is zoomed or panned (the box is then not the picture) or before
 * a frame has arrived.
 */
export function AgentPointer({ width, height, scale }: { width: number; height: number; scale: number }) {
    const activity = useAgentActivity();
    if (!activity || activity.state !== "working" || !activity.pointer || width === 0 || height === 0 || scale !== 1) return null;
    return (
        <div className="kvm-agent-frame" style={{ aspectRatio: `${width} / ${height}` }} aria-hidden="true" data-kvm-ui="">
            <span
                className="kvm-agent-pointer"
                data-testid="agent-pointer"
                style={{ left: `${activity.pointer.fx * 100}%`, top: `${activity.pointer.fy * 100}%` }}
            />
        </div>
    );
}
