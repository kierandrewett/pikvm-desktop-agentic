# Video: failure modes

Written before the tests. The machine decides which picture source is live and what
the status chip says. Most of these are bugs the old console already had once.
`machine.test.ts`, `blank.test.ts` and friends assert each as observable effects on
a manual clock (no real timers).

## Choosing the source

- V1. Mode detection: only `result.extras.vnc_lab.enabled === true` selects snapshot mode (not "truthy"); a failed, timed-out or malformed `/api/info` selects native, so a flaky info call never leaves the screen unstarted.
- V2. The MJPEG URL carries the per-browser quirk (iOS and Safari `dual_final_frames`, Blink `advance_headers`, anything else nothing) and the key is URL-encoded.
- V3. WebRTC is preferred but never awaited: MJPEG starts at once alongside it, so a picture appears without waiting on Janus. Janus is started only when the client exists and WebRTC is available; a `start()` that throws leaves MJPEG alone and arms nothing.

## MJPEG resilience

- V4. A first frame that never arrives within 7 s restarts the stream; restarts back off 800 ms x1.7 to 8 s (800, 1360, 2312, 3930, 6681, 8000, 8000...) and only one restart is ever pending; a real frame resets the backoff to 800.
- V5. While the server is known down its verdict is the only one shown: three writers (health poll, reload, reconnect) used to fight over one outage, flipping words and colours nineteen times in twenty-four seconds. An unchanging outage produces ONE signal change.
- V6. Recovery after the server was down reloads under a NEW stream key, passes through "reconnecting" (not a second "disconnected"), and goes live only on a real frame.
- V7. The last good frame is held across every restart: leaving live freezes (once a frame exists, never before), the reload freezes before the src is replaced, a WebRTC drop freezes, and a live frame thaws.
- V8. The health poll tells "server down" from "no signal": source offline while a stream is up = no signal; back online = live; offline with no stream up changes nothing; a blank picture reads as no signal even when the source says online.
- V9. A health poll must not touch the status while WebRTC or snapshot mode owns the picture, except to note the server is reachable.
- V10. A stream nobody can see is not opened: collapsed preview (unless background alerts watch it) and the framed Pi UI both close the connection, a reconnect or reload cannot reopen it behind them, and expanding or leaving the full UI resumes it.

## Blank frames

- B1. A uniform picture (luminance variance < 6, any solid colour including black) must stay uniform for MORE than 2.5 s before "no signal"; one varied sample resets the wait.
- B2. Entering and leaving blank each re-evaluate the status exactly once; repeated uniform samples do not repaint.
- B3. Sampling is requested only when there is a picture to sample (a stream is up, or the video is swapped in), and not while the document is hidden unless background alerts are watching.
- B4. The grid maths is exact: mean of R, G, B per cell, population variance.

## Snapshot mode (VNC-lab targets)

- S1. Cadence is 200 ms after a good frame, one fetch in flight at a time; a hidden document waits 500 ms and does not fetch.
- S2. Failures back off 400 ms x1.8 (400, 720, 1296, 2333, 4199, 5000...), the first two show "reconnecting", the third and later "disconnected"; a good frame resets to live and zero failures.
- S3. A frame decoded after the mode changed is discarded, never presented.
- S4. MJPEG is never opened in snapshot mode, and the framed Pi UI is refused.

## WebRTC

- W1. A track arriving does NOT swap the picture: the MJPEG stays up until the `<video>` really plays, so a silent WebRTC failure never leaves a blank screen. The swap suspends MJPEG, cancels its timers and says live.
- W2. A track that never plays within 6 s is a failed session (W9): MJPEG takes the picture and the session is retried (W7), not left half open.
- W3. Fallback with nothing to fall back from is a no-op: an "error" status with no video ever seen, repeated every few seconds on a Pi without Janus, used to reload a perfectly good MJPEG stream five times in 25 s, each freezing the picture. Only when MJPEG was suspended, or video was active, is there work. One exception (V12): the SECOND failure in a row on a Pi that never played WebRTC marks the link weak, and the MJPEG is reloaded once, from the reduced source, under the held frame.
- W4. A failure after video was seen DOES fall back (W9). The wrapper used to retry by itself and leave a frozen `<video>` counted as live: after an ICE failure the picture stopped for good and the chip still said "Live". Now the session says it failed once, the picture freezes and MJPEG takes over (going briefly "reconnecting" while it loads), and the retry is the machine's.
- W5. A session that has produced no video track 12 s (`START_GUARD_MS`) after it started is a failed session (W9). It used to be a harmless fallback that left the session running: a handshake hung on a dead connection (a blackholed socket, a handover that left the old one dead) was never replaced. 12 s, not 8: a Janus handshake is about ten round trips plus the first picture, and 8 s killed attempts that were slow but progressing, every time.

### Never giving up

A phone on a bad connection loses WebRTC far more often than it loses MJPEG, and the old console kept the frozen picture (W4), then waited a flat 5 s per attempt, and went quiet while the tab was hidden. Nothing in this section gives up: there is no attempt limit anywhere.

- W6. ONE owner. The machine alone times and runs WebRTC retries. The Janus wrapper reports a failure once (`janusFailed`, with a reason), tears itself down, and never schedules a retry, never restarts itself after an error and has no timer that outlives the failure. The old wrapper retried every 5 s on its own AND restarted a session in the machine on `online` and on return, and two clocks over one session is how two sessions end up open.
- W7. Retry forever with capped exponential backoff and jitter: 500 ms, doubling to 15 s (500, 1000, 2000, 4000, 8000, 15000, 15000...), each delay spread by +-20 % so a room of phones that lost the same cell do not all hit the Pi in the same instant. One retry is ever pending. A Pi with no Janus at all is retried at the cap, silently (W17).
- W8. The backoff resets only when a session has PLAYED for 10 s. One that plays and drops inside 10 s keeps the grown delay (a flapping link must not turn into a tight loop of sessions). `online` and a return from an absence also reset it: the network is new, so the first attempt on it is fast.
- W9. Every way a session can end is the same failure: a Janus error, the signalling socket lost, a plugin or answer error, ICE `failed`, the connection `failed` or `closed`, ICE `disconnected` for 3 s (W10), media silent for 4 s (W11), a hangup or detach from the Pi, no video track in 12 s (W5), a track that never plays in 6 s (W2). Each one: the last good frame is held (W13), MJPEG takes the picture, the session is stopped, the retry is armed.
- W10. ICE `disconnected` is how a browser says it has heard nothing from the peer. One that clears inside 3 s (a radio hiccup) is not a drop; one that lasts 3 s is. `failed` is a drop at once. `closed` is a drop unless the wrapper itself closed it.
- W11. A silent drop (media path gone, signalling socket still up, so Janus says nothing) is found by reading the connection's stats every second. The session is dead when NOTHING has advanced for 4 s: not the video or audio bytes, packets and frames, and not the transport's own counters (the selected candidate pair's bytes and responses received). The transport counter is the heartbeat that makes a quiet screen safe: the browser sends a STUN consent check every few seconds and the Pi answers it whether or not a picture is changing, so a static desktop that sends no frames at all still moves it, and a quiet-but-flowing stream is never read as dead.
- W12. The stats check never kills a session it cannot read. It does not run before media has flowed once (the connect timeouts own that phase, W5 and W2), while the document is hidden, or on a browser whose report has no transport counter (a quiet screen would then be indistinguishable from a dead one; ICE state, W10, still covers it). A failed or incomplete `getStats` is "unknown", never "dead". When the page becomes visible the 4 s count starts again.
- W13. A drop holds the last good frame BEFORE the video is stopped. Stopping a `<video>`'s tracks empties it (its size reads 0), and a frame is taken from the video only while it has a size, so the order "stop the session, then fall back" lost the frame on exactly the restarts that came from `online` and from returning. The order is: leave live (freeze), show the `<img>`, stop the tracks, stop the session, load MJPEG. The picture is the held frame, then the first MJPEG frame; it is never black. KNOWN OPEN: in headless Chrome with software raster, one compositor frame (about 16 ms) can come out black at the instant the drop is handled (0 to 1 per drop, about a third of drops over 16 cuts); none was seen from 0.6 s after the fallback through the retries and the swap back. Not seen or ruled out on a GPU browser or on iOS. Moving the stop of the stream, reading the frame back at once, and keeping the canvas composited at opacity 0 did not remove it (the last made it worse and was reverted).
- W14. The swap back is the swap of W1 and nothing else: MJPEG stays until the new `<video>` plays, and it is released on the same turn the video is revealed and the held frame thawed. The audio preference belongs to the page, not to a session: a session is created wanting what the speaker button says, audio switched off stays off through any number of drops, a drop does not turn it on, and the unmute after a swap is attempted once per swap (the picture is muted first, Safari, K38).
- W15. Visibility. A hidden page (and no screen alerts watching) retries at 30 s, never faster, however long it stays hidden: no tight loop for a screen nobody sees, and still a session ready when it comes back. Coming back (any of R1's signals) tries at once, once (R4). `online` tries at once. A session that started under 0.5 s ago and has no video yet is not restarted by the same burst of signals, so one return is one new session, not two.
- W16. A stopped session's late words are not heard. After a failure the old session may still report (its socket closing, its connection state changing); once the machine has stopped it, none of that reaches the machine, so a late `janusFailed` from the old session cannot stop the new one.
- W17. The chip says "reconnecting video" only to someone who had WebRTC: from the failure of a session that had played in this page, until the next swap. A Pi that never had WebRTC (no Janus, blocked) is retried quietly and the chip stays plain.
- W18. The client keeps the numbers a later adaptive phase needs: every 2 s while a session plays, the received video bitrate, the fraction of packets lost, the jitter, the round trip, the frames per second and the decoded size, with the time. A counter that goes backwards (a new session, a reset) gives no sample for that interval rather than a negative one; no session means no sample; nothing is sent anywhere.
- W19. The vendored `janus.js` is loaded on demand. A browser remembers a failed dynamic import of the same address for the life of the page, so a load that failed while the network was down would have meant no WebRTC until a reload; the next attempt loads it under a fresh query string.
- W20. `holdWebrtc(ms)` stops WebRTC now through the fallback path (W9, the last frame held by W13), and no session is started or retried until the hold ends. A pending W7 retry is cancelled. A hold does not change the backoff (W8) and does not show the "reconnecting video" suffix (W17): it is asked for, not a failure.
- W21. `releaseWebrtc` ends the hold early; the hold's own timer ends it at the same point. It starts ONE normal attempt at once, on the same terms as a retry (W15 for a hidden page, nothing outside native mode). A release without a hold does nothing.
- W22. While held, MJPEG shows the picture (V12 default) and is never left suspended. A hold on a page that never had WebRTC starts nothing and changes nothing else.
- W23. `holdWebrtc` with `ms: Infinity` sets no timer: it is a person's "always reduced" (K123), it never expires however long the page stays open, and only `releaseWebrtc` or a new page ends it. A finite hold always ends by its timer (W21).

### MJPEG never gives up either

- V11. Every path out of a failed MJPEG load ends in one pending reconnect (800 ms x1.7 to 8 s, V4) or in the health poll that reloads it (V6); there is no attempt limit and no state in which neither is armed while the picture is wanted. The only deliberate silence is a stream nobody can see (V10, R5), which is reloaded the moment it is wanted again. Proof: the connection cut for 5, 20 and 90 s with a count of the stream requests the Pi's side saw.

### Reduced picture on a weak link

- V12. The MJPEG source is `adaptive` (the server's per-device re-encode, `/app/api/v1/adaptive/stream`) or `direct` (the Pi's own streamer). It is `adaptive` while the link is taken to be weak: a WebRTC session that had played was lost, or two sessions in a row failed, or WebRTC is held (W20). The first MJPEG load of a page is `direct`, and a link is weak again only after the next loss: it stops being weak when a session has played for WEBRTC_STABLE_MS (W8). A person can pin either source (`source` event, `pref` `adaptive` or `direct`). It is `direct` while V14 has marked adaptive unavailable, and always in the desktop app (loopback is not a weak link). While WebRTC plays, MJPEG is paused as before (W1) and the source waits.
- V13. Changing the source reloads the `<img>` under the held frame: the freeze comes before the new src (V7) and the picture thaws only on a real frame. A source change never shows a black frame in between.
- V14. Adaptive is marked unavailable after three adaptive loads in a row produce no frame: an error, or no first frame within 7 s (V4). The next load is then the direct stream, as a trial. If it shows a frame the routes are missing or refusing (404, 503: limits, Pi down): adaptive is not asked for again for 1 minute (ADAPTIVE_RETRY_MS: the cause may be a refusal that passes, the client limit or the Pi being down, both 503), and a probe of `/app/api/v1/adaptive/status` follows: a 404 says the routes are not there at all and makes the wait 10 minutes (ADAPTIVE_BLOCK_MS). A timer set for the end of the wait (`TIMER.adaptiveRetry`) changes the picture over to adaptive then, if it is wanted and the direct one is on screen, so a healthy direct stream is not stayed on for ever; a page nobody can see does it on return. If the direct stream fails too, it is the network, not the routes: the count restarts and adaptive stays. No failure counts while the server is known down.
- V15. Each load attempt fails once for the count, whatever reports it (the image error, the first-frame watchdog, a stale timer): a load is numbered when it starts and its failure is counted once. A frame from an adaptive load resets the count. A failed direct load never counts against adaptive.
- V16. A host without the routes behaves as before the feature, apart from the three extra probes: the direct URL, cadence and reconnect rules are unchanged.

## Lifecycle

- L1. Back from the background (visible) after more than 1 s (`RESUME_STALE_MS`) replaces the input socket and reloads the stream; within 1 s it only ensures the socket and reloads only if the stream is not up. Snapshot mode just polls again at once.
- L2. Network offline says "disconnected"; online clears the server-down flag, replaces the input socket, restarts a WebRTC session and reloads (unless a load is already on its way).
- L3. The health poll (2.5 s) and the blank sampler (1.5 s) repeat until the driver is disposed; the health poll only runs in native mode.

## Coming back from the background

A dropped MJPEG stream raises NO event in the page: the `<img>` neither errors nor loads again, it just stops updating, still reading "live" (measured in headless Chrome: 0 `load`, 0 `error` over 5 s after the server cut the stream, `streams` on the fake 0). So after the page was frozen, hidden or put in the back/forward cache, the stream cannot be asked whether it is alive; it is replaced.

- R1. Returning counts however it is announced: `visibilitychange` to visible, `pageshow` with `persisted` (back/forward cache), the window's `focus`, the Page Lifecycle `resume`. A plain `pageshow` (first load) is not a return.
- R2. A page that was never told it was hidden is still found out: the repeating timers (health 2.5 s, blank 1.5 s) stop while it is frozen, so a tick that comes more than 4 s after the last one IS the return, whatever events did or did not arrive. `freeze` and `pagehide` start the clock if `hidden` never did.
- R3. After an absence over 1 s the stream is reloaded even though the page believes it is live (a cut or silent stream looks exactly like a good one), and the input socket is replaced. Under 1 s nothing that is up is touched.
- R4. One return, many signals (visible + pageshow + focus + resume + online + the tick): exactly ONE new stream. The first signal clears the absence, so the rest find none; a load already on its way to its first frame is never doubled (after an absence, a load from the last 1.5 s counts; on a return that was no absence, anything inside the first-frame watchdog). A pending backoff reconnect is cancelled by the load that replaces it.
- R5. A hidden page reconnects nothing: no MJPEG reconnect, no reload from the watchdog, health or `need`, no backoff timer ticking for a screen nobody sees (unless background screen alerts watch it). The one exception is the WebRTC retry, which keeps a slow 30 s pace (W15). Whatever dropped meanwhile is found stale on return and reloaded once. A `focus` or `pageshow` while `document.hidden` is not a return.
- R6. A WebRTC session is restarted after an absence over 3 s (`AWAY_RECONNECT_MS`) and when the network comes back: MJPEG takes the picture while the new one negotiates (never blank, W13), the old one is stopped, and the old session's late callbacks are ignored (W16). A retry that is waiting for its timer is brought forward by either. A page that is not WebRTC is never given a session.
- R7. Whatever the target holds because of this page (keys, modifiers, mouse buttons) is released when the page leaves and again when it comes back from an absence, before the socket is replaced, so a release that would have died with the old socket is never needed.
- R8. The input socket (`target/FAILURE_MODES.md`, 9 and 20 to 23) opens no attempt while the page is hidden and is kicked, once, on return.

## Status

- U1. The chip's text carries "· input offline" whenever the HID socket is down, whatever the stream state.

## Screen-change alerts

- A1. Nothing alerts on the first sample after watching begins (it only re-baselines), and being unwatched forgets everything.
- A2. A change touching under 2 % of cells (pointer, caret, clock) never alerts; a dialog-sized one does.
- A3. One alert per episode: while the screen keeps changing, further alerts wait until it has been quiet for 20 s.
