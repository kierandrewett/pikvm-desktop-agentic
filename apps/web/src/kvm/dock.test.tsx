// Failure modes K1, K2, K4, K8, K10, K12, K13 in FAILURE_MODES.md.

import { createStore } from "@pikvm/kvm-engine";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ActionSections } from "./actions";
import { Dock, type DockProps } from "./dock";
import { createFieldFocus } from "./field-focus";
import type { PictureController, PictureState } from "./picture-controller";
import { openRig, renderWithSession } from "./test-support";

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

/** Only what the dock reads; the real controller needs a picture element and is covered by the end-to-end run. */
function stubController(initial: PictureState = idle) {
    const store = createStore(initial);
    const calls = { resetZoom: vi.fn(), toggleAudio: vi.fn(), toggleMic: vi.fn() };
    // A test double for a class-less object: the dock calls five methods and reads one store.
    const controller = {
        store,
        ...calls,
        bindMeter: () => () => {},
        setPrefs: () => {},
    } as unknown as PictureController;
    return { controller, store, calls };
}

const NO_ACTIONS: ActionSections = {
    tools: [{ id: "paste", label: "Paste text to the target\u2026", run: () => {} }],
    power: [],
    view: [{ id: "theme", label: "Toggle theme", run: () => {} }],
};

async function mount(over: Partial<DockProps> = {}, picture: PictureState = idle) {
    const rig = await openRig();
    const focus = createFieldFocus(rig.clock);
    const field = document.createElement("input");
    document.body.appendChild(field);
    focus.attach(field);
    const stub = stubController(picture);
    const props: DockProps = {
        controller: stub.controller,
        focus,
        actions: NO_ACTIONS,
        touchMode: "trackpad",
        touchHid: "abs",
        onTouchMode: vi.fn(),
        onTouchHid: vi.fn(),
        dragLock: false,
        onDragLock: vi.fn(),
        openDialog: vi.fn(),
        ...over,
    };
    renderWithSession(rig, <Dock {...props} />);
    return { rig, focus, field, props, ...stub };
}

describe("focus", () => {
    it("K1: a touch press on a dock key is held off, so the field keeps focus and the keyboard stays up", async () => {
        const { focus, field } = await mount();
        focus.focus();
        expect(document.activeElement).toBe(field);

        const key = screen.getByRole("button", { name: "Tab" });
        // dispatchEvent returns false when preventDefault was called: a touch press that is not
        // held off would move focus to the button and take the system keyboard down.
        const touch = fireEvent.pointerDown(key, { pointerType: "touch" });
        expect(touch).toBe(false);
        expect(fireEvent.mouseDown(key)).toBe(false);
        fireEvent.click(key);
        expect(document.activeElement).toBe(field);
    });

    it("K1: a real mouse press is not held off (it has no soft keyboard to protect)", async () => {
        await mount();
        expect(fireEvent.pointerDown(screen.getByRole("button", { name: "Tab" }), { pointerType: "mouse" })).toBe(true);
    });

    it("K2: a blur with no dock tap in front of it is the keyboard being put away; one right after a tap is not", async () => {
        const { focus, field, rig } = await mount();
        focus.focus();
        fireEvent.pointerDown(screen.getByRole("button", { name: "Escape" }), { pointerType: "touch" });
        field.blur();
        focus.refocus();
        expect(document.activeElement).toBe(field);

        rig.clock.advance(2000);
        field.blur();
        focus.refocus();
        expect(document.activeElement).not.toBe(field);
    });
});

describe("the sheet", () => {
    it("K4: opening it puts the keyboard away and replaces the key rows; Escape and an outside press close it, leaving the keyboard down", async () => {
        const { focus, field } = await mount();
        focus.focus();
        expect(screen.getByRole("group", { name: "Modifiers" })).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "More" }));
        expect(document.activeElement).not.toBe(field);
        expect(screen.getByRole("group", { name: "More", hidden: false })).toBeInTheDocument();
        expect(screen.queryByRole("group", { name: "Modifiers" })).toBeNull();
        expect(screen.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "true");

        fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.queryByRole("group", { name: "Mouse buttons" })).toBeNull();
        expect(screen.getByRole("group", { name: "Modifiers" })).toBeInTheDocument();
        expect(document.activeElement).not.toBe(field);

        fireEvent.click(screen.getByRole("button", { name: "More" }));
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole("group", { name: "Mouse buttons" })).toBeNull();
    });

    it("picking an action closes it; the touch settings are toggles and keep it open", async () => {
        const { props } = await mount();
        fireEvent.click(screen.getByRole("button", { name: "More" }));

        fireEvent.click(screen.getByRole("button", { name: "Touch input: trackpad" }));
        expect(props.onTouchMode).toHaveBeenCalledWith("direct");
        expect(screen.getByRole("group", { name: "Mouse buttons" })).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Toggle theme" }));
        expect(screen.queryByRole("group", { name: "Mouse buttons" })).toBeNull();
    });

    it("K10: trackpad mouse is offered only for the trackpad on a Pi with a relative output", async () => {
        const { rig } = await mount();
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        expect(screen.queryByRole("button", { name: /Trackpad mouse mode/ })).toBeNull();

        await act(async () => {
            rig.hub.last.serverMessage({ event_type: "hid", event: { mouse: { absolute: true, outputs: { available: ["usb", "usb_rel"], active: "usb" } } } });
            await rig.clock.settle();
        });
        expect(screen.getByRole("button", { name: "Trackpad mouse mode: absolute" })).toBeInTheDocument();
    });

    it("K10: with direct touch there is no trackpad mouse choice", async () => {
        const { rig } = await mount({ touchMode: "direct" });
        await act(async () => {
            rig.hub.last.serverMessage({ event_type: "hid", event: { mouse: { absolute: true, outputs: { available: ["usb", "usb_rel"], active: "usb" } } } });
            await rig.clock.settle();
        });
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        expect(screen.queryByRole("button", { name: /Trackpad mouse mode/ })).toBeNull();
        expect(screen.getByRole("button", { name: "Touch input: touch" })).toBeInTheDocument();
    });

    it("drag-lock is a toggle the sheet reports", async () => {
        const { props } = await mount();
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        const lock = screen.getByRole("button", { name: /Hold the left mouse button down/ });
        expect(lock).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(lock);
        expect(props.onDragLock).toHaveBeenCalledWith(true);
    });

    it("mouse buttons click through the link with a hold, and scroll steps by two", async () => {
        const { rig } = await mount();
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        fireEvent.click(screen.getByRole("button", { name: "R, right click" }));
        rig.clock.advance(100);
        expect(rig.sent()).toEqual(["button right:down", "button right:up"]);

        fireEvent.click(screen.getByRole("button", { name: "Scroll down" }));
        expect(rig.hub.last.commands().at(-1)).toMatchObject({ event_type: "mouse_wheel", event: { delta: { x: 0, y: -2 } } });
    });
});

describe("keys", () => {
    it("K8: Fn and More open one at a time", async () => {
        await mount();
        fireEvent.click(screen.getByRole("button", { name: "Fn" }));
        expect(screen.getByRole("group", { name: "Function keys" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "More keys" }));
        expect(screen.queryByRole("group", { name: "Function keys" })).toBeNull();
        expect(screen.getByRole("group", { name: "More keys and shortcuts" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "More keys" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "Fn" })).toHaveAttribute("aria-pressed", "false");
    });

    it("the keyboard button raises the field and says so", async () => {
        const { field } = await mount();
        const button = screen.getByRole("button", { name: "Keyboard" });
        expect(button).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(button);
        expect(document.activeElement).toBe(field);
        expect(button).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(button);
        expect(document.activeElement).not.toBe(field);
    });
});

describe("the bar", () => {
    it("K12: speaker and mic exist only while WebRTC carries audio, and follow its state", async () => {
        const { store, calls } = await mount();
        expect(screen.queryByRole("button", { name: "Audio output" })).toBeNull();

        act(() => store.setState({ ...idle, webrtc: true, audio: { available: true, audioOn: true, micOn: false, micLabel: "Off", micWarn: false } }));
        const speaker = screen.getByRole("button", { name: "Audio output" });
        const mic = screen.getByRole("button", { name: "Microphone" });
        expect(speaker).toHaveAttribute("aria-pressed", "true");
        expect(mic).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(speaker);
        fireEvent.click(mic);
        expect(calls.toggleAudio).toHaveBeenCalledTimes(1);
        expect(calls.toggleMic).toHaveBeenCalledTimes(1);

        act(() => store.setState({ ...idle, webrtc: true, audio: { available: true, audioOn: true, micOn: false, micLabel: "Denied", micWarn: true } }));
        expect(screen.getByRole("button", { name: "Microphone" })).toHaveAttribute("title", "Denied");

        act(() => store.setState(idle));
        expect(screen.queryByRole("button", { name: "Audio output" })).toBeNull();
    });

    it("K13: the zoom-out button exists only while zoomed, and pressing it resets the view", async () => {
        const { store, calls } = await mount();
        expect(screen.queryByRole("button", { name: "Zoom out to the whole screen" })).toBeNull();
        act(() => store.setState({ ...idle, scale: 2.5 }));
        fireEvent.click(screen.getByRole("button", { name: "Zoom out to the whole screen" }));
        expect(calls.resetZoom).toHaveBeenCalledTimes(1);
    });

    it("the dot and word say what the picture and the input are doing", async () => {
        const { rig } = await mount();
        expect(screen.getByRole("img", { name: "Live" })).toBeInTheDocument();
        await act(async () => {
            rig.hub.last.serverClose();
            await rig.clock.settle();
        });
        expect(screen.getByRole("img", { name: "Live \u00b7 input offline" })).toBeInTheDocument();
    });

    it("paste opens the paste dialog", async () => {
        const { props } = await mount();
        fireEvent.click(within(document.body).getByRole("button", { name: "Paste text to the target" }));
        expect(props.openDialog).toHaveBeenCalledWith("paste");
    });
});
