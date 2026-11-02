// Failure modes 41-42 in FAILURE_MODES.md, and the seam: every dialog the screen can open is registered.

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatchMedia } from "../../test/harness";
import { MIC_DEVICE_KEY, OUT_DEVICE_KEY } from "../../settings/local-prefs";
import { onAudioDevicesChanged } from "../audio-devices-event";
import { DIALOG_NAMES, dialogFor } from "../dialog-seam";
import { AudioDevicesDialog } from "./audio-devices-dialog";
import { registerKvmDialogs } from "./index";
import { mountDialog } from "./test-rig";

function stubDevices(devices: Array<Partial<MediaDeviceInfo> & { kind: MediaDeviceKind; deviceId: string }>): void {
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
            enumerateDevices: () => Promise.resolve(devices.map((d) => ({ label: "", groupId: "", toJSON: () => ({}), ...d }))),
            getUserMedia: () => Promise.reject(new Error("no")),
            addEventListener: () => {},
            removeEventListener: () => {},
        },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: () => Promise.resolve() });
}

beforeEach(() => {
    installMatchMedia({ compact: false });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("audio devices (41, 42)", () => {
    const mic1 = { kind: "audioinput" as const, deviceId: "mic-1", label: "USB mic" };
    const alias = { kind: "audioinput" as const, deviceId: "default", label: "Default" };
    const out1 = { kind: "audiooutput" as const, deviceId: "out-1", label: "Speakers" };

    it("41: never offers the OS aliases, and 'follow the default' is the first choice", async () => {
        stubDevices([alias, mic1, out1]);
        await mountDialog(AudioDevicesDialog);
        await screen.findByRole("option", { name: "USB mic" });
        const options = Array.from((screen.getByLabelText("Microphone") as HTMLSelectElement).options).map((o) => o.textContent);
        expect(options).toEqual(["Follow the system default", "USB mic"]);
    });

    it("41: a pinned device that has gone is NAMED as gone, and stays the selection", async () => {
        localStorage.setItem(MIC_DEVICE_KEY, JSON.stringify({ id: "headset", label: "Headset" }));
        stubDevices([mic1, out1]);
        await mountDialog(AudioDevicesDialog);
        const select = screen.getByLabelText("Microphone") as HTMLSelectElement;
        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The microphone you chose (Headset) is not connected."));
        expect(select).toHaveValue("headset");
        expect(screen.getByRole("option", { name: "Headset (not connected)" })).toBeInTheDocument();
    });

    it("42: choosing writes the choice with its label and tells the live stream", async () => {
        stubDevices([mic1, out1]);
        const heard = vi.fn();
        const off = onAudioDevicesChanged(heard);
        await mountDialog(AudioDevicesDialog);
        await screen.findByRole("option", { name: "USB mic" });
        fireEvent.change(screen.getByLabelText("Microphone"), { target: { value: "mic-1" } });
        expect(JSON.parse(localStorage.getItem(MIC_DEVICE_KEY) ?? "null")).toEqual({ id: "mic-1", label: "USB mic" });
        expect(heard).toHaveBeenCalledTimes(1);
        fireEvent.change(screen.getByLabelText("Audio output"), { target: { value: "out-1" } });
        expect(JSON.parse(localStorage.getItem(OUT_DEVICE_KEY) ?? "null")).toEqual({ id: "out-1", label: "Speakers" });
        fireEvent.change(screen.getByLabelText("Microphone"), { target: { value: "" } });
        expect(localStorage.getItem(MIC_DEVICE_KEY)).toBeNull();
        expect(heard).toHaveBeenCalledTimes(3);
        off();
    });

    it("a browser that will not list devices says both follow the default", async () => {
        Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
        await mountDialog(AudioDevicesDialog);
        expect(screen.getByText(/will not list audio devices/)).toBeInTheDocument();
        expect(screen.getByLabelText("Microphone")).toBeDisabled();
    });
});

describe("the seam", () => {
    it("registers a real dialog for every name the screen can open", () => {
        registerKvmDialogs();
        for (const name of DIALOG_NAMES) expect(dialogFor(name), name).toBeDefined();
    });
});
