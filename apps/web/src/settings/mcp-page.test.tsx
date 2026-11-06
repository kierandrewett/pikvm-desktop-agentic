/**
 * Failure modes: the page is not reachable from Settings; it shows an address that is not this host's MCP endpoint, a setup command that
 * is not what the client's CLI takes (checked by hand against `claude mcp add --help` and `codex mcp add --help`), or a credential.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultServer, installFakeServer, renderApp } from "../test/harness";

beforeEach(() => installFakeServer(defaultServer()));
afterEach(() => vi.unstubAllGlobals());

describe("the MCP server page", () => {
    it("is at /settings/mcp, shows this host's endpoint and the verified setup commands, and no credential", async () => {
        renderApp("/settings/mcp", { compact: false });
        await screen.findByRole("heading", { name: "MCP server" });
        const address = `${window.location.origin}/app/mcp`;
        const user = userEvent.setup();
        const shown = () => document.body.textContent ?? "";
        expect(shown()).toContain(`claude mcp add --transport http pikvm ${address}`);
        await user.click(screen.getByRole("radio", { name: "Codex" }));
        expect(shown()).toContain(`codex mcp add pikvm --url ${address}`);
        expect(shown()).toContain("codex mcp login pikvm");
        await user.click(screen.getByRole("radio", { name: "Cursor" }));
        expect(shown()).toContain('"mcpServers"');
        expect(shown()).not.toMatch(/pkd_|sk-/);
    });
});
