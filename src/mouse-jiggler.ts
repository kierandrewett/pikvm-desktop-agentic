/**
 * Native, server-side mouse jiggler.
 *
 * When neither the user nor the agent has touched the mouse/keyboard for a while,
 * nudge the cursor a hair and put it back so the target machine doesn't sleep / lock
 * / show a screensaver. It:
 *   - tracks the LAST cursor position from BOTH the agent (control core) and the user
 *     (parsed off the HID WebSocket in the proxy) so it can restore EXACTLY where the
 *     cursor was before the jiggle;
 *   - locks out agent operations while it jiggles (the runner's gate awaits us), and
 *     unlocks the instant it's done;
 *   - never jiggles while the agent is actually working.
 */

import type { PiKvmControl } from "./pikvm-control";

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

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
    private lastUserPos: { x: number; y: number } | null = null;

    private readonly IDLE_MS = 60_000; // jiggle after this much inactivity
    private readonly CHECK_MS = 10_000; // how often we check
    private readonly DELTA_NORM = 1200; // nudge size in HID units (±32767 full span)

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

    /** Fed by the proxy's HID tap on any user input — `pos` is set for a mouse_move
     *  (HID-normalized ±32767, the same units the agent uses). */
    noteUserActivity(pos: { x: number; y: number } | null): void {
        this.lastUserActivity = Date.now();
        if (pos) this.lastUserPos = pos;
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
    /** Where the cursor actually is now: whichever of user / agent moved it last. */
    private currentPos(): { x: number; y: number } {
        if (this.lastUserPos && this.lastUserActivity >= this.deps.control.lastInputAt()) return this.lastUserPos;
        return this.deps.control.currentMouseNorm();
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
            const pos = this.currentPos();
            // Nudge toward whichever side has room, then land exactly back on `pos`.
            const dx = pos.x + this.DELTA_NORM <= 32767 ? this.DELTA_NORM : -this.DELTA_NORM;
            await this.deps.control.moveInstantNorm(pos.x + dx, pos.y);
            await sleep(160);
            await this.deps.control.moveInstantNorm(pos.x, pos.y); // restore to the original spot
        } catch {
            /* best-effort — the jiggle must never disturb anything */
        } finally {
            this.jiggling = false;
            this.resolveJiggle?.();
            this.resolveJiggle = null;
        }
    }
}
