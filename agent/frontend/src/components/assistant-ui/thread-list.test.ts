import { describe, expect, it } from "vitest";
import {
  runStateLabel,
  runUpdatedAtRaw,
  shouldOfferTaskSearch,
} from "./thread-list";

describe("shouldOfferTaskSearch", () => {
  it("keeps the field away from a list you can already read", () => {
    // The case that prompted this: one task, and a "Search tasks" box above it.
    expect(shouldOfferTaskSearch(0)).toBe(false);
    expect(shouldOfferTaskSearch(1)).toBe(false);
    expect(shouldOfferTaskSearch(7)).toBe(false);
  });

  it("offers it once the list is long enough to be worth searching", () => {
    expect(shouldOfferTaskSearch(8)).toBe(true);
    expect(shouldOfferTaskSearch(40)).toBe(true);
  });
});

describe("task list run metadata", () => {
  /* The list is the one place you go to find a task again, and it showed
     nothing but a truncated title. Seen with five runs open — failed, aborted,
     blocked, rejected and paused — as five identical rows.

     The relative time and the Today/Yesterday grouping were already written and
     styled, reading item.lastMessageAt. ExternalStoreThreadData has no such
     field, so the external-store runtime can never set it and both had been
     dark since they were added. `custom` is what the adapter can populate. */
  it("reads when a task last moved out of the adapter's custom record", () => {
    expect(runUpdatedAtRaw({ updatedAt: "2026-08-06T09:47:19.722Z" })).toBe(
      "2026-08-06T09:47:19.722Z",
    );
    expect(runUpdatedAtRaw({})).toBeUndefined();
    expect(runUpdatedAtRaw(undefined)).toBeUndefined();
    // Not a Date: useThreadListItem compares what the selector returns, and a
    // fresh object every call re-rendered forever — the panel came up on the
    // root error boundary instead of a task list.
    expect(typeof runUpdatedAtRaw({ updatedAt: "2026-08-06T09:47:19.722Z" })).toBe(
      "string",
    );
  });

  it("marks only the states worth interrupting a scan for", () => {
    expect(runStateLabel({ runStatus: "failed" })).toMatchObject({
      label: "Failed",
      tone: "attention",
    });
    expect(runStateLabel({ runStatus: "needs_approval" })).toMatchObject({
      label: "Review",
      tone: "attention",
    });
    expect(runStateLabel({ runStatus: "blocked" })).toMatchObject({
      label: "Blocked",
      tone: "attention",
    });
    expect(runStateLabel({ runStatus: "aborted" })).toMatchObject({
      label: "Stopped",
      tone: "muted",
    });
    expect(runStateLabel({ runStatus: "rejected" })).toMatchObject({
      label: "Denied",
      tone: "muted",
    });
    expect(runStateLabel({ runStatus: "paused" })).toMatchObject({
      label: "Paused",
      tone: "muted",
    });
  });

  it("says nothing for the ordinary states", () => {
    // Marking every row would make the marker mean nothing.
    expect(runStateLabel({ runStatus: "running" })).toBeUndefined();
    expect(runStateLabel({ runStatus: "completed" })).toBeUndefined();
    expect(runStateLabel({ runStatus: "queued" })).toBeUndefined();
    expect(runStateLabel({})).toBeUndefined();
    expect(runStateLabel(undefined)).toBeUndefined();
  });
});
