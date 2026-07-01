/**
 * Native, server-side mouse jiggler.
 *
 * When neither the user nor the agent has touched the mouse/keyboard for a while,
 * nudge the cursor a hair and put it back so the target machine doesn't sleep / lock
 * / show a screensaver. It:
 *   - nudges via control.mouseNudge, which nets back to exactly where the cursor
 *     was using whichever HID mode the target is in (relative deltas, or a hair of
 *     absolute movement when the Pi is absolute-only — the common default);
 *   - locks out agent operations while it jiggles (the runner's gate awaits us), and
 *     unlocks the instant it's done;
 *   - never jiggles while the agent is working or the user is active.
 */

import type { PiKvmControl } from "./pikvm-control";

export interface JigglerDeps {
    control: PiKvmControl;
    /** User toggle. */
    enabled: () => boolean;
    /** True while the agent is mid-run — never jiggle then. */
    isAgentBusy: () => boolean;
}

export class MouseJiggler {
    private timer: NodeJS.Timeout | undefined;
    private jiggling = false;
    private jiggleDone: Promise<void> = Promise.resolve();
    private resolveJiggle: (() => void) | null = null;
    private lastUserActivity = 0;

    private readonly IDLE_MS = 60_000; // jiggle after this much inactivity
    private readonly CHECK_MS = 10_000; // how often we check
    private readonly NUDGE = 10; // relative nudge size (sent then undone)

    constructor(private readonly deps: JigglerDeps) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), this.CHECK_MS);
        if (this.timer.unref) this.timer.unref();
    }
    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    /** Fed by the proxy's HID tap on any user input. */
    noteUserActivity(): void {
        this.lastUserActivity = Date.now();
    }

    isJiggling(): boolean {
        return this.jiggling;
    }
    /** The runner's gate awaits this so no agent op runs mid-jiggle. */
    waitIfJiggling(): Promise<void> {
        return this.jiggling ? this.jiggleDone : Promise.resolve();
    }

    private lastActivity(): number {
        return Math.max(this.lastUserActivity, this.deps.control.lastInputAt());
    }

    private async tick(): Promise<void> {
        if (this.jiggling || !this.deps.enabled() || this.deps.isAgentBusy()) return;
        if (Date.now() - this.lastActivity() < this.IDLE_MS) return;
        await this.jiggle();
    }

    private async jiggle(): Promise<void> {
        this.jiggling = true;
        this.jiggleDone = new Promise((r) => (this.resolveJiggle = r));
        try {
            // Mode-aware nudge that nets to zero displacement: relative deltas when the
            // Pi is relative, a hair of absolute movement (off the last-known position,
            // then straight back) when it's absolute. A plain relative nudge is silently
            // ignored in absolute mode — the default — so the target would keep sleeping.
            await this.deps.control.mouseNudge(this.NUDGE);
        } catch {
            /* best-effort — the jiggle must never disturb anything */
        } finally {
            this.jiggling = false;
            this.resolveJiggle?.();
            this.resolveJiggle = null;
        }
    }
}
