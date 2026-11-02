// Failure modes K3, K5, K10, K11, K16, K17 in FAILURE_MODES.md, through the whole screen.

import { macroDuration, type MacroLike } from "@pikvm/kvm-engine";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultServer, installFakeServer, installViewport, type ServerState } from "../test/harness";
import { PasteDialog, UnavailableDialog } from "./dialog-defaults";
import { registerDialog, type DialogProps } from "./dialog-seam";
import { KvmScreen } from "./kvm-screen";
import { DOCK_QUERY } from "./platform";
import { hidFrame, openRig, renderWithSession, type Rig } from "./test-support";

function stubMedia(dock: boolean): void {
    vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
            matches: query === DOCK_QUERY ? dock : false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
            onchange: null,
        })),
    );
}

let server: ServerState;
beforeEach(() => {
    server = defaultServer();
    installFakeServer(server);
    installViewport();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

async function mount(options: { dock: boolean; macros?: ServerState["macros"] }): Promise<Rig> {
    if (options.macros) server.macros = options.macros;
    stubMedia(options.dock);
    const rig = await openRig();
    renderWithSession(rig, <KvmScreen />);
    // The screen starts the session itself; the rig already opened its socket, so start is a no-op.
    await act(async () => {
        await rig.clock.settle();
    });
    return rig;
}

const field = (): HTMLInputElement => {
    const el = document.querySelector<HTMLInputElement>(".kvm-kbd");
    if (!el) throw new Error("the hidden field is missing");
    return el;
};

describe("layout", () => {
    it("a computer gets the toolbar and no dock", async () => {
        await mount({ dock: false });
        expect(screen.getByRole("button", { name: "Send keys" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Keyboard" })).toBeNull();
        expect(document.querySelector(".kvm-screen")).toHaveAttribute("data-layout", "wide");
    });

    it("a phone gets the dock and no toolbar", async () => {
        await mount({ dock: true });
        expect(screen.getByRole("button", { name: "Keyboard" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Send keys" })).toBeNull();
        expect(document.querySelector(".kvm-screen")).toHaveAttribute("data-layout", "dock");
    });

    it("the picture is an <img> with the video and held frame beside it, all inside one pane", async () => {
        await mount({ dock: false });
        const pane = screen.getByTestId("kvm-pane");
        expect(pane.querySelector("img.kvm-img")).not.toBeNull();
        expect(pane.querySelector("video.kvm-video")).not.toBeNull();
        expect(pane.querySelector("canvas.kvm-freeze")).not.toBeNull();
        // Nothing has arrived yet, so the overlay says a picture is coming.
        expect(within(pane).getByText("Connecting")).toBeInTheDocument();
    });
});

describe("the hidden field", () => {
    it("K3: is uncontrolled, so re-rendering the screen never touches what was typed into it", async () => {
        const rig = await mount({ dock: true });
        field().value = "typed";
        act(() => rig.session.dialogs.open("log"));
        act(() => rig.session.dialogs.close());
        expect(field().value).toBe("typed");
    });

    it("K5: a dialog owns the keyboard: typing into the field reaches nobody, and modifiers the target holds are let go", async () => {
        const rig = await mount({ dock: true });
        rig.session.keyboard.modifiers.press("ControlLeft");
        expect(rig.sent()).toEqual(["key ControlLeft:down"]);

        act(() => rig.session.dialogs.open("log"));
        expect(rig.sent()).toEqual(["key ControlLeft:down", "key ControlLeft:up"]);

        const before = rig.sent().length;
        field().value = "\u200b\u200b\u200b\u200bhello";
        fireEvent.input(field());
        rig.clock.advance(5000);
        expect(rig.sent()).toHaveLength(before);
    });
});

describe("dialogs", () => {
    function Probe({ onClose }: DialogProps) {
        return (
            <div role="dialog" aria-label="Probe">
                <button onClick={onClose}>Done</button>
            </div>
        );
    }

    it("K16: opening a name renders what is registered under it, the last registration wins, and it closes", async () => {
        const rig = await mount({ dock: false });
        registerDialog("log", () => <div role="dialog" aria-label="First" />);
        registerDialog("log", Probe);
        act(() => rig.session.dialogs.open("log"));
        expect(screen.getByRole("dialog", { name: "Probe" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("K16: a name with nothing real behind it still opens a labelled dialog that closes on Escape", async () => {
        const rig = await mount({ dock: false });
        // Every name has a real dialog registered now, so put the stand-in back for one of them.
        registerDialog("log", (props) => <UnavailableDialog name="log" {...props} />);
        act(() => rig.session.dialogs.open("log"));
        const dialog = screen.getByRole("dialog", { name: "PiKVM log" });
        expect(within(dialog).getByText("This is not available in this build.")).toBeInTheDocument();
        fireEvent.keyDown(dialog, { key: "Escape" });
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("the dock's paste button opens the paste dialog", async () => {
        await mount({ dock: true });
        fireEvent.click(screen.getByRole("button", { name: "Paste text to the target" }));
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
});

describe("touch settings", () => {
    it("K10: are stored under the console's own keys, and the trackpad one follows the Pi's mouse mode", async () => {
        const rig = await mount({ dock: true });
        await act(async () => {
            rig.hub.last.serverMessage(hidFrame({ mouse: { absolute: true, outputs: { available: ["usb", "usb_rel"], active: "usb" } } }));
            await rig.clock.settle();
        });
        fireEvent.click(screen.getByRole("button", { name: "More" }));

        fireEvent.click(screen.getByRole("button", { name: "Touch input: trackpad" }));
        expect(localStorage.getItem("pikvm-touch-mode")).toBe("direct");
        expect(screen.getByRole("button", { name: "Touch input: touch" })).toBeInTheDocument();
        // Direct touch is always absolute: no choice to make.
        expect(screen.queryByRole("button", { name: /Trackpad mouse mode/ })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Touch input: touch" }));
        fireEvent.click(screen.getByRole("button", { name: "Trackpad mouse mode: absolute" }));
        expect(localStorage.getItem("pikvm-touch-hid")).toBe("rel");
    });
});

describe("macros", () => {
    const macro: MacroLike & { id: string; pinned: boolean } = {
        id: "m1",
        label: "Run box",
        icon: "terminal",
        pinned: true,
        steps: [
            { type: "chord", mods: ["MetaLeft"], code: "KeyR" },
            { type: "delay", ms: 200 },
            { type: "text", text: "calc" },
        ],
    };

    it("K11: a pinned macro runs through the engine's runner, then the tiles grey while it plays", async () => {
        const rig = await mount({ dock: true, macros: [macro] });
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        const tile = await screen.findByRole("button", { name: "Run box" });
        expect(tile).toBeEnabled();

        fireEvent.click(tile);
        await waitFor(() => expect(rig.session.gate.store.getState().macro).toBe("Run box"));
        // The sheet closed on the pick; opening it again shows the tile greyed.
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        expect(await screen.findByRole("button", { name: "Run box" })).toBeDisabled();

        await act(async () => {
            await rig.clock.advanceAsync(macroDuration(macro) + 1000);
        });
        await waitFor(() => expect(screen.getByRole("button", { name: "Run box" })).toBeEnabled());
        expect(rig.sent()).toEqual(["key MetaLeft:down", "key KeyR:down", "key KeyR:up", "key MetaLeft:up"]);
        expect(rig.http.requests.map((r) => r.path)).toEqual(["/api/hid/print?limit=0&delay=0.02"]);
    });

    it("K11: with the HID socket down a macro with key steps cannot be started, and says nothing it cannot do", async () => {
        const rig = await mount({ dock: true, macros: [macro] });
        await act(async () => {
            rig.hub.last.serverClose();
            await rig.clock.settle();
        });
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        expect(await screen.findByRole("button", { name: "Run box" })).toBeDisabled();
    });

    it("K11: a text-only macro still works with the socket down (it goes over HTTP)", async () => {
        const textOnly: MacroLike & { id: string; pinned: boolean } = { ...macro, id: "m2", label: "Say hi", steps: [{ type: "text", text: "hi" }] };
        const rig = await mount({ dock: true, macros: [textOnly] });
        await act(async () => {
            rig.hub.last.serverClose();
            await rig.clock.settle();
        });
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        expect(await screen.findByRole("button", { name: "Say hi" })).toBeEnabled();
    });
});

describe("the Pi's own UI", () => {
    it("is framed over the picture from the sheet, takes the keyboard from the target, and gives the console back", async () => {
        const rig = await mount({ dock: true });
        rig.session.keyboard.modifiers.press("ShiftLeft");
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        fireEvent.click(screen.getByRole("button", { name: "Full PiKVM UI" }));

        const frame = screen.getByTitle("Full PiKVM UI");
        expect(frame).toHaveAttribute("src", "/?native=1");
        // Two things must never type at the target at once.
        expect(rig.sent()).toContain("key ShiftLeft:up");

        fireEvent.click(within(frame.parentElement as HTMLElement).getByRole("button", { name: "Back to console" }));
        expect(screen.queryByTitle("Full PiKVM UI")).toBeNull();
    });
});

describe("host paste", () => {
    function clipboard(text: string | Error): void {
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { readText: () => (text instanceof Error ? Promise.reject(text) : Promise.resolve(text)) },
        });
    }

    it("Ctrl+V types the host clipboard on the target instead of forwarding the chord", async () => {
        clipboard("from the host");
        const rig = await mount({ dock: false });
        const proceed = fireEvent.keyDown(field(), { key: "v", code: "KeyV", ctrlKey: true });
        expect(proceed).toBe(false);
        await waitFor(() => expect(rig.http.requests).toHaveLength(1));
        expect(rig.http.requests[0]).toMatchObject({ path: "/api/hid/print?limit=0&delay=0.02", body: "from the host" });
        rig.clock.advance(1000);
        expect(rig.sent()).toEqual([]);
    });

    it("says so when the clipboard cannot be read or is empty, and sends nothing", async () => {
        clipboard(new Error("denied"));
        const rig = await mount({ dock: false });
        fireEvent.keyDown(field(), { key: "v", code: "KeyV", metaKey: true });
        await waitFor(() => expect(rig.session.notices.store.getState().text).toBe("Could not read the host clipboard"));

        clipboard("");
        fireEvent.keyDown(field(), { key: "v", code: "KeyV", ctrlKey: true });
        await waitFor(() => expect(rig.session.notices.store.getState().text).toBe("Host clipboard is empty"));
        expect(rig.http.requests).toHaveLength(0);
    });
});

describe("paste dialog", () => {
    async function paste() {
        const rig = await openRig();
        const onClose = vi.fn();
        renderWithSession(rig, <PasteDialog session={rig.session} onClose={onClose} />);
        return { rig, onClose };
    }

    it("K17: nothing to send is not sendable; sending closes at once and the engine types it with the chosen keymap", async () => {
        const { rig, onClose } = await paste();
        const send = screen.getByRole("button", { name: "Type on target" });
        expect(send).toBeDisabled();

        fireEvent.change(screen.getByLabelText("Text to type on the target"), { target: { value: "hello" } });
        expect(send).toBeEnabled();
        expect(screen.getByText("5 characters")).toBeInTheDocument();
        fireEvent.click(send);

        expect(onClose).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(rig.http.requests).toHaveLength(1));
        expect(rig.http.requests[0]).toMatchObject({ method: "POST", path: "/api/hid/print?limit=0&delay=0.02", body: "hello", contentType: "text/plain" });
    });

    it("K17: Ctrl+Enter sends", async () => {
        const { rig } = await paste();
        const box = screen.getByLabelText("Text to type on the target");
        fireEvent.change(box, { target: { value: "x" } });
        fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
        await waitFor(() => expect(rig.http.requests).toHaveLength(1));
    });

    it("K17: the paster refuses while a macro holds the target, and says why", async () => {
        const { rig } = await paste();
        rig.session.gate.beginMacro("Run box");
        fireEvent.change(screen.getByLabelText("Text to type on the target"), { target: { value: "x" } });
        fireEvent.keyDown(screen.getByLabelText("Text to type on the target"), { key: "Enter", metaKey: true });
        await waitFor(() => expect(rig.session.notices.store.getState().text).toBe("Run box is still running"));
        expect(rig.http.requests).toHaveLength(0);
    });
});

describe("screen-change alerts", () => {
    const ITEM = "Alert me when the screen changes";

    afterEach(() => {
        localStorage.removeItem("pikvm-console-screen-alerts");
    });

    it("A browser on a computer offers the switch in More, starting off, and the choice is stored", async () => {
        const request = vi.fn(async () => "granted");
        vi.stubGlobal("Notification", { permission: "default", requestPermission: request });
        await mount({ dock: false });
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        const item = screen.getByRole("button", { name: ITEM });
        expect(item).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(item);
        expect(localStorage.getItem("pikvm-console-screen-alerts")).toBe("on");
        expect(request).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        expect(screen.getByRole("button", { name: ITEM })).toHaveAttribute("aria-pressed", "true");
    });

    it("A phone is not offered it: the page is suspended behind another app", async () => {
        await mount({ dock: true });
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        expect(screen.getByRole("button", { name: "Save screenshot" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: ITEM })).toBeNull();
    });
});
