// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManualClock, type Clock } from "../clock/index";
import { RESUME_STALE_MS } from "../resume";
import { networkCameBack, returnedFromBackground } from "./lifecycle";
import { bindLinkLifecycle } from "./lifecycle.dom";

// Failure modes 9 and 20-23 in FAILURE_MODES.md.

const fakeLink = () => ({ kick: vi.fn(), connect: vi.fn() });

/** A clock whose timers only run when told to: a frozen page is one whose timer did not run on time. */
function stubClock(): Clock & { jump(ms: number): void; fire(): void } {
    let now = 0;
    let pending: (() => void) | null = null;
    return {
        now: () => now,
        setTimeout(fn) {
            pending = fn;
            return () => {
                pending = null;
            };
        },
        jump(ms) {
            now += ms;
        },
        fire() {
            const fn = pending;
            pending = null;
            fn?.();
        },
    };
}

describe("returning from the background", () => {
    it("replaces the socket after a real absence", () => {
        const link = fakeLink();
        returnedFromBackground(link, RESUME_STALE_MS + 1);
        expect(link.kick).toHaveBeenCalledOnce();
        expect(link.connect).not.toHaveBeenCalled();
    });

    it("only asks for a connection after a short one (1 s exactly is short)", () => {
        const link = fakeLink();
        returnedFromBackground(link, RESUME_STALE_MS);
        returnedFromBackground(link, 0);
        expect(link.kick).not.toHaveBeenCalled();
        expect(link.connect).toHaveBeenCalledTimes(2);
    });

    it("the network coming back always kicks", () => {
        const link = fakeLink();
        networkCameBack(link);
        expect(link.kick).toHaveBeenCalledOnce();
    });
});

describe("DOM binding", () => {
    let hidden = false;
    const unbinds: (() => void)[] = [];
    afterEach(() => {
        for (const u of unbinds.splice(0)) u();
        setHidden(false, false);
    });

    function setHidden(next: boolean, announce = true): void {
        hidden = next;
        Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
        if (announce) document.dispatchEvent(new Event("visibilitychange"));
    }
    const bind = (hooks?: { onBackground: () => void }) => {
        const clock = createManualClock(0);
        const link = fakeLink();
        unbinds.push(bindLinkLifecycle(link, clock, document, window, hooks));
        return { clock, link };
    };
    const pageshow = (persisted: boolean): void => {
        const e = new Event("pageshow");
        Object.defineProperty(e, "persisted", { value: persisted });
        window.dispatchEvent(e);
    };
    it("measures hidden time on the engine clock", () => {
        const { clock, link } = bind();
        setHidden(true);
        clock.advance(10_000);
        setHidden(false);
        expect(link.kick).toHaveBeenCalledOnce();
        setHidden(true);
        clock.advance(1000);
        setHidden(false);
        expect(link.connect).toHaveBeenCalledOnce();
    });

    it("kicks on online and unbinds cleanly", () => {
        const { link } = bind();
        window.dispatchEvent(new Event("online"));
        expect(link.kick).toHaveBeenCalledTimes(1);
        unbinds.pop()?.();
        window.dispatchEvent(new Event("online"));
        setHidden(false);
        expect(link.kick).toHaveBeenCalledTimes(1);
    });

    it("20: pageshow (persisted) and the Page Lifecycle resume are returns; a first-load pageshow is not", () => {
        const { clock, link } = bind();
        document.dispatchEvent(new Event("freeze"));
        clock.advance(5000);
        pageshow(false);
        expect(link.kick).not.toHaveBeenCalled();
        pageshow(true);
        expect(link.kick).toHaveBeenCalledOnce();

        document.dispatchEvent(new Event("freeze"));
        clock.advance(5000);
        document.dispatchEvent(new Event("resume"));
        expect(link.kick).toHaveBeenCalledTimes(2);
    });

    it("20: a window focus after pagehide is a return", () => {
        const { clock, link } = bind();
        window.dispatchEvent(new Event("pagehide"));
        clock.advance(2000);
        window.dispatchEvent(new Event("focus"));
        expect(link.kick).toHaveBeenCalledOnce();
    });

    it("20: a page never told it was away is found by its own heartbeat, and a running page is not", () => {
        const stub = stubClock();
        const link = fakeLink();
        unbinds.push(bindLinkLifecycle(link, stub, document, window));
        for (let i = 0; i < 10; i++) {
            stub.jump(1000);
            stub.fire();
        }
        expect(link.kick).not.toHaveBeenCalled();
        stub.jump(4000); // late, but a busy page can be 4 s late
        stub.fire();
        expect(link.kick).not.toHaveBeenCalled();
        stub.jump(60_000); // the page was frozen: the first tick after it ran a minute late
        stub.fire();
        expect(link.kick).toHaveBeenCalledOnce();
    });

    it("20: a late tick on a hidden page is not a return, and does not spend the absence", () => {
        const stub = stubClock();
        const link = fakeLink();
        unbinds.push(bindLinkLifecycle(link, stub, document, window));
        setHidden(true);
        stub.jump(120_000);
        stub.fire();
        expect(link.kick).not.toHaveBeenCalled();
        setHidden(false);
        expect(link.kick).toHaveBeenCalledOnce();
    });

    it("21: a burst of signals for one return kicks once", () => {
        const { clock, link } = bind();
        setHidden(true);
        clock.advance(8000);
        setHidden(false);
        pageshow(true);
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("resume"));
        expect(link.kick).toHaveBeenCalledOnce();
        expect(link.connect).toHaveBeenCalledTimes(3);
    });

    it("22: focus or pageshow while the page is hidden is not a return", () => {
        const { clock, link } = bind();
        setHidden(true);
        clock.advance(8000);
        window.dispatchEvent(new Event("focus"));
        pageshow(true);
        expect(link.kick).not.toHaveBeenCalled();
        expect(link.connect).not.toHaveBeenCalled();
        setHidden(false);
        expect(link.kick).toHaveBeenCalledOnce(); // the absence was not spent by the false returns
    });

    it("23: whatever is held is let go as the page leaves, and again on return from an absence", () => {
        const onBackground = vi.fn();
        const { clock } = bind({ onBackground });
        setHidden(true);
        expect(onBackground).toHaveBeenCalledTimes(1);
        clock.advance(5000);
        setHidden(false);
        expect(onBackground).toHaveBeenCalledTimes(2);
        window.dispatchEvent(new Event("focus")); // no absence: nothing to let go of
        expect(onBackground).toHaveBeenCalledTimes(2);
    });

    it("23: freeze and pagehide also let go", () => {
        const onBackground = vi.fn();
        bind({ onBackground });
        document.dispatchEvent(new Event("freeze"));
        window.dispatchEvent(new Event("pagehide"));
        expect(onBackground).toHaveBeenCalledTimes(2);
    });

    it("unbinding stops the heartbeat", () => {
        const { clock } = bind();
        unbinds.pop()?.();
        expect(clock.pending()).toBe(0);
    });
});
