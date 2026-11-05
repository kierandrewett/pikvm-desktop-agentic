/**
 * The page's report of whether the person is at it.
 *
 * Failure modes, before behaviour:
 *  P1. The app's own HID (the jiggler, the agent, macros: events a script dispatches, or none at all) counts as the person.
 *  P2. A tiny nudge, a bump or slow drift counts as using the window.
 *  P3. Reports keep going while the page is unfocused or the person idle (the host would hold notifications back on stale word).
 *  P4. The person's first key press, or the page losing focus, is not reported at once.
 *  P5. A report carries more than a focus flag and two ages (a key, a position, text, a timestamp).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ACTIVE_WINDOW_MS,
    createPresenceReporter,
    newClientId,
    POINTER_PATH_PX,
    POINTER_RESET_MS,
    REPORT_EVERY_MS,
    type PresenceReporter,
} from "./presence";

type Report = { focused: boolean; keyboardAgoMs: number | null; pointerAgoMs: number | null };

interface Rig {
    reporter: PresenceReporter;
    reports: Report[];
    clock: { t: number };
    focus: { on: boolean };
    /** Time passes; the page re-reads the clock every second, as the hook does. */
    advance(ms: number): void;
}

function rig(): Rig {
    const clock = { t: 5_000_000 };
    const focus = { on: true };
    const reports: Report[] = [];
    const reporter = createPresenceReporter({ now: () => clock.t, focused: () => focus.on, send: (report) => void reports.push(report) });
    return {
        reporter,
        reports,
        clock,
        focus,
        advance(ms) {
            for (let spent = 0; spent < ms; spent += 1000) {
                clock.t += Math.min(1000, ms - spent);
                reporter.evaluate();
            }
        },
    };
}

describe("what counts", () => {
    it("the constants: 40 px of path, forgotten after 1 s, a report every 5 s while active, active for 20 s", () => {
        expect(POINTER_PATH_PX).toBe(40);
        expect(POINTER_RESET_MS).toBe(1000);
        expect(REPORT_EVERY_MS).toBe(5000);
        expect(ACTIVE_WINDOW_MS).toBe(20_000);
    });

    it("P4: a real key press while focused is reported at once, as an age of 0 and no pointer movement", () => {
        const r = rig();
        r.reporter.key(true);
        expect(r.reports).toEqual([{ focused: true, keyboardAgoMs: 0, pointerAgoMs: null }]);
    });

    it("P1: a key press or movement that a script dispatched (not trusted) is never reported: the app's own HID is not the person", () => {
        const r = rig();
        r.reporter.key(false);
        for (let x = 0; x < 400; x += 10) r.reporter.move(x, 50, false);
        r.reporter.touch(false);
        r.advance(10_000);
        expect(r.reports).toEqual([]);
    });

    it("P1: nothing is reported for HID the host sends, because it never reaches the page as input: a quiet page stays quiet", () => {
        const r = rig();
        r.advance(60_000);
        expect(r.reports).toEqual([]);
    });

    it("P2: one tiny nudge, a bump, or slow drift is not a movement", () => {
        const r = rig();
        r.reporter.move(100, 100, true);
        r.reporter.move(104, 103, true);
        r.advance(1000);
        // Drift: 10 px a second for a minute is far more than 40 px in all, but never 40 px within a second.
        for (let i = 0; i < 60; i++) {
            r.clock.t += 1100;
            r.reporter.move(100 + i * 10, 100, true);
            r.reporter.evaluate();
        }
        expect(r.reports).toEqual([]);
    });

    it("a real movement of 40 px of path within a second is reported, as an age and no key", () => {
        const r = rig();
        r.reporter.move(100, 100, true);
        r.clock.t += 100;
        r.reporter.move(125, 100, true);
        expect(r.reports).toEqual([]);
        r.clock.t += 100;
        r.reporter.move(150, 100, true);
        expect(r.reports).toEqual([{ focused: true, keyboardAgoMs: null, pointerAgoMs: 0 }]);
    });

    it("the path is the distance travelled, not the distance from the start: back and forth counts", () => {
        const r = rig();
        r.reporter.move(100, 100, true);
        for (let i = 0; i < 5; i++) {
            r.clock.t += 50;
            r.reporter.move(i % 2 ? 100 : 120, 100, true);
        }
        expect(r.reports.length).toBe(1);
    });

    it("a finger on the screen is deliberate input and counts at once", () => {
        const r = rig();
        r.reporter.touch(true);
        expect(r.reports).toEqual([{ focused: true, keyboardAgoMs: null, pointerAgoMs: 0 }]);
    });
});

describe("when it reports", () => {
    it("P3/P4: while active it refreshes every 5 s with the growing age, then stops once the person is idle, after one last report", () => {
        const r = rig();
        r.reporter.key(true);
        r.advance(4000);
        expect(r.reports).toHaveLength(1);
        r.advance(1000);
        expect(r.reports).toHaveLength(2);
        expect(r.reports[1]).toEqual({ focused: true, keyboardAgoMs: 5000, pointerAgoMs: null });
        r.advance(15_000);
        // Reports at 0, 5, 10, 15 s, and one more at 20 s when the window closes.
        expect(r.reports.map((report) => report.keyboardAgoMs)).toEqual([0, 5000, 10_000, 15_000, 20_000]);
        const before = r.reports.length;
        r.advance(120_000);
        expect(r.reports).toHaveLength(before);
    });

    it("P4: losing focus while active sends one report at once, saying so; and nothing while unfocused", () => {
        const r = rig();
        r.reporter.key(true);
        r.advance(2000);
        r.focus.on = false;
        r.reporter.evaluate();
        expect(r.reports.at(-1)).toEqual({ focused: false, keyboardAgoMs: 2000, pointerAgoMs: null });
        const count = r.reports.length;
        r.reporter.key(true);
        r.advance(30_000);
        expect(r.reports).toHaveLength(count);
    });

    it("P3: an unfocused page that was never active reports nothing, ever", () => {
        const r = rig();
        r.focus.on = false;
        r.reporter.key(true);
        r.reporter.move(0, 0, true);
        r.reporter.move(200, 0, true);
        r.advance(60_000);
        expect(r.reports).toEqual([]);
    });

    it("focus coming back while the last input is still recent reports again", () => {
        const r = rig();
        r.reporter.key(true);
        r.focus.on = false;
        r.reporter.evaluate();
        const count = r.reports.length;
        r.advance(3000);
        r.focus.on = true;
        r.reporter.evaluate();
        expect(r.reports).toHaveLength(count + 1);
        expect(r.reports.at(-1)).toMatchObject({ focused: true, keyboardAgoMs: 3000 });
    });

    it("P5: a report has exactly three fields, and a client id is something the host accepts", () => {
        const r = rig();
        r.reporter.key(true);
        r.reporter.move(0, 0, true);
        r.reporter.move(300, 400, true);
        for (const report of r.reports) expect(Object.keys(report).sort()).toEqual(["focused", "keyboardAgoMs", "pointerAgoMs"]);
        expect(newClientId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
        expect(newClientId()).not.toBe(newClientId());
    });
});

describe("the hook's listeners", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("P1: a keydown the page dispatches itself is not trusted, so a script cannot stand in for the person", () => {
        const event = new KeyboardEvent("keydown", { key: "a" });
        expect(event.isTrusted).toBe(false);
        const moved = new PointerEvent("pointermove", { clientX: 10, clientY: 10 });
        expect(moved.isTrusted).toBe(false);
    });
});
