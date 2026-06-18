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
}

const TRIAGE_SYSTEM =
    "You are an ambient screen watcher for a remote desktop. You are shown a screenshot AFTER the screen changed. " +
    "Decide if the user (who is away from this screen) would want to know. Be conservative — most changes (typing, " +
    "scrolling, cursor moves, app switches) are NOT important. Important = a NEW notification, a new email, a new chat/Teams " +
    "message, a meeting starting, an error/dialog needing attention, or a finished long task. " +
    'Respond with ONLY compact JSON: {"kind":"notification|email|message|meeting|app-change|content-change|nothing",' +
    '"important":true|false,"notify":true|false,"title":"short headline","detail":"one sentence"}.';

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

function fpDiff(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    if (!n) return 1;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
    return sum / n / 255; // 0..1 mean absolute difference
}

let counter = 0;
const nextId = () => `amb${Date.now().toString(36)}${(counter++).toString(36)}`;

export class AmbientMonitor extends EventEmitter {
    private timer: NodeJS.Timeout | undefined;
    private lastFp: Uint8Array | undefined;
    private baselineFp: Uint8Array | undefined;
    private changing = false;
    private lastTriageAt = 0;
    private busy = false;

    // Meeting state derived from sustained presence.
    private inMeeting = false;
    private activeSince = 0;
    private inactiveSince = 0;

    // Diff thresholds (mean abs diff of the tiny fingerprint, 0..1).
    private readonly MOVE = 0.04; // above this the screen is actively changing
    private readonly SETTLE = 0.015; // below this it has settled
    private readonly MEANINGFUL = 0.05; // settled frame must differ this much from baseline
    private readonly TRIAGE_COOLDOWN_MS = 8000;
    private readonly MEETING_SUSTAIN_MS = 10000;
    private readonly MEETING_CLEAR_MS = 20000;

    constructor(private readonly deps: AmbientDeps) {
        super();
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

    private async tick(): Promise<void> {
        const s = this.deps.settings();
        if (!s.enabled || this.busy || !this.deps.isOnKVM()) return;

        // --- meeting detection (programmatic, off sustained presence) ---
        this.evaluateMeeting(s);

        // --- screen-change detection (programmatic) ---
        const fp = this.deps.control.captureFingerprint ? await this.deps.control.captureFingerprint() : null;
        if (!fp) return;

        if (!this.lastFp) {
            this.lastFp = fp;
            this.baselineFp = fp;
            return;
        }
        const dStep = fpDiff(fp, this.lastFp);
        this.lastFp = fp;

        if (dStep > this.MOVE) {
            this.changing = true;
            return; // still moving — wait for it to settle
        }
        // Settled. Did we just finish a change that left the screen meaningfully different?
        if (this.changing && dStep < this.SETTLE) {
            this.changing = false;
            const dBase = this.baselineFp ? fpDiff(fp, this.baselineFp) : 1;
            this.baselineFp = fp;
            const now = Date.now();
            if (dBase >= this.MEANINGFUL && now - this.lastTriageAt > this.TRIAGE_COOLDOWN_MS) {
                this.lastTriageAt = now;
                await this.triage(s);
            }
        }
    }

    private evaluateMeeting(s: AmbientSettings): void {
        const p = this.deps.presence.getState();
        const live = p.micActive || p.audioActive;
        const now = Date.now();
        if (live) {
            this.inactiveSince = 0;
            if (!this.activeSince) this.activeSince = now;
            if (!this.inMeeting && now - this.activeSince >= this.MEETING_SUSTAIN_MS) {
                this.inMeeting = true;
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
                const res = await this.deps.ntfy.notify(t.detail ? `${t.title} — ${t.detail}` : t.title, {
                    title: "PiKVM",
                    priority: t.kind === "meeting-start" ? "high" : "default",
                    tags: "desktop_computer",
                });
                ev.notified = res.sent;
            }
            this.emitEvent(ev);
        } finally {
            this.busy = false;
        }
    }

    private async onMeetingStart(s: AmbientSettings): Promise<void> {
        const base: AmbientEvent = {
            id: nextId(),
            ts: Date.now(),
            kind: "meeting-start",
            title: "Meeting detected",
            important: true,
            notified: false,
        };
        // Escalate to the stronger model for a quick brief, if enabled.
        if (s.meetingAssist) {
            const frame = await this.grabFrame();
            if (frame) {
                const brief = await this.deps.quickLook(
                    frame,
                    "A meeting just started on this screen. In 1–2 sentences: what app/meeting is this, and who/what is it about if visible? Then suggest a natural opening line to say. Be concise.",
                    { model: s.smartModel, thinking: "medium" },
                );
                if (brief) base.detail = brief.slice(0, 600);
                base.thumb = `data:${frame.mimeType};base64,${frame.data}`;
            }
        }
        if (s.notify) {
            const res = await this.deps.ntfy.notify(base.detail ? `Meeting detected — ${base.detail}` : "A meeting just started on the remote machine.", {
                title: "PiKVM — meeting",
                priority: "high",
                tags: "calendar",
            });
            base.notified = res.sent;
        }
        this.emitEvent(base);
    }
}
