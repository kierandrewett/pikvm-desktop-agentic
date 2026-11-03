import { Segmented, SettingRow, SettingsCard, SettingsPage, SettingsSection } from "@pikvm/chat-web/settings";
import { useState } from "react";
import { readThemeChoice, setThemeChoice, type ThemeChoice } from "../../theme";
import { ScreenAlertsSection } from "./screen-alerts";

const CHOICES = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "System" },
] as const satisfies ReadonlyArray<{ value: ThemeChoice; label: string }>;

export function DisplayPage() {
    const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);

    return (
        <SettingsPage title="Display" description="Theme and screen alerts.">
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
            <ScreenAlertsSection />
        </SettingsPage>
    );
}
