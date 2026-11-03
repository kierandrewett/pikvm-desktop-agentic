/**
 * Loaded features register their private transient state here. The query core does not load feature code.
 * A reset is synchronous. Each feature must also reject old asynchronous results with an account epoch.
 * A module first loaded after a reset starts with its default state, not the previous account's state.
 */
const resets = new Map<string, () => void>();

export function registerSessionReset(name: string, reset: () => void): () => void {
    if (!name.trim()) throw new Error("Session reset needs a name");
    const existing = resets.get(name);
    if (existing && existing !== reset) {
        // Dev hot reload can evaluate a module again (a new ?t= URL) before the old copy's dispose runs, so the
        // newest copy replaces the stale one. In a production build each module runs once: a clash is a real bug.
        if (!import.meta.env.DEV) throw new Error(`Session reset already registered: ${name}`);
        console.warn(`[session-reset] replacing stale registration after hot reload: ${name}`);
    }
    resets.set(name, reset);
    return () => {
        if (resets.get(name) === reset) resets.delete(name);
    };
}

/** Run all resets before reporting failures. A failed reset must not leave other private state intact. */
export function resetSessionState(): void {
    const failures: Error[] = [];
    for (const [name, reset] of resets) {
        try {
            const result: unknown = reset();
            if (result && typeof result === "object" && "then" in result) {
                throw new Error("Session reset must be synchronous");
            }
        } catch (cause) {
            failures.push(new Error(`Session reset failed: ${name}`, { cause }));
        }
    }
    if (failures.length) throw new AggregateError(failures, "Private session state could not be fully reset");
}
