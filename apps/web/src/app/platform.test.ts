/**
 * What the page does only for iOS: the type tokens' switch (`data-ios`), and the touch listener that lets :active draw.
 *
 * Failure modes:
 *  P1. An iPad that says it is a Mac is not told apart from a Mac, or a Mac is taken for an iPad (its text sizes
 *      would jump to 17px on a desktop).
 *  P2. The pressed state never shows on iOS because the page listens for no touch, or a listener is added where it
 *      is not needed, or one that can delay scrolling.
 */

import { describe, expect, it, vi } from "vitest";
import { enablePressedState, isIos, markIos } from "./platform";

const IPHONE = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15", platform: "iPhone", maxTouchPoints: 5 };
const IPAD_AS_MAC = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", platform: "MacIntel", maxTouchPoints: 5 };
const MAC = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", platform: "MacIntel", maxTouchPoints: 0 };
const ANDROID = { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130", platform: "Linux armv8l", maxTouchPoints: 5 };

describe("P1: which device is iOS", () => {
    it("an iPhone and an iPad that reports as a Mac with a touch screen are; a Mac and an Android phone are not", () => {
        expect(isIos(IPHONE)).toBe(true);
        expect(isIos(IPAD_AS_MAC)).toBe(true);
        expect(isIos(MAC)).toBe(false);
        expect(isIos(ANDROID)).toBe(false);
    });

    it("the installed app on an engine that says nothing else is told by navigator.standalone", () => {
        expect(isIos({ ...MAC, standalone: true })).toBe(true);
    });

    it("markIos sets data-ios once, only on iOS, and keeps what the inline script already set", () => {
        const phone = document.createElement("html");
        expect(markIos(phone, IPHONE)).toBe(true);
        expect(phone.getAttribute("data-ios")).toBe("true");
        const desktop = document.createElement("html");
        expect(markIos(desktop, MAC)).toBe(false);
        expect(desktop.hasAttribute("data-ios")).toBe(false);
        const set = document.createElement("html");
        set.setAttribute("data-ios", "true");
        expect(markIos(set, MAC)).toBe(true);
    });
});

describe("P2: the touch listener that makes :active draw on iOS", () => {
    it("adds a passive touchstart listener on iOS, and removes it", () => {
        const doc = document.implementation.createHTMLDocument();
        const add = vi.spyOn(doc, "addEventListener");
        const remove = vi.spyOn(doc, "removeEventListener");
        const stop = enablePressedState(doc, IPHONE);
        expect(add).toHaveBeenCalledWith("touchstart", expect.any(Function), { passive: true });
        stop();
        expect(remove).toHaveBeenCalledWith("touchstart", add.mock.calls[0]?.[1]);
    });

    it("adds nothing on a desktop or Android", () => {
        for (const host of [MAC, ANDROID]) {
            const doc = document.implementation.createHTMLDocument();
            const add = vi.spyOn(doc, "addEventListener");
            enablePressedState(doc, host)();
            expect(add).not.toHaveBeenCalled();
        }
    });
});
