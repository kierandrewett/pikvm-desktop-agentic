import { SettingRow, SettingsCard, SettingsSection, Switch } from "@pikvm/chat-web/settings";
import { useServerSettings } from "../use-settings";

/** The mouse jiggler, as a section of Connection: it is about the target the app is connected to. Hidden until the settings load. */
export function KeepAwakeSection() {
    const { settings, loading, loadError, saving, saveError, save } = useServerSettings();
    if (loadError) return null;
    return (
        <SettingsSection title="Keep the target awake">
            <SettingsCard>
                <SettingRow
                    id="keep-awake"
                    label="Mouse jiggler"
                    description="Moves the target's mouse now and then while it is idle, so it does not lock or sleep."
                    status={saving ? { state: "saving" } : { state: "idle" }}
                    error={saveError ? `Could not save: ${saveError}` : null}
                    control={<Switch label="Mouse jiggler" checked={settings?.jiggler === true} disabled={loading || saving} onChange={(jiggler) => save({ jiggler })} />}
                />
            </SettingsCard>
        </SettingsSection>
    );
}
