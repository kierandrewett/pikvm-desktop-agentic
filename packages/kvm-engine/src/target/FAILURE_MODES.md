# target/: failure modes

Written before the tests; each line names the test that pins it (`link.test.ts`,
`device-state.test.ts`, `outbound-queue.test.ts`, `lifecycle.test.ts`).

## Socket lifetime (`link.ts`)

1. **A dead socket's late events corrupt the live one.** `kick` abandons a socket that looks
   open but is dead; its `close` can arrive after the replacement is up. Acting on it marks the
   live socket closed and starts a pointless retry. Every handler is guarded by the attempt
   that owns it. Also covers late `open` and late `message` (which would feed old frames into
   state and refresh the silence watchdog of a socket that is not current).
2. **A silent socket is trusted forever.** A phone that slept, a tailnet path change, a proxy
   that drops idle connections: the socket reads open and carries nothing. A `ping` goes out
   every 10 s; 25 s with no frame of ANY kind replaces the socket at once (no backoff).
   Any frame, not only `pong`, counts as life.
3. **Hammering a Pi that is away.** The wait between attempts grows 1200 ms x1.7 capped at
   5000 ms; it resets when a connection actually opens, not on a refused one. `kick` resets it
   and connects now; `connect` connects now but does NOT reset it.
4. **Two sockets at once.** `connect` while open or connecting does nothing; `start` twice does
   nothing; a kick while connecting replaces, never adds.
5. **Leaked socket or timer after stop.** `stop` closes the socket, ends the heartbeat and the
   reconnect wait, and nothing reconnects afterwards.
6. **A throwing socket constructor** (bad URL, blocked scheme) is a failed attempt retried on
   the backoff, not an exception out of `send`.
7. **Reporting "offline" during the very first connect.** `everSettled` stays false until an
   attempt opens, is refused or drops; `connecting` is true only while a socket is pending.
8. **A frame that is not JSON** (or not an object) must not break the handler or the watchdog.
9. **Foreground return.** After more than 1 s away (`RESUME_STALE_MS`) the socket is replaced;
   shorter, it is only asked to be connected. `online` always kicks. (`lifecycle.test.ts`)

## Outbound queue (`outbound-queue.ts`, via `link.ts`)

10. **Keystrokes delivered long after they were typed.** Items older than 2 s are dropped at
    flush, so typing into a rebooting Pi does not replay into its login prompt.
11. **A dropped release holds a key or button forever.** Releases survive the age limit AND
    the 256 cap (a release at the cap evicts the oldest non-release).
12. **Unbounded growth** while down: capped at 256; order of survivors preserved.
13. **Sending while down must try to reconnect**, not just queue.

## Device state (`device-state.ts`)

14. **Replace where a merge was meant.** atx, msd, info, hid and gpio deltas carry only what
    changed; a delta with only `busy` must not forget `enabled`, a storage delta must not
    forget `images`. A frame with no body resets atx and msd to null (console parity).
15. **Streamer.** `limits` travel with `features` (features without limits clears them);
    `applied` updates alone; `streamer.source` feeds the source flag only when present.
16. **Caps Lock races.** A report disagreeing with a toggle still in flight is the pre-toggle
    one and is ignored for 1.2 s; a matching report clears the pending window; the first report
    makes the state known; `noteCapsToggle` from an unknown state does nothing (toggling the
    unknown gives the unknown). LEDs are found at `keyboard.leds` or `leds`, on any event.
17. **Mouse mode lost on a delta.** `hid` events carry `mouse` as a delta; fields absent from
    one message keep their value. `absolute` falls back to `outputs.active === "usb"` only while
    unknown.
18. **Mouse output flood.** `setMouseOutput` is a no-op while the mode is unknown, already
    right, or the output is not offered, and makes at most one request per 1.5 s and none while
    one is in flight; a failed request releases the busy flag.
19. **keymaps shapes.** kvmd's `available` is a map; a list is tolerated; stored untouched for
    the paste module to normalise.

## Coming back from the background (`lifecycle.dom.ts`, `link.ts`)

20. **A return nobody announced.** iOS freezes an installed app without the page being told it
    was hidden, and a back/forward cache restore has no `hidden` at all. The page's own
    heartbeat (1 s) stops while it is frozen; a tick more than 4 s after the last is a return,
    whatever events did or did not arrive. `visibilitychange`, `pageshow` (persisted),
    `focus` and the Page Lifecycle `resume` land in the same place.
21. **A burst is one return.** The first signal clears the absence (hidden time and heartbeat),
    so visible + pageshow + focus + resume find none and only ask for a connection: one kick,
    never several that would replace the fresh socket again.
22. **A hidden page reconnecting forever.** With `mayConnect` answering no, no attempt is made and
    the backoff clock does not run (a failed attempt before the page was hidden does not keep
    retrying behind it); the link waits for a kick or a send. `focus` or `pageshow` while
    `document.hidden` is not a return. An open socket is left alone.
23. **A release that never comes.** The page leaving (hidden, `freeze`, `pagehide`) and the page
    returning from an absence both call `onBackground`, so whatever the target holds for this
    page is let go before the old socket is replaced.
