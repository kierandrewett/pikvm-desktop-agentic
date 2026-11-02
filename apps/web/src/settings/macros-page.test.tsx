/**
 * Settings -> Macros is the KVM screen's macro manager drawn as a page. The manager's own failure
 * modes (kvm/dialogs/FAILURE_MODES.md, 32-40) are tested against the dialog; what is tested here is
 * what the page adds, and that it is that component and not a copy of it.
 *
 * Failure modes, before behaviour:
 *  M1. The list cannot be loaded: the page must say so, not show an empty manager.
 *  M2. A save the server refuses: the page names it and the draft is kept, not reverted.
 *  M3. Deleting without being asked, or asking and then not honouring Cancel.
 *  M4. Opening the page grabs focus, or draws a scrim and traps the keyboard like a dialog.
 *  M5. Running closes or navigates away from Settings, or runs a macro with no usable step.
 *  M6. Running while the link to the target is down sends keys into the void instead of saying so.
 *  M7. The page opened on a phone is not usable: targets under 44px stay in CSS, but the manager
 *      must switch to its phone layout and keep every action reachable.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMacroSaveChainForTests } from "../kvm/dialogs/macros-dialog";
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
    await screen.findByRole("group", { name: "Saved macros" });
    await waitFor(() => expect(screen.queryByText("Loading\u2026")).toBeNull());
    return view;
}

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
        expect(screen.getByRole("button", { name: "New macro" })).toBeDisabled();
    });

    it("M2: a refused save is named and the draft stays", async () => {
        server.macros = [reboot];
        server.macrosPutStatus = 500;
        await open();
        await userEvent.click(screen.getByRole("switch", { name: "Shift" }));
        // The KVM behind it is mounted and draws the same notice; the user sees the pane in front.
        expect(await within(screen.getByRole("tabpanel")).findByText(/Could not save macros/)).toBeInTheDocument();
        expect(screen.getByRole("switch", { name: "Shift" })).toHaveAttribute("aria-checked", "true");
    });

    it("M3: delete asks first, Cancel keeps it, Delete removes it", async () => {
        server.macros = [reboot, login];
        await open();
        fireEvent.click(screen.getByRole("button", { name: "Delete macro" }));
        const ask = screen.getByRole("alertdialog", { name: /Delete the macro/ });
        fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
        expect(puts()).toHaveLength(0);
        fireEvent.click(screen.getByRole("button", { name: "Delete macro" }));
        fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete macro" }));
        await waitFor(() => expect(lastPut().map((m) => m.id)).toEqual(["login"]));
    });

    it("M4: it is a page, not a dialog: no scrim role, no focus grab, no Done button", async () => {
        server.macros = [reboot];
        await open();
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.getByTestId("macros-dialog")).toHaveAttribute("data-presentation", "page");
        expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
        expect(document.body).toHaveFocus();
        // Escape on a page is not a close: nothing happens and the page stays.
        fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
        expect(screen.getByTestId("settings")).toBeInTheDocument();
    });

    it("M5: Run keeps the page and a macro with nothing to send cannot be run", async () => {
        server.macros = [login];
        const { router } = await open();
        fireEvent.click(screen.getByRole("button", { name: "Run" }));
        await act(async () => {
            rig.clock.advance(2000);
            await rig.clock.settle();
        });
        expect(router.state.location.pathname).toBe("/settings/macros");
        expect(screen.getByLabelText("Name")).toHaveValue("Login");
        fireEvent.click(screen.getByRole("button", { name: "New macro" }));
        expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
    });

    it("M6: a macro of keys is refused, and says so, while the link to the target is down", async () => {
        server.macros = [reboot];
        await open();
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

    it("M7: on a phone the list is a strip and every action is on the page", async () => {
        server.macros = [reboot, login];
        await open({ compact: true });
        expect(screen.getByTestId("macros-dialog")).toHaveAttribute("data-compact", "true");
        for (const name of ["New macro", "Run", "Delete macro", "Move down the list", "Add key combo", "Add text", "Add pause"]) {
            expect(screen.getByRole("button", { name })).toBeInTheDocument();
        }
    });
});

describe("manager", () => {
    it("is the component the KVM dialog opens: same name, same controls", async () => {
        server.macros = [reboot];
        await open();
        expect(screen.getByRole("group", { name: "Saved macros" })).toBeInTheDocument();
        expect(screen.getByRole("radiogroup", { name: "Icon" })).toBeInTheDocument();
        expect(screen.getByLabelText("Pin to the toolbar and menu")).toBeChecked();
    });

    it("creates a macro with a key combo, a text and a pause, and PUTs exactly that", async () => {
        await open();
        fireEvent.click(screen.getByRole("button", { name: "New macro" }));
        const name = screen.getByLabelText("Name");
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
        await open();
        await userEvent.click(screen.getByRole("radio", { name: "power" }));
        await waitFor(() => expect(lastPut()[0]?.icon).toBe("power"));
        const pin = screen.getByLabelText("Pin to the toolbar and menu");
        expect(pin).not.toBeChecked();
        await userEvent.click(pin);
        await waitFor(() => expect(lastPut()[0]?.pinned).toBe(true));
    });

    it("reorders the list, which is the order of the pinned tiles", async () => {
        server.macros = [reboot, login];
        await open();
        expect(screen.getByRole("button", { name: "Move up the list" })).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "Move down the list" }));
        await waitFor(() => expect(lastPut().map((m) => m.id)).toEqual(["login", "reboot"]));
        // At the bottom now: the arrow that got it there is off and the other has the focus.
        expect(screen.getByRole("button", { name: "Move down the list" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Move up the list" })).toHaveFocus();
        const list = screen.getByRole("group", { name: "Saved macros" });
        expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual(["Login", "Reboot"]);
    });

    it("runs the macro on the target from Settings: keys over the socket, text through kvmd", async () => {
        server.macros = [login];
        await open();
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
