/**
 * The hook that mounts the reporter on the page. jsdom (like a script in a browser) can only dispatch UNtrusted events, which is exactly
 * the kind the app's own synthetic input is, so what these show is that none of it reaches the host; the trusted path is the reporter's
 * own test (presence.test.ts), driven the way the listeners drive it.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePresence } from "./use-presence";

describe("usePresence", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("P1: keys and pointer movement dispatched by a script (the jiggler's, a macro's, a test's) are never reported", async () => {
        const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
        vi.stubGlobal("fetch", fetchSpy);
        const { unmount } = renderHook(() => usePresence());
        for (let i = 0; i < 20; i++) {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
            document.dispatchEvent(new PointerEvent("pointermove", { clientX: i * 30, clientY: 10, bubbles: true }));
            document.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
        }
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchSpy).not.toHaveBeenCalled();
        unmount();
    });

    it("takes its listeners off when the page is torn down", async () => {
        const remove = vi.spyOn(document, "removeEventListener");
        const { unmount } = renderHook(() => usePresence());
        unmount();
        expect(remove.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(["keydown", "pointermove", "pointerdown", "touchmove", "visibilitychange"]));
    });
});
