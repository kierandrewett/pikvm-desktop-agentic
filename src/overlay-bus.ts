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

/** One labelled, persistent screen region for the console overlay (frame px). */
export interface OverlayRegion {
    label: string;
    kind: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/** A proactive action the agent offers for the current screen (lock screen → log in). */
export interface OverlaySuggestion {
    id: string;
    title: string;
    detail?: string;
    /** Instruction handed to the agent when the user taps it. */
    task: string;
}

export type OverlayEvent =
    | { type: "acting"; active: boolean; action?: string }
    | { type: "context"; app?: string; sensitive?: boolean }
    | { type: "cursor"; x: number; y: number; w: number; h: number; kind: string }
    | { type: "region"; x: number; y: number; width: number; height: number; w: number; h: number; label: string; hold?: number }
    // The LLM-segmented map of the whole screen: labelled, persistent boxes drawn
    // until the next map arrives (distinct from the transient `region` scan box).
    // w/h are the frame dimensions the region pixels are expressed in.
    | { type: "regions"; regions: OverlayRegion[]; w: number; h: number }
    // Proactive "suggested actions" for the current screen — a tappable card over
    // the live view. An empty list clears it.
    | { type: "suggestions"; items: OverlaySuggestion[] }
    | { type: "typing"; [k: string]: unknown };

export class OverlayBus extends EventEmitter {
    /** Last acting state, replayed to a client that connects mid-task. */
    private acting: { active: boolean; action?: string } = { active: false };
    private context: { app?: string; sensitive?: boolean } | null = null;
    /** Last segmented region map, replayed so a late client draws it immediately. */
    private regions: { type: "regions"; regions: OverlayRegion[]; w: number; h: number } | null = null;
    /** Current suggestion card, replayed so a late client shows it immediately. */
    private suggestions: OverlaySuggestion[] = [];

    emitOverlay(e: OverlayEvent): void {
        if (e.type === "acting") this.acting = { active: e.active, ...(e.action ? { action: e.action } : {}) };
        if (e.type === "context") this.context = { ...(e.app ? { app: e.app } : {}), ...(e.sensitive ? { sensitive: true } : {}) };
        if (e.type === "regions") this.regions = e;
        if (e.type === "suggestions") this.suggestions = e.items;
        this.emit("overlay", e);
    }

    /** Subscribe; returns an unsubscribe fn. Replays the current acting/context/regions. */
    subscribe(fn: (e: OverlayEvent) => void): () => void {
        // Replay current state so a late client shows the right thing immediately.
        fn({ type: "acting", active: this.acting.active, ...(this.acting.action ? { action: this.acting.action } : {}) });
        if (this.context) fn({ type: "context", ...this.context });
        if (this.regions) fn(this.regions);
        if (this.suggestions.length) fn({ type: "suggestions", items: this.suggestions });
        this.on("overlay", fn);
        return () => this.off("overlay", fn);
    }
}
