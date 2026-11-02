// Failure modes B1, B4 and A1-A3: see FAILURE_MODES.md.

import { describe, expect, it } from "vitest";
import { BLANK_GRID_CELLS, INITIAL_BLANK, lumaGrid, stepBlank } from "./blank";
import { ALERT_QUIET_MS, INITIAL_SCREEN_ACTIVITY, noteScreenSample } from "./screen-activity";

function rgba(value: (cell: number) => number): number[] {
    const px: number[] = [];
    for (let i = 0; i < BLANK_GRID_CELLS; i++) {
        const v = value(i);
        px.push(v, v, v, 255);
    }
    return px;
}

describe("lumaGrid", () => {
    it("B4: is the mean of R, G and B per cell", () => {
        const px = rgba(() => 0);
        px[0] = 30;
        px[1] = 60;
        px[2] = 90;
        const r = lumaGrid(px);
        expect(r.lum[0]).toBe(60);
        expect(r.lum[1]).toBe(0);
        expect(r.lum).toHaveLength(BLANK_GRID_CELLS);
    });

    it("B1: a solid colour, black or any other, is uniform", () => {
        expect(lumaGrid(rgba(() => 0)).uniform).toBe(true);
        expect(lumaGrid(rgba(() => 255)).uniform).toBe(true);
        expect(lumaGrid(rgba(() => 77)).uniform).toBe(true);
        expect(lumaGrid(rgba(() => 77)).variance).toBeCloseTo(0, 6);
    });

    it("B4: the threshold is variance 6 (population)", () => {
        const spread = (d: number) => lumaGrid(rgba((i) => (i % 2 ? 100 + d : 100 - d)));
        expect(spread(2.4).variance).toBeCloseTo(5.76, 2);
        expect(spread(2.4).uniform).toBe(true);
        expect(spread(2.5).variance).toBeCloseTo(6.25, 2);
        expect(spread(2.5).uniform).toBe(false);
        const checker = lumaGrid(rgba((i) => (i % 2 ? 255 : 0)));
        expect(checker.mean).toBeCloseTo(127.5, 6);
        expect(checker.variance).toBeCloseTo(127.5 * 127.5, 3);
        expect(checker.uniform).toBe(false);
    });

    it("reuses the caller's buffer, which is what lets two grids ping-pong without allocating", () => {
        const out = new Float32Array(BLANK_GRID_CELLS);
        expect(lumaGrid(rgba(() => 9), out).lum).toBe(out);
        expect(lumaGrid(rgba(() => 9), new Float32Array(3)).lum).not.toHaveLength(3);
    });
});

describe("stepBlank", () => {
    it("B1: becomes blank only after MORE than 2500 ms and clears on any varied sample", () => {
        let b = stepBlank(INITIAL_BLANK, true, 0);
        expect(b).toEqual({ since: 0, blank: false });
        b = stepBlank(b, true, 2500);
        expect(b.blank).toBe(false);
        b = stepBlank(b, true, 2501);
        expect(b.blank).toBe(true);
        b = stepBlank(b, true, 9999);
        expect(b.blank).toBe(true);
        expect(stepBlank(b, false, 10000)).toEqual(INITIAL_BLANK);
    });
});

describe("screen-change alerts", () => {
    const flat = (v: number) => new Float32Array(BLANK_GRID_CELLS).fill(v);
    /** A grid with `cells` cells brightened by 50. */
    const changed = (cells: number) => {
        const g = flat(10);
        for (let i = 0; i < cells; i++) g[i] = 60;
        return g;
    };

    it("A1: the first sample only re-baselines, and being unwatched forgets everything", () => {
        let r = noteScreenSample(INITIAL_SCREEN_ACTIVITY, changed(0), true, 0);
        expect(r.alert).toBe(false);
        r = noteScreenSample(r.state, changed(200), true, 1500);
        expect(r.alert).toBe(true);
        r = noteScreenSample(r.state, flat(10), false, 3000);
        expect(r.state).toEqual(INITIAL_SCREEN_ACTIVITY);
        r = noteScreenSample(r.state, changed(500), true, 4500);
        expect(r.alert).toBe(false); // what happened while focused cannot fire on losing focus
    });

    it("A2: under 2 % of cells never alerts, a dialog-sized change does", () => {
        const base = noteScreenSample(INITIAL_SCREEN_ACTIVITY, flat(10), true, 0).state;
        const small = noteScreenSample(base, changed(Math.floor(BLANK_GRID_CELLS * 0.02) - 1), true, 1500);
        expect(small.alert).toBe(false);
        const edge = noteScreenSample(base, changed(Math.ceil(BLANK_GRID_CELLS * 0.02)), true, 1500);
        expect(edge.alert).toBe(true);
        const dialog = noteScreenSample(base, changed(Math.round(BLANK_GRID_CELLS * 0.09)), true, 1500);
        expect(dialog.alert).toBe(true);
    });

    it("A2: a cell must move by more than 10 to count", () => {
        const base = noteScreenSample(INITIAL_SCREEN_ACTIVITY, flat(10), true, 0).state;
        expect(noteScreenSample(base, flat(20), true, 1500).alert).toBe(false); // exactly 10
        expect(noteScreenSample(base, flat(20.5), true, 1500).alert).toBe(true);
    });

    it("A3: one alert per episode, the next only after 20 s of quiet", () => {
        let s = noteScreenSample(INITIAL_SCREEN_ACTIVITY, flat(0), true, 0).state;
        const alerts: number[] = [];
        let t = 1500;
        // the screen churns every tick for a minute
        for (let i = 0; i < 40; i++, t += 1500) {
            const r = noteScreenSample(s, flat(i % 2 ? 0 : 100), true, t);
            s = r.state;
            if (r.alert) alerts.push(t);
        }
        expect(alerts).toEqual([1500]);
        // 20 s of stillness, then a change
        for (let q = 0; q < 14; q++, t += 1500) s = noteScreenSample(s, flat(s.prev?.[0] ?? 0), true, t).state;
        expect(t - 1500 - (alerts.at(-1) ?? 0)).toBeGreaterThan(ALERT_QUIET_MS);
        const again = noteScreenSample(s, flat(((s.prev?.[0] ?? 0) + 100) % 255), true, t);
        expect(again.alert).toBe(true);
    });
});
