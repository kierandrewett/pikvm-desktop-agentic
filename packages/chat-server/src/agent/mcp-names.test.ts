import { describe, expect, it } from "vitest";
import { mcpToolName } from "./mcp-names.ts";

describe("mcpToolName", () => {
    it("names a tool the way the runtime does", () => {
        expect(mcpToolName("pikvm", "screenshot")).toBe("mcp__pikvm_screenshot");
        expect(mcpToolName("My Server", "do-thing")).toBe("mcp__my_server_do_thing");
        expect(mcpToolName("git", "git_status")).toBe("mcp__git_status");
    });

    it("gives up on a name the runtime would hash, so a policy is never keyed to a wrong name", () => {
        expect(mcpToolName("server", "t".repeat(80))).toBeUndefined();
    });
});
