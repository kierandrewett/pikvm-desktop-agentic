/**
 * Proactive "suggested actions" watcher.
 *
 * A cheap, always-on screen watch (like the ambient monitor) that looks for ONE
 * clear, safe thing the agent could do for the user right now — e.g. a lock screen
 * → "Log in". It never calls a model per frame: a tiny grayscale fingerprint diff
 * gates it, so it only spends a vision call when the screen SETTLES into a new
 * state. When it finds something it emits a `suggestions` event; the console floats
 * a tappable card over the live screen and tapping it runs the agent immediately.
 *
 * Distinct from the ambient *monitor* (which is about notifying you of changes and
 * explicitly ignores lock screens): this is about offering to act.
 */

import { EventEmitter } from "events";
import type { PiKvmControl } from "../pikvm-control";

export interface Suggestion {
    id: string;
    /** ≤4-word action label shown on the button, e.g. "Log in". */
    title: string;
    /** One short clause of context, e.g. "Lock screen detected". */
    detail?: string;
    /** The instruction handed to the agent when the user taps the suggestion. */
    task: string;
}

export interface SuggestionDeps {
    control: PiKvmControl;
    /** Only watch while the KVM screen is actually visible. */
    isOnKVM: () => boolean;
    /** Don't suggest while the agent is acting or a meeting is live. */
    isBusy: () => boolean;
    /** User toggle — watch only when on. */
    enabled: () => boolean;
    /** One-shot Pi-harness look at a frame. */
    look: (
        image: { data: string; mimeType: string },
        instruction: string,
        opts?: { model?: string; thinking?: "low" | "medium" | "high"; system?: string },
    ) => Promise<string>;
    /** Cheap vision model id for the look. */
    model: string;
}

const SUGGEST_SYSTEM =
    "You are a proactive assistant watching a remote computer's screen for a user who may be away. " +
    "Look at the screenshot and decide if there is ONE clear, genuinely helpful, SAFE action you could offer to do for them right now. " +
    "Good: a lock screen or login prompt (offer to log in); an obvious 'Restart to finish updates' / 'Update available' prompt; a stuck modal with one obvious safe choice; an app waiting on a trivial confirm. " +
    "Be CONSERVATIVE — for an ordinary desktop, an app in normal use, a video, a terminal mid-command, or anything ambiguous, respond with suggest:false. " +
    "NEVER offer destructive or irreversible actions (deleting, sending, purchasing, formatting). " +
    'Respond with ONLY compact JSON: {"suggest":true|false,"title":"<≤4 words, e.g. Log in>","detail":"<one short clause>","task":"<a precise instruction telling the agent exactly what to do>"}. ' +
    'Example for a Windows lock screen: {"suggest":true,"title":"Log in","detail":"Lock screen detected","task":"Unlock and sign in to this machine. Press Ctrl+Alt+Del if the screen asks for it, then type the saved login password into the password field (use list_secrets to find it and type_secret to enter it) and submit."}. ' +
    'If nothing is worth offering, respond exactly {"suggest":false}.';

function fpDiff(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    if (!n) return 1;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
    return sum / n / 255;
}

/** Spread of a fingerprint; near-zero ⇒ a blank/solid/"no signal" screen. */
function fpVariance(a: Uint8Array): number {
    if (!a.length) return 0;
    let mean = 0;
    for (let i = 0; i < a.length; i++) mean += a[i]!;
    mean /= a.length;
    let v = 0;
    for (let i = 0; i < a.length; i++) v += (a[i]! - mean) ** 2;
    return Math.sqrt(v / a.length);
}

function parseSuggestion(raw: string): { title: string; detail?: string; task: string } | null {
    if (!raw) return null;
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
        const o = JSON.parse(m[0]);
        if (o.suggest !== true) return null;
        const title = String(o.title ?? "").trim().slice(0, 32);
        const task = String(o.task ?? "").trim().slice(0, 600);
        if (!title || !task) return null;
        return { title, task, ...(o.detail ? { detail: String(o.detail).trim().slice(0, 120) } : {}) };
    } catch {
        return null;
    }
}

let counter = 0;
const nextId = () => `sug${Date.now().toString(36)}${(counter++).toString(36)}`;

export class SuggestionWatcher extends EventEmitter {
    private timer: NodeJS.Timeout | undefined;
    private lastFp: Uint8Array | undefined;
    private baselineFp: Uint8Array | undefined;
    private changing = false;
    private busy = false;
    private lastLookAt = 0;
    private current: Suggestion | null = null;
    /** The JPEG the most recent suggestion was derived from (for metrics: "what was on
     *  screen when it was offered"). */
    private lastShot: Buffer | undefined;
    /** Titles the user dismissed for the CURRENT screen state (reset on a new state). */
    private dismissed = new Set<string>();

    private readonly INTERVAL_MS = 2500;
    private readonly MOVE = 0.04; // above ⇒ screen actively changing
    private readonly SETTLE = 0.015; // below ⇒ settled
    private readonly MEANINGFUL = 0.05; // a settled frame must differ this much from baseline
    private readonly BLANK_VARIANCE = 6; // below ⇒ blank / no-signal
    private readonly LOOK_COOLDOWN_MS = 6000;

    constructor(private readonly deps: SuggestionDeps) {
        super();
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), this.INTERVAL_MS);
        if (this.timer.unref) this.timer.unref();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    /** The suggestion currently shown (for replay to a freshly-connected client). */
    currentSuggestions(): Suggestion[] {
        return this.current ? [this.current] : [];
    }

    /** The frame the current suggestion was derived from (for metrics). */
    lastFrame(): Buffer | undefined {
        return this.lastShot;
    }

    /** Hide a suggestion and don't re-offer it until the screen state changes. */
    dismiss(id: string): void {
        if (this.current && this.current.id === id) {
            this.dismissed.add(this.current.title);
            this.setCurrent(null);
        }
    }

    private setCurrent(s: Suggestion | null): void {
        const changed = (s?.id ?? null) !== (this.current?.id ?? null);
        this.current = s;
        if (changed) this.emit("suggestions", this.currentSuggestions());
    }

    private async tick(): Promise<void> {
        if (this.busy) return;
        if (!this.deps.enabled()) {
            this.setCurrent(null);
            return;
        }
        if (!this.deps.isOnKVM()) return;
        // The agent is driving (or a meeting's live) — drop any card and don't look.
        if (this.deps.isBusy()) {
            this.setCurrent(null);
            return;
        }
        const capture = this.deps.control.captureFingerprint;
        if (!capture) return; // no cheap gate available → stay quiet rather than poll vision
        let fp: Uint8Array | null = null;
        try {
            fp = await capture();
        } catch {
            return;
        }
        if (!fp) return;

        const step = this.lastFp ? fpDiff(fp, this.lastFp) : 1;
        this.lastFp = fp;
        if (step > this.MOVE) {
            this.changing = true; // still moving — wait for it to settle
            return;
        }
        if (step > this.SETTLE) return; // not settled yet

        const baseDiff = this.baselineFp ? fpDiff(fp, this.baselineFp) : 1;
        if (!this.changing && baseDiff < this.MEANINGFUL) return; // nothing new since the last look

        // Settled into a (new) state.
        this.changing = false;
        this.baselineFp = fp;
        this.dismissed.clear(); // a genuinely new screen — old dismissals no longer apply
        if (fpVariance(fp) < this.BLANK_VARIANCE) {
            this.setCurrent(null); // blank / no-signal
            return;
        }
        if (Date.now() - this.lastLookAt < this.LOOK_COOLDOWN_MS) return;
        this.lastLookAt = Date.now();

        this.busy = true;
        try {
            const shot = await this.deps.control.cachedScreenshot(); // reuse the frame the gate just looked at
            const raw = await this.deps.look(
                { data: shot.base64, mimeType: shot.mimeType },
                "Decide if there's one helpful, safe action to offer for this screen. Output only the JSON.",
                { model: this.deps.model, thinking: "low", system: SUGGEST_SYSTEM },
            );
            const parsed = parseSuggestion(raw);
            if (parsed && !this.dismissed.has(parsed.title)) {
                this.lastShot = shot.data; // keep the frame for metrics ("what was on screen")
                this.setCurrent({ id: nextId(), ...parsed });
            } else {
                this.setCurrent(null);
            }
        } catch {
            /* best-effort — never disturb anything */
        } finally {
            this.busy = false;
        }
    }
}
