/** Small, Electron-independent state machine for the embedded harness view. */

export class HarnessViewLifecycle {
    private authBootstrapIssued = false;
    private currentLoadFailed = false;
    private retryTimer: NodeJS.Timeout | null = null;
    private assetReloadTimer: NodeJS.Timeout | null = null;
    private consecutiveFailures = 0;

    constructor(
        private readonly url: string,
        private readonly retryDelayMs = 500,
        private readonly assetReloadDelayMs = 800,
        private readonly maxRetryDelayMs = 15_000,
    ) {}

    /**
     * Failed loads since the last successful one. A harness that is still
     * starting fails a couple of times and recovers; one that cannot start at
     * all, because another instance already owns its port, fails forever. The
     * count is what tells those apart, so the view can keep quiet about the
     * first and explain itself about the second.
     */
    failureCount(): number {
        return this.consecutiveFailures;
    }

    /**
     * The renderer needs one reload after Electron seeds its non-secret auth
     * sentinel. Track that in the desktop process: a full navigation is allowed
     * to replace renderer storage, but must never create a reload loop.
     */
    shouldBootstrapAuth(currentUrl: string): boolean {
        if (
            this.currentLoadFailed ||
            !currentUrl.startsWith(this.url) ||
            this.authBootstrapIssued
        ) {
            return false;
        }
        this.authBootstrapIssued = true;
        return true;
    }

    beginLoad(): void {
        this.currentLoadFailed = false;
    }

    failed(): void {
        this.currentLoadFailed = true;
        this.consecutiveFailures += 1;
    }

    /**
     * Coalesce a burst of initial connection failures into one retry, backing
     * off as the streak grows. A harness that will never start was otherwise
     * retried twice a second for as long as the app stayed open.
     */
    /**
     * How long the next retry would wait, in milliseconds.
     *
     * Exposed so the backoff can be asserted on directly. Timing it with a
     * stopwatch instead made the test flaky: with a 10ms base and a 40ms cap,
     * an overloaded scheduler can fire the first timer at 45ms and the fourth
     * at 42ms, and "the fourth waits longer than the first" then fails on a
     * schedule that is perfectly correct.
     */
    nextRetryDelayMs(): number {
        return Math.min(
            this.retryDelayMs * 2 ** Math.max(0, this.consecutiveFailures - 1),
            this.maxRetryDelayMs,
        );
    }

    scheduleRetry(reload: () => void): void {
        if (this.retryTimer) return;
        const delay = this.nextRetryDelayMs();
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            reload();
        }, delay);
    }

    loaded(): void {
        this.consecutiveFailures = 0;
        if (!this.retryTimer) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }

    /** Collapse a build's many filesystem events into one cache-bypassing reload. */
    scheduleAssetReload(reload: () => void): void {
        if (this.assetReloadTimer) {
            clearTimeout(this.assetReloadTimer);
        }
        this.assetReloadTimer = setTimeout(() => {
            this.assetReloadTimer = null;
            reload();
        }, this.assetReloadDelayMs);
    }

    stop(): void {
        this.loaded();
        if (!this.assetReloadTimer) return;
        clearTimeout(this.assetReloadTimer);
        this.assetReloadTimer = null;
    }
}
