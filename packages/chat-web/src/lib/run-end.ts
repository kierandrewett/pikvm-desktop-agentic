/**
 * A run ending, as the host app hears of it. The pane keeps its own live state per conversation (live.ts); this is the
 * one outward signal: "a response in this conversation just finished", so a host can do something the pane cannot,
 * such as put a badge on the app's icon while the app is out of sight. Only a response this page watched happen: the
 * replay of an old end after a reconnect (`chat.resume`) is not announced.
 */

export interface RunFinished {
    readonly conversationId: string;
    /** How the response ended; `cancelled` is the person stopping it themselves. */
    readonly status: "completed" | "failed" | "incomplete" | "cancelled";
}

const listeners = new Set<(event: RunFinished) => void>();

/** Hear every run that ends from now on. Returns what stops listening. */
export function onRunFinished(listener: (event: RunFinished) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function announceRunFinished(event: RunFinished): void {
    for (const listener of [...listeners]) {
        try {
            listener(event);
        } catch {
            // A host's listener failing must not stop the pane settling the conversation.
        }
    }
}
