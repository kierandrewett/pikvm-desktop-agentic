// Failure modes 20-23 in packages/kvm-engine/src/target/FAILURE_MODES.md, through the real session: the
// page's own events, a real keyboard and link over the engine's fake socket and a manual clock.

import { afterEach, describe, expect, it } from "vitest";
import { openRig } from "./test-support";

let hidden = false;
function setHidden(next: boolean): void {
    hidden = next;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
}
afterEach(async () => setHidden(false));

describe("the session when the page goes away and comes back", () => {
    it("a key held when the page is hidden is released at once, before anything else could go wrong", async () => {
        const rig = await openRig({ bindLifecycle: true });
        rig.session.keyboard.modifiers.press("ShiftLeft");
        await rig.clock.settle();
        expect(rig.sent()).toEqual(["key ShiftLeft:down"]);
        setHidden(true);
        await rig.clock.settle();
        expect(rig.sent()).toEqual(["key ShiftLeft:down", "key ShiftLeft:up"]);
        await rig.session.stop();
    });

    it("hidden, the socket dies and nothing reconnects it, however long the page stays hidden", async () => {
        const rig = await openRig({ bindLifecycle: true });
        setHidden(true);
        rig.hub.last.serverClose();
        await rig.clock.advanceAsync(5 * 60_000);
        expect(rig.hub.sockets).toHaveLength(1);
        await rig.session.stop();
    });

    it("shown again after a real absence, the link is replaced once, and anything held goes up on the new socket", async () => {
        const rig = await openRig({ bindLifecycle: true });
        rig.session.keyboard.modifiers.press("ControlLeft");
        await rig.clock.settle();
        setHidden(true);
        rig.hub.last.serverClose(); // the old socket died with the page, taking the release with it
        await rig.clock.advanceAsync(8000);
        setHidden(false);
        await rig.clock.settle();
        expect(rig.hub.sockets).toHaveLength(2);
        rig.hub.last.serverOpen();
        await rig.clock.settle();
        // The hide released it (into the socket that was still open), and the return found nothing more to release.
        expect(rig.sent().filter((l) => l.startsWith("key ControlLeft"))).toEqual(["key ControlLeft:down", "key ControlLeft:up"]);
        await rig.session.stop();
    });

    it("a burst of return signals replaces the socket once", async () => {
        const rig = await openRig({ bindLifecycle: true });
        setHidden(true);
        await rig.clock.advanceAsync(8000);
        setHidden(false);
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("resume"));
        const page = new Event("pageshow");
        Object.defineProperty(page, "persisted", { value: true });
        window.dispatchEvent(page);
        await rig.clock.settle();
        expect(rig.hub.sockets).toHaveLength(2);
        await rig.session.stop();
    });
});
