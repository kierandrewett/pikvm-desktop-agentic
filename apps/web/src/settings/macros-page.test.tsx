/**
 * Settings -> Macros is the KVM screen's macro manager drawn as Settings pages: a list of the saved macros, and one
 * macro's editor behind it. The manager's own failure modes (kvm/dialogs/FAILURE_MODES.md, 32-40) are tested against
 * the dialog; what is tested here is what the page adds, and that it runs on the same editor (use-macro-editor.ts)
 * and not a copy of it.
 *
 * Failure modes, before behaviour:
 *  M1. The list cannot be loaded: the page must say so, not show an empty manager.
 *  M2. A save the server refuses: the page names it and the draft is kept, not reverted.
 *  M3. Deleting without being asked, or asking and then not honouring Cancel.
 *  M4. Opening the page grabs focus, or draws a scrim and traps the keyboard like a dialog.
 *  M5. Running closes or navigates away from Settings, or runs a macro with no usable step.
 *  M6. Running while the link to the target is down sends keys into the void instead of saying so.
 *  M7. The page opened on a phone is not usable: targets under 44px stay in CSS, but every action must be
 *      reachable, and the editor has the way back to the list.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMacroSaveChainForTests } from "../kvm/dialogs/use-macro-editor";
import { openRig, type Rig } from "../kvm/test-support";
import { defaultServer, installFakeServer, renderApp, type RecordedRequest, type ServerState } from "../test/harness";

let server: ServerState;
let requests: RecordedRequest[];
let rig: Rig;

const chord = (code: string, mods: string[] = []) => ({ type: "chord", mods, code });
const reboot = { id: "reboot", label: "Reboot", icon: "power", steps: [chord("KeyR", ["ControlLeft"])] };
const login = { id: "login", label: "Login", pinned: false, steps: [{ type: "text", text: "kieran" }, chord("Tab")] };

beforeEach(async () => {
    server = defaultServer();
    requests = installFakeServer(server);
    resetMacroSaveChainForTests();
    rig = await openRig();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const puts = () => requests.filter((r) => r.method === "PUT" && r.path === "/app/api/v1/macros");
const lastPut = () => (puts().at(-1)?.body as { macros: Array<{ id: string; label: string; pinned?: boolean; icon?: string; steps: unknown[] }> }).macros;

async function open(env: { compact?: boolean } = {}) {
    const view = renderApp("/settings/macros", { ...env, session: rig.session });
    await screen.findByRole("heading", { level: 1, name: "Macros" });
    await waitFor(() => expect(screen.queryByText("Loading\u2026")).toBeNull());
    return view;
}

/** From the list into one macro's editor. */
async function openMacro(label: string, env: { compact?: boolean } = {}) {
    const view = await open(env);
    await userEvent.click(await screen.findByRole("button", { name: new RegExp(`^${label}`) }));
    await screen.findByRole("heading", { level: 1, name: label });
    return view;
}

const nameField = () => screen.getByLabelText("Name", { selector: "input" });
const pinSwitch = () => screen.getByRole("switch", { name: "Pin to the toolbar and menu" });
/** Back to the list from an editor (the desktop's link and the phone's button both name the list). */
const backToList = () => userEvent.click(screen.getByRole("button", { name: /^(Back to )?Macros$/ }));

describe("failure modes", () => {
    it("M1: a list that cannot be loaded says why", async () => {
        const real = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
            const path = new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname;
            if (path === "/app/api/v1/macros") return new Response(JSON.stringify({ error: "store unreadable" }), { status: 500 });
            return real(input, init);
        });
        renderApp("/settings/macros", { session: rig.session });
        expect(await screen.findByText(/Could not load macros: .*store unreadable/)).toBeInTheDocument();
        // Not an empty manager with a button that would overwrite what could not be read.
        expect(screen.queryByRole("button", { name: "New macro" })).toBeNull();
    });

    it("M2: a refused save is named and the draft stays", async () => {
        server.macros = [reboot];
        server.macrosPutStatus = 500;
        await openMacro("Reboot");
        await userEvent.click(screen.getByRole("switch", { name: "Shift" }));
        // The KVM behind it is mounted and draws the same notice; the user sees the pane in front.
        expect(await within(screen.getByRole("tabpanel")).findByText(/Could not save macros/)).toBeInTheDocument();
        expect(screen.getByRole("switch", { name: "Shift" })).toHaveAttribute("aria-checked", "true");
    });

    it("M3: delete asks first, Cancel keeps it, Delete removes it", async () => {
        server.macros = [reboot, login];
        await openMacro("Reboot");
        fireEvent.click(screen.getByRole("button", { name: "Delete macro" }));
        const ask = await screen.findByRole("dialog", { name: /Delete the macro/ });
        fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(puts()).toHaveLength(0);
        fireEvent.click(screen.getByRole("button", { name: "Delete macro" }));
        fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete macro" }));
        await waitFor(() => expect(lastPut().map((m) => m.id)).toEqual(["login"]));
        // Back on the list, which no longer has it.
        expect(await screen.findByRole("heading", { level: 1, name: "Macros" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Reboot/ })).toBeNull();
    });

    it("M4: it is a page, not a dialog: no scrim role, no focus grab, no Done button", async () => {
        server.macros = [reboot];
        await openMacro("Reboot");
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
        // Escape on a page is not a close: nothing happens and the page stays.
        fireEvent.keyDown(nameField(), { key: "Escape" });
        expect(screen.getByTestId("settings")).toBeInTheDocument();
        expect(nameField()).toHaveValue("Reboot");
    });

    it("M5: Run keeps the page and a macro with nothing to send cannot be run", async () => {
        server.macros = [login];
        const { router } = await openMacro("Login");
        fireEvent.click(screen.getByRole("button", { name: "Run" }));
        await act(async () => {
            rig.clock.advance(2000);
            await rig.clock.settle();
        });
        expect(router.state.location.pathname).toBe("/settings/macros");
        expect(nameField()).toHaveValue("Login");
        await backToList();
        fireEvent.click(await screen.findByRole("button", { name: "New macro" }));
        expect(await screen.findByRole("button", { name: "Run" })).toBeDisabled();
    });

    it("M6: a macro of keys is refused, and says so, while the link to the target is down", async () => {
        server.macros = [reboot];
        await openMacro("Reboot");
        await act(async () => {
            rig.hub.last.serverClose();
            await rig.clock.settle();
        });
        fireEvent.click(screen.getByRole("button", { name: "Run" }));
        await act(async () => {
            await rig.clock.settle();
        });
        expect(rig.sent().filter((l) => l.startsWith("key"))).toEqual([]);
        expect(rig.session.notices.store.getState().error).toBe(true);
        expect(await screen.findByRole("alert")).toBeInTheDocument();
    });

    it("M7: on a phone the editor has every action, and a way back to the list", async () => {
        server.macros = [reboot, login];
        await openMacro("Reboot", { compact: true });
        for (const name of ["Run", "Delete macro", "Move down the list", "Add key combo", "Add text", "Add pause", "Back to Macros"]) {
            expect(screen.getByRole("button", { name })).toBeInTheDocument();
        }
        await backToList();
        expect(await screen.findByRole("button", { name: "New macro" })).toBeInTheDocument();
    });
});

describe("manager", () => {
    it("is on the editor the KVM dialog uses: same name, same controls", async () => {
        server.macros = [reboot];
        await openMacro("Reboot");
        expect(screen.getByRole("radiogroup", { name: "Icon" })).toBeInTheDocument();
        expect(pinSwitch()).toBeChecked();
        expect(screen.getByRole("group", { name: "Modifier keys for step 1" })).toBeInTheDocument();
    });

    it("lists the saved macros, and says what to do when there are none", async () => {
        await open();
        expect(screen.getByText("No macros yet")).toBeInTheDocument();
        cleanup();
        server.macros = [reboot, login];
        await open();
        expect(screen.getByRole("button", { name: /^Reboot/ })).toHaveTextContent("1 step, on the toolbar");
        expect(screen.getByRole("button", { name: /^Login/ })).toHaveTextContent("2 steps");
    });

    it("creates a macro with a key combo, a text and a pause, and PUTs exactly that", async () => {
        await open();
        fireEvent.click(screen.getByRole("button", { name: "New macro" }));
        const name = await screen.findByLabelText("Name", { selector: "input" });
        await userEvent.clear(name);
        await userEvent.type(name, "Open run box{Enter}");
        await userEvent.click(screen.getByRole("switch", { name: "Super" }));
        await userEvent.selectOptions(screen.getByLabelText("Key for step 1"), "KeyR");
        fireEvent.click(screen.getByRole("button", { name: "Add text" }));
        await userEvent.type(screen.getByLabelText("Text for step 2"), "calc{Enter}");
        fireEvent.click(screen.getByRole("button", { name: "Add pause" }));
        await waitFor(() => {
            const saved = lastPut().find((m) => m.label === "Open run box");
            expect(saved?.steps).toEqual([
                { type: "chord", mods: ["MetaLeft"], code: "KeyR" },
                { type: "text", text: "calc" },
                { type: "delay", ms: 200 },
            ]);
        });
        expect(server.macros).toHaveLength(1);
    });

    it("picks an icon and pins and unpins", async () => {
        server.macros = [login];
        await openMacro("Login");
        await userEvent.click(screen.getByRole("radio", { name: "power" }));
        await waitFor(() => expect(lastPut()[0]?.icon).toBe("power"));
        expect(pinSwitch()).not.toBeChecked();
        await userEvent.click(pinSwitch());
        await waitFor(() => expect(lastPut()[0]?.pinned).toBe(true));
    });

    it("reorders the list, which is the order of the pinned tiles", async () => {
        server.macros = [reboot, login];
        await openMacro("Reboot");
        expect(screen.getByRole("button", { name: "Move up the list" })).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "Move down the list" }));
        await waitFor(() => expect(lastPut().map((m) => m.id)).toEqual(["login", "reboot"]));
        // At the bottom now: the arrow that got it there is off and the other has the focus.
        expect(screen.getByRole("button", { name: "Move down the list" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Move up the list" })).toHaveFocus();
        await backToList();
        const names = (await screen.findAllByRole("button", { name: /^(Login|Reboot)/ })).map((b) => b.textContent?.match(/(Login|Reboot)/)?.[0]);
        expect(names).toEqual(["Login", "Reboot"]);
    });

    it("runs the macro on the target from Settings: keys over the socket, text through kvmd", async () => {
        server.macros = [login];
        await openMacro("Login");
        fireEvent.click(screen.getByRole("button", { name: "Run" }));
        await act(async () => {
            rig.clock.advance(1000);
            await rig.clock.settle();
        });
        expect(rig.http.requests[0]).toMatchObject({ path: "/api/hid/print?limit=0&delay=0.02", body: "kieran" });
        await act(async () => {
            rig.clock.advance(1000);
            await rig.clock.settle();
        });
        expect(rig.sent()).toContain("key Tab:down");
        expect(await within(screen.getByRole("tabpanel")).findByText("Login sent")).toBeInTheDocument();
    });
});
