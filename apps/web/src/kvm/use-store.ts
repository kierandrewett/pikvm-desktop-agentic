import type { ReadableStore } from "@pikvm/kvm-engine";
import { useSyncExternalStore } from "react";

/** Engine stores are shaped for useSyncExternalStore, so reading one is a single call. */
export function useStore<S>(store: ReadableStore<S>): S {
    return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
