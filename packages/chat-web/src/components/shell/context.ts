/**
 * The pane's shell contract: whether the list is a drawer, and whether it is open. The shell (pane-shell.tsx)
 * provides it; the list and the header read it through useShell().
 */
import { createContext, useContext } from "react";

export interface ShellState {
    mobile: boolean;
    sidebarOpen: boolean;
    setSidebarOpen: (open: boolean) => void;
    toggleSidebar: () => void;
    /** Close the drawer after navigating on mobile. */
    afterNavigate: () => void;
}

export const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
    const s = useContext(ShellContext);
    if (!s) throw new Error("useShell outside PaneShell");
    return s;
}
