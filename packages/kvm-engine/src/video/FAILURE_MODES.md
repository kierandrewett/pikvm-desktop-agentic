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
- W2. A track that never plays within 6 s falls back to MJPEG.
- W3. Fallback with nothing to fall back from is a no-op: an "error" status with no video ever seen, repeated every few seconds on a Pi without Janus, used to reload a perfectly good MJPEG stream five times in 25 s, each freezing the picture. Only when MJPEG was suspended, or video was active, is there work.
- W4. An error after video was seen does not fall back (the wrapper retries and the video stays); the session stopping while WebRTC is active does, going briefly "reconnecting" while MJPEG reloads.
- W5. The 8 s start guard with no video falls back harmlessly.

## Lifecycle

- L1. Back from the background after more than 3 s replaces the input socket and reloads the stream; within 3 s it only ensures the socket and reloads only if not live. Snapshot mode just polls again at once.
- L2. Network offline says "disconnected"; online clears the server-down flag, replaces the input socket and reloads.
- L3. The health poll (2.5 s) and the blank sampler (1.5 s) repeat until the driver is disposed; the health poll only runs in native mode.

## Status

- U1. The chip's text carries "· input offline" whenever the HID socket is down, whatever the stream state.

## Screen-change alerts

- A1. Nothing alerts on the first sample after watching begins (it only re-baselines), and being unwatched forgets everything.
- A2. A change touching under 2 % of cells (pointer, caret, clock) never alerts; a dialog-sized one does.
- A3. One alert per episode: while the screen keeps changing, further alerts wait until it has been quiet for 20 s.
