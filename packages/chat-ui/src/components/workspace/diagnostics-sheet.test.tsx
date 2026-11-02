// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsSheet } from "./diagnostics-sheet";
import type { RunSnapshot } from "../../types";

afterEach(cleanup);

const run = (over: Partial<RunSnapshot>): RunSnapshot =>
  ({
    run_id: "r-1",
    task: "Reboot the lab host",
    status: "running",
    origin: "managed",
    mode: "assistant",
    created_at: "2026-08-04T10:00:00Z",
    updated_at: "2026-08-04T10:00:00Z",
    event_count: 1,
    event_cursor: 1,
    error: null,
    conversation: [],
    operator_guidance: [],
    plan: null,
    events: [],
    timeline_events: [],
    observation: null,
    pending_action: null,
    pending_approval: null,
    verification_images: [],
    active_activity: null,
    ...over,
  }) as RunSnapshot;

describe("DiagnosticsSheet", () => {
  it("counts one event in the singular", () => {
    // A run always starts on its first event, so "1 events" beside "cursor 1"
    // was the ordinary reading of this sheet, not an edge case.
    render(
      <DiagnosticsSheet open onOpenChange={vi.fn()} run={run({ event_count: 1 })} />,
    );

    expect(screen.getByText("1 event")).toBeVisible();
    expect(screen.queryByText("1 events")).toBeNull();
  });

  it("counts anything else in the plural", () => {
    render(
      <DiagnosticsSheet open onOpenChange={vi.fn()} run={run({ event_count: 4 })} />,
    );

    expect(screen.getByText("4 events")).toBeVisible();
  });

  it("says why it is empty rather than showing a void", () => {
    /* There was an empty state for "no run selected" and none for a run with
       nothing to show, so the sheet was blank under a badge announcing how many
       events there were. Seen against a snapshot carrying event_count 1 and an
       empty events array, which the daemon can legitimately send: the count is
       the run's, the array is only what this snapshot carried. */
    render(
      <DiagnosticsSheet
        open
        onOpenChange={vi.fn()}
        run={run({ event_count: 1, events: [] })}
      />,
    );

    expect(
      screen.getByText(/This snapshot carried no events/),
    ).toBeVisible();
  });

  it("distinguishes a run that has recorded nothing at all", () => {
    render(
      <DiagnosticsSheet
        open
        onOpenChange={vi.fn()}
        run={run({ event_count: 0, events: [] })}
      />,
    );

    expect(
      screen.getByText("No events recorded for this task yet."),
    ).toBeVisible();
  });

  it("keeps its own empty state for no run at all", () => {
    render(<DiagnosticsSheet open onOpenChange={vi.fn()} run={null} />);

    expect(
      screen.getByText("Select a conversation to inspect its events."),
    ).toBeVisible();
  });

  it("builds at most the latest 250 events, newest first, and says it is a window", () => {
    const events = Array.from({ length: 400 }, (_, index) => ({
      sequence: index + 1,
      kind: "action.attempted",
      at: "2026-08-04T10:00:00Z",
      data: {},
    }));
    render(
      <DiagnosticsSheet
        open
        onOpenChange={vi.fn()}
        run={run({ event_count: 400, event_cursor: 400, events: events as RunSnapshot["events"] })}
      />,
    );

    const rows = document.querySelectorAll("details");
    expect(rows).toHaveLength(250);
    expect(rows[0]).toHaveTextContent("#400");
    expect(rows[249]).toHaveTextContent("#151");
    expect(screen.getByText("latest 250 shown")).toBeVisible();
  });

  it("builds nothing while closed", () => {
    const events = [{ sequence: 1, kind: "run.created", at: "2026-08-04T10:00:00Z", data: {} }];
    render(
      <DiagnosticsSheet
        open={false}
        onOpenChange={vi.fn()}
        run={run({ events: events as RunSnapshot["events"] })}
      />,
    );
    expect(document.querySelectorAll("details")).toHaveLength(0);
  });
});
