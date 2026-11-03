/**
 * The Chat pane's layout. Wide: the conversation list is a column beside the thread. Phone layout: the list is an
 * off-canvas drawer that pushes the page aside, opened by the header button or a horizontal swipe.
 *
 * Everything is relative to the pane, never the window: the drawer and the page are positioned inside this element,
 * widths are container units, so the host's bottom navigation stays on top and a hidden pane moves nothing. The swipe
 * engages only after a mostly horizontal pan and not in the first 16 px at the screen edge (drawer-gesture.ts), so
 * it does not fight the OS back gesture.
 *
 * The open drawer is modal: a labelled dialog, focus moves into it, the page under the scrim is inert, Escape closes
 * it. Its Escape handler is on the pane, not the window.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useT } from "../../l10n/provider";
import { useIsMobile } from "../../lib/media";
import { usePaneActive } from "../../lib/pane-active";
import { ShellContext, type ShellState } from "./context";
import { attachDrawerGesture } from "./drawer-gesture";

const DRAWER_WIDTH = "min(85cqw, 320px)";

export function PaneShell({ list, children }: { list: ReactNode; children: ReactNode }) {
    const t = useT();
    const mobile = useIsMobile();
    const active = usePaneActive();
    const [open, setOpenState] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const drawer = useRef<HTMLDivElement>(null);
    const openRef = useRef(open);
    openRef.current = open;
    const gestureOn = useRef(false);
    gestureOn.current = mobile && active;

    const setOpen = useCallback((next: boolean) => {
        openRef.current = next;
        setOpenState(next);
    }, []);
    // The drawer only exists in the phone layout, and a hidden pane keeps it shut.
    const drawerOpen = open && mobile && active;

    useEffect(() => {
        const el = root.current;
        if (!el || !mobile) return;
        return attachDrawerGesture({
            root: el,
            width: () => drawer.current?.offsetWidth ?? 300,
            isOpen: () => openRef.current,
            setOpen,
            enabled: () => gestureOn.current,
        });
    }, [mobile, setOpen]);

    // Focus into the open drawer, and back to what opened it when it closes (never to the composer).
    const opener = useRef<HTMLElement | null>(null);
    useEffect(() => {
        const panel = drawer.current;
        if (drawerOpen && panel) {
            const current = document.activeElement;
            if (current instanceof HTMLElement && !panel.contains(current)) opener.current = current;
            const frame = requestAnimationFrame(() => panel.focus({ preventScroll: true }));
            return () => cancelAnimationFrame(frame);
        }
        const back = opener.current;
        opener.current = null;
        if (back?.isConnected && back.tagName !== "TEXTAREA" && !panel?.contains(document.activeElement)) {
            back.focus({ preventScroll: true });
        }
    }, [drawerOpen]);

    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && !e.defaultPrevented && openRef.current) {
            e.preventDefault();
            setOpen(false);
        }
    };

    const state = useMemo<ShellState>(
        () => ({
            mobile,
            sidebarOpen: drawerOpen,
            setSidebarOpen: setOpen,
            toggleSidebar: () => setOpen(!openRef.current),
            afterNavigate: () => setOpen(false),
        }),
        [mobile, drawerOpen, setOpen],
    );

    if (!mobile) {
        return (
            <ShellContext.Provider value={state}>
                <div ref={root} data-shell="wide" className="relative flex h-full min-h-0 overflow-hidden">
                    <aside
                        aria-label={t("shell-sidebar")}
                        className="h-full w-[var(--sidebar-width)] max-w-[40%] shrink-0 border-e border-default bg-sidebar"
                    >
                        {list}
                    </aside>
                    <main className="relative isolate flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-surface">
                        {children}
                    </main>
                </div>
            </ShellContext.Provider>
        );
    }

    return (
        <ShellContext.Provider value={state}>
            {/* data-open feeds --p (0 closed .. 1 open); a drag overrides it through --drawer-progress. */}
            <div
                ref={root}
                data-shell="phone"
                data-open={drawerOpen}
                onKeyDown={onKeyDown}
                className="group/shell relative h-full touch-pan-y overflow-hidden bg-sidebar [container-type:inline-size] [--p:var(--drawer-progress,0)] data-[open=true]:[--p:var(--drawer-progress,1)]"
            >
                <div
                    ref={drawer}
                    // A dialog only while open: code that looks for open overlays must not see the closed drawer.
                    role={drawerOpen ? "dialog" : undefined}
                    aria-modal={drawerOpen || undefined}
                    aria-label={t("shell-sidebar")}
                    tabIndex={-1}
                    aria-hidden={!drawerOpen}
                    inert={!drawerOpen}
                    style={{ width: DRAWER_WIDTH }}
                    className="absolute inset-y-0 left-0 z-[1] bg-sidebar outline-none [transform:translateX(calc((var(--p)-1)*100%))] transition-transform duration-300 ease-[var(--ease-enter)] group-data-[dragging=true]/shell:transition-none"
                >
                    {list}
                </div>
                <div
                    data-page-card=""
                    style={{ ["--drawer-w" as string]: DRAWER_WIDTH }}
                    className="absolute inset-0 z-10 overflow-hidden group-data-[open=true]/shell:shadow-dialog [transform:translateX(calc(var(--p)*var(--drawer-w)))] [border-start-start-radius:calc(24px*var(--roundness)*var(--p))] [border-end-start-radius:calc(24px*var(--roundness)*var(--p))] transition-[transform,border-radius] duration-300 ease-[var(--ease-enter)] group-data-[dragging=true]/shell:transition-none"
                >
                    <main
                        inert={drawerOpen}
                        className="relative isolate flex h-full flex-col overflow-hidden bg-surface"
                    >
                        {children}
                    </main>
                    <div
                        aria-hidden
                        data-page-scrim=""
                        onClick={() => setOpen(false)}
                        className="absolute inset-0 z-10 bg-drawer-scrim [opacity:calc(var(--p)*0.35)] transition-opacity duration-300 group-data-[dragging=true]/shell:transition-none"
                        style={{ pointerEvents: drawerOpen ? "auto" : "none" }}
                    />
                </div>
            </div>
        </ShellContext.Provider>
    );
}
