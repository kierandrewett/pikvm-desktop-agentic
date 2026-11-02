// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ToolFallbackRoot,
  ToolFallbackTrigger,
} from "./tool-fallback";

afterEach(cleanup);

const trigger = (status: Parameters<typeof ToolFallbackTrigger>[0]["status"]) =>
  render(
    <ToolFallbackRoot>
      <ToolFallbackTrigger toolName="mail.send" status={status} />
    </ToolFallbackRoot>,
  );

describe("ToolFallbackTrigger", () => {
  it("does not claim a tool ran while it is still waiting to be allowed", () => {
    /* "Used tool: mail.send" sat above a pair of Allow once / Deny & stop
       buttons. The tool had not been used and would not be until the operator
       decided — and this is the renderer every non-computer MCP tool uses,
       which is where the side-effecting ones live. The computer renderer beside
       it has always said "Approval needed" for the same state. */
    trigger({ type: "requires-action", reason: "interrupt" });

    expect(screen.getByText("Approval needed:")).toBeVisible();
    expect(screen.queryByText("Used tool:")).toBeNull();
  });

  it("still says used for a tool that has actually run", () => {
    trigger({ type: "complete" });

    expect(screen.getByText("Used tool:")).toBeVisible();
  });

  it("keeps its own wording for a cancelled call", () => {
    trigger({ type: "incomplete", reason: "cancelled" });

    expect(screen.getByText("Cancelled tool:")).toBeVisible();
  });
});
