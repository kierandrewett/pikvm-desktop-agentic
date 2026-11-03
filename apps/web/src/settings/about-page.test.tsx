/**
 * Settings -> About names the desktop app and its platform when there is a desktop shell, and
 * says nothing about one in a browser or on a phone.
 */

import { DESKTOP_BRIDGE_KEY } from "@pikvm/contracts/desktop";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultServer, installFakeServer, renderApp } from "../test/harness";

beforeEach(() => {
    installFakeServer(defaultServer());
});

afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, DESKTOP_BRIDGE_KEY);
});

describe("about", () => {
    it("a browser or phone shows the app and host versions and no desktop row", async () => {
        renderApp("/settings/about");
        expect(await screen.findByText("9.9.9")).toBeInTheDocument();
        expect(screen.getByText("App version")).toBeInTheDocument();
        expect(screen.getByText("App build")).toBeInTheDocument();
        expect(screen.getByText(__BUILD_ID__)).toBeInTheDocument();
        expect(screen.queryByText("Desktop app")).toBeNull();
    });

    it("lists what the device reports about its display and copies it", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
        renderApp("/settings/about");
        const report = await screen.findByTestId("display-report");
        for (const field of [
            "navigator.standalone:",
            "display-mode:",
            "html data:",
            "safe-area insets:",
            "screen:",
            "100vh / 100lvh / 100svh / 100dvh:",
            "inner / outer:",
            "visualViewport:",
            "documentElement:",
            "html:",
            "body:",
            "#root:",
            ".app-shell:",
            "nav:",
            "#status-edge:",
            "ancestors that would clip the shell:",
        ]) {
            expect(report.textContent).toContain(field);
        }
        screen.getByRole("button", { name: "Copy" }).click();
        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
        expect(writeText.mock.calls[0]?.[0]).toBe(report.textContent);
        expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    });

    it("the desktop app adds its own version and the operating system it runs on", async () => {
        Reflect.set(window, DESKTOP_BRIDGE_KEY, { platform: "darwin", version: "2.4.1", nativeControls: true });
        renderApp("/settings/about");
        expect(await screen.findByText("2.4.1 on macOS")).toBeInTheDocument();
    });
});
