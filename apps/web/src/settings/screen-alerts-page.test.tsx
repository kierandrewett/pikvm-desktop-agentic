/**
 * Settings -> Display -> Screen changes: the same switch as the KVM screen's menu.
 *
 * Failure modes, before behaviour:
 *  S1. A phone is offered a switch that cannot do anything (its page is suspended in the background).
 *  S2. Turning it on in a browser does not ask for notifications (no gesture later), or asks in the desktop app,
 *      where the shell refuses them.
 *  S3. A refused permission says nothing, so the user waits for a notification that will never come.
 *  S4. The switch shows a different state from the one the KVM screen reads.
 */

import { DESKTOP_BRIDGE_KEY } from "@pikvm/contracts/desktop";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCREEN_ALERTS_KEY, readScreenAlerts } from "../kvm/screen-alerts";
import { defaultServer, installFakeServer, renderApp } from "../test/harness";

const original = Reflect.get(globalThis, "Notification");

beforeEach(() => {
    installFakeServer(defaultServer());
    localStorage.removeItem(SCREEN_ALERTS_KEY);
});

afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, DESKTOP_BRIDGE_KEY);
    if (original === undefined) Reflect.deleteProperty(globalThis, "Notification");
    else Reflect.set(globalThis, "Notification", original);
});

const notificationApi = (permission: NotificationPermission, answer: NotificationPermission = permission) => {
    const requestPermission = vi.fn(async () => answer);
    Reflect.set(globalThis, "Notification", { permission, requestPermission });
    return requestPermission;
};

describe("screen changes setting", () => {
    it("S1: a phone is told why it is not offered, and gets no switch", async () => {
        renderApp("/settings/display", { coarse: true, compact: true });
        expect(await screen.findByText(/Not available on a phone/)).toBeInTheDocument();
        expect(screen.queryByRole("switch", { name: "Alert me when the screen changes" })).toBeNull();
    });

    it("S2/S4: in a browser it starts off, turning it on is stored for the KVM screen and asks for notifications", async () => {
        const request = notificationApi("default", "granted");
        renderApp("/settings/display");
        const toggle = await screen.findByRole("switch", { name: "Alert me when the screen changes" });
        expect(toggle).toHaveAttribute("aria-checked", "false");
        await userEvent.click(toggle);
        expect(toggle).toHaveAttribute("aria-checked", "true");
        expect(readScreenAlerts()).toBe("on");
        expect(request).toHaveBeenCalledTimes(1);
        expect(screen.queryByText("Notifications are blocked")).toBeNull();

        await userEvent.click(toggle);
        expect(readScreenAlerts()).toBe("off");
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("S3: refused notifications are said, with what still works", async () => {
        notificationApi("default", "denied");
        renderApp("/settings/display");
        await userEvent.click(await screen.findByRole("switch", { name: "Alert me when the screen changes" }));
        expect(await screen.findByText("Notifications are blocked")).toBeInTheDocument();
        expect(screen.getByText(/Only the title and badge change/)).toBeInTheDocument();
    });

    it("a browser with no Notification API still gets the title and badge, and no complaint", async () => {
        Reflect.deleteProperty(globalThis, "Notification");
        renderApp("/settings/display");
        await userEvent.click(await screen.findByRole("switch", { name: "Alert me when the screen changes" }));
        await waitFor(() => expect(readScreenAlerts()).toBe("on"));
        expect(screen.queryByText("Notifications are blocked")).toBeNull();
    });

    it("S2: the desktop app starts on, says it pulses the taskbar, and never asks for notifications", async () => {
        const request = notificationApi("default", "denied");
        Reflect.set(window, DESKTOP_BRIDGE_KEY, {
            platform: "linux",
            version: "0.0.0",
            nativeControls: false,
            requestAttention() {},
            onDownloadDone: () => () => {},
            openExternal: async () => {},
            window: {
                minimise() {},
                toggleMaximise() {},
                close() {},
                isMaximised: async () => false,
                onMaximiseChange: () => () => {},
                setFullscreen: async () => false,
                isFullscreen: async () => false,
                onFullscreenChange: () => () => {},
                onFocusChange: () => () => {},
            },
        });
        renderApp("/settings/display");
        const toggle = await screen.findByRole("switch", { name: "Alert me when the screen changes" });
        expect(toggle).toHaveAttribute("aria-checked", "true");
        expect(screen.getByText(/taskbar entry pulses/)).toBeInTheDocument();
        await userEvent.click(toggle);
        await userEvent.click(toggle);
        expect(request).not.toHaveBeenCalled();
    });
});
