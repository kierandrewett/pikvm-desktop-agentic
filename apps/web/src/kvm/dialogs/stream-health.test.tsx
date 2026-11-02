// Failure modes 13-22 in FAILURE_MODES.md.

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { status } from "@pikvm/kvm-engine/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatchMedia } from "../../test/harness";
import type * as platform from "../platform";
import { HealthDialog } from "./health-dialog";
import { StreamDialog } from "./stream-dialog";
import { mountDialog, openRig, pi, type Rig } from "./test-rig";

const screenshot = vi.hoisted(() => ({ calls: 0, gate: null as null | { resolve: () => void; promise: Promise<void> } }));
vi.mock("../platform", async (importOriginal) => ({
    ...(await importOriginal<typeof platform>()),
    saveScreenshot: () => {
        screenshot.calls++;
        return screenshot.gate?.promise ?? Promise.resolve();
    },
}));

beforeEach(() => {
    installMatchMedia({ compact: false });
    screenshot.calls = 0;
    screenshot.gate = null;
});

const streamer = {
    features: { quality: true, resolution: true, h264: true },
    limits: {
        desired_fps: { min: 0, max: 70 },
        h264_bitrate: { min: 25, max: 20000 },
        h264_gop: { min: 0, max: 60 },
        available_resolutions: ["640x360", "1280x720"],
    },
    applied: { quality: 80, desired_fps: 30, resolution: "1280x720", h264_bitrate: 5000, h264_gop: 30 },
};

const posted = (rig: Rig) => rig.http.requests.map((r) => r.path);

describe("stream settings (13-16)", () => {
    async function mountStream() {
        const rig = await openRig();
        pi(rig, "streamer", streamer);
        const view = await mountDialog(StreamDialog, rig);
        return { rig, view };
    }

    it("13: the label follows the drag, the change is posted on release, once", async () => {
        const { rig } = await mountStream();
        const quality = screen.getByLabelText("Quality") as HTMLInputElement;
        expect(quality).toHaveValue("80");
        expect(quality).toHaveAttribute("aria-valuetext", "80%");
        fireEvent.input(quality, { target: { value: "60" } });
        fireEvent.input(quality, { target: { value: "55" } });
        expect(quality).toHaveAttribute("aria-valuetext", "55%");
        expect(screen.getByText("55%")).toBeInTheDocument();
        expect(rig.http.requests).toEqual([]);
        fireEvent.change(quality);
        expect(posted(rig)).toEqual(["/api/streamer/set_params?quality=55"]);
    });

    it("13: FPS reads 0 as unlimited, to the screen reader too", async () => {
        await mountStream();
        const fps = screen.getByLabelText("Target FPS");
        expect(fps).toHaveAttribute("aria-valuetext", "30 fps");
        fireEvent.input(fps, { target: { value: "0" } });
        expect(fps).toHaveAttribute("aria-valuetext", "unlimited");
    });

    it("14: a refused change says so and puts the control back to what the Pi has", async () => {
        const { rig } = await mountStream();
        rig.http.respond = () => status(409);
        const quality = screen.getByLabelText("Quality") as HTMLInputElement;
        fireEvent.input(quality, { target: { value: "60" } });
        fireEvent.change(quality);
        await waitFor(() =>
            expect(rig.session.notices.store.getState()).toMatchObject({ text: "Could not change the stream quality (409)", error: true }),
        );
        await waitFor(() => expect(quality).toHaveValue("80"));
        expect(screen.getByText("80%")).toBeInTheDocument();
    });

    it("14: a Pi event never rewrites the control the user is holding, and catches up afterwards", async () => {
        const { rig } = await mountStream();
        const quality = screen.getByLabelText("Quality") as HTMLInputElement;
        fireEvent.pointerDown(quality);
        fireEvent.input(quality, { target: { value: "40" } });
        pi(rig, "streamer", { applied: { quality: 90 } });
        expect(quality).toHaveValue("40");
        fireEvent.pointerUp(quality);
        pi(rig, "streamer", { applied: { quality: 70 } });
        await waitFor(() => expect(quality).toHaveValue("70"));
    });

    it("14: the resolution select posts the choice and shows only what the Pi applied", async () => {
        const { rig } = await mountStream();
        const select = screen.getByLabelText("Resolution") as HTMLSelectElement;
        expect(select).toHaveValue("1280x720");
        fireEvent.change(select, { target: { value: "640x360" } });
        expect(posted(rig)).toEqual(["/api/streamer/set_params?resolution=640x360"]);
        // Controlled by the Pi's applied value: no event means no change shown.
        await waitFor(() => expect(select).toHaveValue("1280x720"));
        pi(rig, "streamer", { applied: { resolution: "640x360" } });
        expect(select).toHaveValue("640x360");
    });

    it("15: rows the Pi cannot honour are absent and an empty form says so", async () => {
        const rig = await openRig();
        await mountDialog(StreamDialog, rig);
        expect(screen.getByText("The Pi has not reported any adjustable stream settings.")).toBeInTheDocument();
        pi(rig, "streamer", { features: { quality: true }, limits: {}, applied: { quality: 50, desired_fps: 10 } });
        expect(screen.getByLabelText("Quality")).toBeInTheDocument();
        expect(screen.getByLabelText("Target FPS")).toBeInTheDocument();
        expect(screen.queryByLabelText("H264 bitrate")).toBeNull();
        expect(screen.queryByLabelText("Resolution")).toBeNull();
        expect(screen.queryByText(/not reported any adjustable/)).toBeNull();
    });

    it("16: Reset stream asks first; Cancel sends nothing, Confirm resets and says so", async () => {
        const { rig } = await mountStream();
        fireEvent.click(screen.getByRole("button", { name: "Reset stream" }));
        const ask = screen.getByRole("alertdialog", { name: "Reset the stream?" });
        expect(rig.http.requests).toEqual([]);
        fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
        expect(rig.http.requests).toEqual([]);
        fireEvent.click(screen.getByRole("button", { name: "Reset stream" }));
        fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Reset stream" }));
        await waitFor(() => expect(posted(rig)).toEqual(["/api/streamer/reset"]));
        await waitFor(() => expect(rig.session.notices.store.getState().text).toBe("Stream reset"));
    });

    it("Save screenshot runs once however fast it is tapped", async () => {
        await mountStream();
        const gate = Promise.withResolvers<void>();
        screenshot.gate = gate;
        const button = screen.getByRole("button", { name: "Save screenshot" });
        fireEvent.click(button);
        fireEvent.click(button);
        fireEvent.click(button);
        expect(screenshot.calls).toBe(1);
        expect(button).toBeDisabled();
        await act(async () => gate.resolve());
        await waitFor(() => expect(button).toBeEnabled());
    });
});

describe("system dialog (17-22)", () => {
    const gpioFrame = {
        model: {
            scheme: {
                outputs: {
                    relay0: { switch: true, pulse: { max_delay: 10 } },
                    __v4_locator__: { switch: true, pulse: { max_delay: 0 } },
                },
            },
        },
        state: { outputs: { relay0: { online: true, state: false, busy: false }, __v4_locator__: { online: true, state: false } } },
    };

    async function mountHealth(frames: Array<[string, unknown]> = []) {
        const rig = await openRig();
        for (const [type, event] of frames) pi(rig, type, event);
        const view = await mountDialog(HealthDialog, rig);
        return { rig, view };
    }

    it("17: says nothing is reported until the Pi has spoken, then that all is fine", async () => {
        const { rig } = await mountHealth();
        expect(screen.getByText("Nothing reported from the PiKVM yet.")).toBeInTheDocument();
        pi(rig, "hid", { online: true, connected: true });
        expect(screen.getByText("Everything looks fine.")).toBeInTheDocument();
        expect(screen.queryByText("Nothing reported from the PiKVM yet.")).toBeNull();
    });

    it("18: lists input not reaching the Pi first, with its level in words", async () => {
        const { rig } = await mountHealth([["hid", { online: true, connected: true }], ["streamer", { streamer: { source: { online: false } } }]]);
        expect(screen.queryByRole("list", { name: "Problems" })?.textContent).toBe("No video signal from the target");
        act(() => rig.hub.last.serverClose());
        const items = within(screen.getByRole("list", { name: "Problems" })).getAllByRole("listitem");
        expect(items.map((i) => i.getAttribute("aria-label"))).toEqual([
            "Error: Keyboard and mouse input is not reaching the PiKVM",
            "Error: No video signal from the target",
        ]);
    });

    it("19: Detach on an attached board, disabled while unknown or busy", async () => {
        const { rig } = await mountHealth();
        expect(screen.getByTestId("hid-state")).toHaveTextContent("state unknown");
        expect(screen.getByRole("button", { name: "Attach" })).toBeDisabled();
        pi(rig, "hid", { online: true });
        expect(screen.getByTestId("hid-state")).toHaveTextContent("attached");
        fireEvent.click(screen.getByRole("button", { name: "Detach" }));
        await waitFor(() => expect(posted(rig)).toEqual(["/api/hid/set_connected?connected=0"]));
        expect(rig.session.notices.store.getState().text).toBe("Detaching the keyboard and mouse\u2026");
        pi(rig, "hid", { busy: true });
        expect(screen.getByRole("button", { name: "Detach" })).toBeDisabled();
        expect(screen.getByTestId("hid-state")).toHaveTextContent("attached \u00b7 busy");
    });

    it("19: Reset keyboard and mouse asks first", async () => {
        const { rig } = await mountHealth([["hid", { online: true, connected: true }]]);
        fireEvent.click(screen.getByRole("button", { name: "Reset" }));
        expect(rig.http.requests).toEqual([]);
        fireEvent.click(within(screen.getByRole("alertdialog", { name: "Reset the keyboard and mouse?" })).getByRole("button", { name: "Reset" }));
        await waitFor(() => expect(posted(rig)).toEqual(["/api/hid/reset"]));
    });

    it("20: a GPIO switch asks first, then toggles through kvmd", async () => {
        const { rig } = await mountHealth([["gpio", gpioFrame]]);
        const sw = screen.getByRole("switch", { name: "relay0" });
        expect(sw).toHaveAttribute("aria-checked", "false");
        fireEvent.click(sw);
        const ask = screen.getByRole("alertdialog", { name: "Turn \u201crelay0\u201d on?" });
        expect(within(ask).getByText("The console cannot tell what this output is wired to.")).toBeInTheDocument();
        expect(rig.http.requests).toEqual([]);
        fireEvent.click(within(ask).getByRole("button", { name: "Turn on" }));
        await waitFor(() => expect(posted(rig)).toEqual(["/api/gpio/switch?channel=relay0&state=1"]));
        pi(rig, "gpio", { state: { outputs: { relay0: { online: true, state: true } } } });
        expect(screen.getByRole("switch", { name: "relay0" })).toHaveAttribute("aria-checked", "true");
        expect(screen.getByRole("switch", { name: "relay0" })).toHaveTextContent("On");
    });

    it("20: Pulse asks, naming a power button press; Cancel sends nothing", async () => {
        const { rig } = await mountHealth([["gpio", gpioFrame]]);
        fireEvent.click(screen.getByRole("button", { name: "Pulse relay0" }));
        const ask = screen.getByRole("alertdialog", { name: "Pulse \u201crelay0\u201d?" });
        expect(within(ask).getByText(/press of it/)).toBeInTheDocument();
        fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
        expect(rig.http.requests).toEqual([]);
    });

    it("20: the locator LED needs no question, and two quick taps send one request", async () => {
        const { rig } = await mountHealth([["gpio", gpioFrame]]);
        const gate = Promise.withResolvers<{ ok: boolean; status: number }>();
        rig.http.respond = () => gate.promise;
        const locator = screen.getByRole("switch", { name: "Locator LED" });
        fireEvent.click(locator);
        fireEvent.click(locator);
        await waitFor(() => expect(posted(rig)).toEqual(["/api/gpio/switch?channel=__v4_locator__&state=1"]));
        // Guarded, not disabled: focus stays on the control.
        expect(locator).toHaveAttribute("aria-disabled", "true");
        locator.focus();
        gate.resolve(status(200));
        await waitFor(() => expect(locator).toHaveAttribute("aria-disabled", "false"));
        expect(locator).toHaveFocus();
    });

    it("20: the USB breaker carries its own warning", async () => {
        const { rig } = await mountHealth([
            ["gpio", { model: { scheme: { outputs: { __v3_usb_breaker__: { switch: true } } } }, state: { outputs: { __v3_usb_breaker__: { online: true, state: true } } } }],
        ]);
        fireEvent.click(screen.getByRole("switch", { name: "USB power to the target" }));
        expect(screen.getByText("The keyboard, mouse and any mounted image disconnect.")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
        await waitFor(() => expect(posted(rig)).toEqual(["/api/gpio/switch?channel=__v3_usb_breaker__&state=0"]));
    });

    it("21: offline and busy outputs say which, and are disabled", async () => {
        await mountHealth([
            [
                "gpio",
                {
                    model: { scheme: { outputs: { a: { switch: true }, b: { switch: true } } } },
                    state: { outputs: { a: { online: false }, b: { online: true, busy: true } } },
                },
            ],
        ]);
        expect(screen.getByTestId("gpio-a")).toHaveTextContent("offline");
        expect(screen.getByTestId("gpio-b")).toHaveTextContent("busy");
        expect(screen.getByRole("switch", { name: "a" })).toBeDisabled();
        expect(screen.getByRole("switch", { name: "b" })).toBeDisabled();
    });

    it("22: ATX LEDs read as text, Reset asks first and presses through kvmd", async () => {
        const { rig } = await mountHealth([["atx", { enabled: true, busy: false, leds: { power: true, hdd: false } }]]);
        expect(screen.getByTestId("atx-power-led")).toHaveTextContent("Power on");
        expect(screen.getByText("Drive idle")).toBeInTheDocument();
        fireEvent.click(within(screen.getByTestId("atx-section")).getByRole("button", { name: "Reset" }));
        const ask = screen.getByRole("alertdialog", { name: "Press the reset button?" });
        expect(rig.http.requests).toEqual([]);
        fireEvent.click(within(ask).getByRole("button", { name: "Reset" }));
        await waitFor(() => expect(posted(rig)).toEqual(["/api/atx/click?button=reset"]));
    });

    it("22: no ATX section without wiring; the mass-storage state opens its dialog", async () => {
        const { rig } = await mountHealth([["msd", { enabled: true, online: true, busy: false, drive: { image: null, cdrom: true, connected: false }, storage: {} }]]);
        expect(screen.queryByTestId("atx-section")).toBeNull();
        expect(screen.getByTestId("msd-state")).toHaveTextContent("No image selected.");
        fireEvent.click(screen.getByRole("button", { name: "Open mass storage" }));
        expect(rig.session.dialogs.store.getState().open).toBe("msd");
    });

    it("shows the About line, selectable text", async () => {
        await mountHealth([["info", { node: { hostname: "kvm1" }, system: { kvmd: { version: "4.1" } } }]]);
        expect(screen.getByTestId("about-line")).toHaveTextContent("kvm1 \u00b7 kvmd 4.1");
    });
});
