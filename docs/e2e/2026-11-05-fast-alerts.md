# E2E run: the pop-up watch (2026-11-05)

A pop-up in the corner of the screen, from the moment it appears on the (fake) PiKVM to the notification arriving at the (fake) push service. The stack is the real web host with its own local OCR; the PiKVM, the push service and the chat model are the fakes in `tools/`.

## Command and environment

```sh
yarn build
node scripts/fetch-ocr.mjs                 # the PP-OCRv4 models, pinned in deploy/ocr.lock
SHARP_MODULES=~/.cache/pikvm-e2e/sharp/node_modules OCR_NODE_MODULES=~/.cache/pikvm-e2e/ocr-bench/node_modules OCR_MODELS=builds/ocr/models \
  node apps/web/e2e/watch-fast.e2e.mjs --runs 10
```

- Machine: AMD Ryzen 7 5800X 8-Core Processor x16, load average at the start 4.23 4.98 5.38; Node v22.22.2; commit 9f5bef91 plus the working tree; onnxruntime-node 1.31.1, 2 threads in the OCR worker.
- Frames: 1920 x 1080 JPEG (quality 85, 137 KB for the idle desktop) drawn with sharp: a Windows-like desktop, a taskbar with a clock, and Outlook, Teams and Teams-call toasts at 100% scale in Open Sans (dark and white desktops alternating). Each toast has its own name and text.
- Pace: the production defaults: a look every 1 s, a pop-up held 1.2 s, a 4 s gap between checks, 500 a day. The toast is shown at a random moment against the 1 s look cycle, stays 2.5 s (a call 4 s), then the desktop is back for 6 s.
- Rule: none; chat model: none for the main run (so no request is made to any model), the fake one for the last three toasts.

## What was NOT measured

- The push service on a real network. The fake push service is on loopback; a real FCM or Apple push adds its own delay (tens to hundreds of ms, sometimes seconds for a device that is asleep) after the host's send. Nothing here says how long a phone takes to show the notification.
- A real chat model. With none configured (the main run) nothing is asked of any model; with the fake one the model's time is the fake's. A real model on the real network answered in 0.1 to 3 s when tried by hand (docs/deploy-web.md, "The notification's words"), and the host gives up on it after 2.5 s.
- A real Pi. The fake kvmd answers a snapshot from memory; a real Pi's snapshot was measured by hand at 75 to 140 ms for a 123 KB JPEG (reported by the main agent, not by this run). The time to capture and encode is inside it and is not part of these numbers beyond the fake's.
- The Xeon the image runs on: this is a workstation. The OCR benchmark on that Xeon is in `2026-11-05-fast-alerts-ocr.md`.

## Latency, toast to notification

10 toasts. "Toast to push" is measured outside the host, from the moment the fake PiKVM started serving the toast to the fake push service receiving it; the other columns are the host's own timestamps for the same toast (`checks.jsonl`).

| | min | median | max |
| --- | --- | --- | --- |
| **Toast to notification at the push service** | 1390 ms | 1767 ms | 1886 ms |
| Toast to the first look that saw it (waiting for the next 1 s look, and the snapshot) | 97 ms | 431 ms | 524 ms |
| First look to confirming look (the 1.2 s hold) | 1201 ms | 1202 ms | 1203 ms |
| Frame captured to notification sent (what the log calls totalMs) | 81 ms | 109 ms | 419 ms |
| First look to notification sent | 1281 ms | 1310 ms | 1619 ms |
| Crop and OCR (confirming look to text ready) | 75 ms | 101 ms | 375 ms |
| of which the OCR read itself | 64 ms | 89 ms | 359 ms |
| Push send (text ready to the fake push service answering; no chat model) | 5 ms | 6 ms | 41 ms |

| # | kind | desktop | toast to push | first look to push | capture to push | wait for look | hold | crop + OCR | OCR | push | urgency / TTL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | email | dark | 1886 ms | 1363 ms | 162 ms | 524 ms | 1202 ms | 141 ms | 127 ms | 20 ms | normal / 300 s |
| 2 | teams | dark | 1390 ms | 1293 ms | 92 ms | 97 ms | 1202 ms | 85 ms | 75 ms | 6 ms | normal / 300 s |
| 3 | call | dark | 1813 ms | 1289 ms | 89 ms | 524 ms | 1201 ms | 83 ms | 73 ms | 5 ms | high / 60 s |
| 4 | email | dark | 1768 ms | 1321 ms | 121 ms | 447 ms | 1201 ms | 114 ms | 103 ms | 6 ms | normal / 300 s |
| 5 | teams | dark | 1712 ms | 1281 ms | 81 ms | 431 ms | 1201 ms | 75 ms | 66 ms | 5 ms | normal / 300 s |
| 6 | call | bright | 1767 ms | 1619 ms | 419 ms | 162 ms | 1203 ms | 375 ms | 359 ms | 41 ms | high / 60 s |
| 7 | email | bright | 1596 ms | 1285 ms | 84 ms | 311 ms | 1202 ms | 77 ms | 64 ms | 6 ms | normal / 300 s |
| 8 | teams | bright | 1784 ms | 1313 ms | 112 ms | 472 ms | 1202 ms | 105 ms | 93 ms | 6 ms | normal / 300 s |
| 9 | call | bright | 1554 ms | 1310 ms | 109 ms | 244 ms | 1203 ms | 101 ms | 89 ms | 6 ms | high / 60 s |
| 10 | email | bright | 1535 ms | 1287 ms | 86 ms | 248 ms | 1202 ms | 79 ms | 66 ms | 6 ms | normal / 300 s |

## With a chat model configured

Two pop-ups are written up by the fake chat model (it answers after a scripted 350 ms) and a call is not asked about. **The fake model's latency is not a real model's**: the number to read is how much the model step adds to the host's own path.

| kind | toast to push | capture to push | model |
| --- | --- | --- | --- |
| email | 2595 ms | 441 ms | 370 ms |
| teams | 2493 ms | 471 ms | 364 ms |
| call | 2106 ms | 105 ms | not asked (calls never wait) |

## Cost of looking every second

- Snapshots in 30 s: 30 (every 1 s, plus one extra look per pending pop-up).
- The host's CPU over that 30 s idle window (utime + stime of the host process, one core = 100%): 1.0%, on this workstation. The whole of a look on the host is the fake kvmd round trip, decoding the 1920 x 1080 JPEG and reducing it to the 128 x 72 grey grid.
- The grey grid alone, sharp on this machine, 40 reads of a 1920 x 1080 JPEG: median 2.9 ms, max 3.2 ms.
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
| it looks every second | 30 snapshots in 30 s; host CPU 1.0% (one core = 100%, this machine) | pass |
| the OCR worker is a process of its own and is warm before the first toast | host pid 1312141, child processes 1312181 | pass |
| each notification says what the toast said: a call is 'Incoming call: <who>' with urgency high and a 60 s TTL, mail and chat carry the sender and the message with urgency normal | 10 of 10 as expected | pass |
| with no chat model configured nothing is asked of any model | 0 requests to the fake chat model while 10 toasts were shown | pass |
| the screen's words are in neither the check log nor the host's output | none of Berg, Carter, Shah, Lunch, Invoice, ticket, calling found in 11 log lines or 6 output lines | pass |
| every toast was noticed once: no repeat | 10 notifications for 10 toasts | pass |
| a toast that is up for only 2 s (gone at, or just before, the look that confirms it) is still notified | notified: {"title":"Teams","body":"…","tag":"pikvm-alert-613847d6","url":"/app/","badge":1} | pass |
| with a chat model set the page's view says so | chatModel true | pass |
| with a chat model, each pop-up's body is the model's sentence and a call's is not asked about | bodies [44,59,43] characters; call title Incoming call: Kit Moreno | pass |
| the request carries the text and no image, and is made for two pop-ups out of three | 2 requests to the fake chat model, image in 0; model small | pass |
| the log says the model's sentence was used, with its time, and holds no text | model ms 370, 364 (the fake answers after 350 ms) | pass |

13 of 13 passed.
