// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRestoreState } from "@/components/workspace/task-restore-state";

afterEach(cleanup);

describe("TaskRestoreState", () => {
  it("offers the two actions its own copy names", () => {
    /* The card said "Retry it from the task list or start a new task" and
       offered neither. The composer is disabled in this state, so that was
       advice with nothing on screen to press: the only way out was the sidebar,
       which the copy did not mention. */
    const onRetry = vi.fn();
    const onNewTask = vi.fn();
    render(
      <TaskRestoreState
        task="Reboot the lab host"
        runId="r-42"
        restoring={false}
        onRetry={onRetry}
        onNewTask={onNewTask}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Start a new task" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onNewTask).toHaveBeenCalledOnce();
  });

  it("keeps the daemon's own words as detail rather than as the headline", () => {
    /* This failure used to be told three times over: a destructive badge in the
       header, this card, and between them an Alert carrying whatever string the
       daemon put in `detail`. Reproduced by restarting the daemon with a run id
       still in sessionStorage — the loudest text on screen was "no such run",
       lowercase and unpunctuated. The card owns the explanation now; the raw
       string stays because it is the one useful lead in a bug report. */
    render(
      <TaskRestoreState
        task="Reboot the lab host"
        runId="r-42"
        restoring={false}
        detail="no such run"
      />,
    );

    const card = screen.getByRole("alert", { name: "Task unavailable" });
    expect(card.textContent).toContain(
      "The saved conversation could not be loaded.",
    );
    expect(card.textContent).toContain("no such run");
    // The explanation comes first; the daemon's string is supporting detail.
    const text = card.textContent ?? "";
    expect(text.indexOf("could not be loaded")).toBeLessThan(
      text.indexOf("no such run"),
    );
  });

  it("shows the run id when the task has no title to show", () => {
    /* A task whose conversation would not load has no title, and the header's
       fallback is the literal words "New task" — printed here it read as the
       task's own name. The id is the one thing actually known about it. */
    render(<TaskRestoreState runId="r-gone-42" restoring={false} />);

    expect(screen.getByText("r-gone-42")).not.toBeNull();
    expect(screen.queryByText("New task")).toBeNull();
  });

  it("prefers a real task title over the id", () => {
    render(
      <TaskRestoreState
        task="Reboot the lab host"
        runId="r-42"
        restoring={false}
      />,
    );

    expect(screen.getByText("Reboot the lab host")).not.toBeNull();
    expect(screen.queryByText("r-42")).toBeNull();
  });

  it("stays a quiet status while the task is still coming back", () => {
    /* Restoring is not a failure: no alert, no actions, and nothing about the
       daemon — just what is happening and the promise that it costs nothing. */
    render(
      <TaskRestoreState
        task="Reboot the lab host"
        runId="r-42"
        restoring
        detail="no such run"
      />,
    );

    expect(screen.getByRole("status", { name: "Restoring task" })).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("no such run")).toBeNull();
    expect(
      screen.getByText(/No model work will restart/),
    ).not.toBeNull();
  });
});
