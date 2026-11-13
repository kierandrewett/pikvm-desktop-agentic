# Adaptive video: failure modes

Written before the code. The host offers a second, per-device picture for a poor link: the Pi's MJPEG read once,
re-encoded smaller, and never queued. The normal `/streamer/stream` proxy is untouched and still the default.
Proved end to end by `~/.cache/pikvm-e2e/adaptive-server/` (see its REPORT.md), not by unit tests.

Terms: a **rung** is one step of the ladder (scale, JPEG quality, frame-rate cap). A **device** is one browser
profile, named by a random key the page keeps; its rung outlives a connection.

## The link

- A1. A slow client must never receive a stale picture. The kernel's send buffer (not Node's) holds most of what a slow link
  cannot take, and it grows with the connection. The host counts what is queued toward the client (Node's `writableLength`
  plus the kernel's `tx_queue` from `/proc/net/tcp`), and while that is above the limit a due frame is DROPPED, never
  queued. The limit is seconds of data at the measured rate, with a floor, so it holds at 200 kbps and at 50 Mbps alike.
- A2. A frame is never held back to "catch up": when the client is ready the newest frame is the one sent. Frames that came
  in between are gone. Memory per client is one frame in flight, whatever the link.
- A3. Backlog moves the device DOWN one rung (at most one step per 1.5 s, so the effect of a step can be seen before
  the next). Several seconds with no backlog move it UP one rung. Never both inside one hold-off.
- A4. No flapping: an up-step that is followed by a down-step within 15 s doubles the wait before the next up-step
  (6 s, 12 s, ... 48 s). A clean 60 s resets it.
- A5. A link too slow even for the bottom rung keeps dropping frames at the bottom; it is not closed for that. A link that
  accepts NOTHING for 30 s while data is queued is dead (a phone that left Wi-Fi leaves no FIN): the connection is destroyed.
- A6. Where `/proc/net/tcp` cannot be read (not Linux, a locked-down container) only `writableLength` is known. The status
  says so (`kernelQueue: false`) and the staleness bound is then the kernel buffer, not seconds. Never pretend otherwise.
- A7. Behind a reverse proxy the socket the host sees is the proxy's, which reads fast and buffers on its own. The host
  cannot see the phone's link then; staleness is bounded only by the proxy's buffers. Documented, not fixable here.
- A8. A single frame bigger than the link can take in about a second is the rung's fault: it queues past the limit, the
  next due frames are dropped and the device steps down. It is not sent twice and not split.

## The picture

- P1. ONE read of the Pi's MJPEG feeds every adaptive client. It opens with the first client and is closed with the last
  (no linger). Opening one Pi stream per client would be the Pi's problem, and a mobile reconnect storm would be a flood.
- P2. The Pi's stream ending, answering non-200, sending the wrong content type or nothing for 8 s is reconnected with a
  capped exponential backoff (1 s to 15 s, reset after 5 s of healthy frames). Clients stay connected meanwhile and
  get nothing, not stale frames re-sent. Reconnects are visible in the status. One dead connection is ONE failure: its
  `end`, `close` and stall timer all arrive, and counting each would open two Pi streams (the generation of the attempt
  is bumped by the first, so the rest are ignored).
- P3. No picture within 10 s of a client asking (Pi down, no signal source, host just started) answers 503 BEFORE any
  stream header, so `<img>` raises `error` and the page can fall back. After the stream started, the Pi gone for 30 s
  ends the client's response (the page reconnects).
- P4. The multipart parser trusts only `Content-Length`. A part without one, a length over 16 MiB, a header block over
  4 KiB or a part that is not a JPEG (no SOI, no EOI) is a protocol error: that part is skipped when its length is known,
  otherwise the upstream is dropped and reconnected. Unbounded buffering of a hostile or broken source is impossible.
- P5. A frame that sharp cannot decode is skipped and counted (`decodeErrors`), never sent half-made and never fatal.
- P6. Rung 0 passes the Pi's JPEG through unchanged (no CPU). Rungs below decode and re-encode. Re-encoding runs through
  a process-wide limit (2 at once, slot handed straight to the next waiter) so three clients cannot starve the host's chat,
  OCR or recorder. A pump has one encode outstanding, so the queue is never longer than the number of clients; the
  frame is sent as it was encoded and the pump's next turn takes whatever is newest.
- P7. Clients on the same rung share ONE encode of a frame (cache of the newest frame only).
- P8. The picture size changing (the target changed resolution) needs nothing: the scale is read from each frame's own
  JPEG header.
- P9. A client that arrives in the few milliseconds between the Pi's stream closing and the host noticing is handed the last
  frame (tens of milliseconds old). That is right, not a stale picture; the host drops the frame as soon as it notices.

## Identity and limits

- I1. The device key comes from the page (a random id it stores) and is `[A-Za-z0-9_-]{8,64}`; anything else is 400.
  A missing key is 400, not a shared "anonymous" rung that two phones would fight over.
- I2. A key is bound to who is signed in (`method:subject`; `local` where the desktop's single token gate is used). The
  same key from another subject is a different device and sees nothing of the first. The status lists only the caller's
  own devices.
- I3. A device has one connection at a time. A new connection for a key replaces the old one (a phone coming back does
  not wait for the dead socket to time out, and does not count twice against the limit).
- I4. At most 6 adaptive connections at once; the next gets 503 with `Retry-After`. At most 64 devices are remembered (the
  longest idle is forgotten first); a device idle for 10 minutes is forgotten.
- I5. `profile` is `auto`, `medium` or `low`; anything else is 400. It sets the best rung allowed and where to start. The
  device may still fall to the bottom. A remembered worse rung is kept, not reset to the profile's start.
- I6. Only GET. Anything else is 405. No cross-origin readability (no CORS headers); a cookie is `SameSite=Lax`, so another
  site's `<img>` is not signed in.
- I7. kvmd's global streamer parameters are never read for this and never written. The Pi's own picture, quality, fps and
  resolution are unchanged by anything here. The adaptive read is one extra viewer of `/streamer/stream`, nothing more.

## Teardown

- T1. The client closing, erroring or being replaced ends its pump, releases its upstream subscription and removes its
  timers. When the last client goes, the Pi connection is destroyed and the proc-net poll stops. Verified by counting
  sockets and handles before, during and after.
- T2. The server in use changing, or the host shutting down, ends adaptive responses (`live.track`), like the other streams.
- T3. An error inside a pump is contained to that client (its response is destroyed); it never escapes to the process.
- T4. A write that throws or a response already destroyed is treated as the client having gone.
- T5. The tick that reads the kernel queues runs only while a client exists, and `unref`s its timer.
