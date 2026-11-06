/**
 * Failure modes: the page is not reachable from Settings; it shows an address that is not this host's MCP endpoint, a setup command that
 * is not what the client's CLI takes (checked by hand against `claude mcp add --help` and `codex mcp add --help`), or a credential.
 */
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultServer, installFakeServer, renderApp } from "../test/harness";

beforeEach(() => installFakeServer(defaultServer()));
afterEach(() => vi.unstubAllGlobals());

describe("the MCP server page", () => {
    it("is at /settings/mcp, shows this host's endpoint and the verified setup commands, and no credential", async () => {
        renderApp("/settings/mcp", { compact: false });
        await screen.findByRole("heading", { name: "MCP server" });
        const address = `${window.location.origin}/app/mcp`;
        const text = document.body.textContent ?? "";
        expect(text).toContain(`claude mcp add --transport http pikvm ${address}`);
        expect(text).toContain(`codex mcp add pikvm --url ${address}`);
        expect(text).toContain('"mcpServers"');
        expect(text).not.toMatch(/pkd_|sk-/);
        expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(5);
    });
});
