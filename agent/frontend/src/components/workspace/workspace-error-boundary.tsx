import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last thing between a render error and an empty panel.
 *
 * There was no boundary anywhere in this app, so a single throw during render
 * unmounted the whole tree and left the conversation pane blank — no message,
 * no retry, nothing to distinguish it from a pane that had simply not loaded.
 * Measured with the daemon answering /api/runs with an object where the app
 * types RunSummary[]: `runs.map is not a function` inside a useMemo, `#root`
 * left with zero children, and not a word on screen.
 *
 * What makes that worse than an ordinary crash is the titlebar beside it. The
 * readiness pill polls /daemon/status, which was answering perfectly well, so
 * the window said "Agent ready" over a pane showing nothing at all. Two parts
 * of the same window disagreeing, with the confident one wrong.
 *
 * A shape mismatch is the realistic way in: this bundle ships inside the
 * desktop app while the daemon is a separate process on its own release
 * cadence, so one can be newer than the other. The boundary does not fix that —
 * it just makes the window say so rather than going quiet.
 */
type Props = {
    children: ReactNode;
    /**
     * What broke, in the user's terms. Defaults to the conversation because
     * that is what the root boundary guards.
     *
     * Named because one boundary at the root is not enough: opening the
     * Recorded proof sheet against a daemon that answered its endpoint with a
     * different shape threw during render, and with nothing between that sheet
     * and the root the whole workspace went — conversation, sidebar, composer —
     * over a panel someone opened out of curiosity. A sheet should fail inside
     * itself.
     */
    title?: string;
    description?: string;
    /** Distinguishes the console line when several boundaries are in play. */
    scope?: string;
    /**
     * Draw the failure somewhere other than in place.
     *
     * A sheet's boundary needs this: its children render at the end of the
     * shell's tree, so the default centred panel would appear loose in the
     * layout with nothing to close. The sheet supplies its own frame instead,
     * and `reset` is what its Close is wired to.
     */
    fallback?: (error: Error, reset: () => void) => ReactNode;
};
type State = { error: Error | null };

const DEFAULT_TITLE = "The conversation could not be displayed";
const DEFAULT_DESCRIPTION =
    "The agent daemon answered with something this panel did not understand. It is usually a version mismatch between the two.";

export class WorkspaceErrorBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        // Kept on the console for a bug report; the panel itself stays readable.
        console.error(`[${this.props.scope ?? "workspace"}] render failed`, error, info.componentStack);
    }

    private readonly reset = (): void => {
        this.setState({ error: null });
    };

    render(): ReactNode {
        const { error } = this.state;
        if (!error) return this.props.children;
        if (this.props.fallback) return this.props.fallback(error, this.reset);
        return (
            <div
                role="alert"
                className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center"
            >
                <p className="text-base font-medium text-foreground">
                    {this.props.title ?? DEFAULT_TITLE}
                </p>
                {/* Named plainly rather than "something went wrong": the usual
                    cause is this panel and the daemon being different versions,
                    and saying so is the difference between a shrug and a lead. */}
                <p className="max-w-sm text-sm text-muted-foreground">
                    {this.props.description ?? DEFAULT_DESCRIPTION}
                </p>
                <p className="max-w-sm font-mono text-xs break-words text-muted-foreground/80">
                    {error.message}
                </p>
                <button
                    type="button"
                    className="mt-1 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted"
                    onClick={this.reset}
                >
                    Try again
                </button>
            </div>
        );
    }
}
