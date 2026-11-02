/**
 * FAILURE MODES (written before the tests)
 *
 *  1. The route still frames another document, so the conversation cannot share the app's
 *     theme, viewport or safe areas.
 *  2. A host without chat (features.chat false) lands on a broken or empty workspace
 *     instead of "Chat is not available", or cannot recover without a reload.
 *  3. The state endpoint failing shows a blank panel rather than a retry.
 *  4. The harness proxy answering 502/503 looks like an empty conversation.
 *  5. The workspace talks to the wrong place: not under /app/harness, or without the
 *     workspace header the proxy requires.
 *  6. The phone layout is chosen by the window instead of the shell's rule, or the
 *     workspace clears the safe areas the shell already padded.
 *  7. Chat's weight is paid by every page: it must load when Chat is opened.
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultServer, installFakeServer, renderApp, type ServerState } from "../test/harness";

let server: ServerState;

// The route is a lazy chunk; its first import (markdown, the provider forms, assistant-ui) is
// slower than a test's default wait, and is not what these tests are about.
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
    it("renders the workspace in the app, not in a frame, against the harness proxy", async () => {
        renderApp("/chat", { compact: false });
        await screen.findByRole("region", { name: "Agent conversation" });
        expect(document.querySelector("iframe")).toBeNull();
        expect(await screen.findByText("There is 120 GB free on C:.")).toBeInTheDocument();

        const first = server.harness.calls.find((call) => call.path === "/api/runs");
        expect(first?.headers["x-pikvm-workspace"]).toBe("1");
        expect(server.harness.calls.every((call) => call.headers["x-pikvm-workspace"] === "1")).toBe(true);
    });

    it("explains what to do when the host cannot reach the agent, and recovers on Check again", async () => {
        const user = userEvent.setup();
        server.chat = false;
        renderApp("/chat");
        expect(await screen.findByRole("heading", { name: "Chat is not available" })).toBeInTheDocument();
        expect(server.harness.calls).toHaveLength(0);

        server.chat = true;
        await user.click(screen.getByRole("button", { name: "Check again" }));
        await screen.findByRole("region", { name: "Agent conversation" });
    });

    it("shows a retry, not a workspace, when the app state cannot be loaded", async () => {
        server.stateStatus = 500;
        renderApp("/chat");
        expect(await screen.findByRole("heading", { name: "Cannot reach the app server" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });

    it.each([502, 503])("says the agent is not running when the proxy answers %i", async (status) => {
        server.harness.status = status;
        renderApp("/chat");
        const alert = await screen.findByRole("alert");
        expect(within(alert).getByRole("heading", { name: "The agent is not running" })).toBeInTheDocument();
        expect(alert).toHaveTextContent(String(status));
        expect(screen.queryByRole("region", { name: "Agent conversation" })).toBeNull();
    });

    it("uses the phone layout the shell chose, with the safe areas left to the shell", async () => {
        renderApp("/chat", { compact: true });
        await screen.findByRole("region", { name: "Agent conversation" });
        const root = document.querySelector(".workspace-shell");
        expect(root).toHaveAttribute("data-layout", "compact");
        expect(root).toHaveAttribute("data-insets", "host");
        expect(screen.getByRole("button", { name: "Open tasks" })).toBeInTheDocument();
        // The shell's own bar is still there.
        expect(screen.getByRole("tab", { name: /chat/i })).toBeInTheDocument();
    });

    it("uses the rail on a wide screen", async () => {
        renderApp("/chat", { compact: false });
        await screen.findByRole("region", { name: "Agent conversation" });
        expect(document.querySelector(".workspace-shell")).toHaveAttribute("data-layout", "wide");
        await waitFor(() => expect(document.querySelector(".workspace-rail")).not.toBeNull());
    });
});
