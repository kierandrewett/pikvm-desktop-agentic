/** Small, Electron-independent state machine for the embedded harness view. */

export class HarnessViewLifecycle {
    private authBootstrapIssued = false;
    private currentLoadFailed = false;
    private retryTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly url: string,
        private readonly retryDelayMs = 500,
    ) {}

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
    }

    /** Coalesce a burst of initial connection failures into one retry. */
    scheduleRetry(reload: () => void): void {
        if (this.retryTimer) return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            reload();
        }, this.retryDelayMs);
    }

    loaded(): void {
        if (!this.retryTimer) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }

    stop(): void {
        this.loaded();
    }
}
