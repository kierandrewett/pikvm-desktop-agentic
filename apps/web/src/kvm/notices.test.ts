// Failure mode K15 in FAILURE_MODES.md.

import { createManualClock } from "@pikvm/kvm-engine";
import { describe, expect, it } from "vitest";
import { createNoticeCenter, TOAST_ERROR_MS, TOAST_FADE_MS, TOAST_OK_MS } from "./notices";

describe("the toast", () => {
    it("shows a confirmation for 2.6 s, fades, and empties its text only after the fade", () => {
        const clock = createManualClock();
        const center = createNoticeCenter(clock);
        center.notify({ text: "Macro sent" });
        expect(center.store.getState()).toEqual({ text: "Macro sent", error: false, show: true });

        clock.advance(TOAST_OK_MS);
        expect(center.store.getState()).toEqual({ text: "Macro sent", error: false, show: false });
        clock.advance(TOAST_FADE_MS);
        expect(center.store.getState().text).toBe("");
    });

    it("keeps a failure up longer than a confirmation", () => {
        const clock = createManualClock();
        const center = createNoticeCenter(clock);
        center.notify({ text: "Paste failed", error: true });
        clock.advance(TOAST_OK_MS + 1);
        expect(center.store.getState().show).toBe(true);
        clock.advance(TOAST_ERROR_MS - TOAST_OK_MS);
        expect(center.store.getState().show).toBe(false);
    });

    it("a sticky notice stays until dismissed or replaced", () => {
        const clock = createManualClock();
        const center = createNoticeCenter(clock);
        center.notify({ text: "Typing 4,000 characters", sticky: true });
        clock.advance(60_000);
        expect(center.store.getState().show).toBe(true);

        center.notify({ text: "Typed 4,000 characters" });
        expect(center.store.getState().text).toBe("Typed 4,000 characters");
        clock.advance(TOAST_OK_MS);
        expect(center.store.getState().show).toBe(false);
    });

    it("something newer shown during the fade is not emptied by the older one's clean-up", () => {
        const clock = createManualClock();
        const center = createNoticeCenter(clock);
        center.notify({ text: "first" });
        clock.advance(TOAST_OK_MS);
        center.notify({ text: "second" });
        clock.advance(TOAST_FADE_MS);
        expect(center.store.getState()).toEqual({ text: "second", error: false, show: true });
    });
});
