import type { KeyboardLayout } from "@pikvm/contracts/api";
import { Segmented, SettingRow, SettingsCard, SettingsPage, SettingsSection } from "@pikvm/chat-web/settings";
import { useServerSettings } from "../use-settings";
import { InputSections } from "./input";
import { LoadError } from "./load-error";

const LAYOUTS = [
    { value: "us", label: "US" },
    { value: "uk", label: "UK" },
] as const satisfies ReadonlyArray<{ value: KeyboardLayout; label: string }>;

/** Nothing is selected until the settings load: the control is disabled and shows no layout rather than a guess. */
const UNSET = "" as KeyboardLayout;

export function KeyboardPage() {
    const { settings, loading, loadError, retry, saving, saveError, save } = useServerSettings();

    if (loadError) {
        return (
            <SettingsPage title="Keyboard and mouse">
                <LoadError message={loadError} onRetry={retry} />
            </SettingsPage>
        );
    }

    return (
        <SettingsPage title="Keyboard and mouse" description="How text is typed on the target, and how touch drives its mouse.">
            <SettingsSection title="Keyboard">
                <SettingsCard>
                    <SettingRow
                        id="keyboard-layout"
                        label="Keyboard layout"
                        description="The keyboard layout of the target. Used when the app types text for you. It does not change what your own keyboard sends."
                        status={saving ? { state: "saving" } : { state: "idle" }}
                        error={saveError ? `Could not save the layout: ${saveError}` : null}
                        control={
                            <Segmented
                                label="Keyboard layout"
                                options={[...LAYOUTS]}
                                value={settings?.keyboardLayout ?? UNSET}
                                disabled={loading || saving}
                                onChange={(keyboardLayout) => save({ keyboardLayout })}
                            />
                        }
                    />
                </SettingsCard>
            </SettingsSection>
            <InputSections />
        </SettingsPage>
    );
}
