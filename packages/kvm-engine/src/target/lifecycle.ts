import type { TargetLink } from "./link";

/**
 * After a real stay in the background (an installed app switched away from, a phone locked),
 * what still reads as connected usually is not: iOS freezes the page and its sockets go quiet
 * without closing. So past a few seconds the socket is replaced rather than trusted.
 */
export const BACKGROUND_KICK_AFTER_MS = 3000;

/** The page became visible again after `awayMs` hidden (0 when it was never seen hidden). */
export function returnedFromBackground(link: Pick<TargetLink, "kick" | "connect">, awayMs: number): void {
    if (awayMs > BACKGROUND_KICK_AFTER_MS) link.kick();
    else link.connect();
}

/** The network came back: the old socket rode the network that just went, so never trust it. */
export function networkCameBack(link: Pick<TargetLink, "kick">): void {
    link.kick();
}
