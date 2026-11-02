/**
 * Engine stores are shaped for useSyncExternalStore, so a hook is two lines. The selector must
 * return a stable value (a primitive, or a part of the state that keeps its identity), or React
 * would see a new snapshot on every read.
 */

import type { ReadableStore } from "@pikvm/kvm-engine";
import { useSyncExternalStore } from "react";

export function useStore<S>(store: ReadableStore<S>): S {
    return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function useStoreSelector<S, T>(store: ReadableStore<S>, select: (state: S) => T): T {
    return useSyncExternalStore(
        store.subscribe,
        () => select(store.getState()),
        () => select(store.getState()),
    );
}
