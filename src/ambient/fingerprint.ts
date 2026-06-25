/**
 * Perceptual-fingerprint maths, shared by the ambient monitor (screen-change
 * detection) and the control core (settle-gating reads / verifying action effects).
 *
 * A "fingerprint" is a tiny grayscale bitmap of the live frame (e.g. 16x16),
 * captured cheaply by `PiKvmControl.captureFingerprint`. Keeping the maths +
 * thresholds in one place stops the monitor and the action settle-gate drifting
 * apart on calibration.
 */

/** Mean absolute difference of two fingerprints, normalised to 0..1. */
export function fpDiff(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    if (!n) return 1;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
    return sum / n / 255;
}

/** Spread of a fingerprint; near-zero ⇒ a blank/solid/"no signal" screen. */
export function fpVariance(a: Uint8Array): number {
    if (!a.length) return 0;
    let mean = 0;
    for (let i = 0; i < a.length; i++) mean += a[i]!;
    mean /= a.length;
    let v = 0;
    for (let i = 0; i < a.length; i++) v += (a[i]! - mean) ** 2;
    return Math.sqrt(v / a.length);
}

/* Settle thresholds (mean-abs fingerprint diff, 0..1). One source of truth so the
 * action settle-gate uses the same calibration as the ambient monitor. */
export const FP_MOVE = 0.04; // above this the screen is actively changing
export const FP_SETTLE = 0.015; // below this it has settled
export const FP_MEANINGFUL = 0.05; // a settled frame must differ this much from baseline to matter

export interface SettleResult {
    /** True once the screen held still long enough (or there's no fingerprint source). */
    ready: boolean;
    /** True if we gave up at the timeout on a still-moving screen (spinner/marquee). */
    stillAnimating: boolean;
    waitedMs: number;
}

export interface SettleOpts {
    timeoutMs?: number;
    pollMs?: number;
    /** Consecutive below-threshold frames required (Playwright's "two identical"). */
    k?: number;
    settle?: number;
    /** Injectable clock/sleep for deterministic tests. */
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll a fingerprint source until the frame stops changing — K CONSECUTIVE frames
 * below the settle threshold (not the first one, which can land mid-animation), or
 * a hard timeout. Resolves `ready` immediately if the source yields null (no
 * fingerprint wired) so callers degrade gracefully. Pure: clock + sleep injectable.
 */
export async function awaitSettled(capture: () => Promise<Uint8Array | null>, opts: SettleOpts = {}): Promise<SettleResult> {
    const timeoutMs = opts.timeoutMs ?? 1200;
    const pollMs = opts.pollMs ?? 150;
    const k = Math.max(1, opts.k ?? 2);
    const settle = opts.settle ?? FP_SETTLE;
    const now = opts.now ?? (() => Date.now());
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const start = now();
    let prev = await capture();
    if (!prev) return { ready: true, stillAnimating: false, waitedMs: 0 };
    let stable = 0;
    while (now() - start < timeoutMs) {
        await sleep(pollMs);
        const cur = await capture();
        if (!cur) return { ready: true, stillAnimating: false, waitedMs: now() - start };
        const d = fpDiff(prev, cur);
        prev = cur;
        if (d < settle) {
            if (++stable >= k) return { ready: true, stillAnimating: false, waitedMs: now() - start };
        } else {
            stable = 0;
        }
    }
    return { ready: false, stillAnimating: true, waitedMs: now() - start };
}
