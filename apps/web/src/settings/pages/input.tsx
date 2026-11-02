import { Group, Row, Segmented } from "../../ui/controls";
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
        <>
            <Group
                title="Touch"
                footer="Trackpad moves a cursor with your finger, like a laptop. Touch points straight at the screen: tap to click, hold to right-click."
            >
                <Row label="Touch input">
                    <Segmented label="Touch input" options={MODES} value={mode} onChange={setMode} />
                </Row>
            </Group>
            <Group
                title="Trackpad mouse"
                footer="Absolute lands the cursor exactly and lets the view follow it. Relative is for targets that ignore an absolute mouse, such as some BIOS screens and games."
            >
                <Row label="Mouse mode">
                    <Segmented label="Trackpad mouse" options={HID} value={hid} onChange={setHid} />
                </Row>
            </Group>
        </>
    );
}
