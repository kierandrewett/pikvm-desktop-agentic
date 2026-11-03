// Failure modes 32-40 in FAILURE_MODES.md.

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatchMedia } from "../../test/harness";
import { MACRO_ICON_NAMES } from "../macro-icon";
import { MacrosDialog } from "./macros-dialog";
import { resetMacroSaveChainForTests } from "./use-macro-editor";
import { jsonResponse, mountDialog, openRig, stubFetch, type Mounted } from "./test-rig";

interface WireMacro {
    id: string;
    label: string;
    icon?: string;
    pinned?: boolean;
    steps: unknown[];
}

interface MacroServer {
    macros: WireMacro[];
    puts: WireMacro[][];
    /** Answer PUTs with this status (and `{error}` body) instead of storing. */
    failWith: number | null;
    /** Hold PUT answers until this resolves. */
    hold: Promise<void> | null;
}

function serveMacros(initial: WireMacro[]): MacroServer {
    const server: MacroServer = { macros: initial, puts: [], failWith: null, hold: null };
    stubFetch({
        "/app/api/v1/macros": async (req) => {
            if (req.method !== "PUT") return jsonResponse({ macros: server.macros });
            const body = JSON.parse(req.body ?? "{}") as { macros?: WireMacro[] } | WireMacro[];
            const list = Array.isArray(body) ? body : (body.macros ?? []);
            server.puts.push(list);
            await server.hold;
            if (server.failWith !== null) return jsonResponse({ error: "disk full" }, server.failWith);
            server.macros = list;
            return jsonResponse({ macros: list });
        },
    });
    return server;
}

const chord = (code: string, mods: string[] = []) => ({ type: "chord", mods, code });
const reboot: WireMacro = { id: "reboot", label: "Reboot", icon: "power", steps: [chord("KeyR", ["ControlLeft"])] };
const login: WireMacro = { id: "login", label: "Login", pinned: false, steps: [{ type: "text", text: "admin" }, chord("Tab"), { type: "delay", ms: 250 }] };

beforeEach(() => {
    installMatchMedia({ compact: false });
    resetMacroSaveChainForTests();
});

afterEach(() => {
    // Unmount while the stubs are still in place: a component leaving reads matchMedia.
    cleanup();
    vi.unstubAllGlobals();
});

async function mountMacros(initial: WireMacro[]): Promise<{ server: MacroServer; view: Mounted }> {
    const server = serveMacros(initial);
    const view = await mountDialog(MacrosDialog);
    await screen.findByRole("group", { name: "Saved macros" });
    await waitFor(() => expect(screen.queryByText("Loading")).toBeNull());
    return { server, view };
}

const lastPut = (server: MacroServer): WireMacro[] => server.puts[server.puts.length - 1] ?? [];
/** The `code` of each chord step, in order. */
const codesOf = (steps: unknown[]): unknown[] => steps.map((s) => (typeof s === "object" && s !== null && "code" in s ? s.code : undefined));
const nameField = () => screen.getByLabelText("Name") as HTMLInputElement;

describe("macro list and editor", () => {
    it("lists the stored macros with the first selected", async () => {
        await mountMacros([reboot, login]);
        const list = screen.getByRole("group", { name: "Saved macros" });
        expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual(["Reboot", "Login"]);
        expect(within(list).getByRole("button", { name: "Reboot" })).toHaveAttribute("aria-current", "true");
        expect(nameField()).toHaveValue("Reboot");
        fireEvent.click(within(list).getByRole("button", { name: "Login" }));
        expect(within(list).getByRole("button", { name: "Login" })).toHaveAttribute("aria-current", "true");
        expect(within(list).getByRole("button", { name: "Reboot" })).not.toHaveAttribute("aria-current");
        expect(nameField()).toHaveValue("Login");
    });

    it("with none stored it says how to make one", async () => {
        await mountMacros([]);
        expect(screen.getByText("No macros yet.")).toBeInTheDocument();
        expect(screen.getByText("Use New macro to add one.")).toBeInTheDocument();
    });

    it("39: a new name is saved when the field is left, and an empty one becomes 'Macro'", async () => {
        const { server } = await mountMacros([reboot]);
        const name = nameField();
        await userEvent.clear(name);
        await userEvent.type(name, "Restart now");
        expect(server.puts).toEqual([]);
        fireEvent.blur(name);
        await waitFor(() => expect(lastPut(server)[0]?.label).toBe("Restart now"));
        await userEvent.clear(name);
        fireEvent.blur(name);
        await waitFor(() => expect(lastPut(server)[0]?.label).toBe("Macro"));
    });

    it("40: pinned unless turned off; the toggle saves", async () => {
        const { server } = await mountMacros([reboot, login]);
        const pinned = screen.getByLabelText("Pin to the toolbar and menu");
        expect(pinned).toBeChecked();
        fireEvent.click(pinned);
        await waitFor(() => expect(lastPut(server)[0]?.pinned).toBe(false));
        fireEvent.click(within(screen.getByRole("group", { name: "Saved macros" })).getByRole("button", { name: "Login" }));
        expect(screen.getByLabelText("Pin to the toolbar and menu")).not.toBeChecked();
    });
});

describe("a macro is built a piece at a time (32-34)", () => {
    it("32: a new macro is not saved until it does something, and the key choice saves it with its modifiers", async () => {
        const { server } = await mountMacros([reboot]);
        fireEvent.click(screen.getByRole("button", { name: "New macro" }));
        // Into the name, selected.
        expect(nameField()).toHaveValue("New macro");
        expect(nameField()).toHaveFocus();
        expect(screen.getByTestId("macro-unsaved")).toHaveTextContent("Not saved yet");
        expect(server.puts).toEqual([]);
        expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();

        // Modifiers first, the way people build a chord: the step must survive having no key yet.
        fireEvent.click(screen.getByRole("switch", { name: "Ctrl" }));
        fireEvent.click(screen.getByRole("switch", { name: "Alt" }));
        expect(screen.getByRole("switch", { name: "Ctrl" })).toHaveAttribute("aria-checked", "true");
        await act(async () => {});
        expect(lastPut(server).map((m) => m.id)).toEqual(["reboot"]);
        expect(within(screen.getByRole("group", { name: "Saved macros" })).getByRole("button", { name: "New macro" })).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Key for step 1"), { target: { value: "Delete" } });
        await waitFor(() => expect(lastPut(server).map((m) => m.label)).toEqual(["Reboot", "New macro"]));
        const saved = lastPut(server)[1];
        expect(saved?.steps).toEqual([chord("Delete", ["ControlLeft", "AltLeft"])]);
        expect(saved?.icon).toBe("command");
        expect(saved?.pinned).toBe(true);
        expect(screen.queryByTestId("macro-unsaved")).toBeNull();
        expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
    });

    it("32: an empty step added to a saved macro stays in the editor but is not sent, and says so", async () => {
        const { server } = await mountMacros([reboot]);
        fireEvent.click(screen.getByRole("button", { name: "Add text" }));
        await act(async () => {});
        expect(screen.getByLabelText("Text for step 2")).toBeInTheDocument();
        expect(screen.getByLabelText("Text for step 2")).toHaveFocus();
        expect(screen.getByTestId("macro-unsaved")).toHaveTextContent("One step is still empty");
        expect(lastPut(server)[0]?.steps).toEqual([chord("KeyR", ["ControlLeft"])]);

        const text = screen.getByLabelText("Text for step 2");
        await userEvent.type(text, "hello");
        fireEvent.blur(text);
        await waitFor(() => expect(lastPut(server)[0]?.steps).toEqual([chord("KeyR", ["ControlLeft"]), { type: "text", text: "hello" }]));
        expect(screen.queryByTestId("macro-unsaved")).toBeNull();
    });

    it("32: the server's reply never replaces what is being edited", async () => {
        const { server } = await mountMacros([reboot]);
        fireEvent.click(screen.getByRole("button", { name: "Add key combo" }));
        await act(async () => {});
        expect(server.macros[0]?.steps).toHaveLength(1);
        // After the save round trip the empty combo is still on screen.
        expect(screen.getByLabelText("Key for step 2")).toHaveValue("");
    });

    it("33: saves are serialised and coalesced: the last draft wins, nothing older lands after it", async () => {
        const { server } = await mountMacros([reboot]);
        const release = Promise.withResolvers<void>();
        server.hold = release.promise;
        fireEvent.click(screen.getByRole("switch", { name: "Alt" }));
        await waitFor(() => expect(server.puts).toHaveLength(1));
        fireEvent.click(screen.getByRole("switch", { name: "Shift" }));
        fireEvent.click(screen.getByRole("switch", { name: "Super" }));
        // The first is still in flight: no second PUT may overtake it.
        await act(async () => {});
        expect(server.puts).toHaveLength(1);
        server.hold = null;
        release.resolve();
        await waitFor(() => expect(server.puts).toHaveLength(2));
        expect(lastPut(server)[0]?.steps).toEqual([chord("KeyR", ["ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft"])]);
        await act(async () => {});
        expect(server.puts).toHaveLength(2);
    });

    it("34: a failed save says so, keeps the draft, and the next edit tries again", async () => {
        const { server, view } = await mountMacros([reboot]);
        server.failWith = 500;
        fireEvent.click(screen.getByRole("switch", { name: "Alt" }));
        await waitFor(() =>
            expect(view.rig.session.notices.store.getState()).toMatchObject({ text: "Could not save macros: disk full", error: true }),
        );
        expect(screen.getByRole("switch", { name: "Alt" })).toHaveAttribute("aria-checked", "true");
        server.failWith = null;
        fireEvent.click(screen.getByRole("switch", { name: "Shift" }));
        await waitFor(() => expect(server.macros[0]?.steps).toEqual([chord("KeyR", ["ControlLeft", "AltLeft", "ShiftLeft"])]));
    });
});

describe("steps (36, 37)", () => {
    it("36: modifiers are switches that say whether they are on, and the key list keeps a code it does not know", async () => {
        await mountMacros([{ id: "x", label: "Odd", steps: [chord("MediaPlayPause", ["AltRight"])] }]);
        expect(screen.getByRole("switch", { name: "AltGr" })).toHaveAttribute("aria-checked", "true");
        expect(screen.getByRole("switch", { name: "Ctrl" })).toHaveAttribute("aria-checked", "false");
        expect(screen.getByLabelText("Key for step 1")).toHaveValue("MediaPlayPause");
    });

    it("36: text and pause steps edit and save, the pause clamped to what the server accepts", async () => {
        const { server } = await mountMacros([login]);
        const text = screen.getByLabelText("Text for step 1");
        await userEvent.clear(text);
        await userEvent.type(text, "root{Enter}");
        await waitFor(() => expect(lastPut(server)[0]?.steps[0]).toEqual({ type: "text", text: "root" }));
        const pause = screen.getByLabelText("Pause for step 3, milliseconds");
        expect(pause).toHaveValue(250);
        await userEvent.clear(pause);
        await userEvent.type(pause, "99999{Enter}");
        await waitFor(() => expect(lastPut(server)[0]?.steps[2]).toEqual({ type: "delay", ms: 10_000 }));
    });

    it("37: moving a step keeps the focus on that step's button, even when it reaches an end", async () => {
        const { server } = await mountMacros([{ id: "m", label: "Three", steps: [chord("KeyA"), chord("KeyB"), chord("KeyC")] }]);
        const down = screen.getByRole("button", { name: "Move step 1 down" });
        down.focus();
        fireEvent.click(down);
        await waitFor(() => expect(codesOf(lastPut(server)[0]?.steps ?? [])).toEqual(["KeyB", "KeyA", "KeyC"]));
        expect(screen.getByRole("button", { name: "Move step 2 down" })).toHaveFocus();
        fireEvent.click(screen.getByRole("button", { name: "Move step 2 down" }));
        await waitFor(() => expect(codesOf(lastPut(server)[0]?.steps ?? [])).toEqual(["KeyB", "KeyC", "KeyA"]));
        // At the end the down arrow is off; the up arrow is still under the finger.
        expect(screen.getByRole("button", { name: "Move step 3 down" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Move step 3 up" })).toHaveFocus();
    });

    it("37: a one-step macro has no reorder arrows; removing the last step leaves an empty combo", async () => {
        const { server } = await mountMacros([reboot]);
        expect(screen.queryByRole("button", { name: /Move step/ })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Remove step 1" }));
        expect(screen.getByLabelText("Key for step 1")).toHaveValue("");
        expect(screen.getByTestId("macro-unsaved")).toHaveTextContent("Not saved yet");
        await act(async () => {});
        // The server would drop the empty macro, so it is sent as gone.
        expect(lastPut(server)).toEqual([]);
    });

    it("35: Add buttons stop at 40 steps", async () => {
        await mountMacros([{ id: "big", label: "Big", steps: Array.from({ length: 40 }, () => chord("KeyA")) }]);
        expect(screen.getByRole("button", { name: "Add key combo" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Add text" })).toBeDisabled();
    });
});

describe("icons (38)", () => {
    const radios = () => within(screen.getByRole("radiogroup", { name: "Icon" })).getAllByRole("radio");

    it("38: a radiogroup with ONE tab stop on the chosen icon", async () => {
        await mountMacros([reboot]);
        const all = radios();
        expect(all).toHaveLength(MACRO_ICON_NAMES.length + 1);
        expect(all.filter((r) => r.tabIndex === 0).map((r) => r.getAttribute("aria-label"))).toEqual(["power"]);
        expect(all.filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.getAttribute("aria-label"))).toEqual(["power"]);
    });

    it("38: 'No icon' previews the initials and is where a macro with none starts", async () => {
        await mountMacros([{ id: "n", label: "Quick", steps: [chord("KeyA")] }]);
        const none = screen.getByRole("radio", { name: "No icon" });
        expect(none).toHaveAttribute("aria-checked", "true");
        expect(none).toHaveTextContent("QU");
        expect(none.tabIndex).toBe(0);
    });

    it("38: a stored icon this build does not know still leaves one tab stop", async () => {
        await mountMacros([{ id: "u", label: "Odd", icon: "not-a-real-icon", steps: [chord("KeyA")] }]);
        expect(radios().filter((r) => r.tabIndex === 0)).toHaveLength(1);
    });

    it("38: arrows move the SELECTION (and the focus), wrapping, and save", async () => {
        const { server } = await mountMacros([reboot]);
        const power = screen.getByRole("radio", { name: "power" });
        power.focus();
        const next = MACRO_ICON_NAMES[MACRO_ICON_NAMES.indexOf("power") + 1] ?? "";
        fireEvent.keyDown(power, { key: "ArrowRight" });
        await waitFor(() => expect(lastPut(server)[0]?.icon).toBe(next));
        expect(screen.getByRole("radio", { name: next })).toHaveFocus();
        expect(screen.getByRole("radio", { name: next })).toHaveAttribute("aria-checked", "true");
        fireEvent.keyDown(screen.getByRole("radio", { name: next }), { key: "Home" });
        await waitFor(() => expect(lastPut(server)[0]?.icon).toBe(""));
        expect(screen.getByRole("radio", { name: "No icon" })).toHaveFocus();
        fireEvent.keyDown(screen.getByRole("radio", { name: "No icon" }), { key: "ArrowLeft" });
        await waitFor(() => expect(lastPut(server)[0]?.icon).toBe(MACRO_ICON_NAMES[MACRO_ICON_NAMES.length - 1]));
    });
});

describe("delete and run (35)", () => {
    it("35: Delete macro asks first; Cancel changes nothing, Confirm removes it and selects the next", async () => {
        const { server } = await mountMacros([reboot, login]);
        fireEvent.click(screen.getByRole("button", { name: "Delete macro" }));
        const ask = screen.getByRole("alertdialog", { name: 'Delete the macro "Reboot"?' });
        fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
        expect(server.puts).toEqual([]);
        fireEvent.click(screen.getByRole("button", { name: "Delete macro" }));
        fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete macro" }));
        await waitFor(() => expect(lastPut(server).map((m) => m.id)).toEqual(["login"]));
        expect(nameField()).toHaveValue("Login");
    });

    it("35: deleting the last macro lands focus on New macro", async () => {
        const { server } = await mountMacros([reboot]);
        fireEvent.click(screen.getByRole("button", { name: "Delete macro" }));
        fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete macro" }));
        await waitFor(() => expect(lastPut(server)).toEqual([]));
        expect(screen.getByRole("button", { name: "New macro" })).toHaveFocus();
        expect(screen.getByText("Use New macro to add one.")).toBeInTheDocument();
    });

    it("Run closes the dialog and the macro reaches the target: keys over the socket, text through kvmd", async () => {
        const { view } = await mountMacros([login, reboot]);
        const { rig } = view;
        fireEvent.click(screen.getByRole("button", { name: "Run" }));
        expect(view.closed.count).toBe(1);
        await act(async () => {
            rig.clock.advance(1000);
            await rig.clock.settle();
        });
        expect(rig.http.requests[0]).toMatchObject({ path: "/api/hid/print?limit=0&delay=0.02", body: "admin" });
        await act(async () => {
            rig.clock.advance(1000);
            await rig.clock.settle();
        });
        expect(rig.sent()).toContain("key Tab:down");
        expect(rig.session.notices.store.getState().text).toBe("Login sent");
    });

    it("a macro with no usable step cannot be run", async () => {
        await mountMacros([]);
        fireEvent.click(screen.getByRole("button", { name: "New macro" }));
        expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    });

    it("33: a dialog reopened after an edit reads the list only once that edit has landed", async () => {
        const server = serveMacros([reboot]);
        const first = await mountDialog(MacrosDialog);
        await screen.findByRole("switch", { name: "Alt" });
        const release = Promise.withResolvers<void>();
        server.hold = release.promise;
        fireEvent.click(screen.getByRole("switch", { name: "Alt" }));
        await waitFor(() => expect(server.puts).toHaveLength(1));
        first.unmount();
        const rig = await openRig();
        await mountDialog(MacrosDialog, rig);
        await act(async () => {});
        expect(screen.getByText("Loading")).toBeInTheDocument();
        release.resolve();
        await screen.findByRole("switch", { name: "Alt" });
        await waitFor(() => expect(screen.getByRole("switch", { name: "Alt" })).toHaveAttribute("aria-checked", "true"));
    });
});
