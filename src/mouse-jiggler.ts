/**
 * Native, server-side mouse jiggler.
 *
 * When neither the user nor the agent has touched the mouse/keyboard for a while,
 * nudge the cursor and put it back so the target machine doesn't sleep / lock / blank
 * its display. It:
 *   - nudges via control.mouseNudge, which nets back to exactly where the cursor was
 *     using whichever HID mode the target is in (relative deltas, or a real jog of
 *     absolute movement when the Pi is absolute-only — the common default);
 *   - locks out agent operations while it jiggles (the runner's gate awaits us), and
 *     unlocks the instant it's done;
 *   - never jiggles while the agent is working or the user is active;
 *   - reports what it is doing (`status()` + `[jiggler]` log lines) so "it doesn't
 *     seem to work" is answerable with evidence instead of a guess.
 */

/** The slice of PiKvmControl the jiggler needs. A narrow seam so this is testable
 *  without a live Pi (PiKvmControl satisfies it structurally). */
export interface JigglerControl {
    /** When any HID input was last sent through the control core (ms epoch). */
    lastInputAt(): number;
    /** Move the cursor and put it back, in whichever HID mode the target is in. */
    mouseNudge(px?: number): Promise<void>;
    /** Is the HID actually attached to the target? undefined = unknown. */
    isHidOnline?: () => boolean | undefined;
}

export interface JigglerDeps {
    control: JigglerControl;
    /** User toggle. */
    enabled: () => boolean;
    /** True while the agent is mid-run — never jiggle then. */
    isAgentBusy: () => boolean;
    log?: (line: string) => void;
}

export interface JigglerStatus {
    enabled: boolean;
    /** ms epoch of the last successful nudge, 0 if we have never managed one. */
    lastNudgeAt: number;
    nudges: number;
    /** Consecutive failures since the last successful nudge. */
    failures: number;
    /** Why the last nudge failed, if it did. */
    lastError?: string;
}

export class MouseJiggler {
    private timer: NodeJS.Timeout | undefined;
    private jiggling = false;
    private jiggleDone: Promise<void> = Promise.resolve();
    private resolveJiggle: (() => void) | null = null;
    private lastUserActivity = 0;
    private lastNudgeAt = 0;
    private nudges = 0;
    private failures = 0;
    private lastError: string | undefined;
    private lastNudgeLogAt = 0;

    /** Jiggle after this much inactivity. Deliberately under a minute: the shortest
     *  display-blank timeouts in the wild are one minute, and a nudge that lands after
     *  the screen has already gone is a nudge that arrived too late. */
    private readonly IDLE_MS = 45_000;
    private readonly CHECK_MS = 10_000;
    /** Don't log a routine nudge more than this often — one line every 45s forever is
     *  noise, but total silence is what made this impossible to diagnose. */
    private readonly NUDGE_LOG_MS = 10 * 60_000;

    constructor(private readonly deps: JigglerDeps) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), this.CHECK_MS);
        if (this.timer.unref) this.timer.unref();
        this.log(`watching for idle — nudging after ${Math.round(this.IDLE_MS / 1000)}s (enabled: ${this.deps.enabled()})`);
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

    status(): JigglerStatus {
        return {
            enabled: this.deps.enabled(),
            lastNudgeAt: this.lastNudgeAt,
            nudges: this.nudges,
            failures: this.failures,
            ...(this.lastError ? { lastError: this.lastError } : {}),
        };
    }

    private log(line: string): void {
        this.deps.log?.(`[jiggler] ${line}`);
    }

    private lastActivity(): number {
        // Our own nudge bumps the control core's input clock, so this doubles as the
        // "when did we last jiggle" anchor: the cadence settles at one nudge per IDLE_MS.
        return Math.max(this.lastUserActivity, this.deps.control.lastInputAt());
    }

    private async tick(): Promise<void> {
        if (this.jiggling || !this.deps.enabled() || this.deps.isAgentBusy()) return;
        const idle = Date.now() - this.lastActivity();
        if (idle < this.IDLE_MS) return;
        await this.jiggle(idle);
    }

    private async jiggle(idleMs: number): Promise<void> {
        this.jiggling = true;
        this.jiggleDone = new Promise((r) => (this.resolveJiggle = r));
        try {
            // A detached HID swallows everything we send, so say so rather than
            // counting a nudge that never reached the target.
            if (this.deps.control.isHidOnline?.() === false) throw new Error("HID is detached from the target");
            await this.deps.control.mouseNudge();
            const recovered = this.failures > 0;
            this.failures = 0;
            this.lastError = undefined;
            this.lastNudgeAt = Date.now();
            this.nudges++;
            if (recovered || this.lastNudgeAt - this.lastNudgeLogAt > this.NUDGE_LOG_MS) {
                this.lastNudgeLogAt = this.lastNudgeAt;
                this.log(`nudged after ${Math.round(idleMs / 1000)}s idle (${this.nudges} total)`);
            }
        } catch (e) {
            // Best-effort — a failed jiggle must never disturb anything. But it must be
            // visible: a silent catch here is why this looked like it was doing nothing.
            this.failures++;
            this.lastError = e instanceof Error ? e.message : String(e);
            if (this.failures === 1 || this.failures % 10 === 0) {
                this.log(`nudge failed (${this.failures}x): ${this.lastError}`);
            }
        } finally {
            this.jiggling = false;
            this.resolveJiggle?.();
            this.resolveJiggle = null;
        }
    }
}
