# E2E run: the pop-up watch (2026-11-05)

A pop-up in the corner of the screen, from the moment it appears on the (fake) PiKVM to the notification arriving at the (fake) push service. The stack is the real web host with its own local OCR; the PiKVM, the push service and the chat model are the fakes in `tools/`.

## Command and environment

```sh
yarn build
node scripts/fetch-ocr.mjs                 # the PP-OCRv4 models, pinned in deploy/ocr.lock
SHARP_MODULES=~/.cache/pikvm-e2e/sharp/node_modules OCR_NODE_MODULES=~/.cache/pikvm-e2e/ocr-bench/node_modules OCR_MODELS=builds/ocr/models \
  node apps/web/e2e/watch-fast.e2e.mjs --runs 10
```

- Machine: AMD Ryzen 7 5800X 8-Core Processor x16, load average at the start 6.98 5.54 5.79; Node v22.22.2; commit 1f29875d plus the working tree; onnxruntime-node 1.31.1, 2 threads in the OCR worker.
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
| **Toast to notification at the push service** | 1451 ms | 1793 ms | 2184 ms |
| Toast to the first look that saw it (waiting for the next 1 s look, and the snapshot) | 129 ms | 503 ms | 865 ms |
| First look to confirming look (the 1.2 s hold) | 1201 ms | 1202 ms | 1202 ms |
| Frame captured to notification sent (what the log calls totalMs) | 82 ms | 117 ms | 171 ms |
| First look to notification sent | 1283 ms | 1318 ms | 1371 ms |
| Crop and OCR (confirming look to text ready) | 76 ms | 110 ms | 150 ms |
| of which the OCR read itself | 66 ms | 97 ms | 135 ms |
| Push send (text ready to the fake push service answering; no chat model) | 5 ms | 6 ms | 20 ms |

| # | kind | desktop | toast to push | first look to push | capture to push | wait for look | hold | crop + OCR | OCR | push | urgency / TTL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | email | dark | 1737 ms | 1371 ms | 171 ms | 367 ms | 1201 ms | 150 ms | 135 ms | 20 ms | normal / 300 s |
| 2 | teams | dark | 1901 ms | 1296 ms | 96 ms | 605 ms | 1201 ms | 89 ms | 77 ms | 6 ms | normal / 300 s |
| 3 | call | dark | 2048 ms | 1283 ms | 82 ms | 765 ms | 1202 ms | 76 ms | 66 ms | 5 ms | high / 60 s |
| 4 | email | dark | 1451 ms | 1322 ms | 121 ms | 129 ms | 1202 ms | 114 ms | 105 ms | 6 ms | normal / 300 s |
| 5 | teams | dark | 1793 ms | 1290 ms | 89 ms | 503 ms | 1202 ms | 83 ms | 72 ms | 5 ms | normal / 300 s |
| 6 | call | bright | 1602 ms | 1334 ms | 133 ms | 269 ms | 1202 ms | 121 ms | 109 ms | 11 ms | high / 60 s |
| 7 | email | bright | 1507 ms | 1286 ms | 85 ms | 222 ms | 1202 ms | 78 ms | 66 ms | 6 ms | normal / 300 s |
| 8 | teams | bright | 2184 ms | 1320 ms | 119 ms | 865 ms | 1202 ms | 111 ms | 98 ms | 7 ms | normal / 300 s |
| 9 | call | bright | 1740 ms | 1318 ms | 117 ms | 423 ms | 1202 ms | 110 ms | 97 ms | 6 ms | high / 60 s |
| 10 | email | bright | 1839 ms | 1290 ms | 89 ms | 550 ms | 1202 ms | 82 ms | 71 ms | 6 ms | normal / 300 s |

## With a chat model configured: two steps

Every pop-up that is not a call goes through the chat model twice: READ (the OCR text to facts) then JUDGE (the facts to a verdict and the notification's body). Each step is answered by the fake chat model after its own scripted delay (READ 400 ms, JUDGE 600 ms) or is made to fail. **The fake model's latency is not a real model's**: the numbers to read are what the two steps add to the host's own path, and what a failure costs. The measurements of real models are in `2026-11-05-notification-judge.md`.

| pop-up | fake model | outcome | toast to push | capture to push | READ | JUDGE |
| --- | --- | --- | --- | --- | --- | --- |
| an urgent pop-up | READ 400 ms, JUDGE 600 ms: notify | pushed (person_waiting) | 2924 ms | 1121 ms | 427 ms | 615 ms |
| a routine pop-up | READ 400 ms, JUDGE 600 ms: not urgent (routine) | judged not urgent, nothing pushed | - | - | 417 ms | 613 ms |
| a pop-up with the judge down | READ 400 ms, JUDGE answers 503 | pushed, failed open (judge error) | 1804 ms | 544 ms | 416 ms | 14 ms (error) |
| a pop-up with the judge not answering | READ 400 ms, JUDGE never answers | pushed, failed open (judge timeout) | 4925 ms | 3527 ms | 417 ms | 3002 ms (timeout) |
| a pop-up with the reader down | READ answers 503, JUDGE 600 ms: notify | pushed (reader error, judge got the lines) | 2528 ms | 699 ms | 11 ms (error) | 611 ms |
| a call | not asked | pushed, no model | 2171 ms | 117 ms | not asked | not asked |

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
- The grey grid alone, sharp on this machine, 40 reads of a 1920 x 1080 JPEG: median 3.2 ms, max 4.4 ms.
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
| the OCR worker is a process of its own and is warm before the first toast | host pid 1660482, child processes 1660537 | pass |
| each notification says what the toast said: a call is 'Incoming call: <who>' with urgency high and a 60 s TTL, mail and chat carry the sender and the message with urgency normal | 10 of 10 as expected | pass |
| with no chat model configured nothing is asked of any model | 0 requests to the fake chat model while 10 toasts were shown | pass |
| the screen's words are in neither the check log nor the host's output | none of Berg, Carter, Shah, Lunch, Invoice, ticket, calling found in 11 log lines or 6 output lines | pass |
| every toast was noticed once: no repeat | 10 notifications for 10 toasts | pass |
| a toast that is up for only 2 s (gone at, or just before, the look that confirms it) is still notified | notified: {"title":"Teams","body":"…","tag":"pikvm-alert-613847d6","url":"/app/","badge":1} | pass |
| with a chat model set the page's view says so | chatModel true | pass |
| an urgent pop-up is pushed with the judge's detailed body and title | body 60 characters, title Zed Quinn | pass |
| both steps were asked, in order, READ with the OCR text and JUDGE with the facts READ found, each asking for JSON, none with an image | read+json, judge+json; the judge was sent 88 characters | pass |
| the log has each step's time and the verdict as fixed words, and no text | read 427 ms (scripted 400), judge 615 ms (scripted 600), {"readMs":427,"judgeMs":615,"notify":true,"reason":"person_waiting"} | pass |
| a routine pop-up is judged not urgent: nothing pushed, outcome 'no', only the reason in the log | pushes 0, log {"readMs":417,"judgeMs":613,"notify":false,"reason":"routine"}, 2 model requests | pass |
| the judge failing (503) fails open: the pop-up is pushed, as the facts' text, and the log says the judge errored | body 76 characters; {"readMs":416,"judgeMs":14,"judgeSkipped":"error"} | pass |
| the judge not answering is cut at its hard limit (3 s) and fails open as well | judge 3002 ms, toast to push 4925 ms; {"readMs":417,"judgeMs":3002,"judgeSkipped":"timeout"} | pass |
| the reader failing: the judge is given the OCR lines as read, and its body is used | {"readMs":11,"readSkipped":"error","judgeMs":611,"notify":true,"reason":"time_critical"} | pass |
| a call is pushed at once and never asked about | 0 model requests; toast to push 2171 ms | pass |
| every request carries the model, a key, JSON mode and no image | 10 requests | pass |
| a page reports a key press just now | status 200 | pass |
| a pop-up while the person is using the window: no push, no request to the model, logged as held | pushes 0, model requests 0, log: held (you are using this window) | pass |
| the held line holds no pop-up text | 268 characters of log | pass |
| the same pop-up after 20 s of quiet is pushed | notification 1508 ms after the pop-up appeared, 24 s after the last input | pass |

23 of 23 passed.
