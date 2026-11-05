# E2E run: the pop-up watch (2026-11-05)

A pop-up in the corner of the screen, from the moment it appears on the (fake) PiKVM to the notification arriving at the (fake) push service. The stack is the real web host with its own local OCR; the PiKVM, the push service and the chat model are the fakes in `tools/`.

## Command and environment

```sh
yarn build
node scripts/fetch-ocr.mjs                 # the PP-OCRv4 models, pinned in deploy/ocr.lock
SHARP_MODULES=~/.cache/pikvm-e2e/sharp/node_modules OCR_NODE_MODULES=~/.cache/pikvm-e2e/ocr-bench/node_modules OCR_MODELS=builds/ocr/models \
  node apps/web/e2e/watch-fast.e2e.mjs --runs 10
```

- Machine: AMD Ryzen 7 5800X 8-Core Processor x16, load average at the start 8.05 7.99 8.22; Node v22.22.2; commit 8be0ce5d plus the working tree; onnxruntime-node 1.31.1, 2 threads in the OCR worker.
- Frames: 1920 x 1080 JPEG (quality 85, 137 KB for the idle desktop) drawn with sharp: a Windows-like desktop, a taskbar with a clock, and Outlook, Teams and Teams-call toasts at 100% scale in Open Sans (dark and white desktops alternating). Each toast has its own name and text.
- Pace: the production defaults: a look every 1 s, a pop-up held 1.2 s, a 4 s gap between checks, 500 a day. The toast is shown at a random moment against the 1 s look cycle, stays 2.5 s (a call 4 s), then the desktop is back for 6 s.
- Rule: none; chat model: none for the main run (so no request is made to any model), the fake one (two scripted steps, READ then JUDGE) for the section after it.

## What was NOT measured

- The push service on a real network. The fake push service is on loopback; a real FCM or Apple push adds its own delay (tens to hundreds of ms, sometimes seconds for a device that is asleep) after the host's send. Nothing here says how long a phone takes to show the notification.
- A real chat model. With none configured (the main run) nothing is asked of any model; with the fake one the two steps' time is the fake's. What real small models answered, and how fast, is in `2026-11-05-notification-judge.md` (hosted models over a network, not a local one on this machine). The host gives up on READ after 3 s and on JUDGE after what is left of a 5 s budget.
- A real Pi. The fake kvmd answers a snapshot from memory; a real Pi's snapshot was measured by hand at 75 to 140 ms for a 123 KB JPEG (reported by the main agent, not by this run). The time to capture and encode is inside it and is not part of these numbers beyond the fake's.
- The Xeon the image runs on: this is a workstation. The OCR benchmark on that Xeon is in `2026-11-05-fast-alerts-ocr.md`.

## Latency, toast to notification

10 toasts. "Toast to push" is measured outside the host, from the moment the fake PiKVM started serving the toast to the fake push service receiving it; the other columns are the host's own timestamps for the same toast (`checks.jsonl`).

| | min | median | max |
| --- | --- | --- | --- |
| **Toast to notification at the push service** | 1433 ms | 1761 ms | 2123 ms |
| Toast to the first look that saw it (waiting for the next 1 s look, and the snapshot) | 107 ms | 463 ms | 832 ms |
| First look to confirming look (the 1.2 s hold) | 1201 ms | 1202 ms | 1203 ms |
| Frame captured to notification sent (what the log calls totalMs) | 89 ms | 118 ms | 185 ms |
| First look to notification sent | 1289 ms | 1318 ms | 1386 ms |
| Crop and OCR (confirming look to text ready) | 82 ms | 112 ms | 162 ms |
| of which the OCR read itself | 69 ms | 100 ms | 147 ms |
| Push send (text ready to the fake push service answering; no chat model) | 4 ms | 7 ms | 22 ms |

| # | kind | desktop | toast to push | first look to push | capture to push | wait for look | hold | crop + OCR | OCR | push | urgency / TTL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | email | dark | 1553 ms | 1386 ms | 185 ms | 168 ms | 1202 ms | 162 ms | 147 ms | 22 ms | normal / 300 s |
| 2 | teams | dark | 1692 ms | 1303 ms | 102 ms | 390 ms | 1202 ms | 94 ms | 82 ms | 7 ms | normal / 300 s |
| 3 | call | dark | 1644 ms | 1289 ms | 89 ms | 355 ms | 1201 ms | 84 ms | 73 ms | 4 ms | high / 60 s |
| 4 | email | dark | 2044 ms | 1333 ms | 132 ms | 711 ms | 1202 ms | 124 ms | 113 ms | 7 ms | normal / 300 s |
| 5 | teams | dark | 2123 ms | 1292 ms | 91 ms | 832 ms | 1203 ms | 83 ms | 71 ms | 6 ms | normal / 300 s |
| 6 | call | bright | 2014 ms | 1318 ms | 118 ms | 696 ms | 1201 ms | 112 ms | 100 ms | 5 ms | high / 60 s |
| 7 | email | bright | 1752 ms | 1302 ms | 102 ms | 452 ms | 1201 ms | 82 ms | 69 ms | 19 ms | normal / 300 s |
| 8 | teams | bright | 2038 ms | 1328 ms | 127 ms | 711 ms | 1203 ms | 118 ms | 104 ms | 7 ms | normal / 300 s |
| 9 | call | bright | 1433 ms | 1327 ms | 127 ms | 107 ms | 1201 ms | 119 ms | 104 ms | 7 ms | high / 60 s |
| 10 | email | bright | 1761 ms | 1299 ms | 99 ms | 463 ms | 1202 ms | 91 ms | 75 ms | 6 ms | normal / 300 s |

## With a chat model configured: two steps

Every pop-up that is not a call goes through the chat model twice: READ (the OCR text to facts) then JUDGE (the facts to a verdict and the notification's body). Each step is answered by the fake chat model after its own scripted delay (READ 400 ms, JUDGE 600 ms) or is made to fail. **The fake model's latency is not a real model's**: the numbers to read are what the two steps add to the host's own path, and what a failure costs. The measurements of real models are in `2026-11-05-notification-judge.md`.

| pop-up | fake model | outcome | toast to push | capture to push | READ | JUDGE |
| --- | --- | --- | --- | --- | --- | --- |
| an urgent pop-up | READ 400 ms, JUDGE 600 ms: notify | pushed (person_waiting) | 3348 ms | 1215 ms | 440 ms | 619 ms |
| a routine pop-up | READ 400 ms, JUDGE 600 ms: not urgent (routine) | judged not urgent, nothing pushed | - | - | 440 ms | 620 ms |
| a pop-up with the judge down | READ 400 ms, JUDGE answers 503 | pushed, failed open (judge error) | 2530 ms | 575 ms | 418 ms | 24 ms (error) |
| a pop-up with the judge not answering | READ 400 ms, JUDGE never answers (hang guard 20 s) | pushed, failed open (judge timeout) | 22031 ms | 20536 ms | 419 ms | 20002 ms (timeout) |
| a pop-up with a slow model | READ 6 s, JUDGE 6 s: notify | pushed (person_waiting) | 14274 ms | 12165 ms | 6041 ms | 6029 ms |
| a first pop-up while the model is slow | READ 3 s, JUDGE 3 s: notify | pushed (person_waiting) | 10065 ms | 8135 ms | 4024 ms | 4029 ms |
| a second pop-up, queued behind the first | READ 3 s, JUDGE 3 s: notify | pushed (failure) | 13360 ms | 11204 ms | 4021 ms | 4027 ms |
| a pop-up with the reader down | READ answers 503, JUDGE 600 ms: notify | pushed (reader error, judge got the lines) | 2918 ms | 736 ms | 31 ms (error) | 616 ms |
| a call | not asked | pushed, no model | 1409 ms | 132 ms | not asked | not asked |

The two steps are in the log as `judged.readMs` and `judged.judgeMs` and as `latency.factsAt` and `latency.judgedAt`; the verdict is `judged.notify` and `judged.reason` (one of a fixed list); a step that gave nothing usable is `readSkipped` or `judgeSkipped` with `timeout`, `error`, `invalid` or `empty`. The judge's own words, the facts and the pop-up's text are never logged.

## Real small models, the same prompts

Not run by this script (it needs a network and a key): the measurement of the two prompts on six hosted small models and 105 synthetic pop-ups, copied here from `2026-11-05-notification-judge.md`, which has the method, the iterations and what was not verified.

| Model | Right of 105 | Clear (83) | Borderline (22) | False notifies | Missed notifies | Detail kept | Valid JSON (of 210 steps) | READ median (90th pct) | JUDGE median (90th pct) | Both, median (90th pct) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A, small hosted | 100 | 82 | 18 | 3 (1 by fail-open) | 2 | 59 of 59 | 208 | 1.0 s (1.7) | 1.0 s (2.4) | 2.2 s (4.2) |
| 8B | 103 | 83 | 20 | 1 (1 by fail-open) | 1 | 56 of 60 | 209 | 2.1 s (3.0) | 1.2 s (1.8) | 3.4 s (4.7) |
| 12B | 100 | 81 | 19 | 3 (2 by fail-open) | 2 | 57 of 59 | 208 | 1.2 s (2.4) | 0.8 s (1.6) | 2.1 s (4.4) |
| 3B | 105 | 83 | 22 | 0 | 0 | 58 of 61 | 210 | 0.9 s (2.3) | 0.7 s (1.2) | 1.6 s (3.8) |
| 4B | 84 | 69 | 15 | 21 | 0 | 59 of 61 | 210 | 1.4 s (2.5) | 1.1 s (1.6) | 2.6 s (3.9) |
| 1B, stands for a weak local model | 65 | 56 | 9 | 40 (13 by fail-open) | 0 | 55 of 61 | 164 | 1.1 s (2.7) | 1.0 s (4.0) | 2.4 s (5.9) |

## Cost of looking every second

- Snapshots in 30 s: 30 (every 1 s, plus one extra look per pending pop-up).
- The host's CPU over that 30 s idle window (utime + stime of the host process, one core = 100%): 1.1%, on this workstation. The whole of a look on the host is the fake kvmd round trip, decoding the 1920 x 1080 JPEG and reducing it to the 128 x 72 grey grid.
- The grey grid alone, sharp on this machine, 40 reads of a 1920 x 1080 JPEG: median 3.4 ms, max 4.4 ms.
- Bytes: one snapshot of this frame is 137 KB, so a look a second is about 137 KB/s from the Pi to the host (the real Pi's frame is 123 KB).
- What the Pi spends serving a snapshot a second was not measured here (see above); the main agent measured 75 to 140 ms per snapshot on the real one, which a look a second keeps busy for at most about 14% of a core.

## Threshold: the zone's change fraction

The default zone (bottom right, x 0.62 to 1, y 0.55 to 1) is 49 x 33 = 1617 cells of the 128 x 72 grid. The zone has changed when 1.5% of them did (25 cells), a cell having changed when its grey level moved by 10 of 255. Measured on this run's frames:

| what changed in the zone | desktop | fraction of the zone's cells | must fire |
| --- | --- | --- | --- |
| a blinking caret in a text box | dark | 0.12% | no |
| the taskbar clock's minute digit | dark | 0.00% | no |
| the clock and the date at midnight | dark | 0.00% | no |
| a tray icon changing colour and gaining a badge | dark | 0.31% | no |
| the mouse pointer moving into the zone | dark | 0.19% | no |
| a 40 px spinner turning a quarter | dark | 0.43% | no |
| toast: email | dark | 17.19% | yes |
| toast: emailDark | dark | 9.96% | yes |
| toast: teams | dark | 8.53% | yes |
| toast: teamsLight | dark | 14.16% | yes |
| toast: call | dark | 10.58% | yes |
| toast: generic | dark | 14.16% | yes |
| toast: faint | dark | 7.17% | yes |
| a blinking caret in a text box | bright | 0.12% | no |
| the taskbar clock's minute digit | bright | 0.00% | no |
| the clock and the date at midnight | bright | 0.00% | no |
| a tray icon changing colour and gaining a badge | bright | 0.31% | no |
| the mouse pointer moving into the zone | bright | 0.25% | no |
| a 40 px spinner turning a quarter | bright | 0.06% | no |
| toast: email | bright | 10.27% | yes |
| toast: emailDark | bright | 15.83% | yes |
| toast: teams | bright | 12.68% | yes |
| toast: teamsLight | bright | 8.91% | yes |
| toast: call | bright | 15.83% | yes |
| toast: generic | bright | 8.78% | yes |
| toast: faint | bright | 11.01% | yes |
| the same frame re-encoded at JPEG quality 60 | dark | 0.00% | no |
| the same frame with +-3 grey noise on every pixel | dark | 0.00% | no |

## Checks

| Check | Observed | Result |
| --- | --- | --- |
| threshold: every kind of noise is under the zone line and every toast is over it | line 1.5% of 1617 cells; worst noise 0.43% (3.5x under the line); weakest toast 7.17% (4.8x over it) | pass |
| the watch switches on with no chat model and no key | status 200 | pass |
| it looks every second | 30 snapshots in 30 s; host CPU 1.1% (one core = 100%, this machine) | pass |
| the OCR worker is a process of its own and is warm before the first toast | host pid 1957385, child processes 1957426 | pass |
| each notification says what the toast said: a call is 'Incoming call: <who>' with urgency high and a 60 s TTL, mail and chat carry the sender and the message with urgency normal | 10 of 10 as expected | pass |
| with no chat model configured nothing is asked of any model | 0 requests to the fake chat model while 10 toasts were shown | pass |
| the screen's words are in neither the check log nor the host's output | none of Berg, Carter, Shah, Lunch, Invoice, ticket, calling found in 11 log lines or 6 output lines | pass |
| every toast was noticed once: no repeat | 10 notifications for 10 toasts | pass |
| a toast that is up for only 2 s (gone at, or just before, the look that confirms it) is still notified | notified: {"title":"Teams","body":"…","tag":"pikvm-alert-613847d6","url":"/app/","badge":1} | pass |
| with a chat model set the page's view says so | chatModel true | pass |
| an urgent pop-up is pushed with the judge's detailed body and title | body 60 characters, title Zed Quinn | pass |
| both steps were asked, in order, READ with the OCR text and JUDGE with the facts READ found, each asking for JSON, none with an image | read+json, judge+json; the judge was sent 88 characters | pass |
| the log has each step's time and the verdict as fixed words, and no text | read 440 ms (scripted 400), judge 619 ms (scripted 600), {"readMs":440,"judgeMs":619,"notify":true,"reason":"person_waiting"} | pass |
| a routine pop-up is judged not urgent: nothing pushed, outcome 'no', only the reason in the log | pushes 0, log {"readMs":440,"judgeMs":620,"notify":false,"reason":"routine"}, 2 model requests | pass |
| the judge failing (503) fails open: the pop-up is pushed, as the facts' text, and the log says the judge errored | body 76 characters; {"readMs":418,"judgeMs":24,"judgeSkipped":"error"} | pass |
| the judge not answering is ended only by the hang guard (20 s here) and fails open as well | judge 20002 ms, toast to push 22031 ms; {"readMs":419,"judgeMs":20002,"judgeSkipped":"timeout"} | pass |
| a slow model is waited for: READ 6 s and JUDGE 6 s are both used, nothing is skipped, and the judge's own body is pushed | {"readMs":6041,"judgeMs":6029,"notify":true,"reason":"person_waiting"}, toast to push 14274 ms | pass |
| a second pop-up that arrives while a slow check runs waits and is read: both pushed, in order, with their own bodies, nothing skipped | pushed (read 4024 ms, judge 4029 ms); pushed (read 4021 ms, judge 4027 ms) | pass |
| the reader failing: it is tried once more, then the judge is given the OCR lines as read, and its body is used | read, read, judge; {"readMs":31,"readSkipped":"error","judgeMs":616,"notify":true,"reason":"time_critical"} | pass |
| a call is pushed at once and never asked about | 0 model requests; toast to push 1409 ms | pass |
| every request carries the model, a key, JSON mode and no image | 14 requests | pass |
| a page reports a key press just now | status 200 | pass |
| a pop-up while the person is using the window: no push, no request to the model, logged as held | pushes 0, model requests 0, log: held (you are using this window) | pass |
| the held line holds no pop-up text | 268 characters of log | pass |
| the same pop-up after 20 s of quiet is pushed | notification 1405 ms after the pop-up appeared, 24 s after the last input | pass |

25 of 25 passed.
