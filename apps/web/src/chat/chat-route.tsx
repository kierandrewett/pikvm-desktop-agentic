/**
 * The Chat destination: the conversation pane from @pikvm/chat-web, rendered in the app (no iframe), talking to the
 * chat server inside the host at /app/chat/*.
 *
 * Two states come before the conversation:
 *   - the host cannot be reached at all   -> say so, offer a retry;
 *   - the host's chat server is not up    -> "Chat is not available" with the reason it gave.
 * When the chat server is up but the agent program was not found, the pane still opens (the providers and settings
 * work) with a note on top saying what is missing, since a message could not be answered.
 *
 * ChatScope carries the pane's tokens and utilities, so nothing it defines applies outside the pane. `active` says
 * whether the Chat tab is in front: a hidden pane stays mounted, with its page-wide listeners off.
 */

import { ChatPane, ChatScope, onRunFinished } from "@pikvm/chat-web";
import { useEffect } from "react";
import { useAppState } from "../api/queries";
import { badgeController } from "../notify/app-badge";

export function ChatRoute({ active }: { active: boolean }) {
    const state = useAppState();
    // A run that ends while the app is out of sight puts a badge on its icon (a run the person stopped does not).
    useEffect(
        () =>
            onRunFinished((run) => {
                if (run.status !== "cancelled") badgeController.chatRunFinished();
            }),
        [],
    );

    if (state.isPending) return <div className="empty-state" role="status" aria-label="Loading" />;

    if (state.isError) {
        return (
            <div className="empty-state">
                <h1>Cannot reach the app server</h1>
                <p>{state.error.message} Check that the host is running, then try again.</p>
                <button type="button" className="btn btn-primary" onClick={() => void state.refetch()}>
                    Try again
                </button>
            </div>
        );
    }

    const { chat, agent } = state.data.features;
    if (!chat) {
        return (
            <div className="empty-state">
                <h1>Chat is not available</h1>
                <p>
                    The chat server inside this host is not running{agent?.reason ? `: ${agent.reason}` : ""}. If it was just
                    started, give it a moment and check again.
                </p>
                <button type="button" className="btn btn-primary" onClick={() => void state.refetch()}>
                    Check again
                </button>
            </div>
        );
    }

    return (
        <div className="chat-surface">
            {agent && !agent.found ? (
                <p className="chat-note" role="alert">
                    The agent program was not found, so messages cannot be answered yet.
                    {agent.reason ? ` ${agent.reason}` : ""}
                </p>
            ) : null}
            <ChatScope active={active}>
                <ChatPane />
            </ChatScope>
        </div>
    );
}
