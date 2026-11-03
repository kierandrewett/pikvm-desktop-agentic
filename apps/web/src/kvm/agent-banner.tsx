/**
 * The KVM tab's agent banner: who has control, what the agent is doing, Stop, and Hand back. It is a chip over
 * the picture, not a bar, so the picture keeps its size. The agent's pointer is drawn separately (AgentPointer).
 *
 * Control is the server's: a person's mouse or keys at the target take it back (state `released`, reason
 * `operator`), and only Hand back, or a new message in Chat, gives it again.
 */

import { Link } from "@tanstack/react-router";
import type { AgentActivity } from "@pikvm/contracts/api";
import { useState } from "react";
import { actionLabel, handBackToAgent, stopAgent, useAgentActivity } from "../agent/activity";

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

export function AgentBanner() {
    const activity = useAgentActivity();
    const [failed, setFailed] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
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
            {activity.state === "waiting_approval" ? (
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
