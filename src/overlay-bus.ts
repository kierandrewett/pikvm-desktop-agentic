/**
 * Overlay event bus — the agent's on-screen "X-ray" (acting scrim, AI cursor,
 * look/region scan boxes, watched-typing box, recognised-app/sensitivity) and
 * its live acting state, broadcast to any client.
 *
 * These used to go straight to the desktop's native overlay WebContentsView over
 * IPC. Routing them through this bus lets the SAME events drive the web console's
 * overlay (so web and desktop share one interface), via an SSE endpoint on the
 * control server. The desktop still mirrors them to its native overlay too.
 */

import { EventEmitter } from "node:events";

export type OverlayEvent =
    | { type: "acting"; active: boolean; action?: string }
    | { type: "context"; app?: string; sensitive?: boolean }
    | { type: "cursor"; x: number; y: number; w: number; h: number; kind: string }
    | { type: "region"; x: number; y: number; width: number; height: number; w: number; h: number; label: string; hold?: number }
    | { type: "typing"; [k: string]: unknown };

export class OverlayBus extends EventEmitter {
    /** Last acting state, replayed to a client that connects mid-task. */
    private acting: { active: boolean; action?: string } = { active: false };
    private context: { app?: string; sensitive?: boolean } | null = null;

    emitOverlay(e: OverlayEvent): void {
        if (e.type === "acting") this.acting = { active: e.active, ...(e.action ? { action: e.action } : {}) };
        if (e.type === "context") this.context = { ...(e.app ? { app: e.app } : {}), ...(e.sensitive ? { sensitive: true } : {}) };
        this.emit("overlay", e);
    }

    /** Subscribe; returns an unsubscribe fn. Replays the current acting/context. */
    subscribe(fn: (e: OverlayEvent) => void): () => void {
        // Replay current state so a late client shows the right thing immediately.
        fn({ type: "acting", active: this.acting.active, ...(this.acting.action ? { action: this.acting.action } : {}) });
        if (this.context) fn({ type: "context", ...this.context });
        this.on("overlay", fn);
        return () => this.off("overlay", fn);
    }
}
