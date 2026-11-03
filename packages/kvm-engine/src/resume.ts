// Coming back to the page after it was away: one definition of "how long was it gone" for the
// video machine and the input link, so the two never disagree about whether to trust what they held.
//
// A page can be away without ever being told. iOS freezes a home-screen app mid-task and the
// `hidden` event may not have been delivered; a bfcache restore has no `hidden` at all. What does
// not lie is the page's own heartbeat: a timer that fires every second or two stops dead while the
// page is frozen, so the gap between its last tick and the first thing that runs after the thaw IS
// the time away.

/** Away longer than this and nothing that was open is trusted: the stream is reloaded, the socket replaced. */
export const RESUME_STALE_MS = 1000;

/** No heartbeat for this long and the page was frozen, whether or not it was ever told it was hidden. */
export const SUSPEND_GAP_MS = 4000;

/** The page's own heartbeat, which the frozen-page detection reads. */
export const HEARTBEAT_MS = 1000;

/**
 * How long the page was away at `now`.
 *
 * `hiddenAt` is when it was last told it was hidden (null if it never was); `lastBeat` is the last
 * heartbeat tick. Whichever shows the longer absence wins: a hidden page that kept ticking (a
 * desktop tab) is away since it was hidden, and a frozen one that was never told is away since its
 * last tick.
 */
export function awayMs(now: number, hiddenAt: number | null, lastBeat: number | null): number {
    const hidden = hiddenAt === null ? 0 : now - hiddenAt;
    const silent = lastBeat === null ? 0 : now - lastBeat;
    return Math.max(hidden, silent > SUSPEND_GAP_MS ? silent : 0);
}
