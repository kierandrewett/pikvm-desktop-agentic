import { RESUME_STALE_MS } from "../resume";
import type { TargetLink } from "./link";

/**
 * The page is back after `awayMs` (0 when it was never away). After a real stay in the background
 * (an installed app switched away from, a phone locked) what still reads as connected usually is
 * not: iOS freezes the page and its sockets go quiet without closing. So past `RESUME_STALE_MS` the
 * socket is replaced rather than trusted; a shorter absence only makes sure it is connected.
 */
export function returnedFromBackground(link: Pick<TargetLink, "kick" | "connect">, awayMs: number): void {
    if (awayMs > RESUME_STALE_MS) link.kick();
    else link.connect();
}

/** The network came back: the old socket rode the network that just went, so never trust it. */
export function networkCameBack(link: Pick<TargetLink, "kick">): void {
    link.kick();
}
