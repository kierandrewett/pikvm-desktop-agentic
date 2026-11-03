/** MCP gateway settings use the same bound rows as the rest of Settings. */
import type { McpApprovals } from "@pikvm/chat-protocol";
import { useState } from "react";
import { useT } from "../../../l10n/provider";
import { captureSessionEpoch, isSessionEpochCurrent } from "../../../lib/queries";
import { ConfirmDialog } from "../../ui/dialog";
import { erase, fieldBinding, useAdminSetting, type Binding } from "../bindings";
import { AdminKeyRow, BoundRow, SettingsCard, SettingsSection, Switch } from "../kit";

/** Require confirmation only when a setting reduces protection. */
function ConfirmedSwitch({
    binding,
    label,
    riskyValue,
    title,
    description,
    confirmLabel,
}: {
    binding: Binding<unknown>;
    label: string;
    riskyValue: boolean;
    title: string;
    description: string;
    confirmLabel: string;
}) {
    const [confirmEpoch, setConfirmEpoch] = useState<number | null>(null);
    return (
        <>
            <Switch
                checked={binding.value === true}
                disabled={!binding.writable}
                label={label}
                onChange={(value) => {
                    if (value === riskyValue) setConfirmEpoch(captureSessionEpoch());
                    else binding.set(value);
                }}
            />
            <ConfirmDialog
                open={confirmEpoch !== null && isSessionEpochCurrent(confirmEpoch)}
                onOpenChange={(open) => !open && setConfirmEpoch(null)}
                title={title}
                description={description}
                confirmLabel={confirmLabel}
                danger
                onConfirm={() => {
                    if (confirmEpoch !== null && isSessionEpochCurrent(confirmEpoch) && binding.writable)
                        binding.set(riskyValue);
                }}
            />
        </>
    );
}

export function McpApprovalSettings() {
    const t = useT();
    const approvals = useAdminSetting<McpApprovals>("agent.mcpApprovals");
    return (
        <SettingsSection title={t("integrations-approvals-title")}>
            <SettingsCard>
                <BoundRow
                    id="agent.mcpApprovals.trustReadOnly"
                    binding={erase(fieldBinding(approvals, "trustReadOnly"))}
                    control={{
                        type: "custom",
                        render: (binding) => (
                            <ConfirmedSwitch
                                binding={binding}
                                label={t("integrations-approvals-trust-label")}
                                riskyValue={true}
                                title={t("integrations-approvals-trust-title")}
                                description={t("integrations-approvals-trust-description")}
                                confirmLabel={t("integrations-approvals-trust-confirm")}
                            />
                        ),
                    }}
                />
                <BoundRow
                    id="agent.mcpApprovals.confirmDestructive"
                    binding={erase(fieldBinding(approvals, "confirmDestructive"))}
                    control={{
                        type: "custom",
                        render: (binding) => (
                            <ConfirmedSwitch
                                binding={binding}
                                label={t("integrations-approvals-destructive-label")}
                                riskyValue={false}
                                title={t("integrations-approvals-destructive-title")}
                                description={t("integrations-approvals-destructive-description")}
                                confirmLabel={t("integrations-approvals-destructive-confirm")}
                            />
                        ),
                    }}
                />
            </SettingsCard>
        </SettingsSection>
    );
}

export function AdminMcpSettings() {
    const t = useT();
    return (
        <>
            <McpApprovalSettings />
            <SettingsSection title={t("integrations-personal-servers")}>
                <SettingsCard>
                    <AdminKeyRow
                        k="policy.mcp.allow"
                        control={{ type: "list", placeholder: "https://mcp.example.com/*" }}
                    />
                    <AdminKeyRow
                        k="system.mcp.allowPrivateNetworks"
                        control={{
                            type: "custom",
                            render: (binding) => (
                                <ConfirmedSwitch
                                    binding={binding}
                                    label={t("integrations-private-label")}
                                    riskyValue={true}
                                    title={t("integrations-private-title")}
                                    description={t("integrations-private-description")}
                                    confirmLabel={t("integrations-private-confirm")}
                                />
                            ),
                        }}
                    />
                </SettingsCard>
            </SettingsSection>
            <SettingsSection title={t("integrations-catalogue")}>
                <SettingsCard>
                    <AdminKeyRow k="system.mcp.featured" control={{ type: "list", placeholder: "catalogue-id" }} />
                    <AdminKeyRow
                        k="system.mcp.logoService"
                        control={{ type: "text", mono: true, placeholder: "https://icons.example.com/{domain}.ico" }}
                    />
                </SettingsCard>
            </SettingsSection>
        </>
    );
}
