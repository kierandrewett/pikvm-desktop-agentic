/**
 * The agent's settings pages: Providers, Models and Agent, from @pikvm/chat-web, inside our Settings layout.
 *
 * They talk to the chat server inside the host (/app/chat/api); each brings the data layer with it (ChatServices) and
 * is drawn on the same settings kit as every other page, inside the Settings scope. The code loads with the first of
 * these pages opened, as Chat's does with the Chat tab. External MCP servers have no page: they are not configurable
 * here (the host refuses it); integrations go through one gateway the server holds.
 */

import { SettingRow, SettingsCard, SettingsPage, SettingsSection } from "@pikvm/chat-web/settings";
import { type ComponentType, lazy, Suspense } from "react";
import { useAppState } from "../api/queries";

type ChatPage = "providers" | "models" | "agent";

const pages: Record<ChatPage, ComponentType> = {
    providers: lazy(() => import("@pikvm/chat-web").then((m) => ({ default: m.ProvidersPage }))),
    models: lazy(() => import("@pikvm/chat-web").then((m) => ({ default: m.ModelsPage }))),
    agent: lazy(() => import("@pikvm/chat-web").then((m) => ({ default: m.AgentPage }))),
};

const TITLES: Record<ChatPage, string> = { providers: "Model providers", models: "Models", agent: "Agent" };

function ChatSettingsPage({ page }: { page: ChatPage }) {
    const state = useAppState();
    const Page = pages[page];

    if (state.isPending) return <div role="status" aria-label="Loading" />;
    if (state.isError || !state.data.features.chat) {
        return (
            <SettingsPage title={TITLES[page]}>
                <SettingsSection>
                    <SettingsCard>
                        <SettingRow
                            label="Not available on this host"
                            description={`Chat is not available on this host.${
                                state.isSuccess && state.data.features.agent?.reason ? ` ${state.data.features.agent.reason}` : ""
                            }`}
                        />
                    </SettingsCard>
                </SettingsSection>
            </SettingsPage>
        );
    }
    return (
        <Suspense fallback={<div role="status" aria-label="Loading" />}>
            <Page />
        </Suspense>
    );
}

export const ProvidersPage = () => <ChatSettingsPage page="providers" />;
export const ModelsPage = () => <ChatSettingsPage page="models" />;
export const AgentPage = () => <ChatSettingsPage page="agent" />;
