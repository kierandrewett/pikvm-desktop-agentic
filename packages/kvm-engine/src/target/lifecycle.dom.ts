import type { Clock } from "../clock/index";
import { awayMs, HEARTBEAT_MS, SUSPEND_GAP_MS } from "../resume";
import type { TargetLink } from "./link";
import { networkCameBack, returnedFromBackground } from "./lifecycle";

export interface LinkLifecycleHooks {
    /**
     * The page is leaving (hidden, frozen, put in the back/forward cache) or has come back from an
     * absence: whatever the target is holding because of this page (a key, a button, a modifier)
     * must be let go, because the release may never come.
     */
    readonly onBackground?: () => void;
}

/**
 * Wire the page's visibility and connectivity events to the link. Returns the unbind.
 *
 * Absence is measured on the engine clock, so a phone that slept for minutes reports the real gap
 * even though no timer ran meanwhile. It is told two ways: by the page being hidden, frozen or
 * paged out, and, because iOS can freeze a page without telling it, by the page's own heartbeat:
 * a tick that comes long after the last one means the page was gone. Every way back (visible,
 * pageshow from the back/forward cache, the window's focus, the Page Lifecycle `resume`, a tick
 * after a gap) lands in the same place, and the first one of a burst does the work: it clears the
 * absence, so the rest find none and only ask for a connection.
 */
export function bindLinkLifecycle(
    link: Pick<TargetLink, "kick" | "connect">,
    clock: Clock,
    doc: Document = document,
    win: Window = window,
    hooks: LinkLifecycleHooks = {},
): () => void {
    let hiddenAt: number | null = null;
    let lastBeat = clock.now();
    let cancelBeat: () => void = () => {};

    const leave = (): void => {
        // null, not 0: an engine clock may legitimately read 0 when the page left.
        hiddenAt ??= clock.now();
        hooks.onBackground?.();
    };
    /** `silentFor`: how long the heartbeat was silent, when it is the one reporting the return. */
    const back = (silentFor = 0): void => {
        if (doc.hidden) return; // not back: a page nobody can see reconnects nothing
        const now = clock.now();
        const away = Math.max(awayMs(now, hiddenAt, lastBeat), silentFor);
        hiddenAt = null;
        lastBeat = now;
        if (away > 0) hooks.onBackground?.();
        returnedFromBackground(link, away);
    };
    const beat = (): void => {
        const now = clock.now();
        const silent = now - lastBeat;
        // A tick long after the last: the page was frozen. A return, whatever the page was told.
        if (silent > SUSPEND_GAP_MS) back(silent);
        lastBeat = now;
        cancelBeat = clock.setTimeout(beat, HEARTBEAT_MS);
    };
    cancelBeat = clock.setTimeout(beat, HEARTBEAT_MS);

    const onVisibility = (): void => (doc.hidden ? leave() : back());
    const onPageShow = (e: Event): void => {
        if ((e as PageTransitionEvent).persisted) back();
    };
    const onReturn = (): void => back();
    const onOnline = (): void => networkCameBack(link);
    doc.addEventListener("visibilitychange", onVisibility);
    doc.addEventListener("freeze", leave);
    doc.addEventListener("resume", onReturn);
    win.addEventListener("pagehide", leave);
    win.addEventListener("pageshow", onPageShow);
    win.addEventListener("focus", onReturn);
    win.addEventListener("online", onOnline);
    return () => {
        cancelBeat();
        doc.removeEventListener("visibilitychange", onVisibility);
        doc.removeEventListener("freeze", leave);
        doc.removeEventListener("resume", onReturn);
        win.removeEventListener("pagehide", leave);
        win.removeEventListener("pageshow", onPageShow);
        win.removeEventListener("focus", onReturn);
        win.removeEventListener("online", onOnline);
    };
}
