// Health indicator, device popouts and the key strip's edge fade (parity items 1.15, 1.10, 1.5).

import { createStore, createManualClock } from "@pikvm/kvm-engine";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionSections } from "./actions";
import { createFieldFocus } from "./field-focus";
import { KeyStrip } from "./key-rows";
import type { PictureController, PictureState } from "./picture-controller";
import { openRig, renderWithSession } from "./test-support";
import { Toolbar } from "./toolbar";

const idle: PictureState = {
    signal: "live",
    mode: "native",
    webrtc: false,
    scale: 1,
    audio: { available: false, audioOn: true, micOn: false, micLabel: "Off", micWarn: false },
    res: { text: "", av: "", show: false },
    fullUi: false,
    hasFrame: true,
    width: 1920,
    height: 1080,
};
const actions: ActionSections = { tools: [], power: [], view: [] };

function stub(initial: PictureState) {
    const store = createStore(initial);
    // A test double: the toolbar reads one store and calls bindMeter.
    const controller = { store, bindMeter: () => () => {}, resetZoom: () => {}, toggleAudio: () => {}, toggleMic: () => {} } as unknown as PictureController;
    return { store, controller };
}

afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
});

describe("health indicator", () => {
    it("is not drawn while nothing is wrong, and names the problem when something is", async () => {
        const rig = await openRig();
        const { controller } = stub(idle);
        const openDialog = vi.fn();
        renderWithSession(rig, <Toolbar controller={controller} actions={actions} openDialog={openDialog} keysOpen={false} onKeys={() => {}} />);
        expect(screen.queryByTestId("health")).toBeNull();

        await act(async () => {
            rig.hub.last.serverMessage({ event_type: "streamer", event: { streamer: { source: { online: false } } } });
            await rig.clock.settle();
        });
        const button = screen.getByTestId("health");
        expect(button).toHaveAttribute("title", "No video signal from the target");
        expect(button).toHaveClass("is-error");
        fireEvent.click(button);
        expect(openDialog).toHaveBeenCalledWith("health");
    });

    it("a dead input socket is the first thing it says (the screen is up but nothing typed arrives)", async () => {
        const rig = await openRig();
        const { controller } = stub(idle);
        renderWithSession(rig, <Toolbar controller={controller} actions={actions} openDialog={() => {}} keysOpen={false} onKeys={() => {}} />);
        await act(async () => {
            rig.hub.last.serverClose();
            await rig.clock.settle();
        });
        expect(screen.getByTestId("health").title.split("\n")[0]).toMatch(/input|keyboard/i);
    });
});

describe("audio device popouts", () => {
    function devices() {
        const list = [
            { kind: "audioinput", deviceId: "mic-a", label: "Desk mic" },
            { kind: "audioinput", deviceId: "default", label: "Default" },
            { kind: "audiooutput", deviceId: "spk-a", label: "Headset" },
        ];
        vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { mediaDevices: { enumerateDevices: async () => list, addEventListener: () => {}, removeEventListener: () => {} } }));
    }

    it("a chevron beside the mic lists the devices, follows the system by default, and pins a pick", async () => {
        devices();
        const rig = await openRig();
        const { controller } = stub({ ...idle, webrtc: true, audio: { ...idle.audio, available: true } });
        renderWithSession(rig, <Toolbar controller={controller} actions={actions} openDialog={() => {}} keysOpen={false} onKeys={() => {}} />);

        fireEvent.click(await screen.findByRole("button", { name: "Choose microphone" }));
        expect(screen.getByRole("button", { name: "Follow the system default" })).toHaveAttribute("aria-pressed", "true");
        // The OS alias is not a device.
        expect(screen.queryByRole("button", { name: "Default" })).toBeNull();
        fireEvent.click(await screen.findByRole("button", { name: "Desk mic" }));
        expect(JSON.parse(localStorage.getItem("pikvm-console-mic-device") ?? "{}")).toEqual({ id: "mic-a", label: "Desk mic" });
    });

    it("a pinned device that has gone is still listed, and says so", async () => {
        devices();
        localStorage.setItem("pikvm-console-mic-device", JSON.stringify({ id: "gone", label: "Old headset" }));
        const rig = await openRig();
        const { controller } = stub({ ...idle, webrtc: true, audio: { ...idle.audio, available: true } });
        renderWithSession(rig, <Toolbar controller={controller} actions={actions} openDialog={() => {}} keysOpen={false} onKeys={() => {}} />);
        fireEvent.click(await screen.findByRole("button", { name: "Choose microphone" }));
        await waitFor(() => expect(screen.getByRole("button", { name: "Old headset (not connected)" })).toBeInTheDocument());
    });
});

describe("key strip edge fade", () => {
    function strip(scroll: { width: number; client: number; left: number }) {
        const clock = createManualClock();
        const focus = createFieldFocus(clock);
        const proto = HTMLElement.prototype;
        vi.spyOn(proto, "scrollWidth", "get").mockReturnValue(scroll.width);
        vi.spyOn(proto, "clientWidth", "get").mockReturnValue(scroll.client);
        return { focus };
    }

    it("fades only the edge with more behind it", async () => {
        const rig = await openRig();
        const { focus } = strip({ width: 900, client: 400, left: 0 });
        renderWithSession(rig, <KeyStrip keyboard={rig.session.keyboard} focus={focus} dragLock={false} onDragLock={() => {}} />);
        const row = screen.getByRole("group", { name: "Controls" });
        expect(row).toHaveClass("more-after");
        expect(row).not.toHaveClass("more-before");

        Object.defineProperty(row, "scrollLeft", { configurable: true, value: 500 });
        fireEvent.scroll(row);
        expect(row).toHaveClass("more-before");
        expect(row).not.toHaveClass("more-after");
    });

    it("does not fade a row that fits", async () => {
        const rig = await openRig();
        const { focus } = strip({ width: 400, client: 400, left: 0 });
        renderWithSession(rig, <KeyStrip keyboard={rig.session.keyboard} focus={focus} dragLock={false} onDragLock={() => {}} />);
        const row = screen.getByRole("group", { name: "Controls" });
        expect(row).not.toHaveClass("more-after");
        expect(row).not.toHaveClass("more-before");
    });
});

void render;
