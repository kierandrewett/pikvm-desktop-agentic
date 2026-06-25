/**
 * Ambient background monitor.
 *
 * Watches the live screen cheaply and only escalates to the Pi harness when
 * something genuinely changes — never an LLM per frame. Two programmatic signals
 * drive it:
 *
 *  1. Screen change: a tiny grayscale fingerprint diff. When the screen finishes
 *     CHANGING (was moving, now settled) and differs meaningfully from the last
 *     baseline, we triage that frame with a cheap model.
 *  2. Meeting: sustained PiKVM mic/audio (≥10s, so short notification blips back
 *     off) flips an in-meeting state, which can escalate to a stronger model for a
 *     brief / suggestions.
 *
 * Triage classifies the change and decides if it's worth surfacing / pushing.
 * All model calls go through the runner's `quickLook` (Pi harness).
 */

import { EventEmitter } from "events";
import { fpDiff, fpVariance, FP_MOVE, FP_SETTLE, FP_MEANINGFUL } from "./fingerprint";
import type { PiKvmControl } from "../pikvm-control";
import type { PresenceMonitor } from "../presence";
import type { AmbientEvent } from "../agent/protocol";
import type { AmbientSettings } from "../settings";
import type { NtfyClient } from "./ntfy";

export interface AmbientDeps {
    control: PiKvmControl;
    presence: PresenceMonitor;
    ntfy: NtfyClient;
    settings: () => AmbientSettings;
    /** Only run while the KVM screen is actually visible. */
    isOnKVM: () => boolean;
    /** One-shot Pi-harness look at a frame (cheap or smart model). */
    quickLook: (
        image: { data: string; mimeType: string },
        instruction: string,
        opts?: { model?: string; thinking?: "low" | "medium" | "high"; system?: string },
    ) => Promise<string>;
    /** The live local meeting transcript (for the copilot). */
    getTranscript?: () => string;
}

const TRIAGE_SYSTEM =
    "You are an ambient screen watcher for a remote desktop. You are shown a screenshot AFTER the screen changed. " +
    "Decide if the user (who is away from this screen) would want to know. Be conservative — most changes (typing, " +
    "scrolling, cursor moves, app switches) are NOT important. Important = a NEW notification, a new email, a new chat/Teams " +
    "message, a meeting starting, an error/dialog needing attention, or a finished long task. " +
    "NEVER important (set important=false, notify=false): a 'No signal'/no-input message, a blank/black/solid screen, a " +
    "screensaver, a lock screen, the desktop wallpaper, or just the cursor/clock moving. " +
    'Respond with ONLY compact JSON: {"kind":"notification|email|message|meeting|app-change|content-change|nothing",' +
    '"important":true|false,"notify":true|false,"title":"...","detail":"..."}. ' +
    "Keep title to AT MOST 6 words and detail to one short clause. Be terse — no filler, no pleasantries.";

function parseTriage(raw: string): { kind: AmbientEvent["kind"]; important: boolean; notify: boolean; title: string; detail?: string } | null {
    if (!raw) return null;
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
        const o = JSON.parse(m[0]);
        const kindMap: Record<string, AmbientEvent["kind"]> = {
            notification: "notification",
            email: "email",
            message: "message",
            meeting: "meeting-start",
            "app-change": "app-change",
            "content-change": "content-change",
            nothing: "info",
        };
        const kind = kindMap[String(o.kind)] ?? "info";
        return {
            kind,
            important: !!o.important,
            notify: !!o.notify,
            title: String(o.title ?? "Screen changed").slice(0, 120),
            ...(o.detail ? { detail: String(o.detail).slice(0, 400) } : {}),
        };
    } catch {
        return null;
    }
}

// fpDiff / fpVariance now live in ./fingerprint (shared with the control settle-gate).

let counter = 0;
const nextId = () => `amb${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Is `now` within an "HH:MM"–"HH:MM" window? Handles overnight (start > end). */
export function withinActiveHours(hours: { enabled: boolean; start: string; end: string }, now: Date): boolean {
    if (!hours.enabled) return true;
    const toMin = (s: string) => {
        const [h, m] = s.split(":").map((x) => parseInt(x, 10));
        return (h || 0) * 60 + (m || 0);
    };
    const cur = now.getHours() * 60 + now.getMinutes();
    const start = toMin(hours.start);
    const end = toMin(hours.end);
    if (start === end) return true; // full day
    return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

export class AmbientMonitor extends EventEmitter {
    private timer: NodeJS.Timeout | undefined;
    private lastFp: Uint8Array | undefined;
    private baselineFp: Uint8Array | undefined;
    private changing = false;
    private lastTriageAt = 0;
    private busy = false;

    // Meeting state derived from sustained presence.
    private inMeeting = false;
    private forcedMeeting = false; // simulated via forceMeeting — don't auto-end
    private activeSince = 0;
    private inactiveSince = 0;

    // Last observed diffs (for the debug readout).
    private lastStepDiff = 0;
    private lastBaseDiff = 0;

    // Diff thresholds (mean abs diff of the tiny fingerprint, 0..1) — shared with the
    // control settle-gate so both stay calibrated together (see ./fingerprint).
    private readonly MOVE = FP_MOVE; // above this the screen is actively changing
    private readonly SETTLE = FP_SETTLE; // below this it has settled
    private readonly MEANINGFUL = FP_MEANINGFUL; // settled frame must differ this much from baseline
    private readonly TRIAGE_COOLDOWN_MS = 8000;
    private readonly MEETING_SUSTAIN_MS = 10000;
    private readonly MEETING_CLEAR_MS = 20000;

    private lastIdleTraceAt = 0;

    constructor(private readonly deps: AmbientDeps) {
        super();
    }

    /** Emit a live trace line (streamed to the Ambient console over SSE). */
    private trace(text: string, level: "info" | "change" | "triage" | "meeting" | "notify" = "info"): void {
        this.emit("trace", { ts: Date.now(), level, text });
    }

    isInMeeting(): boolean {
        return this.inMeeting;
    }

    start(): void {
        if (this.timer) return;
        const tick = () => {
            void this.tick().finally(() => {
                if (this.timer) this.timer = setTimeout(tick, Math.max(1500, this.deps.settings().intervalMs));
            });
        };
        this.timer = setTimeout(tick, 1500);
    }

    stop(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }

    private emitEvent(e: AmbientEvent): void {
        this.emit("event", e);
    }

    /** Surface a copilot suggestion (called by the meeting agent via main). */
    pushSuggestion(text: string): void {
        this.emit("suggestion", { ts: Date.now(), text });
    }
    /** Surface live monitor/agent activity to the console + overlay. */
    pushTrace(text: string, level: "meeting" | "activity" = "activity"): void {
        this.emit("trace", { ts: Date.now(), level, text });
    }

    private async tick(): Promise<void> {
        const s = this.deps.settings();
        if (!s.enabled || this.busy) return;

        // Region monitors (watch_region) are a real BACKGROUND task: check every tick,
        // even while otherwise idle/in a meeting, and ALERT when a watched area changes
        // (a VM/app finishing loading, a dialog appearing). Cheap when nothing is watched.
        await this.checkWatches();

        // Meeting detection always runs while enabled — a meeting is worth helping
        // with whenever it happens, regardless of the active-hours window. The live
        // copilot (a real agent) is driven separately by transcript + asks.
        this.evaluateMeeting(s);
        if (this.inMeeting) return; // in a meeting → the copilot agent is in charge

        // Screen-change triage respects on-KVM + active hours. Surface idle reasons
        // (throttled) so the console isn't silent.
        const idle = !this.deps.isOnKVM() ? "waiting — not on the KVM screen" : !withinActiveHours(s.activeHours, new Date()) ? "idle — outside active hours" : null;
        if (idle) {
            const now = Date.now();
            if (now - this.lastIdleTraceAt > 30000) {
                this.lastIdleTraceAt = now;
                this.trace(idle);
            }
            return;
        }

        // --- screen-change detection (programmatic) ---
        const fp = this.deps.control.captureFingerprint ? await this.deps.control.captureFingerprint() : null;
        if (!fp) return;

        if (!this.lastFp) {
            this.lastFp = fp;
            this.baselineFp = fp;
            return;
        }
        const dStep = fpDiff(fp, this.lastFp);
        this.lastStepDiff = dStep;
        this.lastFp = fp;

        if (dStep > this.MOVE) {
            this.changing = true;
            return; // still moving — wait for it to settle
        }
        // Settled. Did we just finish a change that left the screen meaningfully different?
        if (this.changing && dStep < this.SETTLE) {
            this.changing = false;
            const dBase = this.baselineFp ? fpDiff(fp, this.baselineFp) : 1;
            this.lastBaseDiff = dBase;
            this.baselineFp = fp;
            const now = Date.now();
            // Skip blank/"no signal"/solid screens — not worth a model call or a ping.
            const blank = fpVariance(fp) < 6;
            if (blank) {
                this.trace(`screen settled but blank/no-signal (Δ=${dBase.toFixed(3)}) — skipping`, "change");
            } else if (dBase >= this.MEANINGFUL && now - this.lastTriageAt > this.TRIAGE_COOLDOWN_MS) {
                this.lastTriageAt = now;
                this.trace(`screen changed (Δ=${dBase.toFixed(3)}) → triaging with ${s.triageModel}…`, "change");
                await this.triage(s);
            }
        }
    }

    /** Background region-watch check: alert the harness (ambient event + trace) when a
     *  region the agent registered via watch_region changes. The agent-facing notice is
     *  enqueued by changedWatches() and surfaced on its next tool result. */
    private async checkWatches(): Promise<void> {
        const changed = (await this.deps.control.changedWatches?.().catch(() => [])) ?? [];
        for (const c of changed) {
            this.trace(`watched region "${c.label}" changed (Δ=${c.delta.toFixed(2)})`, "change");
            this.emitEvent({ id: nextId(), ts: Date.now(), kind: "content-change", title: `Watched region changed: ${c.label}`, important: false, notified: false });
        }
    }

    private evaluateMeeting(s: AmbientSettings): void {
        // A forced/simulated meeting has no real audio to sustain it — leave it
        // entirely to forceMeeting(false) so it doesn't auto-end after the clear timer.
        if (this.forcedMeeting) return;
        const p = this.deps.presence.getState();
        const live = p.micActive || p.audioActive;
        const now = Date.now();
        if (live) {
            this.inactiveSince = 0;
            if (!this.activeSince) this.activeSince = now;
            if (!this.inMeeting && now - this.activeSince >= this.MEETING_SUSTAIN_MS) {
                this.inMeeting = true;
                this.trace("meeting detected — sustained target audio/mic", "meeting");
                void this.onMeetingStart(s);
            }
        } else {
            this.activeSince = 0;
            if (this.inMeeting) {
                if (!this.inactiveSince) this.inactiveSince = now;
                else if (now - this.inactiveSince >= this.MEETING_CLEAR_MS) {
                    this.inMeeting = false;
                    this.inactiveSince = 0;
                    this.emitEvent({ id: nextId(), ts: now, kind: "meeting-end", title: "Meeting ended", important: false, notified: false });
                }
            }
        }
    }

    private async grabFrame(): Promise<{ data: string; mimeType: string; thumb?: string } | null> {
        const cap = this.deps.control.captureScreen ? await this.deps.control.captureScreen() : null;
        if (!cap) return null;
        return { data: cap.data.toString("base64"), mimeType: "image/jpeg" };
    }

    private async triage(s: AmbientSettings): Promise<void> {
        this.busy = true;
        try {
            const frame = await this.grabFrame();
            if (!frame) return;
            const raw = await this.deps.quickLook(frame, "Classify this screen change.", {
                model: s.triageModel,
                thinking: "low",
                system: TRIAGE_SYSTEM,
            });
            const t = parseTriage(raw);
            this.trace(t ? `verdict: ${t.kind} — "${t.title}" (important=${t.important})` : `verdict unparsed: ${raw.slice(0, 80)}`, "triage");
            if (!t || !t.important) return; // boring — drop it
            const ev: AmbientEvent = {
                id: nextId(),
                ts: Date.now(),
                kind: t.kind,
                title: t.title,
                important: true,
                notified: false,
                ...(t.detail ? { detail: t.detail } : {}),
                thumb: `data:${frame.mimeType};base64,${frame.data}`,
            };
            if (s.notify && t.notify) {
                // Short and sweet — just the headline.
                const res = await this.deps.ntfy.notify(t.title, {
                    title: "PiKVM",
                    priority: t.kind === "meeting-start" ? "high" : "default",
                    tags: "desktop_computer",
                });
                ev.notified = res.sent;
                this.trace(res.sent ? `🔔 pushed: ${t.title}` : `push not sent (${res.reason ?? "?"})`, "notify");
            }
            this.emitEvent(ev);
        } finally {
            this.busy = false;
        }
    }

    private async onMeetingStart(s: AmbientSettings): Promise<void> {
        // Programmatic detection only — the live copilot agent (driven from main)
        // produces the brief + ongoing suggestions. Here we just announce it.
        const base: AmbientEvent = {
            id: nextId(),
            ts: Date.now(),
            kind: "meeting-start",
            title: "Meeting detected",
            important: true,
            notified: false,
        };
        const frame = await this.grabFrame();
        if (frame) base.thumb = `data:${frame.mimeType};base64,${frame.data}`;
        if (s.notify) {
            const res = await this.deps.ntfy.notify("Meeting started", { title: "PiKVM — meeting", priority: "high", tags: "calendar" });
            base.notified = res.sent;
            this.trace(res.sent ? "🔔 pushed: meeting started" : `meeting push not sent (${res.reason ?? "?"})`, "notify");
        }
        this.emitEvent(base);
    }

    /* ------------------------------- testing ----------------------------- */

    /** Live status so the UI can show why the monitor is / isn't firing. */
    getDebug() {
        const s = this.deps.settings();
        return {
            enabled: s.enabled,
            onKVM: this.deps.isOnKVM(),
            withinHours: withinActiveHours(s.activeHours, new Date()),
            inMeeting: this.inMeeting,
            busy: this.busy,
            lastStepDiff: Number(this.lastStepDiff.toFixed(4)),
            lastBaseDiff: Number(this.lastBaseDiff.toFixed(4)),
            hasCapture: !!this.deps.control.captureScreen,
            hasFingerprint: !!this.deps.control.captureFingerprint,
            triageModel: s.triageModel,
        };
    }

    /** Force a triage of the current frame right now (bypasses the change gate). */
    async forceTriage(): Promise<{ ok: boolean; reason?: string; result?: unknown; raw?: string }> {
        if (this.busy) return { ok: false, reason: "busy" };
        const s = this.deps.settings();
        this.busy = true;
        try {
            this.trace(`manual check → triaging with ${s.triageModel}…`, "change");
            const frame = await this.grabFrame();
            if (!frame) {
                this.trace("manual check failed — no frame (not on KVM)", "change");
                return { ok: false, reason: "no frame — not on the KVM screen or capture unavailable" };
            }
            const raw = await this.deps.quickLook(frame, "Classify this screen change.", {
                model: s.triageModel,
                thinking: "low",
                system: TRIAGE_SYSTEM,
            });
            const t = parseTriage(raw);
            this.trace(t ? `verdict: ${t.kind} — "${t.title}" (important=${t.important})` : `verdict unparsed: ${raw.slice(0, 80)}`, "triage");
            const ev: AmbientEvent = {
                id: nextId(),
                ts: Date.now(),
                kind: t?.kind ?? "info",
                title: `[test] ${t?.title ?? "triage"}`,
                important: !!t?.important,
                notified: false,
                ...(t?.detail ? { detail: t.detail } : raw ? { detail: raw.slice(0, 300) } : {}),
                thumb: `data:${frame.mimeType};base64,${frame.data}`,
            };
            if (s.notify && t?.notify) {
                const r = await this.deps.ntfy.notify(t.title, { title: "PiKVM", priority: "default" });
                ev.notified = r.sent;
            }
            this.emitEvent(ev);
            return { ok: true, result: t ?? null, raw };
        } finally {
            this.busy = false;
        }
    }

    /** Force the meeting state on/off (tests the brief + transcription wiring). */
    async forceMeeting(on: boolean): Promise<void> {
        const s = this.deps.settings();
        if (on && !this.inMeeting) {
            this.inMeeting = true;
            this.forcedMeeting = true; // persist until explicitly ended (no real audio to sustain it)
            this.activeSince = Date.now();
            this.inactiveSince = 0;
            await this.onMeetingStart(s);
        } else if (!on && this.inMeeting) {
            this.inMeeting = false;
            this.forcedMeeting = false;
            this.activeSince = 0;
            this.inactiveSince = 0;
            this.emitEvent({ id: nextId(), ts: Date.now(), kind: "meeting-end", title: "Meeting ended (test)", important: false, notified: false });
        }
    }
}
