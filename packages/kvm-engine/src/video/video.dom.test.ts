// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoDriver } from "./driver";
import { createVideoDom } from "./video.dom";
import type { VideoEventInit } from "./types";

// Failure modes R1 and R2 in FAILURE_MODES.md: every way the page learns it was away reaches the machine.

function setup() {
    const pane = document.createElement("div");
    const img = document.createElement("img");
    const video = document.createElement("video");
    const sent: VideoEventInit[] = [];
    const driver = { send: (e: VideoEventInit) => void sent.push(e) } as unknown as VideoDriver;
    const dom = createVideoDom({ elements: { pane, img, video } });
    const detach = dom.attach(driver);
    return { sent, detach, video };
}

let hidden = false;
function setHidden(next: boolean): void {
    hidden = next;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}
const pageshow = (persisted: boolean): void => {
    const e = new Event("pageshow");
    Object.defineProperty(e, "persisted", { value: persisted });
    window.dispatchEvent(e);
};

afterEach(() => setHidden(false));

describe("the page's lifecycle reaches the machine", () => {
    it("R1: visibility, focus, the Page Lifecycle resume and a persisted pageshow, each with what document.hidden reads", () => {
        const { sent, detach } = setup();
        setHidden(true);
        document.dispatchEvent(new Event("visibilitychange"));
        setHidden(false);
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("resume"));
        pageshow(true);
        expect(sent).toEqual([
            { type: "visibility", hidden: true },
            { type: "visibility", hidden: false },
            { type: "resume", reason: "focus", hidden: false },
            { type: "resume", reason: "resume", hidden: false },
            { type: "resume", reason: "pageshow", hidden: false },
        ]);
        detach();
    });

    it("R1: a pageshow that is only the first load is not a return", () => {
        const { sent, detach } = setup();
        pageshow(false);
        expect(sent).toEqual([]);
        detach();
    });

    it("R2: freeze and pagehide say the page is going, so the time away has a start even if hidden never comes", () => {
        const { sent, detach } = setup();
        document.dispatchEvent(new Event("freeze"));
        window.dispatchEvent(new Event("pagehide"));
        expect(sent).toEqual([{ type: "freeze" }, { type: "freeze" }]);
        detach();
    });

    it("a focus while the document is hidden reports hidden, so the machine can ignore it", () => {
        const { sent, detach } = setup();
        setHidden(true);
        window.dispatchEvent(new Event("focus"));
        expect(sent).toEqual([{ type: "resume", reason: "focus", hidden: true }]);
        detach();
    });

    it("Safari pauses a playing <video> in the background: coming back starts it again", () => {
        const { video, detach } = setup();
        const play = vi.fn(() => Promise.resolve());
        Object.defineProperty(video, "paused", { configurable: true, get: () => true });
        Object.defineProperty(video, "srcObject", { configurable: true, get: () => ({}) });
        video.play = play;
        setHidden(false);
        document.dispatchEvent(new Event("visibilitychange"));
        expect(play).toHaveBeenCalledOnce();
        detach();
    });

    it("detaching removes every listener", () => {
        const { sent, detach } = setup();
        detach();
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("freeze"));
        pageshow(true);
        expect(sent).toEqual([]);
    });
});
