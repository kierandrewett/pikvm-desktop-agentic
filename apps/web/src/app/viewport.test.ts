/**
 * FAILURE MODES (written before the tests)
 *
 * trackViewport (pure)
 *  1. An address bar collapsing (a small loss) is read as the keyboard and hides the bar.
 *  2. The keyboard is missed because the "tallest" height was never recorded (first sample
 *     taken with the keyboard already up).
 *  3. The keyboard stays "open" after it closes, because tallest is not kept as the maximum.
 *  4. Rotating the phone leaves a stale tallest, so the new orientation's shorter viewport
 *     reads as a keyboard forever. (Covered in the nav tests via the orientationchange event.)
 */

import { describe, expect, it } from "vitest";
import { INITIAL_TRACK, KEYBOARD_THRESHOLD_PX, trackViewport } from "./viewport";

describe("trackViewport", () => {
    it("does not treat a collapsing address bar as the keyboard", () => {
        let track = trackViewport(INITIAL_TRACK, 800);
        track = trackViewport(track, 800 - KEYBOARD_THRESHOLD_PX);
        expect(track.keyboardOpen).toBe(false);
    });

    it("reports the keyboard once more than the threshold is lost", () => {
        let track = trackViewport(INITIAL_TRACK, 800);
        track = trackViewport(track, 800 - KEYBOARD_THRESHOLD_PX - 1);
        expect(track.keyboardOpen).toBe(true);
    });

    it("reports the keyboard as closed again when the viewport grows back", () => {
        let track = trackViewport(INITIAL_TRACK, 800);
        track = trackViewport(track, 450);
        track = trackViewport(track, 800);
        expect(track).toEqual({ tallest: 800, keyboardOpen: false });
    });

    it("keeps the tallest height seen, not the latest", () => {
        let track = trackViewport(INITIAL_TRACK, 800);
        track = trackViewport(track, 450);
        track = trackViewport(track, 500);
        expect(track.tallest).toBe(800);
        expect(track.keyboardOpen).toBe(true);
    });

    it("cannot see a keyboard that was already up at the first sample", () => {
        // Known limit, pinned so a change is deliberate: with no taller sample there is
        // nothing to compare against, exactly as in the console.
        expect(trackViewport(INITIAL_TRACK, 450).keyboardOpen).toBe(false);
    });

    describe("against a known baseline (the installed app's 100vh)", () => {
        it("does not read a visual viewport that launched short as the keyboard", () => {
            // 874 screen, 62 reported missing at launch.
            expect(trackViewport(INITIAL_TRACK, 812, 874).keyboardOpen).toBe(false);
        });

        it("sees a keyboard that was already up at the first sample", () => {
            expect(trackViewport(INITIAL_TRACK, 450, 874).keyboardOpen).toBe(true);
        });

        it("closes the keyboard when the viewport returns to its short launch value, because the baseline is the screen", () => {
            let track = trackViewport(INITIAL_TRACK, 450, 874);
            track = trackViewport(track, 812, 874);
            expect(track).toEqual({ tallest: 874, keyboardOpen: false });
        });

        it("ignores a baseline of zero (a probe that could not be measured)", () => {
            expect(trackViewport(INITIAL_TRACK, 800, 0).tallest).toBe(800);
        });
    });
});
