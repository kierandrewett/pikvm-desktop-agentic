import { Button } from "@/components/ui/button";

/**
 * The selected task, while it is coming back — or once it has failed to.
 *
 * The failure told the same story three times over: a destructive "Task
 * unavailable" badge in the header, this card, and between them an Alert
 * carrying whatever string the daemon put in `detail` — "no such run", lowercase
 * and unpunctuated, as the loudest text on screen. Reproduced by restarting the
 * daemon with a run id still in localStorage, which is the ordinary way to end
 * up here.
 *
 * So the card owns it. The daemon's own words are kept, because they are the
 * one useful lead in a bug report, but as small supporting detail rather than
 * the headline. And the copy named two actions the screen did not offer — the
 * composer is disabled in this state, so "retry it or start a new task" was
 * advice with nothing to press. Both are buttons now.
 */
export function TaskRestoreState({
  task,
  runId,
  restoring,
  detail,
  onRetry,
  onNewTask,
}: {
  task?: string;
  runId?: string | null;
  restoring: boolean;
  detail?: string;
  onRetry?: () => void;
  onNewTask?: () => void;
}) {
  return (
    <div
      className="mx-auto flex h-full w-full max-w-(--thread-max-width) flex-col justify-center px-6"
      role={restoring ? "status" : "alert"}
      aria-label={restoring ? "Restoring task" : "Task unavailable"}
    >
      <div className="mx-auto w-full max-w-md rounded-xl border border-border/70 bg-muted/20 p-5">
        <p className="text-sm font-medium">
          {restoring ? "Restoring task" : "Task unavailable"}
        </p>
        {/* A task whose conversation would not load has no title to show — the
            header's fallback is the literal words "New task", and printing that
            here read as the task's own name. The id is the one thing actually
            known about it, and it is what a bug report needs. */}
        {task ? (
          <p className="mt-2 truncate text-sm text-foreground">{task}</p>
        ) : runId ? (
          <p className="mt-2 truncate font-mono text-sm text-foreground">
            {runId}
          </p>
        ) : null}
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {restoring
            ? "Loading the saved conversation. No model work will restart."
            : "The saved conversation could not be loaded. It may have been cleared when the agent daemon restarted."}
        </p>
        {!restoring && detail ? (
          <p className="mt-2 font-mono text-xs break-words text-muted-foreground/80">
            {detail}
          </p>
        ) : null}
        {!restoring ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onRetry}>
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={onNewTask}>
              Start a new task
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
