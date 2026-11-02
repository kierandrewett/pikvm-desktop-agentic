import { describe, expect, it } from "vitest";
import { createManualClock } from "../../clock/index";
import { createArmedModifiers } from "./armed-modifiers";

// Failure mode 17 in FAILURE_MODES.md.

describe("armed modifiers", () => {
    it("a first tap at clock time 0 arms, and a quick second tap locks (0 is a time, not 'never')", () => {
        const clock = createManualClock(0);
        const armed = createArmedModifiers(clock);
        armed.tap("ControlLeft");
        clock.advance(100);
        armed.tap("ControlLeft");
        expect(armed.isLocked("ControlLeft")).toBe(true);
    });

    it("the 350ms window is exclusive", () => {
        const clock = createManualClock(5000);
        const armed = createArmedModifiers(clock);
        armed.tap("ShiftLeft");
        clock.advance(350);
        armed.tap("ShiftLeft");
        expect(armed.isArmed("ShiftLeft")).toBe(false);
    });

    it("timing is per modifier", () => {
        const clock = createManualClock(5000);
        const armed = createArmedModifiers(clock);
        armed.tap("ShiftLeft");
        clock.advance(100);
        armed.tap("ControlLeft");
        clock.advance(100);
        armed.tap("ControlLeft"); // 100ms after ITS own first tap: locks
        expect(armed.isLocked("ControlLeft")).toBe(true);
        expect(armed.isLocked("ShiftLeft")).toBe(false);
    });

    it("clear keeps locked modifiers and drops the rest", () => {
        const clock = createManualClock(5000);
        const armed = createArmedModifiers(clock);
        armed.tap("ControlLeft");
        clock.advance(10);
        armed.tap("ControlLeft");
        armed.tap("AltLeft");
        armed.clear();
        expect(armed.list()).toEqual(["ControlLeft"]);
    });

    it("reset drops locked modifiers too and publishes once", () => {
        const clock = createManualClock(5000);
        const armed = createArmedModifiers(clock);
        armed.tap("ControlLeft");
        clock.advance(10);
        armed.tap("ControlLeft");
        let notified = 0;
        armed.store.subscribe(() => notified++);
        armed.reset();
        armed.reset();
        expect(armed.store.getState()).toEqual({ armed: [], locked: [] });
        expect(notified).toBe(1);
    });

    it("clear with nothing armed does not notify", () => {
        const armed = createArmedModifiers(createManualClock(0));
        let notified = 0;
        armed.store.subscribe(() => notified++);
        armed.clear();
        expect(notified).toBe(0);
    });
});
