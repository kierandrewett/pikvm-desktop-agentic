import type { HidInputKind } from "../proxy/kvmd";

/**
 * A person at the target: the keys, buttons, moves, wheel turns and pastes the kvmd proxy saw.
 *
 * The agent's own input never passes the proxy (it has its own link to the Pi), so everything
 * noted here is somebody else. That is what makes "a person moved the mouse" a server-side fact
 * the Desk can act on without trusting any page to report it.
 */

export interface OperatorInput {
    readonly kind: HidInputKind;
    /** Epoch milliseconds when the proxy saw it. */
    readonly at: number;
}

export interface OperatorPresence {
    /** Called by the proxy tap for each frame of real input. */
    note(kind: HidInputKind): void;
    /** When the last input was seen; 0 if none since the server started. */
    lastInputAt(): number;
    subscribe(listener: (input: OperatorInput) => void): () => void;
}

export function createPresence(now: () => number = Date.now): OperatorPresence {
    const listeners = new Set<(input: OperatorInput) => void>();
    let last = 0;
    return {
        note(kind) {
            const input: OperatorInput = { kind, at: now() };
            last = input.at;
            // Copied first: a listener may unsubscribe while it is told.
            for (const listener of [...listeners]) listener(input);
        },
        lastInputAt: () => last,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
