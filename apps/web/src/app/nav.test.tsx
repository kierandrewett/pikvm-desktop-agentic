/**
 * FAILURE MODES (written before the tests)
 *
 * Active state
 *  1. A nested route (/settings/keyboard) leaves Settings unselected.
 *  2. A path that is nobody's (typo) selects a tab anyway, or leaves no tab in the tab order.
 *  3. More than one tab is a tab stop, so Tab walks through all of them.
 *  4. The tabpanel is not labelled by the tab that is showing.
 *
 * Keyboard
 *  5. Arrow keys fail to wrap, or move the wrong way for the orientation.
 *  6. Home/End do not reach the ends.
 *  7. Arrowing activates a tab (loads a whole surface) instead of only moving focus.
 *  8. Space does not open the focused tab (links only react to Enter).
 *
 * Layout
 *  9. Both the bar and the rail render, or neither.
 * 10. The bar stays up over the soft keyboard, or stays hidden after it closes.
 * 11. The wide layout hides its rail when the viewport shrinks (it has no keyboard bar).
 * 12. A rotation leaves a stale "tallest" and hides the bar for good.
 * 13. `/` does not land on the KVM.
 * 14. The black status-bar strip stays at the top of the layout viewport while iOS pans the visual viewport
 *     for the keyboard, so the status bar shows page content instead of black. (The static contract, the
 *     meta tags, manifest and CSS, is in chrome.test.ts; the pixels are in e2e/phone-chrome.e2e.mjs.)
 *
 * Icons only on the desktop rail
 * 15. The rail draws a label again (visible text under the icon), or the bar loses its labels.
 * 16. A rail item has no accessible name (an icon-only link announces as nothing), or its name is the tooltip's copy twice.
 * 17. The tooltip is the item's name but is exposed to assistive tech as well, so a screen reader hears it twice.
 * 18. The rail's CSS shows the tooltip only on hover and keyboard focus and is as narrow as an icon (static contract here; the
 *     pixels are in e2e/desktop-layout.e2e.mjs).
 */

import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultServer, installFakeServer, installViewport, renderApp } from "../test/harness";

// Chat is a lazy chunk and the router waits for it before rendering /chat; warm it so the
// first test to land there is not racing a cold import.
beforeAll(async () => {
    await import("../chat/chat-route");
}, 30_000);

beforeEach(() => {
    installFakeServer(defaultServer());
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const selectedTab = () => screen.getByRole("tab", { selected: true });
const shellHeight = () => document.documentElement.style.getPropertyValue("--app-height");

describe("active tab", () => {
    it("selects KVM on /kvm", async () => {
        renderApp("/kvm");
        await waitFor(() => expect(selectedTab()).toHaveTextContent("KVM"));
    });

    it("selects Chat on /chat", async () => {
        renderApp("/chat");
        await waitFor(() => expect(selectedTab()).toHaveTextContent("Chat"));
    });

    it("keeps Settings selected on a nested settings page", async () => {
        renderApp("/settings/keyboard", { compact: false });
        await waitFor(() => expect(selectedTab()).toHaveAccessibleName("Settings"));
    });

    it("sends / to the KVM", async () => {
        const { router } = renderApp("/");
        await waitFor(() => expect(router.state.location.pathname).toBe("/kvm"));
        expect(selectedTab()).toHaveTextContent("KVM");
    });

    it("selects nothing on an unknown path but still leaves one tab stop", async () => {
        renderApp("/nonsense");
        await screen.findAllByRole("tab");
        expect(screen.queryByRole("tab", { selected: true })).toBeNull();
        const stops = screen.getAllByRole("tab").filter((tab) => tab.getAttribute("tabindex") === "0");
        expect(stops).toHaveLength(1);
    });

    it("makes only the selected tab a tab stop", async () => {
        renderApp("/chat");
        await waitFor(() => expect(selectedTab()).toHaveTextContent("Chat"));
        const stops = screen.getAllByRole("tab").filter((tab) => tab.getAttribute("tabindex") === "0");
        expect(stops.map((tab) => tab.textContent)).toEqual(["Chat"]);
    });

    it("labels the tabpanel with the showing tab", async () => {
        renderApp("/chat");
        await waitFor(() => expect(selectedTab()).toHaveTextContent("Chat"));
        expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Chat");
    });

    it("moves to the tab that is clicked", async () => {
        const user = userEvent.setup();
        const { router } = renderApp("/kvm");
        await user.click(await screen.findByRole("tab", { name: "Chat" }));
        await waitFor(() => expect(router.state.location.pathname).toBe("/chat"));
        expect(selectedTab()).toHaveTextContent("Chat");
    });

    it("goes back to the Settings list when Settings is tapped again on one of its pages", async () => {
        const user = userEvent.setup();
        const { router } = renderApp("/settings/keyboard", { compact: true });
        await waitFor(() => expect(selectedTab()).toHaveAccessibleName("Settings"));
        await user.click(screen.getByRole("tab", { name: "Settings" }));
        await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    });
});

describe("keyboard navigation", () => {
    it("moves focus with the arrows without opening anything", async () => {
        const user = userEvent.setup();
        const { router } = renderApp("/kvm", { compact: true });
        const kvm = await screen.findByRole("tab", { name: "KVM" });
        kvm.focus();
        await user.keyboard("{ArrowRight}");
        expect(screen.getByRole("tab", { name: "Chat" })).toHaveFocus();
        expect(router.state.location.pathname).toBe("/kvm");
    });

    it("wraps in both directions", async () => {
        const user = userEvent.setup();
        renderApp("/kvm", { compact: true });
        const kvm = await screen.findByRole("tab", { name: "KVM" });
        kvm.focus();
        await user.keyboard("{ArrowLeft}");
        expect(screen.getByRole("tab", { name: "Settings" })).toHaveFocus();
        await user.keyboard("{ArrowRight}");
        expect(kvm).toHaveFocus();
    });

    it("uses Up and Down in the vertical rail", async () => {
        const user = userEvent.setup();
        renderApp("/kvm", { compact: false });
        const tablist = await screen.findByRole("tablist");
        expect(tablist).toHaveAttribute("aria-orientation", "vertical");
        screen.getByRole("tab", { name: "KVM" }).focus();
        await user.keyboard("{ArrowDown}");
        expect(screen.getByRole("tab", { name: "Chat" })).toHaveFocus();
        await user.keyboard("{ArrowUp}");
        expect(screen.getByRole("tab", { name: "KVM" })).toHaveFocus();
    });

    it("jumps to the ends with Home and End", async () => {
        const user = userEvent.setup();
        renderApp("/chat", { compact: true });
        const chat = await screen.findByRole("tab", { name: "Chat" });
        chat.focus();
        await user.keyboard("{End}");
        expect(screen.getByRole("tab", { name: "Settings" })).toHaveFocus();
        await user.keyboard("{Home}");
        expect(screen.getByRole("tab", { name: "KVM" })).toHaveFocus();
    });

    it("opens the focused tab with Enter", async () => {
        const user = userEvent.setup();
        const { router } = renderApp("/kvm", { compact: true });
        await screen.findByRole("tab", { name: "KVM" });
        screen.getByRole("tab", { name: "KVM" }).focus();
        await user.keyboard("{ArrowRight}{Enter}");
        await waitFor(() => expect(router.state.location.pathname).toBe("/chat"));
    });

    it("opens the focused tab with Space", async () => {
        const user = userEvent.setup();
        const { router } = renderApp("/kvm", { compact: true });
        await screen.findByRole("tab", { name: "KVM" });
        screen.getByRole("tab", { name: "KVM" }).focus();
        await user.keyboard("{ArrowRight}{ArrowRight} ");
        await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    });
});

describe("layout", () => {
    it("draws a horizontal bar on a phone and no rail", async () => {
        renderApp("/kvm", { compact: true });
        const tablist = await screen.findByRole("tablist");
        expect(tablist).toHaveAttribute("aria-orientation", "horizontal");
        expect(screen.getAllByRole("tablist")).toHaveLength(1);
    });

    it("draws a vertical rail on a wide screen and no bar", async () => {
        renderApp("/kvm", { compact: false });
        const tablist = await screen.findByRole("tablist");
        expect(tablist).toHaveAttribute("aria-orientation", "vertical");
        expect(screen.getAllByRole("tablist")).toHaveLength(1);
    });

    it("hides the bar while the soft keyboard is up and restores it after", async () => {
        const viewport = installViewport(800);
        renderApp("/kvm", { compact: true });
        await screen.findByRole("tablist");

        act(() => viewport.resize(450));
        await waitFor(() => expect(screen.queryByRole("tablist")).toBeNull());

        act(() => viewport.resize(800));
        await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
    });

    it("keeps the bar when only an address bar's worth of height is lost", async () => {
        const viewport = installViewport(800);
        renderApp("/kvm", { compact: true });
        await screen.findByRole("tablist");
        act(() => viewport.resize(700));
        await waitFor(() => expect(shellHeight()).toBe("700px"));
        expect(screen.getByRole("tablist")).toBeInTheDocument();
    });

    it("keeps the rail on a wide screen however short the viewport gets", async () => {
        const viewport = installViewport(800);
        renderApp("/kvm", { compact: false });
        await screen.findByRole("tablist");
        act(() => viewport.resize(300));
        await waitFor(() => expect(shellHeight()).toBe("300px"));
        expect(screen.getByRole("tablist")).toBeInTheDocument();
    });

    it("does not read a rotation to a shorter viewport as the keyboard", async () => {
        const viewport = installViewport(800);
        renderApp("/kvm", { compact: true });
        await screen.findByRole("tablist");

        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            // Landscape: the viewport is now short, and the orientation event arrives first.
            act(() => {
                window.dispatchEvent(new Event("orientationchange"));
                viewport.height = 380;
                viewport.dispatchEvent(new Event("resize"));
            });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(350);
            });
            expect(screen.getByRole("tablist")).toBeInTheDocument();
        } finally {
            vi.useRealTimers();
        }
    });

    it("sizes the shell to the visual viewport", async () => {
        installViewport(612);
        renderApp("/kvm", { compact: true });
        await screen.findByRole("tablist");
        expect(shellHeight()).toBe("612px");
    });

    it("puts the visual viewport's offset on <html>, where the status-bar strip reads it", async () => {
        const viewport = installViewport(612);
        const { unmount } = renderApp("/kvm", { compact: true });
        await screen.findByRole("tablist");
        const root = document.documentElement;
        expect(root.style.getPropertyValue("--app-top")).toBe("0px");
        viewport.offsetTop = 120;
        act(() => void viewport.dispatchEvent(new Event("scroll")));
        await waitFor(() => expect(root.style.getPropertyValue("--app-top")).toBe("120px"));
        unmount();
        expect(root.style.getPropertyValue("--app-top")).toBe("");
    });

    describe("in the installed app", () => {
        // The device report (402x874, black status bar): the web view, the layout viewport and the visual viewport
        // are all 812; 100vh would be the 874 screen. The layout-viewport probe is fixed top:0 bottom:0.
        const LAYOUT = 812;
        beforeEach(() => {
            document.documentElement.setAttribute("data-standalone", "true");
            const real = HTMLElement.prototype.getBoundingClientRect;
            vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
                return this.style.bottom === "0px" ? ({ height: LAYOUT, width: 0, top: 0, left: 0, right: 0, bottom: LAYOUT, x: 0, y: 0 } as DOMRect) : real.call(this);
            });
        });
        afterEach(() => {
            document.documentElement.removeAttribute("data-standalone");
            vi.restoreAllMocks();
        });

        it("leaves the height to the CSS (100dvh) while the keyboard is closed", async () => {
            installViewport(LAYOUT);
            renderApp("/kvm", { compact: true });
            expect(await screen.findByRole("tablist")).toBeInTheDocument();
            expect(shellHeight()).toBe("");
        });

        it("uses the visual viewport's height while the keyboard is up and gives the height back to the CSS when it closes", async () => {
            const viewport = installViewport(LAYOUT);
            renderApp("/kvm", { compact: true });
            await screen.findByRole("tablist");
            act(() => viewport.resize(450));
            await waitFor(() => expect(shellHeight()).toBe("450px"));
            expect(document.documentElement.getAttribute("data-keyboard")).toBe("open");
            expect(screen.queryByRole("tablist")).toBeNull();
            act(() => viewport.resize(LAYOUT));
            await waitFor(() => expect(shellHeight()).toBe(""));
            expect(document.documentElement.getAttribute("data-keyboard")).toBe("closed");
            expect(screen.getByRole("tablist")).toBeInTheDocument();
        });
    });
});

describe("icons only on the desktop rail", () => {
    it("names every rail item without drawing a label, and the bar still draws them", async () => {
        const rail = renderApp("/kvm", { compact: false });
        const tabs = await screen.findAllByRole("tab");
        expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual(["KVM", "Chat", "Settings"]);
        // The tooltip is the only text in a rail item, and it is hidden from assistive tech.
        for (const tab of tabs) {
            const tip = tab.querySelector(".nav-tip");
            expect(tip).not.toBeNull();
            expect(tip).toHaveAttribute("aria-hidden", "true");
            expect(tab.textContent).toBe(tip?.textContent);
        }
        expect(rail.container.querySelectorAll(".nav-tab > span:not(.nav-tip)")).toHaveLength(0);
        rail.unmount();

        renderApp("/kvm", { compact: true });
        const bar = await screen.findAllByRole("tab");
        expect(bar.map((tab) => tab.textContent)).toEqual(["KVM", "Chat", "Settings"]);
        expect(bar.map((tab) => tab.getAttribute("aria-label"))).toEqual(["KVM", "Chat", "Settings"]);
        expect(document.querySelector(".nav-tip")).toBeNull();
    });
});
