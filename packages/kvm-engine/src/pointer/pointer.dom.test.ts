// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PointerDriver } from "./driver";
import { attachPointerInput } from "./pointer.dom";

// Failure mode R7 in video/FAILURE_MODES.md: whatever the target holds for this page is let go when the page leaves.

let hidden = false;
function setHidden(next: boolean): void {
    hidden = next;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}
afterEach(() => setHidden(false));

function setup() {
    const send = vi.fn(() => ({ preventDefault: false }));
    const driver = { send } as unknown as PointerDriver;
    const detach = attachPointerInput({ pane: document.createElement("div"), driver });
    return { send, detach };
}

describe("a pointer the page never sees released", () => {
    it("the window losing focus, the page being hidden and pagehide each tell the machine to let go", () => {
        const { send, detach } = setup();
        window.dispatchEvent(new Event("blur"));
        setHidden(true);
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("pagehide"));
        expect(send.mock.calls.map((c) => (c as unknown as [{ type: string }])[0].type)).toEqual(["blur", "blur", "blur"]);
        detach();
    });

    it("becoming visible again is not a reason to let go", () => {
        const { send, detach } = setup();
        setHidden(false);
        document.dispatchEvent(new Event("visibilitychange"));
        expect(send).not.toHaveBeenCalled();
        detach();
    });

    it("detaching removes the listeners", () => {
        const { send, detach } = setup();
        detach();
        setHidden(true);
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("pagehide"));
        window.dispatchEvent(new Event("blur"));
        expect(send).not.toHaveBeenCalled();
    });
});

describe("P20: the screen's edge strip belongs to the page while a finger is on the picture", () => {
    function touchStart(pane: HTMLElement, x: number, target: Element = pane): Event {
        const event = new Event("touchstart", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "changedTouches", { value: [{ clientX: x, clientY: 200 }] });
        target.dispatchEvent(event);
        return event;
    }

    function paneWith(ignoreTarget?: (target: EventTarget | null) => boolean) {
        const pane = document.createElement("div");
        document.body.append(pane);
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
        const detach = attachPointerInput({ pane, driver: { send: vi.fn(() => ({ preventDefault: false })) } as unknown as PointerDriver, ...(ignoreTarget ? { ignoreTarget } : {}) });
        return { pane, detach };
    }

    it("a touch starting at the left or right edge is cancelled; one elsewhere is not", () => {
        const { pane, detach } = paneWith();
        expect(touchStart(pane, 5).defaultPrevented).toBe(true);
        expect(touchStart(pane, 24).defaultPrevented).toBe(true);
        expect(touchStart(pane, 395).defaultPrevented).toBe(true);
        expect(touchStart(pane, 25).defaultPrevented).toBe(false);
        expect(touchStart(pane, 200).defaultPrevented).toBe(false);
        detach();
        pane.remove();
    });

    it("a touch on overlaid UI is left alone, and detaching removes the guard", () => {
        const ui = document.createElement("button");
        const { pane, detach } = paneWith((target) => target === ui);
        pane.append(ui);
        expect(touchStart(pane, 5, ui).defaultPrevented).toBe(false);
        detach();
        expect(touchStart(pane, 5).defaultPrevented).toBe(false);
        pane.remove();
    });
});
