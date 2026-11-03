import { SettingRow, SettingsCard, SettingsPage, SettingsSection, Switch } from "@pikvm/chat-web/settings";
import { useServerSettings } from "../use-settings";
import { LoadError } from "./load-error";

export function KeepAwakePage() {
    const { settings, loading, loadError, retry, saving, saveError, save } = useServerSettings();

    if (loadError) {
        return (
            <SettingsPage title="Keep awake">
                <LoadError message={loadError} onRetry={retry} />
            </SettingsPage>
        );
    }

    return (
        <SettingsPage title="Keep awake" description="Keep the target from locking or sleeping.">
            <SettingsSection title="Mouse jiggler">
                <SettingsCard>
                    <SettingRow
                        id="keep-awake"
                        label="Keep the target awake"
                        description="Moves the target's mouse now and then while it is idle."
                        status={saving ? { state: "saving" } : { state: "idle" }}
                        error={saveError ? `Could not save: ${saveError}` : null}
                        control={
                            <Switch
                                label="Keep the target awake"
                                checked={settings?.jiggler === true}
                                disabled={loading || saving}
                                onChange={(jiggler) => save({ jiggler })}
                            />
                        }
                    />
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}
