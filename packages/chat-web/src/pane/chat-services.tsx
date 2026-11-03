/**
 * ChatServices: the chat server's data layer for whatever renders inside it: where the server is, the query client
 * every lifted page reads through, the socket that keeps it current, and Mod+Z for undo offers while the tab is in
 * front. Render it inside a KitScope.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { bindUndoShortcut } from "../components/ui/undo";
import { configureChat } from "../lib/config";
import { usePaneActive } from "../lib/pane-active";
import { queryClient, wireSocket } from "../lib/queries";

export interface ChatServicesProps {
    /** REST root and socket URL of the chat server; defaults to the host's `/app/chat/*` routes. */
    apiBase?: string;
    wsUrl?: string;
    children: ReactNode;
}

export function ChatServices({ apiBase, wsUrl, children }: ChatServicesProps) {
    // Before the first child renders: the endpoints are read at call time by the data layer.
    useState(() => {
        configureChat({ apiBase: apiBase ?? "/app/chat/api", wsUrl: wsUrl ?? "/app/chat/ws" });
    });
    const active = usePaneActive();
    useEffect(() => (active ? bindUndoShortcut() : undefined), [active]);
    useEffect(() => {
        wireSocket();
    }, []);
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
