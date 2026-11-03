/**
 * FAILURE MODES (written before the tests)
 *
 *  1. Settings still lists the Python-backed Providers page, or lists an MCP servers page: the host refuses
 *     to configure external servers, so the page would be a form that cannot save.
 *  2. The agent's pages are not in Settings at all, or are listed twice.
 *  3. A host without a chat server opens a page that fails; it should say there is nothing to set yet.
 *  4. A page is drawn outside ChatScope, so its tokens and utilities do not apply.
 *  5. The pane is told it is in front while Settings is hidden behind another tab.
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_GROUPS } from "./pages";
import { defaultServer, installFakeServer, renderApp, type ServerState } from "../test/harness";

let server: ServerState;

beforeAll(async () => {
    await import("@pikvm/chat-web");
}, 30_000);

beforeEach(() => {
    server = defaultServer();
    installFakeServer(server);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("the agent's settings", () => {
    it("lists Providers, Models and Agent once each, and no MCP page", () => {
        const agent = SETTINGS_GROUPS.find((group) => group.title === "Agent");
        expect(agent?.pages.map((page) => page.title)).toEqual(["Providers", "Models", "Agent"]);
        const all = SETTINGS_GROUPS.flatMap((group) => group.pages.map((page) => page.id));
        expect(new Set(all).size).toBe(all.length);
        expect(all.some((id) => /mcp/i.test(id))).toBe(false);
    });

    it.each([
        ["providers", "Providers"],
        ["models", "Models"],
        ["agent", "Agent"],
    ])("opens %s inside ChatScope", async (id, title) => {
        const user = userEvent.setup();
        renderApp("/settings", { compact: true });
        await user.click(await screen.findByRole("link", { name: title }));
        const page = await screen.findByTestId(`chat-page-${id}`);
        expect(page.closest(".chat-scope")).not.toBeNull();
        expect(within(document.body).getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    });

    it("says there is nothing to set yet when the host has no chat server", async () => {
        server.chat = false;
        server.agent = { found: false, reason: "Chat is starting" };
        const user = userEvent.setup();
        renderApp("/settings", { compact: true });
        await user.click(await screen.findByRole("link", { name: "Providers" }));
        expect(await screen.findByText(/Chat is not available on this host/)).toBeInTheDocument();
        expect(screen.queryByTestId("chat-page-providers")).toBeNull();
    });

    it("is told it is in front only while Settings is", async () => {
        const user = userEvent.setup();
        renderApp("/settings/providers", { compact: false });
        const page = await screen.findByTestId("chat-page-providers");
        expect(page.closest(".chat-scope")).toHaveAttribute("data-active", "true");
        await user.click(screen.getByRole("tab", { name: "KVM" }));
        await waitFor(() => expect(page.closest(".chat-scope")).toHaveAttribute("data-active", "false"));
    });
});
