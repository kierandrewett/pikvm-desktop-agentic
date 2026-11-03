import { useState } from "react";
import { useMediaQuery } from "../../app/viewport";
import { alertPermission, askForAlertPermission } from "../../kvm/attention";
import { DOCK_QUERY, isDesktopApp } from "../../kvm/platform";
import { readScreenAlerts, SCREEN_ALERTS_KEY } from "../../kvm/screen-alerts";
import { Group, Row, Switch } from "../../ui/controls";
import { useStoredValue } from "../local-prefs";

/**
 * Tell me when the screen changes while this window is behind others. The same switch as the KVM
 * screen's More menu. The desktop app pulses its taskbar entry; a browser marks the tab's title and
 * the app badge and, if allowed, shows a notification; a phone cannot, because the page is
 * suspended the moment you leave it.
 */
export function ScreenAlertsGroup() {
    const desktop = isDesktopApp();
    const phone = useMediaQuery(DOCK_QUERY) && !desktop;
    const [alerts, setAlerts] = useStoredValue(SCREEN_ALERTS_KEY, readScreenAlerts);
    const [permission, setPermission] = useState(alertPermission);

    if (phone) {
        return (
            <Group title="Screen changes">
                <Row
                    label="Alert me when the screen changes"
                    hint="Not available on a phone: this page is suspended as soon as you leave it, so nothing can watch the screen. Settings, Notifications has the server watch it instead and sends a notification."
                />
            </Group>
        );
    }

    const on = alerts === "on";
    return (
        <Group
            title="Screen changes"
            footer={
                desktop
                    ? "While this window is behind others, its taskbar entry pulses when the target's screen changes: a dialog opens, a reboot starts, an install finishes."
                    : "While this window is behind others, the tab's title and icon badge change when the target's screen changes, and a notification is shown if you allow them. The picture keeps streaming to watch for it."
            }
        >
            <Row label="Alert me when the screen changes">
                <Switch
                    label="Alert me when the screen changes"
                    checked={on}
                    onChange={(next) => {
                        setAlerts(next ? "on" : "off");
                        // The click is the gesture a browser wants before it shows its notification prompt.
                        if (next && !desktop) void askForAlertPermission().then(setPermission);
                    }}
                />
            </Row>
            {on && !desktop && permission === "denied" ? (
                <Row
                    label="Notifications are blocked"
                    hint="Only the title and badge change. Allow notifications for this site in the browser's settings to be told in the system's own way."
                />
            ) : null}
        </Group>
    );
}
