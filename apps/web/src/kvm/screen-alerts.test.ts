import { createManualClock, ALERT_QUIET_MS } from "@pikvm/kvm-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_BRIDGE_KEY } from "@pikvm/contracts/desktop";
import { createScreenAlerts, readScreenAlerts, SCREEN_ALERTS_KEY, watchingForChange } from "./screen-alerts";

const grid = (fill: number, changed = 0): Float32Array => {
    const g = new Float32Array(960).fill(fill);
    for (let i = 0; i < changed; i++) g[i] = fill + 100;
    return g;
};

describe("watching", () => {
    it("only a backgrounded window where the page keeps running, with alerts on, is watching", () => {
        expect(watchingForChange(true, true, true)).toBe(true);
        // In front: already being looked at.
        expect(watchingForChange(true, true, false)).toBe(false);
        // Switched off by the user.
        expect(watchingForChange(true, false, true)).toBe(false);
        // A phone: the page is suspended behind another app, so nothing could be watching.
        expect(watchingForChange(false, true, true)).toBe(false);
    });
});

describe("screen alerts", () => {
    function setup(watching = true) {
        const clock = createManualClock(1_000_000);
        const bridge = { requestAttention: vi.fn() };
        let on = watching;
        const alerts = createScreenAlerts({ clock, attention: bridge, watching: () => on });
        return { clock, bridge, alerts, watch: (v: boolean) => (on = v) };
    }

    it("pulses once when a dialog-sized part of the picture changes, not for the first sample or small noise", () => {
        const { alerts, bridge } = setup();
        alerts.sample(grid(50));
        alerts.sample(grid(50, 5)); // under 2% of cells
        expect(bridge.requestAttention).not.toHaveBeenCalled();
        alerts.sample(grid(50, 100));
        expect(bridge.requestAttention).toHaveBeenCalledTimes(1);
    });

    it("one alert per episode: more change while it churns waits for the screen to be quiet", () => {
        const { alerts, bridge, clock } = setup();
        alerts.sample(grid(50));
        alerts.sample(grid(50, 100));
        alerts.sample(grid(50, 200));
        expect(bridge.requestAttention).toHaveBeenCalledTimes(1);
        clock.advance(ALERT_QUIET_MS + 1);
        alerts.sample(grid(50, 100));
        expect(bridge.requestAttention).toHaveBeenCalledTimes(2);
    });

    it("does nothing while nobody is watching, and forgets the picture so focus returning cannot fire one", () => {
        const { alerts, bridge, watch } = setup(false);
        alerts.sample(grid(50));
        alerts.sample(grid(50, 400));
        expect(bridge.requestAttention).not.toHaveBeenCalled();
        watch(true);
        alerts.sample(grid(50, 400)); // the first sample after watching begins only re-baselines
        expect(bridge.requestAttention).not.toHaveBeenCalled();
    });
});

describe("the stored choice", () => {
    afterEach(() => {
        localStorage.removeItem(SCREEN_ALERTS_KEY);
        Reflect.deleteProperty(window, DESKTOP_BRIDGE_KEY);
    });

    it("a browser starts with alerts off (they keep the stream running and ask for notifications), the desktop app with them on", () => {
        expect(readScreenAlerts()).toBe("off");
        Reflect.set(window, DESKTOP_BRIDGE_KEY, { requestAttention() {} });
        expect(readScreenAlerts()).toBe("on");
    });

    it("what the user chose wins in both places, and an unreadable value falls back to the default", () => {
        localStorage.setItem(SCREEN_ALERTS_KEY, "on");
        expect(readScreenAlerts()).toBe("on");
        Reflect.set(window, DESKTOP_BRIDGE_KEY, { requestAttention() {} });
        localStorage.setItem(SCREEN_ALERTS_KEY, "off");
        expect(readScreenAlerts()).toBe("off");
        localStorage.setItem(SCREEN_ALERTS_KEY, "banana");
        expect(readScreenAlerts()).toBe("on");
    });
});
