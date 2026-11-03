/**
 * Thread-wide context: the conversation id and display options. Kept in its own module so turn and activity
 * components can share it without importing each other.
 */
import { createContext } from "react";

export interface ThreadContextValue {
    conversationId: string;
    /** Read-only miniature: do not mount message actions. */
    preview?: boolean;
    /** `ui.thread.avatars`: user and model avatars at the start of each run. */
    avatars?: boolean;
    /** `ui.thread.assistantBubbles`: assistant replies in bubbles. */
    assistantBubbles?: boolean;
}

export const ThreadContext = createContext<ThreadContextValue>({ conversationId: "" });
