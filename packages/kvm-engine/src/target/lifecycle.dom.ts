import type { Clock } from "../clock/index";
import type { TargetLink } from "./link";
import { networkCameBack, returnedFromBackground } from "./lifecycle";

/**
 * Wire the page's visibility and connectivity events to the link. Returns the unbind.
 *
 * Hidden time is measured with the engine clock, so a phone that slept for minutes reports
 * the real gap even though no timer ran meanwhile.
 */
export function bindLinkLifecycle(
    link: Pick<TargetLink, "kick" | "connect">,
    clock: Clock,
    doc: Document = document,
    win: Window = window,
): () => void {
    let hiddenAt: number | null = null;
    const onVisibility = (): void => {
        if (doc.hidden) {
            hiddenAt = clock.now();
            return;
        }
        // null, not 0: an engine clock may legitimately read 0 when the page was hidden.
        const away = hiddenAt === null ? 0 : clock.now() - hiddenAt;
        hiddenAt = null;
        returnedFromBackground(link, away);
    };
    const onOnline = (): void => networkCameBack(link);
    doc.addEventListener("visibilitychange", onVisibility);
    win.addEventListener("online", onOnline);
    return () => {
        doc.removeEventListener("visibilitychange", onVisibility);
        win.removeEventListener("online", onOnline);
    };
}
