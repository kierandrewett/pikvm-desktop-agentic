/**
 * Tracks all keyboard/mouse activity — the agent's *and* the user's own input
 * (captured from the KVM page) — so the agent can see what's already been typed,
 * e.g. when a human typed part of a field before handing off.
 */

import { EventEmitter } from "events";

export type InputSource = "user" | "agent";

export interface InputEvent {
    source: InputSource;
    kind: "text" | "key" | "mouse";
    detail: string;
    at: number;
}

const MAX_BUFFER = 2000;
const MAX_EVENTS = 200;

export class InputTracker extends EventEmitter {
    /** Rolling reconstruction of typed text (both sources). */
    private buffer = "";
    private events: InputEvent[] = [];
    private lastSource: InputSource | undefined;

    private push(e: InputEvent) {
        this.events.push(e);
        if (this.events.length > MAX_EVENTS) this.events.shift();
        this.lastSource = e.source;
        this.emit("input", e);
    }

    /** Append literal text (the agent's `type_text`, or pasted input). */
    appendText(source: InputSource, text: string) {
        if (!text) return;
        this.buffer = (this.buffer + text).slice(-MAX_BUFFER);
        this.push({ source, kind: "text", detail: text.slice(0, 80), at: Date.now() });
    }

    /** Apply a single key by its `KeyboardEvent.key` value. */
    applyKey(source: InputSource, key: string) {
        if (key === "Backspace") {
            this.buffer = this.buffer.slice(0, -1);
        } else if (key === "Enter") {
            this.buffer = (this.buffer + "\n").slice(-MAX_BUFFER);
        } else if (key === "Tab") {
            this.buffer = (this.buffer + "\t").slice(-MAX_BUFFER);
        } else if (key.length === 1) {
            this.buffer = (this.buffer + key).slice(-MAX_BUFFER);
        } else {
            // Non-printable (arrows, modifiers) — record as an event only.
            this.push({ source, kind: "key", detail: key, at: Date.now() });
            return;
        }
        this.push({ source, kind: "key", detail: key, at: Date.now() });
    }

    mouse(source: InputSource, detail: string) {
        this.push({ source, kind: "mouse", detail, at: Date.now() });
    }

    /** Current reconstructed typed text (tail). */
    typedText(maxChars = 600): string {
        return this.buffer.slice(-maxChars);
    }

    recentEvents(n = 30): InputEvent[] {
        return this.events.slice(-n);
    }

    lastInputSource(): InputSource | undefined {
        return this.lastSource;
    }
}
