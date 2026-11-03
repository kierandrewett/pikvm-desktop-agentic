/**
 * Thread-wide context: the conversation id and display options. Kept in its own module so turn and activity
 * components can share it without importing each other.
 */
import { createContext } from "react";

/**
 * A view of the right-hand panel in chat's own app (files, sources, a file preview, subagent runs). The Chat pane
 * has no side panel, so `ThreadContextValue.openPanel` is never provided and the controls that would call it stay
 * hidden; the type remains because the step components still describe what they would open.
 */
export type PanelView =
    | { kind: "files" }
    | { kind: "sources"; focus?: string }
    | { kind: "file"; path: string }
    | { kind: "subagents" }
    | { kind: "subagent"; callId: string; agentId: string; back?: PanelView }
    | { kind: "upload"; uploadId: string; name: string };

export interface ThreadContextValue {
    conversationId: string;
    /** Read-only miniature: do not mount message actions. */
    preview?: boolean;
    /** Optional: open a side panel with a turn's activity instead of expanding it inline. */
    onOpenDetails?: (turnKey: string) => void;
    /** Open a side panel on a view. Not provided in the Chat pane. */
    openPanel?: (view: PanelView) => void;
    /** `ui.thread.avatars`: user and model avatars at the start of each run. */
    avatars?: boolean;
    /** `ui.thread.assistantBubbles`: assistant replies in bubbles. */
    assistantBubbles?: boolean;
}

export const ThreadContext = createContext<ThreadContextValue>({ conversationId: "" });
