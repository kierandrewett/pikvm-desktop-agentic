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

async function mount(extra: { desktop?: boolean; agent?: () => boolean } = {}) {
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
        desktop: extra.desktop ?? false,
        ...(extra.agent ? { agent: extra.agent } : {}),
        prefs: { active: true, touchMode: "trackpad", touchHid: "abs", dragLock: false, modalOpen: false, windowFocused: true, watching: false },
    });
    made.push(controller);
    return { rig, controller, img, video, freeze, pane, cursor };
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

describe("the resolution toast", () => {
    it("pops when the first real frame arrives, once, then fades and empties", async () => {
        const { rig, controller, img } = await mount();
        Object.defineProperty(img, "naturalWidth", { configurable: true, value: 1920 });
        Object.defineProperty(img, "naturalHeight", { configurable: true, value: 1080 });
        img.dispatchEvent(new Event("load"));
        expect(controller.store.getState().res).toEqual({ text: "1920 \u00d7 1080  \u00b7  MJPEG", av: "", show: true });

        // The same picture again is not news.
        rig.clock.advance(2600);
        expect(controller.store.getState().res.show).toBe(false);
        img.dispatchEvent(new Event("load"));
        expect(controller.store.getState().res.show).toBe(false);

        rig.clock.advance(300);
        expect(controller.store.getState().res.text).toBe("");
    });

    it("says nothing before there is a real frame", async () => {
        const { controller, img } = await mount();
        img.dispatchEvent(new Event("load"));
        expect(controller.store.getState().res.show).toBe(false);
    });
});

describe("input offline", () => {
    it("the pointer over the picture says it cannot be used, and the blob is not left claiming a remote cursor", async () => {
        const { rig, pane, cursor } = await mount();
        cursor.style.display = "block";
        rig.hub.last.serverClose();
        await rig.clock.settle();
        expect(pane.style.cursor).toBe("not-allowed");
        expect(cursor.style.display).toBe("none");

        await rig.clock.advanceAsync(1300);
        rig.hub.last.serverOpen();
        await rig.clock.settle();
        expect(pane.style.cursor).toBe("");
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

    it("K20: the network coming back replaces the socket too, once", async () => {
        const rig = await openRig({ bindLifecycle: true });
        rig.session.start();
        window.dispatchEvent(new Event("online"));
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

describe("the cursor report", () => {
    const reports = () =>
        (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => url === "/app/daemon/cursor");

    async function moveTheMouse(rig: Awaited<ReturnType<typeof mount>>["rig"], controller: PictureController): Promise<void> {
        // jsdom has no layout: give the machine a pane and a Pi that has said it is absolute.
        controller.pointer.send({
            type: "env",
            env: { mouseMode: "absolute", pane: { left: 0, top: 0, width: 160, height: 90 }, nat: { w: 160, h: 90 } },
        });
        controller.pointer.send({ type: "enter", kind: "mouse" });
        controller.pointer.send({ type: "move", id: 1, kind: "mouse", x: 20, y: 20, buttons: 0 });
        // Moves are coalesced to the display's next frame.
        controller.pointer.send({ type: "frame" });
        rig.clock.advance(400);
    }

    it("goes to the agent when the host has one, so a hosted page tells it where the person moved", async () => {
        const { rig, controller } = await mount({ agent: () => true });
        await moveTheMouse(rig, controller);
        expect(reports()).toHaveLength(1);
    });

    it("is not sent where nothing would take it: a browser on a host with no agent", async () => {
        const { rig, controller } = await mount({ agent: () => false });
        await moveTheMouse(rig, controller);
        expect(reports()).toHaveLength(0);
    });

    it("is sent from the desktop app whatever the host says about an agent", async () => {
        const { rig, controller } = await mount({ desktop: true });
        await moveTheMouse(rig, controller);
        expect(reports()).toHaveLength(1);
    });
});

describe("the KVM behind another tab", () => {
    // The picture keeps streaming while another tab is in front, so it is live on return; but it is
    // not where the person is pointing, and nothing about it may say so.
    const reports = () =>
        (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => url === "/app/daemon/cursor");

    async function moveTheMouse(rig: Awaited<ReturnType<typeof mount>>["rig"], controller: PictureController): Promise<void> {
        controller.pointer.send({
            type: "env",
            env: { mouseMode: "absolute", pane: { left: 0, top: 0, width: 160, height: 90 }, nat: { w: 160, h: 90 } },
        });
        controller.pointer.send({ type: "enter", kind: "mouse" });
        controller.pointer.send({ type: "move", id: 1, kind: "mouse", x: 20, y: 20, buttons: 0 });
        controller.pointer.send({ type: "frame" });
        rig.clock.advance(400);
    }

    it("takes no gestures: the pointer machine is told a modal owns it", async () => {
        const { controller } = await mount();
        expect(controller.pointer.machine.environment.modalOpen).toBe(false);
        controller.setPrefs({ active: false });
        expect(controller.pointer.machine.environment.modalOpen).toBe(true);
        controller.setPrefs({ active: true });
        expect(controller.pointer.machine.environment.modalOpen).toBe(false);
    });

    it("a real dialog stays open across a tab change", async () => {
        const { controller } = await mount();
        controller.setPrefs({ modalOpen: true });
        controller.setPrefs({ active: false });
        controller.setPrefs({ active: true });
        expect(controller.pointer.machine.environment.modalOpen).toBe(true);
    });

    it("does not report a cursor position to the agent", async () => {
        const { rig, controller } = await mount({ desktop: true });
        controller.setPrefs({ active: false });
        await moveTheMouse(rig, controller);
        expect(reports()).toHaveLength(0);
    });

    it("reports again when it returns", async () => {
        const { rig, controller } = await mount({ desktop: true });
        controller.setPrefs({ active: false });
        controller.setPrefs({ active: true });
        await moveTheMouse(rig, controller);
        expect(reports()).toHaveLength(1);
    });

    it("keeps its picture: the elements are the same and the signal is not reset", async () => {
        const { controller, img } = await mount();
        const before = { signal: controller.store.getState().signal, src: img.getAttribute("src") };
        controller.setPrefs({ active: false });
        controller.setPrefs({ active: true });
        expect(controller.store.getState().signal).toBe(before.signal);
        expect(img.getAttribute("src")).toBe(before.src);
    });
});
