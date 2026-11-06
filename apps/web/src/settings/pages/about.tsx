import type { DesktopUpdate } from "@pikvm/contracts/desktop";
import { Button, SettingRow, SettingsCard, SettingsPage, SettingsSection } from "@pikvm/chat-web/settings";
import { useAppState } from "../../api/queries";
import { desktopBridge, useDesktopUpdate } from "../../host/desktop";
import { DisplayReport } from "./display-report";
import { StatusDot, Value } from "./value";

function UpdateValue({ update }: { update: DesktopUpdate | undefined }) {
    if (!update) return <Value>Checking</Value>;
    if (update.state === "unknown") return <Value>Could not check</Value>;
    if (update.state === "current") {
        return (
            <Value>
                <StatusDot tone="ok" />
                {update.latest} is the newest
            </Value>
        );
    }
    return (
        <div className="flex flex-wrap items-center justify-end gap-3">
            <Value>
                <StatusDot tone="warn" />
                {update.latest} is out
            </Value>
            <Button variant="primary" onClick={() => void desktopBridge()?.openExternal(update.url)}>
                Open release
            </Button>
        </div>
    );
}

const PLATFORM = { linux: "Linux", darwin: "macOS", win32: "Windows" } as const;

export function AboutPage() {
    const state = useAppState();
    const desktop = desktopBridge();
    const update = useDesktopUpdate();
    return (
        <SettingsPage title="About" description="The app and the host it connects to.">
            <SettingsSection title="Versions">
                <SettingsCard>
                    {desktop ? (
                        <SettingRow
                            label="Desktop app"
                            control={
                                <Value>
                                    {desktop.version} on {PLATFORM[desktop.platform]}
                                </Value>
                            }
                        />
                    ) : null}
                    {desktop ? <SettingRow label="Latest release" control={<UpdateValue update={update} />} /> : null}
                    <SettingRow label="App version" control={<Value>{__APP_VERSION__}</Value>} />
                    <SettingRow label="App build" control={<Value>{__BUILD_ID__}</Value>} />
                    <SettingRow
                        label="Host version"
                        control={<Value>{state.data?.version ?? (state.isError ? "Unavailable" : "Loading")}</Value>}
                    />
                </SettingsCard>
            </SettingsSection>
            <DisplayReport />
        </SettingsPage>
    );
}
