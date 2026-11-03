/**
 * The Chat settings pages the host's Settings embeds: Providers, Models and Agent. Render them inside <ChatScope>;
 * each is a whole page built from the settings kit. There is no MCP servers page: the server refuses to configure
 * external servers, so the page would only show a form that cannot save.
 */
import { useT } from "../../l10n/provider";
import { ProvidersSection } from "./integrations/providers";
import { DecisionsModelRow, RoleModelRow } from "./role-models";
import { ModelSelect } from "./models";
import { erase, useUserSetting } from "./bindings";
import type { ReactNode } from "react";
import { AdminKeyRow, BoundRow, HostDrawsTitle, KeyRow, row, SettingsCard, SettingsPage, SettingsSection } from "./kit";

/** The host's Settings draws each page's title above these, so they leave their own out. */
const Hosted = ({ children }: { children: ReactNode }) => (
    <HostDrawsTitle.Provider value>{children}</HostDrawsTitle.Provider>
);

export const ProvidersPage = () => (
    <Hosted>
        <ProvidersSection />
    </Hosted>
);

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
        <Hosted>
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
        </Hosted>
    );
}

export function AgentPage() {
    return (
        <Hosted>
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
        </Hosted>
    );
}
