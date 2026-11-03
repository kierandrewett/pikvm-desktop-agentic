import { SettingRow, SettingsCard, SettingsPage, SettingsSection } from "@pikvm/chat-web/settings";
import { useAppState } from "../../api/queries";
import { desktopBridge } from "../../host/desktop";
import { DisplayReport } from "./display-report";
import { Value } from "./value";

const PLATFORM = { linux: "Linux", darwin: "macOS", win32: "Windows" } as const;

export function AboutPage() {
    const state = useAppState();
    const desktop = desktopBridge();
    return (
        <SettingsPage title="About" description="The app and the host it connects to.">
            <SettingsSection title="PiKVM">
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
