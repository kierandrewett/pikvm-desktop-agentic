/**
 * Presence / do-not-disturb gate.
 *
 * Driven by the PiKVM media-transmission state the app already tracks: when the
 * PiKVM is transmitting the microphone to the target (you're talking / in a
 * call) or audio is coming from the target, the agent yields. The runner and
 * the MCP server both wait on this gate before any HID action.
 */

import { EventEmitter } from "events";

export interface PresenceState {
    /** True if automation should be paused right now. */
    paused: boolean;
    micActive: boolean;
    audioActive: boolean;
    /** Manual override, if any. */
    manual: "auto" | "pause" | "resume";
    /** Human-readable reason for the current pause. */
    reason?: string;
}

export class PresenceMonitor extends EventEmitter {
    private state: PresenceState = {
        paused: false,
        micActive: false,
        audioActive: false,
        manual: "auto",
    };
    private media = { audio: false, mic: false };
    private clearAt = 0;
    private graceTimer: NodeJS.Timeout | undefined;
    private readonly graceMs = 4000;
    private enabled = true;

    /** Enable/disable auto-pause on PiKVM mic/audio activity (manual still works). */
    setEnabled(on: boolean): void {
        this.enabled = on;
        this.recompute();
    }

    getState(): PresenceState {
        return { ...this.state };
    }

    /** No-op lifecycle hooks (kept for symmetry; presence is push-driven). */
    start(): void {}
    stop(): void {
        if (this.graceTimer) clearTimeout(this.graceTimer);
    }

    /** Feed the latest PiKVM media-transmission state. */
    setMediaState(media: { audio: boolean; mic: boolean }): void {
        this.media = media;
        this.recompute();
    }

    /** Force a pause, force a resume, or hand control back to media detection. */
    setManual(mode: "auto" | "pause" | "resume"): void {
        this.state.manual = mode;
        this.recompute();
    }

    private recompute(): void {
        const now = Date.now();
        const detected = this.enabled && (this.media.audio || this.media.mic);
        if (detected) this.clearAt = now + this.graceMs;

        let paused: boolean;
        if (this.state.manual === "pause") paused = true;
        else if (this.state.manual === "resume") paused = false;
        else paused = detected || now < this.clearAt;

        // While inside the grace window, schedule a re-check so we auto-resume.
        if (this.state.manual === "auto" && !detected && now < this.clearAt) {
            if (this.graceTimer) clearTimeout(this.graceTimer);
            this.graceTimer = setTimeout(() => this.recompute(), this.clearAt - now + 50);
        }

        const reason = paused
            ? this.state.manual === "pause"
                ? "Paused manually"
                : this.media.mic
                  ? "Paused — your mic is live on the target"
                  : this.media.audio
                    ? "Paused — audio is playing from the target"
                    : "Paused — recent activity"
            : undefined;

        const next: PresenceState = {
            paused,
            micActive: this.media.mic,
            audioActive: this.media.audio,
            manual: this.state.manual,
            ...(reason ? { reason } : {}),
        };

        const changed = next.paused !== this.state.paused || next.reason !== this.state.reason;
        this.state = next;
        if (changed) this.emit("change", this.getState());
    }

    /** Resolve once automation is permitted (returns immediately if not paused). */
    waitUntilAllowed(signal?: AbortSignal): Promise<void> {
        if (!this.state.paused) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const onChange = (s: PresenceState) => {
                if (!s.paused) {
                    cleanup();
                    resolve();
                }
            };
            const onAbort = () => {
                cleanup();
                reject(new DOMException("Aborted", "AbortError"));
            };
            const cleanup = () => {
                this.off("change", onChange);
                signal?.removeEventListener("abort", onAbort);
            };
            this.on("change", onChange);
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }
}
