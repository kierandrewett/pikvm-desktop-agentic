/**
 * Settings -> About names the desktop app and its platform when there is a desktop shell, and
 * says nothing about one in a browser or on a phone.
 */

import { DESKTOP_BRIDGE_KEY } from "@pikvm/contracts/desktop";
import { screen } from "@testing-library/react";
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
        expect(screen.queryByText("Desktop app")).toBeNull();
    });

    it("the desktop app adds its own version and the operating system it runs on", async () => {
        Reflect.set(window, DESKTOP_BRIDGE_KEY, { platform: "darwin", version: "2.4.1", nativeControls: true });
        renderApp("/settings/about");
        expect(await screen.findByText("2.4.1 on macOS")).toBeInTheDocument();
    });
});
