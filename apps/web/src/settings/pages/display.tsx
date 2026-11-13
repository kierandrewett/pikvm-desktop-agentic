import { Segmented, SettingRow, SettingsCard, SettingsPage, SettingsSection } from "@pikvm/chat-web/settings";
import { useState } from "react";
import { readThemeChoice, setThemeChoice, type ThemeChoice } from "../../theme";
import { PICTURE_QUALITY_KEY, readPictureQuality, useStoredValue, type PictureQuality } from "../local-prefs";
import { ScreenAlertsSection } from "./screen-alerts";

const CHOICES = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "System" },
] as const satisfies ReadonlyArray<{ value: ThemeChoice; label: string }>;

const QUALITY_CHOICES = [
    { value: "auto", label: "Automatic" },
    { value: "reduced", label: "Always reduced" },
    { value: "full", label: "Always full" },
] as const satisfies ReadonlyArray<{ value: PictureQuality; label: string }>;

export function DisplayPage() {
    const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);
    const [quality, setQuality] = useStoredValue<PictureQuality>(PICTURE_QUALITY_KEY, readPictureQuality);

    return (
        <SettingsPage title="Display" description="How the app looks, and when it tells you the screen changed.">
            <SettingsSection title="Appearance">
                <SettingsCard>
                    <SettingRow
                        id="theme"
                        label="Theme"
                        description="System follows the device setting."
                        control={
                            <Segmented
                                label="Theme"
                                options={[...CHOICES]}
                                value={choice}
                                onChange={(next) => {
                                    setChoice(next);
                                    setThemeChoice(next);
                                }}
                            />
                        }
                    />
                </SettingsCard>
            </SettingsSection>
            <SettingsSection title="Picture on a weak connection">
                <SettingsCard>
                    <SettingRow
                        id="picture-quality"
                        label="Picture quality"
                        description="Automatic switches this device to a smaller, slower picture when the connection is poor, and back when it recovers. The reduced picture has no sound. Applies the next time the KVM screen opens."
                        control={<Segmented label="Picture quality" options={[...QUALITY_CHOICES]} value={quality} onChange={setQuality} />}
                    />
                </SettingsCard>
            </SettingsSection>
            <ScreenAlertsSection />
        </SettingsPage>
    );
}
