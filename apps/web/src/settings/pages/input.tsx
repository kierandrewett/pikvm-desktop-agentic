import { Segmented, SettingRow, SettingsCard, SettingsSection } from "@pikvm/chat-web/settings";
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

/** The touch and mouse sections of Keyboard and mouse. Stored in this browser only, under the console's own keys, so the console picks them up. */
export function InputSections() {
    const [mode, setMode] = useStoredValue(TOUCH_MODE_KEY, readTouchMode);
    const [hid, setHid] = useStoredValue(TOUCH_HID_KEY, readTouchHid);

    return (
        <>
            <SettingsSection title="Touch" description="How touch drives the target's mouse.">
                <SettingsCard>
                    <SettingRow
                        id="touch-input"
                        label="Touch input"
                        description="Trackpad moves a cursor, like a laptop. Touch points at the screen: tap to click, hold to right-click."
                        control={<Segmented label="Touch input" options={[...MODES]} value={mode} onChange={setMode} />}
                    />
                </SettingsCard>
            </SettingsSection>
            <SettingsSection title="Trackpad mouse">
                <SettingsCard>
                    <SettingRow
                        id="mouse-mode"
                        label="Mouse mode"
                        description="Absolute places the cursor exactly and the view follows it. Relative suits targets that ignore an absolute mouse, such as some BIOS screens and games."
                        control={<Segmented label="Trackpad mouse" options={[...HID]} value={hid} onChange={setHid} />}
                    />
                </SettingsCard>
            </SettingsSection>
        </>
    );
}
