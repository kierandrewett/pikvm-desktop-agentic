/**
 * ChatScope: everything the lifted components need around them, in one provider. It renders the `.chat-scope`
 * element (tokens and utilities are scoped to it), mirrors the host's `data-theme` onto it, owns the portal layer
 * that menus and dialogs render into, and tells the tree whether the pane is in front.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { L10nProvider } from "../l10n/provider";
import { Toaster } from "../components/ui/toast";
import { bindUndoShortcut } from "../components/ui/undo";
import { configureChat } from "../lib/config";
import { PaneActiveContext } from "../lib/pane-active";
import { queryClient, wireSocket } from "../lib/queries";
import { PortalLayerContext, TooltipProvider } from "../ui/index";
import { createNavStore, NavProvider, type NavStore } from "../nav";

export interface ChatScopeProps {
    /** REST root and socket URL of the chat server; defaults to the host's `/app/chat/*` routes. */
    apiBase?: string;
    wsUrl?: string;
    /** False while the pane is hidden behind another tab. */
    active?: boolean;
    /** Where the pane starts; a settings deep link or a conversation. */
    initialPath?: string;
    children: ReactNode;
}

/** The host's theme, read from <html data-theme> and followed when it changes. */
function useHostTheme(): "light" | "dark" {
    const read = (): "light" | "dark" => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
    const [theme, setTheme] = useState(read);
    useEffect(() => {
        const observer = new MutationObserver(() => setTheme(read()));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        return () => observer.disconnect();
    }, []);
    return theme;
}

export function ChatScope({ apiBase, wsUrl, active = true, initialPath = "/", children }: ChatScopeProps) {
    // Before the first child renders: the endpoints are read at call time by the data layer.
    useState(() => {
        configureChat({ apiBase: apiBase ?? "/app/chat/api", wsUrl: wsUrl ?? "/app/chat/ws" });
    });
    const [store] = useState<NavStore>(() => createNavStore(initialPath));
    const [layer, setLayer] = useState<HTMLElement | null>(null);
    const theme = useHostTheme();
    useEffect(() => (active ? bindUndoShortcut() : undefined), [active]);
    useEffect(() => {
        wireSocket();
    }, []);
    const layerValue = useMemo(() => layer ?? undefined, [layer]);
    return (
        <QueryClientProvider client={queryClient}>
            <NavProvider store={store}>
                <PaneActiveContext.Provider value={active}>
                    <L10nProvider>
                        <PortalLayerContext.Provider value={layerValue}>
                            <TooltipProvider>
                                <div className="chat-scope relative isolate h-full w-full" data-theme={theme}>
                                    {children}
                                    <div ref={setLayer} data-chat-layer="" />
                                    <Toaster />
                                </div>
                            </TooltipProvider>
                        </PortalLayerContext.Provider>
                    </L10nProvider>
                </PaneActiveContext.Provider>
            </NavProvider>
        </QueryClientProvider>
    );
}
