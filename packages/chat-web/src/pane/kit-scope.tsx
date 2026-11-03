/**
 * KitScope: what the lifted components and the settings kit need around them, with no chat server behind it. It
 * renders the `.chat-scope` element (tokens and utilities are scoped to it), mirrors the host's `data-theme` onto it,
 * owns the portal layer that menus, sheets and dialogs render into, and tells the tree whether its tab is in front.
 *
 * ChatScope (the conversation pane) and the host's Settings both sit on it; ChatServices adds the chat server's data
 * layer for the pages that talk to it.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
// The scope owns the sheet its tokens and utilities live in, so rendering one is what brings it in.
import "../styles/chat.css";
import { Toaster } from "../components/ui/toast";
import { L10nProvider } from "../l10n/provider";
import { PaneActiveContext } from "../lib/pane-active";
import { createNavStore, NavProvider, type NavStore } from "../nav";
import { PortalLayerContext, TooltipProvider } from "../ui/index";

export interface KitScopeProps {
    /** False while the tab is hidden behind another. */
    active?: boolean;
    /** Where the lifted navigation starts; a settings deep link or a conversation. */
    initialPath?: string;
    /** Classes for the scope element (the host sizes it). Defaults to filling its parent. */
    className?: string;
    children: ReactNode;
}

/** The host's theme, read from <html data-theme> and followed when it changes. */
function useHostTheme(): "light" | "dark" {
    const read = (): "light" | "dark" =>
        document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    const [theme, setTheme] = useState(read);
    useEffect(() => {
        const observer = new MutationObserver(() => setTheme(read()));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        return () => observer.disconnect();
    }, []);
    return theme;
}

export function KitScope({
    active = true,
    initialPath = "/",
    className = "h-full w-full",
    children,
}: KitScopeProps) {
    const [store] = useState<NavStore>(() => createNavStore(initialPath));
    const [layer, setLayer] = useState<HTMLElement | null>(null);
    const theme = useHostTheme();
    const layerValue = useMemo(() => layer ?? undefined, [layer]);
    return (
        <NavProvider store={store}>
            <PaneActiveContext.Provider value={active}>
                <L10nProvider>
                    <PortalLayerContext.Provider value={layerValue}>
                        <TooltipProvider>
                            <div className={`chat-scope relative isolate ${className}`} data-theme={theme} data-active={String(active)}>
                                {children}
                                <div ref={setLayer} data-chat-layer="" />
                                <Toaster />
                            </div>
                        </TooltipProvider>
                    </PortalLayerContext.Provider>
                </L10nProvider>
            </PaneActiveContext.Provider>
        </NavProvider>
    );
}
