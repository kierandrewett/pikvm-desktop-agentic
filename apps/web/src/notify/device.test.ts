/**
 * Whether this device can get the watch's notifications, and what the person is told when it cannot.
 *
 * Failure modes:
 *  N1. An iPhone in a Safari tab is told "this browser cannot receive notifications", which is true and useless: the fix
 *      is the Home Screen app.
 *  N2. An installed iPhone app on an old iOS is told to install it again.
 *  N3. A denied permission offers a switch that can never work.
 *  N4. Plain http (no service worker, no push) is called "unsupported" and the real cause is lost.
 */

import { describe, expect, it } from "vitest";
import { describeDevice, type DeviceEnv } from "./device";

const desktop: DeviceEnv = {
    secure: true,
    ios: false,
    standalone: false,
    serviceWorker: true,
    pushManager: true,
    notification: true,
    permission: "default",
};

describe("describeDevice", () => {
    it("is ready where everything exists, with the permission it has", () => {
        expect(describeDevice(desktop)).toEqual({ kind: "ready", permission: "default" });
        expect(describeDevice({ ...desktop, permission: "granted" })).toEqual({ kind: "ready", permission: "granted" });
    });

    it("N1: an iPhone in a browser tab is told to add the app to the Home Screen", () => {
        const state = describeDevice({ ...desktop, ios: true, standalone: false, pushManager: false });
        expect(state.kind).toBe("needs-install");
        expect(state).toMatchObject({ message: expect.stringMatching(/Add to Home Screen/) });
    });

    it("an installed iPhone app is ready", () => {
        expect(describeDevice({ ...desktop, ios: true, standalone: true })).toEqual({ kind: "ready", permission: "default" });
    });

    it("N2: an installed iPhone app without push is told its iOS is too old", () => {
        const state = describeDevice({ ...desktop, ios: true, standalone: true, pushManager: false });
        expect(state).toMatchObject({ kind: "unsupported", message: expect.stringMatching(/iOS 16\.4/) });
    });

    it("N3: a denied permission says where to turn it on, differently on iPhone", () => {
        expect(describeDevice({ ...desktop, permission: "denied" })).toMatchObject({ kind: "denied", message: expect.stringMatching(/site settings/) });
        expect(describeDevice({ ...desktop, ios: true, standalone: true, permission: "denied" })).toMatchObject({
            kind: "denied",
            message: expect.stringMatching(/iPhone's Settings, Notifications/),
        });
    });

    it("N4: plain http is reported as such before anything else", () => {
        expect(describeDevice({ ...desktop, secure: false, serviceWorker: false, pushManager: false })).toMatchObject({
            kind: "insecure",
            message: expect.stringMatching(/https/),
        });
    });

    it("a browser without push is unsupported", () => {
        expect(describeDevice({ ...desktop, pushManager: false })).toMatchObject({ kind: "unsupported", message: expect.stringMatching(/cannot receive push/) });
    });
});
