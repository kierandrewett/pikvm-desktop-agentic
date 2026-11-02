/**
 * Tell the agent daemon where the USER just moved the cursor (kvmd units, -32768..32767), so its
 * tracked position follows manual moves: kvmd does not broadcast position, so this is the only
 * way the daemon can observe them. Debounced and best-effort; only the desktop app has a daemon
 * behind `/app/daemon`, and the proxy refuses a request without the workspace header.
 */

import type { Clock } from "@pikvm/kvm-engine";

export const CURSOR_REPORT_MS = 180;
export const CURSOR_REPORT_PATH = "/app/daemon/cursor";

export interface CursorReporter {
    report(x: number, y: number): void;
    dispose(): void;
}

export function createCursorReporter(clock: Clock, fetchImpl: typeof fetch = (...a) => fetch(...a)): CursorReporter {
    let pending: { x: number; y: number } | null = null;
    let cancel: (() => void) | null = null;
    return {
        report(x, y) {
            pending = { x: Math.round(x), y: Math.round(y) };
            if (cancel) return;
            cancel = clock.setTimeout(() => {
                cancel = null;
                const body = pending;
                pending = null;
                if (!body) return;
                fetchImpl(CURSOR_REPORT_PATH, {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-pikvm-workspace": "1" },
                    body: JSON.stringify(body),
                    keepalive: true,
                }).catch(() => {});
            }, CURSOR_REPORT_MS);
        },
        dispose() {
            cancel?.();
            cancel = null;
            pending = null;
        },
    };
}
