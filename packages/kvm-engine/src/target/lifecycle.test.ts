// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createManualClock } from "../clock/index";
import { BACKGROUND_KICK_AFTER_MS, networkCameBack, returnedFromBackground } from "./lifecycle";
import { bindLinkLifecycle } from "./lifecycle.dom";

// Failure mode 9 in FAILURE_MODES.md.

const fakeLink = () => ({ kick: vi.fn(), connect: vi.fn() });

describe("returning from the background", () => {
    it("replaces the socket after a real absence", () => {
        const link = fakeLink();
        returnedFromBackground(link, BACKGROUND_KICK_AFTER_MS + 1);
        expect(link.kick).toHaveBeenCalledOnce();
        expect(link.connect).not.toHaveBeenCalled();
    });

    it("only asks for a connection after a short one (3s exactly is short)", () => {
        const link = fakeLink();
        returnedFromBackground(link, BACKGROUND_KICK_AFTER_MS);
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
    function setHidden(hidden: boolean): void {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
        document.dispatchEvent(new Event("visibilitychange"));
    }

    it("measures hidden time on the engine clock", () => {
        const clock = createManualClock(0);
        const link = fakeLink();
        const unbind = bindLinkLifecycle(link, clock);
        setHidden(true);
        clock.advance(10_000);
        setHidden(false);
        expect(link.kick).toHaveBeenCalledOnce();
        setHidden(true);
        clock.advance(1000);
        setHidden(false);
        expect(link.connect).toHaveBeenCalledOnce();
        unbind();
    });

    it("kicks on online and unbinds cleanly", () => {
        const clock = createManualClock(0);
        const link = fakeLink();
        const unbind = bindLinkLifecycle(link, clock);
        window.dispatchEvent(new Event("online"));
        expect(link.kick).toHaveBeenCalledTimes(1);
        unbind();
        window.dispatchEvent(new Event("online"));
        setHidden(false);
        expect(link.kick).toHaveBeenCalledTimes(1);
    });
});
