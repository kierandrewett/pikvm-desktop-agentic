/**
 * The Chat settings pages the host's Settings embeds: Providers, Models, MCP servers and Agent. Render them inside
 * <ChatScope>; each is a whole page built from the settings kit.
 */
import { useT } from "../../l10n/provider";
import { McpSection } from "./integrations/mcp";
import { ProvidersSection } from "./integrations/providers";
import { DecisionsModelRow, RoleModelRow } from "./role-models";
import { ModelSelect } from "./models";
import { erase, useUserSetting } from "./bindings";
import { AdminKeyRow, BoundRow, KeyRow, row, SettingsCard, SettingsPage, SettingsSection } from "./kit";

export const ProvidersPage = () => <ProvidersSection scope="user" />;
export const McpPage = () => <McpSection scope="user" />;

function DefaultModelRow() {
    const t = useT();
    const b = useUserSetting<string>("agent.defaultModel");
    return (
        <BoundRow
            binding={erase(b)}
            control={{
                type: "custom",
                render: () => (
                    <ModelSelect
                        value={b.value ?? ""}
                        onChange={b.set}
                        disabled={!b.writable}
                        label={t("settings-chat-default-model")}
                    />
                ),
            }}
        />
    );
}

export function ModelsPage() {
    return (
        <SettingsPage title={row("agent.defaultModel").label}>
            <SettingsSection>
                <SettingsCard>
                    <DefaultModelRow />
                    <KeyRow k="agent.defaultThinking" />
                    <RoleModelRow role="smol" />
                    <RoleModelRow role="slow" />
                    <DecisionsModelRow />
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}

export function AgentPage() {
    return (
        <SettingsPage title="Agent">
            <SettingsSection title="PiKVM">
                <SettingsCard>
                    <AdminKeyRow k="agent.pikvm.approval" />
                    <AdminKeyRow k="agent.pikvm.allowPower" />
                    <AdminKeyRow k="agent.pikvm.maxEdge" />
                </SettingsCard>
            </SettingsSection>
            <SettingsSection title="Agent runtime">
                <SettingsCard>
                    <KeyRow k="agent.permission" />
                    <AdminKeyRow k="agent.askTimeoutSec" />
                    <KeyRow k="agent.instructions" />
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}
