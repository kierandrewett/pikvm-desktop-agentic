import { createManualClock, ALERT_QUIET_MS } from "@pikvm/kvm-engine";
import { describe, expect, it, vi } from "vitest";
import { createScreenAlerts, watchingForChange } from "./screen-alerts";

const grid = (fill: number, changed = 0): Float32Array => {
    const g = new Float32Array(960).fill(fill);
    for (let i = 0; i < changed; i++) g[i] = fill + 100;
    return g;
};

describe("watching", () => {
    it("only a backgrounded desktop window with alerts on is watching", () => {
        const bridge = { requestAttention: () => {} };
        expect(watchingForChange(bridge, true, false)).toBe(true);
        expect(watchingForChange(bridge, true, true)).toBe(false);
        expect(watchingForChange(bridge, false, false)).toBe(false);
        expect(watchingForChange(undefined, true, false)).toBe(false);
    });
});

describe("screen alerts", () => {
    function setup(watching = true) {
        const clock = createManualClock(1_000_000);
        const bridge = { requestAttention: vi.fn() };
        let on = watching;
        const alerts = createScreenAlerts({ clock, bridge, watching: () => on });
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
