import { Segmented, SettingRow, SettingsCard, SettingsPage, SettingsSection } from "@pikvm/chat-web/settings";
import {
    readTouchHid,
    readTouchMode,
    TOUCH_HID_KEY,
    TOUCH_MODE_KEY,
    type TouchHid,
    type TouchMode,
    useStoredValue,
} from "../local-prefs";

const MODES = [
    { value: "trackpad", label: "Trackpad" },
    { value: "direct", label: "Touch" },
] as const satisfies ReadonlyArray<{ value: TouchMode; label: string }>;

const HID = [
    { value: "abs", label: "Absolute" },
    { value: "rel", label: "Relative" },
] as const satisfies ReadonlyArray<{ value: TouchHid; label: string }>;

/** Stored in this browser only, under the console's own keys, so the console picks them up. */
export function InputPage() {
    const [mode, setMode] = useStoredValue(TOUCH_MODE_KEY, readTouchMode);
    const [hid, setHid] = useStoredValue(TOUCH_HID_KEY, readTouchHid);

    return (
        <SettingsPage title="Touch and mouse" description="How your finger or trackpad drives the target's mouse.">
            <SettingsSection title="Touch">
                <SettingsCard>
                    <SettingRow
                        id="touch-input"
                        label="Touch input"
                        description="Trackpad moves a cursor with your finger, like a laptop. Touch points straight at the screen: tap to click, hold to right-click."
                        control={<Segmented label="Touch input" options={[...MODES]} value={mode} onChange={setMode} />}
                    />
                </SettingsCard>
            </SettingsSection>
            <SettingsSection title="Trackpad mouse">
                <SettingsCard>
                    <SettingRow
                        id="mouse-mode"
                        label="Mouse mode"
                        description="Absolute lands the cursor exactly and lets the view follow it. Relative is for targets that ignore an absolute mouse, such as some BIOS screens and games."
                        control={<Segmented label="Trackpad mouse" options={[...HID]} value={hid} onChange={setHid} />}
                    />
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}
