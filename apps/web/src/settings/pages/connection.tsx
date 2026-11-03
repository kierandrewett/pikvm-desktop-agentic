import { SettingRow, SettingsCard, SettingsPage, SettingsSection } from "@pikvm/chat-web/settings";
import type { PikvmTarget } from "@pikvm/contracts/api";
import { useAppState, useTarget } from "../../api/queries";
import { LoadError } from "./load-error";
import { TargetForm } from "./target-form";
import { StatusDot, Value } from "./value";

const LINK: Record<PikvmTarget["link"], { text: string; tone: "ok" | "warn" | "danger" | "idle" }> = {
    connected: { text: "Connected", tone: "ok" },
    connecting: { text: "Connecting", tone: "warn" },
    offline: { text: "Offline", tone: "danger" },
    // The server opens the PiKVM event socket lazily, so "unknown" is "not yet", not "down".
    unknown: { text: "Not checked yet", tone: "idle" },
};

export function ConnectionPage() {
    const state = useAppState();
    const editable = useTarget().data;

    if (state.isError) {
        return (
            <SettingsPage title="Connection">
                <LoadError message={state.error.message} onRetry={() => void state.refetch()} />
            </SettingsPage>
        );
    }

    const target = state.data?.pikvm;
    const link = target ? LINK[target.link] : undefined;

    return (
        <SettingsPage title="Connection" description="The PiKVM this app controls.">
            <SettingsSection
                title="PiKVM"
                description={
                    editable?.editable
                        ? undefined
                        : "The host sets the PiKVM at startup. To change it, edit the host configuration."
                }
            >
                <SettingsCard>
                    <SettingRow label="Address" control={<Value>{target?.origin ?? "Loading"}</Value>} />
                    <SettingRow
                        label="Link"
                        control={
                            <Value>
                                {link ? <StatusDot tone={link.tone} /> : null}
                                {link?.text ?? "Loading"}
                            </Value>
                        }
                    />
                </SettingsCard>
            </SettingsSection>
            {editable?.editable ? <TargetForm target={editable} /> : null}
        </SettingsPage>
    );
}
