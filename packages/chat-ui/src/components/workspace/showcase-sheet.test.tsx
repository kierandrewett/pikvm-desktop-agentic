// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ShowcaseCampaign } from "../../types";

const { harnessJson, harnessBlob } = vi.hoisted(() => ({
  harnessJson: vi.fn(),
  harnessBlob: vi.fn(),
}));

vi.mock("../../lib/harness-api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/harness-api")>(
    "../../lib/harness-api",
  );
  return {
    ...actual,
    harnessJson,
    harnessBlob,
  };
});

import { ShowcaseSheet } from "./showcase-sheet";

const campaign: ShowcaseCampaign = {
  schema_version: 1,
  campaign_id: "codex-windows-50",
  title: "50 real Codex tasks on a clean Windows VM",
  status: "running",
  model: { provider: "codex-fast" },
  isolation: { reboot_after_every_task: true },
  total: 50,
  completed: 1,
  passed: 1,
  failed: 0,
  current_task_id: "calc-01",
  current_run_id: "run-live",
  updated_at: "2026-07-29T20:00:00Z",
  tasks: [
    {
      task_id: "observe-01",
      title: "Describe the clean desktop",
      category: "Observation",
      prompt: "Describe the desktop.",
      mutates_workspace: false,
      status: "passed",
      run_id: "run-done",
      duration_ms: 12_000,
      result: { status: "completed", event_count: 8 },
      reboot: {
        status: "ready",
        duration_ms: 31_000,
        transition_observed: true,
      },
      recording: "observe-01/recording.mp4",
      poster: "observe-01/poster.jpg",
    },
    {
      task_id: "calc-01",
      title: "Multiply 37 by 19",
      category: "Calculator",
      prompt: "Use Calculator.",
      mutates_workspace: false,
      status: "running",
      run_id: "run-live",
      result: { status: "executing", event_count: 4 },
      reboot: {
        status: "pending",
        transition_observed: false,
      },
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  };
  URL.createObjectURL = vi.fn(() => "blob:showcase");
  URL.revokeObjectURL = vi.fn();
});

describe("ShowcaseSheet", () => {
  it("shows compact live progress and the current Windows task", async () => {
    harnessJson.mockResolvedValue(campaign);
    harnessBlob.mockResolvedValue(new Blob(["frame"], { type: "image/jpeg" }));

    render(
      <ShowcaseSheet
        open
        onOpenChange={vi.fn()}
        token="workspace-token"
      />,
    );

    expect(
      await screen.findByText("50 real Codex tasks on a clean Windows VM"),
    ).toBeVisible();
    expect(screen.getByText("1 / 50")).toBeVisible();
    expect(screen.getByText("1 passed")).toBeVisible();
    expect(screen.getByText("reboot after every task")).toBeVisible();
    expect(screen.getByText("Describe the clean desktop")).toBeVisible();
    expect(screen.getAllByText("Multiply 37 by 19")).toHaveLength(2);
    expect(screen.getByText("Live")).toBeVisible();
    expect(screen.getByText("Task 2 of 50")).toBeVisible();
    await waitFor(() => {
      expect(
        screen.getByAltText("Live Windows screen for Multiply 37 by 19"),
      ).toBeVisible();
    });
  });
  it("says so rather than throwing when the daemon sends a shape it cannot read", async () => {
    /* The type says `tasks` is an array; the wire does not. This panel ships
       inside the desktop app while the daemon is a separate process on its own
       release cadence, so either can be newer — and an answer without a tasks
       array threw during render ("TypeError: e.tasks is not iterable"), which
       took the whole workspace down, conversation and composer included, over a
       panel opened out of curiosity. Measured over CDP against a daemon
       answering {ok: true}: #root replaced by the root boundary's message. */
    harnessJson.mockResolvedValue({ ok: true });

    render(
      <ShowcaseSheet open onOpenChange={vi.fn()} token="workspace-token" />,
    );

    expect(await screen.findByText("Evidence feed unavailable")).toBeVisible();
    expect(
      screen.getByText(/version mismatch between the two/),
    ).toBeVisible();
  });

  it("reads a campaign that arrives with no tasks yet", async () => {
    // An empty array is a real state, not a bad shape: a campaign that has not
    // started. It must not be mistaken for the mismatch above.
    harnessJson.mockResolvedValue({ ...campaign, tasks: [], current_task_id: null });

    render(
      <ShowcaseSheet open onOpenChange={vi.fn()} token="workspace-token" />,
    );

    expect(
      await screen.findByText("50 real Codex tasks on a clean Windows VM"),
    ).toBeVisible();
    expect(screen.queryByText("Evidence feed unavailable")).toBeNull();
  });
});
