/* Closing the app is not instant: the control server stops a recording cleanly, the transcriber and the agent programs, which takes
 * from a moment to a few seconds. The process keeps the single-instance lock for all of that time. A launch in that gap used to be
 * turned away by the lock and quit at once, then the first copy finished and exited: the person clicked the icon, nothing came up,
 * and the app was gone. The coordinator remembers such a launch and starts the app again as soon as the old copy has gone. */

export interface QuitDeps {
    /** Stops what the process started (the control server and its children). */
    shutdown(): Promise<void>;
    /** Starts a new copy of the app after this one has exited. */
    relaunch(): void;
    exit(): void;
    /** Gives up on a shutdown that does not finish. */
    setTimer(callback: () => void, ms: number): void;
}

export interface QuitCoordinator {
    /** The `will-quit` handler. Returns true when it started the stop (the caller prevents the quit and waits). */
    begin(): boolean;
    /** A second launch reached this copy. Returns true when it was kept for after the stop, false when the window should take the focus. */
    secondLaunch(): boolean;
    readonly stopping: boolean;
}

/** `limitMs`: the longest the stop may take before the process exits anyway. */
export function createQuitCoordinator(deps: QuitDeps, limitMs = 4000): QuitCoordinator {
    let stopping = false;
    let again = false;
    let finished = false;

    const finish = (): void => {
        if (finished) return;
        finished = true;
        if (again) deps.relaunch();
        deps.exit();
    };

    return {
        get stopping() {
            return stopping;
        },
        begin() {
            if (stopping) return false;
            stopping = true;
            deps.shutdown().then(finish, finish);
            deps.setTimer(finish, limitMs);
            return true;
        },
        secondLaunch() {
            if (!stopping) return false;
            again = true;
            return true;
        },
    };
}
