/**
 * A minimal observable value, shaped for React's useSyncExternalStore.
 *
 * `getState` returns the same reference until something actually changes, and `subscribe`
 * returns its own unsubscribe, so a hook is two lines and cannot tear. The engine never
 * imports React; this is the whole seam.
 */
export interface ReadableStore<S> {
    getState(): S;
    subscribe(listener: () => void): () => void;
}

export interface Store<S> extends ReadableStore<S> {
    /** Replace the state. A reference-equal value is not a change and notifies nobody. */
    setState(next: S): void;
}

export function createStore<S>(initial: S): Store<S> {
    let state = initial;
    const listeners = new Set<() => void>();
    return {
        getState: () => state,
        setState(next) {
            if (Object.is(next, state)) return;
            state = next;
            // Copy first: a listener may unsubscribe itself while being notified.
            for (const listener of [...listeners]) listener();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
