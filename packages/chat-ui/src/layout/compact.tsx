/**
 * Which layout the workspace draws.
 *
 * The rule is the app shell's: a coarse primary pointer (a phone or tablet) or a narrow
 * window is "compact". It is decided once, by the host or here, and handed down through
 * context, because pickers, menus and the header all change shape with it and none of
 * them should be re-measuring the screen on their own. Tests choose a layout by
 * rendering the provider, not by resizing a jsdom window.
 */

import { type CSSProperties, createContext, type ReactNode, useContext, useMemo, useSyncExternalStore } from "react";

export const COMPACT_QUERY = "(pointer: coarse), (max-width: 719px)";

interface Presentation {
    readonly compact: boolean;
    /** The bottom safe-area inset portalled surfaces should clear, as a CSS length. */
    readonly safeBottom: string;
}

const CompactContext = createContext<Presentation>({ compact: false, safeBottom: "0px" });

export function CompactProvider({
    compact,
    insets = "self",
    children,
}: {
    compact: boolean;
    insets?: "self" | "host";
    children: ReactNode;
}) {
    const value = useMemo<Presentation>(
        () => ({ compact, safeBottom: insets === "host" ? "0px" : "env(safe-area-inset-bottom, 0px)" }),
        [compact, insets],
    );
    return <CompactContext.Provider value={value}>{children}</CompactContext.Provider>;
}

/** True when the workspace is laid out for a phone: sheets instead of popovers, 44px targets. */
export function useCompact(): boolean {
    return useContext(CompactContext).compact;
}

/**
 * What a surface rendered into a portal (sheet, dialog, menu) needs to inherit from the
 * workspace it was opened from. It sits outside the workspace's DOM, so neither the
 * `data-layout` stamp nor the safe-area variables reach it by cascade.
 */
export function usePortalPresentation(): { "data-layout"?: "compact"; style?: CSSProperties } {
    const { compact, safeBottom } = useContext(CompactContext);
    return compact ? { "data-layout": "compact", style: { "--chat-safe-bottom": safeBottom } as CSSProperties } : {};
}

/** The compact decision from the device itself, for hosts that have no shell deciding it. */
export function useCompactLayout(query: string = COMPACT_QUERY): boolean {
    return useSyncExternalStore(
        (notify) => {
            if (typeof window.matchMedia !== "function") return () => {};
            const list = window.matchMedia(query);
            list.addEventListener("change", notify);
            return () => list.removeEventListener("change", notify);
        },
        () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
        () => false,
    );
}
