/**
 * Whether the KVM screen is the one in front of the user.
 *
 * The screen stays mounted while Chat or Settings is showing, so the picture and the link are
 * live the moment it returns. Mounted is therefore not the same as in use: everything that
 * listens on the document or the window, takes the keyboard, or holds the screen awake asks here
 * and goes quiet while another tab is up.
 */

import { createContext, useContext } from "react";

const KvmActiveContext = createContext(true);

export const KvmActiveProvider = KvmActiveContext.Provider;

export function useKvmActive(): boolean {
    return useContext(KvmActiveContext);
}
