import { useState } from "react";
import { useMediaQuery } from "../../app/viewport";
import { alertPermission, askForAlertPermission } from "../../kvm/attention";
import { DOCK_QUERY, isDesktopApp } from "../../kvm/platform";
import { readScreenAlerts, SCREEN_ALERTS_KEY } from "../../kvm/screen-alerts";
import { SettingRow, SettingsCard, SettingsSection, Switch } from "@pikvm/chat-web/settings";
import { useStoredValue } from "../local-prefs";

/**
 * Tell me when the screen changes while this window is behind others. The same switch as the KVM
 * screen's More menu. The desktop app pulses its taskbar entry; a browser marks the tab's title and
 * the app badge and, if allowed, shows a notification; a phone cannot, because the page is
 * suspended the moment you leave it.
 */
export function ScreenAlertsSection() {
    const desktop = isDesktopApp();
    const phone = useMediaQuery(DOCK_QUERY) && !desktop;
    const [alerts, setAlerts] = useStoredValue(SCREEN_ALERTS_KEY, readScreenAlerts);
    const [permission, setPermission] = useState(alertPermission);

    if (phone) {
        return (
            <SettingsSection title="Screen changes">
                <SettingsCard>
                    <SettingRow
                        id="screen-alerts"
                        label="Alert me when the screen changes"
                        description="Not available on a phone. The page is suspended when you leave it, so it cannot watch the screen. Use Notifications instead: the server watches the screen and sends a notification."
                    />
                </SettingsCard>
            </SettingsSection>
        );
    }

    const on = alerts === "on";
    return (
        <SettingsSection
            title="Screen changes"
            description={
                desktop
                    ? "While this window is behind others, its taskbar entry pulses when the target's screen changes. Examples: a dialog opens, a reboot starts, an install finishes."
                    : "While this window is behind others, the tab title and icon badge change when the target's screen changes. A notification also appears if you allow it. The picture keeps streaming so the app can watch it."
            }
        >
            <SettingsCard>
                <SettingRow
                    id="screen-alerts"
                    label="Alert me when the screen changes"
                    control={
                        <Switch
                            label="Alert me when the screen changes"
                            checked={on}
                            onChange={(next) => {
                                setAlerts(next ? "on" : "off");
                                // The click is the gesture a browser wants before it shows its notification prompt.
                                if (next && !desktop) void askForAlertPermission().then(setPermission);
                            }}
                        />
                    }
                />
                {on && !desktop && permission === "denied" ? (
                    <SettingRow
                        label="Notifications are blocked"
                        description="Only the title and badge change. To get system notifications, allow them for this site in the browser settings."
                    />
                ) : null}
            </SettingsCard>
        </SettingsSection>
    );
}
