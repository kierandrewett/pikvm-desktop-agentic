/**
 * The Chat settings pages the host's Settings embeds: Providers, Models and Agent. Render them inside the host's
 * <SettingsScope>; each is a whole page built from the settings kit and brings the chat server's data layer
 * (ChatServices) with it. There is no MCP servers page: the server refuses to configure external servers, so the
 * page would only show a form that cannot save.
 */
import { useT } from "../../l10n/provider";
import { ProvidersSection } from "./integrations/providers";
import { DecisionsModelRow, RoleModelRow } from "./role-models";
import { ModelSelect } from "./models";
import { erase, useUserSetting } from "./bindings";
import { ChatServices } from "../../pane/chat-services";
import { useState } from "react";
import { api } from "../../lib/api";
import { ConfirmDialog } from "../ui/dialog";
import { AdminKeyRow, BoundRow, Button, KeyRow, SettingRow, SettingsCard, SettingsPage, SettingsSection } from "./kit";

export const ProvidersPage = () => (
    <ChatServices>
        <ProvidersSection />
    </ChatServices>
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
        <ChatServices>
            <SettingsPage title="Models" description="The model new chats start with, and the models for side work.">
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
        </ChatServices>
    );
}

/** Empties the agent's memory for this user (DELETE /api/memory). Asks first: it cannot be undone. */
function ForgetMemoryRow() {
    const [asking, setAsking] = useState(false);
    const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
    const forget = async () => {
        setState("busy");
        try {
            await api.del("/memory");
            setState("done");
        } catch {
            setState("failed");
        }
    };
    return (
        <>
            <SettingRow
                id="agent-memory-forget"
                label="Forget everything"
                description={state === "done" ? "Memory is empty." : state === "failed" ? "That did not work. Try again." : "Delete everything the assistant has remembered about you."}
                control={
                    <Button variant="danger" disabled={state === "busy"} onClick={() => setAsking(true)}>
                        Forget
                    </Button>
                }
            />
            <ConfirmDialog
                open={asking}
                onOpenChange={setAsking}
                title="Forget everything?"
                description="This deletes every memory the assistant has kept for you. It cannot be undone."
                confirmLabel="Forget"
                danger
                onConfirm={() => void forget()}
            />
        </>
    );
}

export function AgentPage() {
    return (
        <ChatServices>
            <SettingsPage title="Agent" description="What the agent may do on the PiKVM, and how it runs.">
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
                        <KeyRow k="agent.memory.enabled" />
                        <ForgetMemoryRow />
                        <KeyRow k="agent.instructions" />
                    </SettingsCard>
                </SettingsSection>
            </SettingsPage>
        </ChatServices>
    );
}
