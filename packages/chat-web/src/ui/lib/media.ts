import { useSyncExternalStore } from "react";

function useMedia(query: string): boolean {
    return useSyncExternalStore(
        (fn) => {
            const m = matchMedia(query);
            m.addEventListener("change", fn);
            return () => m.removeEventListener("change", fn);
        },
        () => matchMedia(query).matches,
        () => false,
    );
}

/**
 * Phone layout: the conversation list becomes a drawer and menus become bottom sheets. The same query the host app
 * uses for its compact layout (apps/web app/viewport.ts COMPACT_QUERY), so the pane switches layout together with
 * the host's bottom navigation: touch screens, and narrow windows.
 */
export const PHONE_QUERY = "(pointer: coarse), (max-width: 719px)";
export const useIsMobile = () => useMedia(PHONE_QUERY);
export const useCoarsePointer = () => useMedia("(pointer: coarse)");
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Platform shortcut label: "Ctrl+Shift+S" or "⇧⌘S" style on macOS. */
export function shortcutLabel(keys: string): string {
    if (!isMac) return keys.replace(/Mod/g, "Ctrl");
    return keys
        .split("+")
        .map((k) => ({ Mod: "⌘", Ctrl: "⌃", Shift: "⇧", Alt: "⌥" })[k] ?? k)
        .join("");
}
