/**
 * FAILURE MODES (written before the tests) — the system's status area follows the page
 *
 *  1. Chat or Settings keeps the KVM's black (a black bar over a light page), or the KVM takes the page colour
 *     (a light stripe over the picture).
 *  2. A theme change repaints the page but not the status area: it stays the old theme's colour until the next
 *     navigation.
 *  3. The edge, html, body and the theme-color meta disagree, so the system samples one colour and the page shows another.
 *  4. Going back to the KVM from Chat leaves the last page colour behind.
 */

import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setThemeChoice } from "../theme";
import { defaultServer, installFakeServer, installViewport, renderApp } from "../test/harness";
import { KVM_COLOUR, PAGE_COLOUR, paintStatusColour, statusColour } from "./status-colour";

beforeEach(() => {
    installFakeServer(defaultServer());
    installViewport(800);
    document.head.innerHTML = '<meta name="theme-color" content="#000000">';
});

afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.style.removeProperty("--status-colour");
});

const painted = () => document.documentElement.style.getPropertyValue("--status-colour");
const metaColour = () => document.head.querySelector('meta[name="theme-color"]')?.getAttribute("content");

describe("statusColour", () => {
    it("is black on the KVM and the page's own colour on Chat and Settings, in each theme", () => {
        expect(statusColour("kvm", "light")).toBe(KVM_COLOUR);
        expect(statusColour("kvm", "dark")).toBe(KVM_COLOUR);
        expect(statusColour("chat", "light")).toBe(PAGE_COLOUR.light);
        expect(statusColour("settings", "light")).toBe(PAGE_COLOUR.light);
        expect(statusColour("chat", "dark")).toBe(PAGE_COLOUR.dark);
        expect(statusColour("settings", "dark")).toBe(PAGE_COLOUR.dark);
    });

    it("is black where no tab is open (an unknown path)", () => {
        expect(statusColour(undefined, "light")).toBe(KVM_COLOUR);
    });

    it("paints the custom property and the theme-color meta together", () => {
        paintStatusColour("#123456");
        expect(painted()).toBe("#123456");
        expect(metaColour()).toBe("#123456");
    });
});

describe("the shell", () => {
    it("paints the KVM black, then Chat and Settings the page's colour, then the KVM black again", async () => {
        setThemeChoice("light");
        renderApp("/kvm", { compact: true });
        await screen.findByRole("tablist");
        expect(painted()).toBe(KVM_COLOUR);
        expect(metaColour()).toBe(KVM_COLOUR);

        await userEvent.click(screen.getByRole("tab", { name: "Chat" }));
        await waitFor(() => expect(painted()).toBe(PAGE_COLOUR.light));
        expect(metaColour()).toBe(PAGE_COLOUR.light);

        await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
        await waitFor(() => expect(painted()).toBe(PAGE_COLOUR.light));

        await userEvent.click(screen.getByRole("tab", { name: "KVM" }));
        await waitFor(() => expect(painted()).toBe(KVM_COLOUR));
        expect(metaColour()).toBe(KVM_COLOUR);
    });

    it("follows a theme change on the page it is on, without a navigation", async () => {
        setThemeChoice("light");
        renderApp("/settings", { compact: true });
        await screen.findByRole("tablist");
        await waitFor(() => expect(painted()).toBe(PAGE_COLOUR.light));
        act(() => setThemeChoice("dark"));
        await waitFor(() => expect(painted()).toBe(PAGE_COLOUR.dark));
        expect(metaColour()).toBe(PAGE_COLOUR.dark);
        act(() => setThemeChoice("light"));
        await waitFor(() => expect(painted()).toBe(PAGE_COLOUR.light));
    });

    it("leaves the KVM black in either theme", async () => {
        setThemeChoice("light");
        renderApp("/kvm", { compact: true });
        await screen.findByRole("tablist");
        act(() => setThemeChoice("dark"));
        await waitFor(() => expect(painted()).toBe(KVM_COLOUR));
    });
});
