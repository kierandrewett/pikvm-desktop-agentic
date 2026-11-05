/**
 * Whether the agent holds the keyboard and mouse, so the person's input to the target is refused.
 *
 * The server decides it (`agentHoldsInput` over the agent's activity) and enforces it at the proxy; this only lets the
 * page stop offering what the server would drop, and let go of anything held when it begins.
 */

import { createContext, useContext } from "react";

const KvmLockedContext = createContext(false);

export const KvmLockedProvider = KvmLockedContext.Provider;

export function useKvmLocked(): boolean {
    return useContext(KvmLockedContext);
}
