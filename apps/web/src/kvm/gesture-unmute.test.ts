// Failure mode K38 in FAILURE_MODES.md.

import { describe, expect, it, vi } from "vitest";
import { onNextActivation } from "./gesture-unmute";

const fire = (type: string): void => {
    document.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
};

describe("K38: unmuting waits for a gesture Safari accepts", () => {
    it("a touch landing is not a gesture: nothing runs until it is released", () => {
        const run = vi.fn();
        const stop = onNextActivation(document, run);
        fire("pointerdown");
        fire("touchstart");
        fire("mousedown");
        expect(run).not.toHaveBeenCalled();
        fire("pointerup");
        expect(run).toHaveBeenCalledTimes(1);
        stop();
    });

    it.each(["pointerup", "touchend", "click", "keydown"])("%s is a gesture, and it runs once however many follow", (type) => {
        const run = vi.fn();
        const stop = onNextActivation(document, run);
        fire(type);
        fire(type);
        fire("pointerup");
        fire("click");
        expect(run).toHaveBeenCalledTimes(1);
        stop();
    });

    it("cancelling stops the wait, and cancelling after it ran is harmless", () => {
        const never = vi.fn();
        const cancel = onNextActivation(document, never);
        cancel();
        fire("pointerup");
        fire("click");
        expect(never).not.toHaveBeenCalled();

        const once = vi.fn();
        const done = onNextActivation(document, once);
        fire("click");
        expect(() => done()).not.toThrow();
        expect(once).toHaveBeenCalledTimes(1);
    });

    it("it listens before the page's own handlers, so the gesture is still live when it runs", () => {
        const order: string[] = [];

        const page = (): void => {
            order.push("page");
        };
        document.body.addEventListener("pointerup", page);
        const stop = onNextActivation(document, () => order.push("unmute"));
        document.body.dispatchEvent(new Event("pointerup", { bubbles: true }));
        expect(order).toEqual(["unmute", "page"]);
        stop();
        document.body.removeEventListener("pointerup", page);
    });

    it("it hands the gesture's event over, so the caller can tell which control was tapped", () => {
        const seen: Event[] = [];
        const stop = onNextActivation(document, (event) => seen.push(event));
        const button = document.createElement("button");
        document.body.append(button);
        button.dispatchEvent(new Event("click", { bubbles: true }));
        expect(seen).toHaveLength(1);
        expect(seen[0]?.target).toBe(button);
        stop();
        button.remove();
    });
});
