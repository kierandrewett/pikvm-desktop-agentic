import { PlugZapIcon, RefreshCwIcon } from "lucide-react";
import { agentIsDown, type ConnectFailure } from "../../hooks/use-harness-workspace";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

/**
 * What the workspace says when it cannot reach the agent.
 *
 * A managed host (the PiKVM app) never asks for a token, so a failed connection has no
 * dialog to fall back on: this is the whole screen. It tells "the agent behind the host
 * is not running" (502/503/504, or no answer at all) from "the host refused the request"
 * (401/403) and from anything else, because each has a different next step, and it keeps
 * asking in the background (see useHarnessWorkspace) so a desktop app that is still
 * starting its agent just works once it is up.
 */
export function HarnessUnavailable({
  failure,
  connecting,
  onRetry,
}: {
  failure: ConnectFailure | null;
  connecting: boolean;
  onRetry: () => void;
}) {
  if (connecting && failure === null) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"
        role="status"
        aria-label="Connecting to the agent"
      >
        <Spinner className="size-5" />
        <p>Connecting to the agent…</p>
      </div>
    );
  }

  const down = agentIsDown(failure);
  const refused = failure?.status === 401 || failure?.status === 403;
  const heading = down
    ? "The agent is not running"
    : refused
      ? "Chat was refused"
      : "Chat could not connect";
  const advice = down
    ? "The app server is up, but the agent behind it is not answering. Start the PiKVM desktop app and keep it running; this page reconnects on its own."
    : refused
      ? "The app server did not accept this request. Sign in again, then retry."
      : "Something unexpected came back from the app server.";

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      role="alert"
      data-slot="harness-unavailable"
      data-reason={down ? "agent-down" : refused ? "refused" : "error"}
    >
      <PlugZapIcon className="size-6 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-base font-semibold text-foreground">{heading}</h1>
      <p className="max-w-[38ch] text-muted-foreground">{advice}</p>
      {failure ? (
        <p className="max-w-[44ch] font-mono text-xs break-words text-muted-foreground/80">
          {failure.status ? `${failure.status}: ` : ""}
          {failure.message}
        </p>
      ) : null}
      <Button type="button" onClick={onRetry} disabled={connecting} className="min-h-11 px-4">
        <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
        Try again
      </Button>
    </div>
  );
}
