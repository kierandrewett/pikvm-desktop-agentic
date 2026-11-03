/**
 * The agent's settings pages: Providers, Models and Agent, from @pikvm/chat-web, inside our Settings layout.
 *
 * They talk to the chat server inside the host (/app/chat/api) and are drawn by ChatScope, which carries the pane's
 * tokens and utilities so none of them apply outside it. The code loads with the first of these pages opened, as
 * Chat's does with the Chat tab. External MCP servers have no page: they are not configurable here (the host
 * refuses it); integrations go through one gateway the server holds.
 */

import { type ComponentType, createContext, lazy, Suspense, useContext } from "react";
import { useAppState } from "../api/queries";

/** Settings is the tab in front. A hidden pane stays mounted, and a scope that is not in front keeps its page-wide listeners off. */
export const SettingsActiveContext = createContext(true);

type ChatPage = "providers" | "models" | "agent";

const pages: Record<ChatPage, ComponentType> = {
    providers: lazy(() => import("@pikvm/chat-web").then((m) => ({ default: m.ProvidersPage }))),
    models: lazy(() => import("@pikvm/chat-web").then((m) => ({ default: m.ModelsPage }))),
    agent: lazy(() => import("@pikvm/chat-web").then((m) => ({ default: m.AgentPage }))),
};

const Scope = lazy(() => import("@pikvm/chat-web").then((m) => ({ default: m.ChatScope })));

function ChatSettingsPage({ page }: { page: ChatPage }) {
    const state = useAppState();
    const active = useContext(SettingsActiveContext);
    const Page = pages[page];

    if (state.isPending) return <div role="status" aria-label="Loading" />;
    if (state.isError || !state.data.features.chat) {
        return (
            <p className="settings-note" role="status">
                Chat is not available on this host, so there is nothing to set here yet.
                {state.isSuccess && state.data.features.agent?.reason ? ` ${state.data.features.agent.reason}` : ""}
            </p>
        );
    }
    return (
        <Suspense fallback={<div role="status" aria-label="Loading" />}>
            <Scope active={active}>
                <Page />
            </Scope>
        </Suspense>
    );
}

export const ProvidersPage = () => <ChatSettingsPage page="providers" />;
export const ModelsPage = () => <ChatSettingsPage page="models" />;
export const AgentPage = () => <ChatSettingsPage page="agent" />;
