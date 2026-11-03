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
