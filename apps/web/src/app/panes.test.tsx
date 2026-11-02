/**
 * FAILURE MODES (written before the tests)
 *
 * Keeping the screens alive
 *  P1. Leaving the KVM tab unmounts the picture: the stream is torn down and started again on
 *      return (a new `src`, a new socket, a blank frame while it reconnects).
 *  P2. The KVM only mounts when its tab is first opened, so a session that starts on Settings
 *      has no picture or link until the user taps KVM.
 *  P3. Chat or Settings remount on return: the draft, the scroll position and the open
 *      settings page are gone.
 *  P4. Returning to Settings opens its list, not the page that was open (the tab link points
 *      at the root).
 *  P5. Chat is mounted at start, so its weight and its harness traffic are paid by a user who
 *      never opens it.
 *
 * Hidden means gone to the user
 *  P6. A hidden pane stays focusable or clickable (no `inert`), so Tab walks into it, or a
 *      screen reader reads three screens at once.
 *  P7. Several panes claim to be the tabpanel, or the one showing is not labelled by its tab.
 *  P8. A path that is nobody's (a typo) leaves one pane showing anyway.
 *
 * The target must not hear from the other tabs
 *  P9. Keys typed on Settings or Chat reach the target through the hidden field or the
 *      desktop app's window-level forwarding.
 *  P10. A key still held when the tab changes stays down on the target (no keyup comes).
 *  P11. The soft keyboard stays up over Settings because the hidden field kept focus.
 *  P12. The screen wake lock is held while another tab is in front, or not taken again when
 *       the KVM returns.
 *
 * Routes stay the truth
 *  P13. Back and forward do not switch panes (panes follow their own state, not the URL).
 *  P14. Landing on /settings/keyboard first and then opening the KVM shows a blank KVM
 *       (it must be live at once, having been mounted from the start).
 */

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openRig, type Rig } from "../kvm/test-support";
import { defaultServer, installFakeServer, installViewport, renderApp, type ServerState } from "../test/harness";

let server: ServerState;

// Chat is a lazy chunk; its first import is slower than a test's default wait and is not what these
// tests are about, so it is warmed once (a deliberate use of dynamic import: the loading boundary itself).
beforeAll(async () => {
    await import("../chat/chat-route");
}, 30_000);
let rig: Rig;

beforeEach(async () => {
    server = defaultServer();
    installFakeServer(server);
    installViewport();
    rig = await openRig();
});

afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "wakeLock");
    sessionStorage.clear();
});

/** Render the app and wait until the shell has drawn (the router loads asynchronously). */
const open = async (path: string, env: { compact?: boolean } = {}) => {
    const view = renderApp(path, { ...env, session: rig.session });
    await screen.findAllByRole("tab");
    return view;
};

const pane = (id: "kvm" | "chat" | "settings"): HTMLElement => {
    const el = document.getElementById(`panel-${id}`);
    if (!el) throw new Error(`no pane ${id}`);
    return el;
};

const shown = (id: "kvm" | "chat" | "settings") => pane(id).getAttribute("data-active") === "true";
const kvmField = (): HTMLInputElement => {
    const el = document.querySelector<HTMLInputElement>(".kvm-kbd");
    if (!el) throw new Error("the hidden field is missing");
    return el;
};

/** The KVM's `<img>`, and a log of every time its source changed (which is a stream request). */
function watchPicture() {
    const img = document.querySelector<HTMLImageElement>("img.kvm-img");
    if (!img) throw new Error("the picture is missing");
    const changes: Array<string | null> = [];
    const observer = new MutationObserver((records) => {
        for (const record of records) changes.push(img.getAttribute(record.attributeName ?? "src"));
    });
    observer.observe(img, { attributes: true, attributeFilter: ["src"] });
    return { img, changes, stop: () => observer.disconnect() };
}

async function tab(user: UserEvent, name: string) {
    await user.click(screen.getByRole("tab", { name }));
}

describe("the KVM stays alive", () => {
    it("P2/P14: mounts at start even when the app opens on Settings", async () => {
        await open("/settings/keyboard");
        await waitFor(() => expect(document.querySelector("img.kvm-img")).not.toBeNull());
        expect(shown("kvm")).toBe(false);
        expect(shown("settings")).toBe(true);
        // The session is the app's one link, started by the screen: no second socket.
        expect(rig.hub.sockets).toHaveLength(1);
    });

    it("P1: a round trip through Chat and Settings keeps the same picture, socket and stream", async () => {
        const user = userEvent.setup();
        await open("/kvm");
        await screen.findByRole("tab", { name: "KVM" });
        const before = watchPicture();
        const sockets = rig.hub.sockets.length;

        await tab(user, "Chat");
        await waitFor(() => expect(shown("chat")).toBe(true));
        await tab(user, "Settings");
        await waitFor(() => expect(shown("settings")).toBe(true));
        await tab(user, "KVM");
        await waitFor(() => expect(shown("kvm")).toBe(true));

        expect(document.querySelector("img.kvm-img")).toBe(before.img);
        expect(before.changes).toEqual([]);
        expect(rig.hub.sockets).toHaveLength(sockets);
        before.stop();
    });
});

describe("Chat and Settings keep their place", () => {
    it("P5: Chat is not mounted until it is first opened", async () => {
        const user = userEvent.setup();
        await open("/kvm");
        await screen.findByRole("tab", { name: "Chat" });
        expect(within(pane("chat")).queryByRole("region", { name: "Agent conversation" })).toBeNull();
        expect(pane("chat").childElementCount).toBe(0);

        await tab(user, "Chat");
        await within(pane("chat")).findByRole("region", { name: "Agent conversation" });
    });

    it("P3: a draft in Chat survives going to the KVM and back", async () => {
        const user = userEvent.setup();
        await open("/chat");
        const region = await within(pane("chat")).findByRole("region", { name: "Agent conversation" });
        const composer = within(region).getByRole("textbox");
        await user.type(composer, "draft message");

        await tab(user, "KVM");
        await waitFor(() => expect(shown("chat")).toBe(false));
        await tab(user, "Chat");
        await waitFor(() => expect(shown("chat")).toBe(true));

        const again = within(pane("chat")).getByRole("textbox");
        expect(again).toBe(composer);
        expect(again).toHaveValue("draft message");
    });

    it("P3/P4: Settings returns to the page that was open, with its scroll", async () => {
        const user = userEvent.setup();
        const { router } = await open("/settings/keyboard", { compact: false });
        await within(pane("settings")).findByRole("heading", { level: 1, name: "Keyboard" });
        const detail = pane("settings").querySelector<HTMLElement>("[data-settings-detail]");
        if (!detail) throw new Error("no detail pane");
        detail.scrollTop = 120;

        await tab(user, "KVM");
        await waitFor(() => expect(router.state.location.pathname).toBe("/kvm"));
        // The tab's own link now points at the remembered page.
        expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("href", "/app/settings/keyboard");

        await tab(user, "Settings");
        await waitFor(() => expect(router.state.location.pathname).toBe("/settings/keyboard"));
        expect(pane("settings").querySelector("[data-settings-detail]")).toBe(detail);
        expect(detail.scrollTop).toBe(120);
        expect(within(pane("settings")).getByRole("heading", { level: 1, name: "Keyboard" })).toBeInTheDocument();
    });

    it("P4: the Settings tab opens the root until a page has been opened", async () => {
        await open("/kvm", { compact: true });
        expect(await screen.findByRole("tab", { name: "Settings" })).toHaveAttribute("href", "/app/settings");
    });
});

describe("hidden panes", () => {
    it("P6/P7: only the pane showing is reachable, and it is the one tabpanel, labelled by its tab", async () => {
        const user = userEvent.setup();
        await open("/kvm");
        await screen.findByRole("tab", { name: "KVM" });
        await tab(user, "Settings");
        await waitFor(() => expect(shown("settings")).toBe(true));

        for (const id of ["kvm", "chat"] as const) {
            expect(pane(id)).toHaveAttribute("inert");
            expect(pane(id)).toHaveAttribute("aria-hidden", "true");
        }
        expect(pane("settings")).not.toHaveAttribute("inert");
        expect(pane("settings")).not.toHaveAttribute("aria-hidden");
        const panel = screen.getByRole("tabpanel");
        expect(panel).toBe(pane("settings"));
        expect(panel).toHaveAccessibleName("Settings");
        expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    });

    it("P8: a path that is nobody's shows no pane", async () => {
        await open("/nonsense");
        await screen.findAllByRole("tab");
        expect(shown("kvm")).toBe(false);
        expect(shown("chat")).toBe(false);
        expect(shown("settings")).toBe(false);
    });

    it("P13: back and forward switch the panes", async () => {
        const user = userEvent.setup();
        const { router } = await open("/kvm");
        await screen.findByRole("tab", { name: "KVM" });
        await tab(user, "Chat");
        await waitFor(() => expect(shown("chat")).toBe(true));
        await tab(user, "Settings");
        await waitFor(() => expect(shown("settings")).toBe(true));

        act(() => router.history.back());
        await waitFor(() => expect(shown("chat")).toBe(true));
        act(() => router.history.back());
        await waitFor(() => expect(shown("kvm")).toBe(true));
        act(() => router.history.forward());
        await waitFor(() => expect(shown("chat")).toBe(true));
        expect(shown("kvm")).toBe(false);
    });
});

describe("the target does not hear from the other tabs", () => {
    const key = (type: "keydown" | "keyup", code: string) =>
        new KeyboardEvent(type, { code, key: code === "F5" ? "F5" : "Shift", bubbles: true, cancelable: true });

    // A chord goes through the key queue, which paces itself on the session's clock.
    const strike = async (code: string) => {
        await act(async () => {
            kvmField().dispatchEvent(key("keydown", code));
            kvmField().dispatchEvent(key("keyup", code));
            rig.clock.advance(1000);
            await rig.clock.settle();
        });
    };

    it("P9: a key aimed at the hidden field while Settings is showing goes nowhere", async () => {
        const user = userEvent.setup();
        await open("/kvm");
        await strike("F5");
        expect(rig.sent()).toEqual(["key F5:down", "key F5:up"]);

        await tab(user, "Settings");
        await waitFor(() => expect(shown("settings")).toBe(true));
        await strike("F5");
        expect(rig.sent()).toEqual(["key F5:down", "key F5:up"]);

        await tab(user, "KVM");
        await waitFor(() => expect(shown("kvm")).toBe(true));
        await strike("F5");
        expect(rig.sent()).toEqual(["key F5:down", "key F5:up", "key F5:down", "key F5:up"]);
    });

    it("P10: a modifier held when the tab changes is let go", async () => {
        const user = userEvent.setup();
        await open("/kvm");
        await screen.findByRole("tab", { name: "KVM" });
        act(() => kvmField().dispatchEvent(key("keydown", "ShiftLeft")));
        expect(rig.sent()).toEqual(["key ShiftLeft:down"]);

        await tab(user, "Chat");
        await waitFor(() => expect(shown("chat")).toBe(true));
        expect(rig.sent()).toEqual(["key ShiftLeft:down", "key ShiftLeft:up"]);
    });

    it("P11: the soft keyboard is put away", async () => {
        const user = userEvent.setup();
        await open("/kvm");
        await screen.findByRole("tab", { name: "KVM" });
        kvmField().focus();
        expect(document.activeElement).toBe(kvmField());

        await tab(user, "Settings");
        await waitFor(() => expect(shown("settings")).toBe(true));
        expect(document.activeElement).not.toBe(kvmField());
    });
});

describe("the screen wake lock follows the KVM showing", () => {
    it("P12: taken at start, dropped for another tab, taken again on return", async () => {
        const user = userEvent.setup();
        const sentinel = { release: vi.fn(async () => {}), addEventListener: vi.fn() };
        const request = vi.fn(async () => sentinel);
        Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });

        await open("/kvm");
        await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

        await tab(user, "Chat");
        await waitFor(() => expect(sentinel.release).toHaveBeenCalledTimes(1));
        await tab(user, "Settings");
        expect(request).toHaveBeenCalledTimes(1);

        await tab(user, "KVM");
        await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    });

    it("P12: never taken by a session that starts on another tab", async () => {
        const sentinel = { release: vi.fn(async () => {}), addEventListener: vi.fn() };
        const request = vi.fn(async () => sentinel);
        Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });

        await open("/settings");
        await waitFor(() => expect(document.querySelector("img.kvm-img")).not.toBeNull());
        expect(request).not.toHaveBeenCalled();
    });
});
