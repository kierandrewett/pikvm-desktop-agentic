// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolFallbackReceipt } from "@/components/assistant-ui/tool-fallback";

const SEARCH_RESULT = JSON.stringify({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        title: "Download Python | Python.org",
        href: "https://www.python.org/downloads/",
      }),
    },
  ],
  structured_content: {
    result: Array.from({ length: 5 }, (_, index) => ({
      title: `Result ${index + 1}`,
      href: `https://example.test/${index + 1}`,
    })),
  },
});

// Without this each render stacked in the same document, so a second case
// asserting the same string as the first failed on "found multiple elements"
// rather than on the behaviour under test.
afterEach(cleanup);

describe("ToolFallbackReceipt", () => {
  it("summarizes a search response and keeps exact evidence behind Details", () => {
    render(
      <ToolFallbackReceipt
        toolName="web.search_text"
        argsText={JSON.stringify({
          query: "python.org latest stable Python release download",
          max_results: 5,
        })}
        result={SEARCH_RESULT}
      />,
    );

    expect(screen.getByText("5 results returned")).toBeVisible();
    expect(screen.getByText("Query")).toBeVisible();
    expect(
      screen.getByText("python.org latest stable Python release download"),
    ).toBeVisible();
    expect(screen.getByText("Max results")).toBeVisible();

    const details = screen.getByRole("button", { name: "Details" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Result:")).toBeNull();

    fireEvent.click(details);

    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Exact arguments")).toBeVisible();
    expect(screen.getByText("Raw result")).toBeVisible();
    expect(screen.getByText(SEARCH_RESULT)).toBeVisible();
  });

  it("summarizes structured completion without inventing verification", () => {
    render(
      <ToolFallbackReceipt
        toolName="files.inspect"
        argsText='{"path":"report.xlsx"}'
        result={{ status: "completed" }}
      />,
    );

    expect(screen.getByText("Completed")).toBeVisible();
    expect(screen.queryByText("Verified")).toBeNull();
  });
  it("says it is held for approval rather than waiting for a result", () => {
    /* resultSummary only sees the result, and an absent one read "Waiting for
       result" — the largest text in the block, printed directly above Allow
       once / Deny & stop. Nothing was waiting on a result: nothing had run, and
       nothing would until the operator decided. Measured against a run parked
       on a mail.send gate, on the screen where an operator authorises an action
       against a real machine. "Held for approval" is the computer renderer's
       own word for the same state, so the two now agree. */
    render(
      <ToolFallbackReceipt
        toolName="mail.send"
        argsText={JSON.stringify({ to: "oncall@example.test" })}
        awaitingApproval
      />,
    );

    expect(screen.getByText("Held for approval")).toBeVisible();
    expect(screen.queryByText("Waiting for result")).toBeNull();
    // The arguments still show: they are what the decision is about.
    expect(screen.getByText("oncall@example.test")).toBeVisible();
  });

  it("keeps waiting for a result when a tool really is running", () => {
    render(
      <ToolFallbackReceipt
        toolName="mail.send"
        argsText={JSON.stringify({ to: "oncall@example.test" })}
      />,
    );

    expect(screen.getByText("Waiting for result")).toBeVisible();
  });
});
