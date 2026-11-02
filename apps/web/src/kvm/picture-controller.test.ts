// Failure modes K18 and K20 in FAILURE_MODES.md.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createFieldFocus } from "./field-focus";
import { createJanusBridge } from "./janus-stream";
import { createPictureController, type PictureController } from "./picture-controller";
import { openRig } from "./test-support";

const made: PictureController[] = [];
afterEach(() => {
    for (const c of made.splice(0)) c.dispose();
    vi.unstubAllGlobals();
});

async function mount() {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const rig = await openRig();
    const pane = document.createElement("div");
    const img = document.createElement("img");
    const video = document.createElement("video");
    const freeze = document.createElement("canvas");
    const cursor = document.createElement("div");
    const lens = document.createElement("canvas");
    pane.append(img, video, freeze, cursor, lens);
    document.body.appendChild(pane);
    const controller = createPictureController({
        session: rig.session,
        elements: { pane, img, video, freeze, cursor, lens },
        focus: createFieldFocus(rig.clock),
        desktop: false,
        prefs: { touchMode: "trackpad", touchHid: "abs", dragLock: false, modalOpen: false, windowFocused: true },
    });
    made.push(controller);
    return { rig, controller, img, video, freeze };
}

describe("the view", () => {
    it("K18: a zoom reaches the image, the video and the held frame together, and the published scale is the machine's", async () => {
        const { controller, img, video, freeze } = await mount();
        expect(controller.store.getState().scale).toBe(1);

        controller.pointer.send({ type: "wheel", x: 10, y: 10, deltaY: -100, modifier: "control" });
        const scale = controller.pointer.machine.currentView.scale;
        expect(scale).toBeGreaterThan(1);
        expect(controller.store.getState().scale).toBe(scale);
        for (const el of [img, video, freeze]) expect(el.style.transform).toContain(`scale(${scale.toFixed(4)})`);
    });

    it("K18: resetting restores the whole picture on all three and publishes scale 1", async () => {
        const { controller, img, video, freeze } = await mount();
        controller.pointer.send({ type: "wheel", x: 10, y: 10, deltaY: -100, modifier: "control" });
        controller.resetZoom();
        expect(controller.pointer.machine.currentView.scale).toBe(1);
        expect(controller.store.getState().scale).toBe(1);
        for (const el of [img, video, freeze]) expect(el.style.transform).toMatch(/scale\(1(\.0+)?\)/);
    });

    it("the picture starts out connecting, in a mode not yet decided", async () => {
        const { controller } = await mount();
        expect(controller.store.getState()).toMatchObject({ signal: "connecting", mode: "detecting", webrtc: false, fullUi: false });
        expect(controller.store.getState().audio.available).toBe(false);
    });

    it("the Pi's UI over the picture is a state the screen can read, and the machine is told", async () => {
        const { controller } = await mount();
        controller.setFullUi(true);
        expect(controller.store.getState().fullUi).toBe(true);
        controller.setFullUi(false);
        expect(controller.store.getState().fullUi).toBe(false);
    });
});

describe("the session", () => {
    it("K20: the link lifecycle is bound once: a long stay in the background replaces the socket exactly once", async () => {
        const rig = await openRig({ bindLifecycle: true });
        // A second screen mounting calls start again; it must not bind a second listener.
        rig.session.start();
        rig.session.start();
        let hidden = false;
        vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);

        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
        rig.clock.advance(5000);
        hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
        await rig.clock.settle();

        expect(rig.hub.sockets).toHaveLength(2);
        await rig.session.stop();
    });

    it("stopping the session lets go of whatever the target is holding", async () => {
        const rig = await openRig();
        rig.session.keyboard.modifiers.press("ShiftLeft");
        await rig.session.stop();
        expect(rig.hub.sockets[0]?.commands().map((c) => c.event)).toContainEqual({ key: "ShiftLeft", state: false });
    });
});

describe("WebRTC", () => {
    it("is offered only where the browser can do it, so a phone without it stays on MJPEG", () => {
        const video = document.createElement("video");
        const bridge = createJanusBridge(video, () => "", () => true);
        vi.stubGlobal("RTCPeerConnection", undefined);
        expect(bridge.port.available()).toBe(false);
        vi.stubGlobal("RTCPeerConnection", class {});
        expect(bridge.port.available()).toBe(true);
        expect(bridge.current()).toBeNull();
    });
});
