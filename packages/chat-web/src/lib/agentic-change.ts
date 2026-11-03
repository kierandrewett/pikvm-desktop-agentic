/**
 * Agentic changes: the title or icon of a chat that the server or the agent changed, not the user. The server tags
 * `chat.conversation.updated` with `agentic` for those (generated title and icon, the conversations MCP tools), and
 * the sidebar row and the conversation header animate them. A rename by the user carries no tag and swaps at once.
 *
 * One helper for both places:
 * - `noteAgenticChange` is called by the event handler before the cache update, so a component that renders the new
 *   value already sees that the change was agentic.
 * - `useAgenticText` delays the new text until the old text has faded out, and reports the phase. The caller puts
 *   `data-agentic-text` on the text element and `data-agentic-phase={phase}` on that element or an ancestor; the CSS
 *   is in styles/agentic-change.css. Only opacity, blur and clip-path animate, so nothing moves or changes height.
 * - `useAgenticIcon` keeps the old icon for a short cross-fade; ChatIcon draws it as a ghost inside its fixed box.
 *
 * Reduced motion (the OS setting or ui.reducedMotion) and a speed of 0 swap at once.
 */
import type { AgenticChange } from "@pikvm/chat-protocol";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { reducedMotion } from "../components/model-picker/motion";
import { motionMs } from "./motion";

/** Text: old text fades and blurs out, then the new text writes in. Together about 450 ms at normal speed. */
export const TEXT_OUT_MS = 140;
export const TEXT_IN_MS = 300;
/** Icon: old and new cross-fade together with a small scale. */
export const ICON_MS = 320;

type Field = keyof AgenticChange;
const stamps = new Map<string, { title: number; icon: number; at: number }>();
/**
 * How long a note stays valid for the value change that follows it. The event handler notes the change, then writes
 * the cache a moment later, and React can render between the two. The change must land in this window to count.
 */
const NOTE_TTL_MS = 2000;
const listeners = new Set<() => void>();
let counter = 0;

/** Record which fields of a chat the server changed on its own. Call before the cache is updated. */
export function noteAgenticChange(conversationId: string, change: AgenticChange | undefined): void {
    if (!change) return;
    const cur = stamps.get(conversationId) ?? { title: 0, icon: 0, at: 0 };
    counter += 1;
    stamps.set(conversationId, {
        title: change.title ? counter : cur.title,
        icon: change.icon ? counter : cur.icon,
        at: Date.now(),
    });
    listeners.forEach((fn) => fn());
}

const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
};

const stampOf = (id: string | undefined, field: Field): number => (id ? (stamps.get(id)?.[field] ?? 0) : 0);

const animates = (ms: number) => !reducedMotion() && motionMs(ms) > 0;

export type TextPhase = "out" | "in" | undefined;

interface Swap<T> {
    from: T;
    to: T;
    phase: "out" | "in";
}

/**
 * The shared core. When `value` changes and the server tagged `field` as agentic, a swap starts: phase "out" for
 * `outMs` (skipped when 0), then "in" for `inMs`, then it ends. Any other change ends the swap at once. The swap is
 * set before paint, so the new value never shows for a frame ahead of its animation.
 */
function useAgenticSwap<T>(
    conversationId: string | undefined,
    field: Field,
    value: T,
    outMs: number,
    inMs: number,
): Swap<T> | undefined {
    const stamp = useSyncExternalStore(subscribe, () => stampOf(conversationId, field));
    const last = useRef({ value, conversation: conversationId });
    // The note this component has already acted on. Only a value change uses it up: the note can arrive in an
    // earlier render than the value (they are two separate updates), and that render must not consume it.
    const consumed = useRef(stamp);
    const [swap, setSwap] = useState<Swap<T> | null>(null);

    useLayoutEffect(() => {
        const prev = last.current;
        last.current = { value, conversation: conversationId };
        if (prev.conversation !== conversationId) {
            consumed.current = stamp;
            return;
        }
        if (prev.value === value) return;
        const noted = Date.now() - (stamps.get(conversationId ?? "")?.at ?? 0) < NOTE_TTL_MS;
        const fresh = stamp !== consumed.current && noted;
        consumed.current = stamp;
        setSwap(
            fresh && animates(outMs + inMs) ? { from: prev.value, to: value, phase: outMs > 0 ? "out" : "in" } : null,
        );
    }, [value, stamp, conversationId, outMs, inMs]);

    useEffect(() => {
        if (!swap) return;
        const timer = setTimeout(
            () => setSwap(swap.phase === "out" ? { ...swap, phase: "in" } : null),
            motionMs(swap.phase === "out" ? outMs : inMs),
        );
        return () => clearTimeout(timer);
    }, [swap, outMs, inMs]);

    // A newer value while a swap runs: draw the newest; the layout effect restarts or ends the swap.
    return swap && swap.to === value ? swap : undefined;
}

/**
 * The text to draw and the animation phase. An agentic change of `value` shows the old text while it fades out
 * (`phase` "out"), then the new text while it writes in ("in"). Any other change shows the new text at once.
 */
export function useAgenticText(conversationId: string | undefined, value: string): { text: string; phase: TextPhase } {
    const swap = useAgenticSwap(conversationId, "title", value, TEXT_OUT_MS, TEXT_IN_MS);
    if (!swap) return { text: value, phase: undefined };
    return { text: swap.phase === "out" ? swap.from : swap.to, phase: swap.phase };
}

/**
 * Set for ICON_MS after an agentic change of `value`, with the icon that is leaving (`from`, which may be empty).
 * Undefined the rest of the time.
 */
export function useAgenticIcon<T>(conversationId: string | undefined, value: T): { swap: { from: T } | undefined } {
    const swap = useAgenticSwap(conversationId, "icon", value, 0, ICON_MS);
    return { swap: swap && { from: swap.from } };
}
