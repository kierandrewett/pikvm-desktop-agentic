/**
 * FAILURE MODES (written before the tests)
 *
 *  1. The route still frames another document, so the conversation cannot share the app's
 *     theme, viewport or safe areas.
 *  2. A host without a chat server (features.chat false) lands on a broken or empty pane
 *     instead of "Chat is not available", or cannot recover without a reload.
 *  3. The state endpoint failing shows a blank panel rather than a retry.
 *  4. The agent program missing looks like an empty conversation: the person types and nothing
 *     can answer, with no word of why.
 *  5. The pane is not told whether its tab is in front, so a hidden Chat keeps page-wide listeners.
 *  6. The pane's styles are not carried by ChatScope, so its tokens would apply to the whole app.
 *  7. Chat's weight is paid by every page: it must load when Chat is opened.
 */

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultServer, installFakeServer, renderApp, type ServerState } from "../test/harness";

let server: ServerState;

// The route is a lazy chunk; its first import is slower than a test's default wait, and is not what these tests are about.
beforeAll(async () => {
    await import("./chat-route");
}, 30_000);

beforeEach(() => {
    server = defaultServer();
    installFakeServer(server);
});

afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
});

describe("chat route", () => {
    it("renders the pane in the app, inside ChatScope, not in a frame", async () => {
        renderApp("/chat", { compact: false });
        await screen.findByRole("region", { name: "Conversation" });
        expect(document.querySelector("iframe")).toBeNull();
        expect(document.querySelector(".chat-surface > .chat-scope")).not.toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("tells the pane it is in front, and that it is not when the KVM is", async () => {
        const user = userEvent.setup();
        renderApp("/chat", { compact: false });
        await screen.findByRole("region", { name: "Conversation" });
        expect(document.querySelector(".chat-scope")).toHaveAttribute("data-active", "true");
        await user.click(screen.getByRole("tab", { name: "KVM" }));
        await waitFor(() => expect(document.querySelector(".chat-scope")).toHaveAttribute("data-active", "false"));
    });

    it("explains what to do when the host has no chat server, and recovers on Check again", async () => {
        const user = userEvent.setup();
        server.chat = false;
        server.agent = { found: false, reason: "disk full" };
        renderApp("/chat");
        expect(await screen.findByRole("heading", { name: "Chat is not available" })).toBeInTheDocument();
        expect(screen.getByText(/disk full/)).toBeInTheDocument();
        expect(screen.queryByRole("region", { name: "Conversation" })).toBeNull();

        server.chat = true;
        server.agent = { found: true };
        await user.click(screen.getByRole("button", { name: "Check again" }));
        await screen.findByRole("region", { name: "Conversation" });
    });

    it("shows a retry, not a pane, when the app state cannot be loaded", async () => {
        server.stateStatus = 500;
        renderApp("/chat");
        expect(await screen.findByRole("heading", { name: "Cannot reach the app server" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });

    it("opens the pane with a note on top when the agent program was not found", async () => {
        server.agent = { found: false, reason: "The agent runtime was not found. Set OMP_BIN." };
        renderApp("/chat");
        const note = await screen.findByRole("alert");
        expect(note).toHaveTextContent("The agent program was not found");
        expect(note).toHaveTextContent("Set OMP_BIN");
        expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
    });
});
