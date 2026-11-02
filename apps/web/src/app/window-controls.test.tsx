/**
 * FAILURE MODES (written before the tests)
 *
 *  1. A browser or phone (no bridge) grows window controls or a titlebar it cannot use.
 *  2. The frameless window has no way to minimise, maximise or close it.
 *  3. A control is wired to the wrong bridge call, or its label lies about the maximised state.
 *  4. A maximise from outside the page (a keyboard shortcut, the OS) leaves the glyph stale.
 *  5. The macOS window, whose traffic lights are the OS's, gets a second set drawn by the page.
 *  6. Chat and Settings have nothing to drag the window by, and the KVM gets a second titlebar
 *     stacked on its own toolbar.
 *  7. The controls leave a subscription behind when the shell goes away.
 *  8. Only the desktop window's own focus and a bridge's presence decide "desktop": an
 *     unrelated global must not.
 */

import type { DesktopBridge, DesktopPlatform } from "@pikvm/contracts/desktop";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isDesktopApp } from "../host/desktop";
import { defaultServer, installFakeServer, renderApp } from "../test/harness";

interface FakeBridge {
    readonly bridge: DesktopBridge;
    readonly calls: string[];
    emitMaximise(value: boolean): void;
    readonly listeners: Set<(maximised: boolean) => void>;
}

function fakeBridge(platform: DesktopPlatform, maximised = false): FakeBridge {
    const calls: string[] = [];
    const listeners = new Set<(maximised: boolean) => void>();
    const bridge: DesktopBridge = {
        platform,
        version: "1.14.0",
        nativeControls: platform === "darwin",
        window: {
            minimise: () => void calls.push("minimise"),
            toggleMaximise: () => void calls.push("toggleMaximise"),
            close: () => void calls.push("close"),
            isMaximised: () => Promise.resolve(maximised),
            onMaximiseChange: (listener) => {
                listeners.add(listener);
                return () => void listeners.delete(listener);
            },
            setFullscreen: (on) => Promise.resolve(on),
            isFullscreen: () => Promise.resolve(false),
            onFullscreenChange: () => () => {},
            onFocusChange: () => () => {},
        },
        openExternal: () => Promise.resolve(),
    };
    return { bridge, calls, listeners, emitMaximise: (value) => listeners.forEach((listener) => listener(value)) };
}

// Chat is a lazy chunk and the router waits for it before rendering /chat; warm it.
beforeAll(async () => {
    await import("../chat/chat-route");
}, 30_000);

beforeEach(() => {
    installFakeServer(defaultServer());
});

afterEach(() => {
    Reflect.deleteProperty(window, "pikvmDesktop");
});

const install = (fake: FakeBridge): void => {
    Object.defineProperty(window, "pikvmDesktop", { value: fake.bridge, configurable: true });
};

describe("in a browser", () => {
    it("draws no window controls and no titlebar", async () => {
        const { container } = renderApp("/settings/keyboard", { compact: false });
        await screen.findByRole("tab", { name: /settings/i });
        expect(screen.queryByRole("group", { name: "Window controls" })).toBeNull();
        expect(container.querySelector(".window-titlebar")).toBeNull();
        expect(container.querySelector(".app-shell")).not.toHaveAttribute("data-desktop");
        expect(isDesktopApp()).toBe(false);
    });

    it("is not fooled by the old bridge name", () => {
        Object.defineProperty(window, "desktopConsole", { value: {}, configurable: true });
        try {
            expect(isDesktopApp()).toBe(false);
        } finally {
            Reflect.deleteProperty(window, "desktopConsole");
        }
    });
});

describe("the frameless desktop window", () => {
    it("minimises, maximises and closes through the bridge", async () => {
        const fake = fakeBridge("linux");
        install(fake);
        renderApp("/settings/keyboard", { compact: false });
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Minimise" }));
        await user.click(screen.getByRole("button", { name: "Maximise" }));
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(fake.calls).toEqual(["minimise", "toggleMaximise", "close"]);
    });

    it("says Restore when the window starts maximised, and follows changes made elsewhere", async () => {
        const fake = fakeBridge("win32", true);
        install(fake);
        renderApp("/settings/keyboard", { compact: false });
        expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
        act(() => fake.emitMaximise(false));
        await waitFor(() => expect(screen.getByRole("button", { name: "Maximise" })).toBeInTheDocument());
        act(() => fake.emitMaximise(true));
        await waitFor(() => expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument());
    });

    it("marks the shell so the toolbar can keep clear of the controls", async () => {
        install(fakeBridge("linux"));
        const { container } = renderApp("/settings/keyboard", { compact: false });
        await screen.findByRole("button", { name: "Close" });
        expect(container.querySelector(".app-shell")).toHaveAttribute("data-desktop", "frameless");
    });

    it("drops its subscription when the shell goes away", async () => {
        const fake = fakeBridge("linux");
        install(fake);
        const { unmount } = renderApp("/settings/keyboard", { compact: false });
        await screen.findByRole("button", { name: "Close" });
        expect(fake.listeners.size).toBe(1);
        unmount();
        expect(fake.listeners.size).toBe(0);
    });
});

describe("macOS", () => {
    it("leaves the traffic lights to the OS", async () => {
        install(fakeBridge("darwin"));
        const { container } = renderApp("/settings/keyboard", { compact: false });
        await screen.findByRole("tab", { name: /settings/i });
        expect(screen.queryByRole("group", { name: "Window controls" })).toBeNull();
        expect(container.querySelector(".app-shell")).toHaveAttribute("data-desktop", "native");
        // Still something to drag the window by.
        expect(container.querySelector(".window-titlebar")).not.toBeNull();
    });
});

describe("the titlebar", () => {
    it.each(["/chat", "/settings/keyboard"])("is drawn on %s", async (path) => {
        install(fakeBridge("linux"));
        const { container } = renderApp(path, { compact: false });
        await screen.findByRole("button", { name: "Close" });
        expect(container.querySelectorAll(".window-titlebar")).toHaveLength(1);
    });

    it("is not drawn on the KVM, whose toolbar is the titlebar", async () => {
        install(fakeBridge("linux"));
        const { container } = renderApp("/kvm", { compact: false });
        await screen.findByRole("button", { name: "Close" });
        expect(container.querySelector(".window-titlebar")).toBeNull();
    });
});

it("never calls the bridge while rendering", async () => {
    const fake = fakeBridge("linux");
    const spy = vi.spyOn(fake.bridge.window, "close");
    install(fake);
    renderApp("/settings/keyboard", { compact: false });
    await screen.findByRole("button", { name: "Close" });
    expect(spy).not.toHaveBeenCalled();
});
