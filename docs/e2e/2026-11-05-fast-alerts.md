# E2E run: fast alerts (2026-11-05)

A pop-up in the corner of the screen, from the moment it appears on the (fake) PiKVM to the notification arriving at the (fake) push service. The stack is the real web host with its own local OCR; the PiKVM, the push service and OpenRouter are the fakes in `tools/`.

## Command and environment

```sh
yarn build
node scripts/fetch-ocr.mjs                 # the PP-OCRv4 models, pinned in deploy/ocr.lock
SHARP_MODULES=~/.cache/pikvm-e2e/sharp/node_modules OCR_NODE_MODULES=~/.cache/pikvm-e2e/ocr-bench/node_modules OCR_MODELS=builds/ocr/models \
  node apps/web/e2e/watch-fast.e2e.mjs --runs 10
```

- Machine: AMD Ryzen 7 5800X 8-Core Processor x16, load average at the start 4.73 4.77 4.87; Node v22.22.2; commit d8f4f195 plus the working tree; onnxruntime-node 1.31.1, 2 threads in the OCR worker.
- Frames: 1920 x 1080 JPEG (quality 85, 137 KB for the idle desktop) drawn with sharp: a Windows-like desktop, a taskbar with a clock, and Outlook, Teams and Teams-call toasts at 100% scale in Open Sans (dark and white desktops alternating). Each toast has its own name and text.
- Pace: the production defaults. The whole screen every 3 s with a 6 s settle and a 60 s gap; fast alerts every 1 s, held 1.2 s, a 4 s gap, 500 a day. The toast is shown at a random moment against the 1 s look cycle, stays 2.5 s (a call 4 s), then the desktop is back for 6 s.
- Rule: none. So the fast path makes no network call at all.

## What was NOT measured

- The push service on a real network. The fake push service is on loopback; a real FCM or Apple push adds its own delay (tens to hundreds of ms, sometimes seconds for a device that is asleep) after the host's send. Nothing here says how long a phone takes to show the notification.
- A vision model or Jev. The fast path with no rule uses neither, so there is no model latency to measure. The fallback (OCR timed out, or too few words, with PIKVM_WATCH_FAST_CLOUD_FALLBACK=1 and a key) and a user's rule do call OpenRouter; their latency is not measured.
- A real Pi. The fake kvmd answers a snapshot from memory; a real Pi's snapshot was measured by hand at 75 to 140 ms for a 123 KB JPEG (reported by the main agent, not by this run). The time to capture and encode is inside it and is not part of these numbers beyond the fake's.
- The Xeon the image runs on: this is a workstation. The OCR benchmark on that Xeon is in `2026-11-05-fast-alerts-ocr.md`.

## Latency, toast to notification

10 toasts. "Toast to push" is measured outside the host, from the moment the fake PiKVM started serving the toast to the fake push service receiving it; the other columns are the host's own timestamps for the same toast (`checks.jsonl`).

| | min | median | max |
| --- | --- | --- | --- |
| **Toast to notification at the push service** | 1317 ms | 1678 ms | 2145 ms |
| Toast to the first look that saw it (waiting for the next 1 s look, and the snapshot) | 10 ms | 389 ms | 833 ms |
| First look to confirming look (the 1.2 s hold) | 1201 ms | 1202 ms | 1203 ms |
| Frame captured to notification sent (what the log calls totalMs) | 81 ms | 107 ms | 157 ms |
| First look to notification sent | 1282 ms | 1308 ms | 1358 ms |
| Crop and OCR (confirming look to text ready) | 75 ms | 101 ms | 137 ms |
| of which the OCR read itself | 63 ms | 89 ms | 124 ms |
| Decision (no rule: none) | 0 ms | 0 ms | 0 ms |
| Push send (the host's request to the fake push service answering) | 3 ms | 4 ms | 19 ms |

| # | kind | desktop | toast to push | first look to push | capture to push | wait for look | hold | crop + OCR | OCR | push | urgency / TTL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | email | dark | 1442 ms | 1358 ms | 157 ms | 85 ms | 1202 ms | 137 ms | 124 ms | 19 ms | normal / 300 s |
| 2 | teams | dark | 2091 ms | 1290 ms | 90 ms | 801 ms | 1201 ms | 84 ms | 73 ms | 5 ms | normal / 300 s |
| 3 | call | dark | 1678 ms | 1289 ms | 88 ms | 389 ms | 1202 ms | 82 ms | 71 ms | 5 ms | high / 60 s |
| 4 | email | dark | 2022 ms | 1326 ms | 125 ms | 696 ms | 1202 ms | 120 ms | 109 ms | 4 ms | normal / 300 s |
| 5 | teams | dark | 1933 ms | 1282 ms | 81 ms | 651 ms | 1202 ms | 76 ms | 66 ms | 4 ms | normal / 300 s |
| 6 | call | bright | 1317 ms | 1308 ms | 107 ms | 10 ms | 1202 ms | 102 ms | 90 ms | 4 ms | high / 60 s |
| 7 | email | bright | 1669 ms | 1282 ms | 81 ms | 388 ms | 1202 ms | 75 ms | 63 ms | 5 ms | normal / 300 s |
| 8 | teams | bright | 2145 ms | 1312 ms | 111 ms | 833 ms | 1202 ms | 107 ms | 95 ms | 3 ms | normal / 300 s |
| 9 | call | bright | 1568 ms | 1308 ms | 107 ms | 260 ms | 1203 ms | 101 ms | 89 ms | 4 ms | high / 60 s |
| 10 | email | bright | 1631 ms | 1284 ms | 83 ms | 347 ms | 1203 ms | 78 ms | 66 ms | 3 ms | normal / 300 s |

## With the optional summary on

Two pop-ups are summarised by the fake OpenRouter (it answers after a scripted 350 ms) and a call is not. **The fake model's latency is not a real model's**: a real model on the real network answered in 0.1 to 3 s when tried by hand (see docs/deploy-web.md, "Summaries"), and the host gives up on it after 2.5 s. The number to read is how much the summary adds to the host's own path.

| kind | toast to push | capture to push | summary |
| --- | --- | --- | --- |
| email | 1884 ms | 421 ms | 356 ms |
| teams | 2242 ms | 457 ms | 354 ms |
| call | 1839 ms | 115 ms | none (calls are never summarised) |

## Cost of looking every second

- Snapshots in 30 s: 10 with the watch alone (every 3 s), 30 with fast alerts on (every 1 s, plus one extra look per pending pop-up).
- The host's CPU over those 30 s idle windows (utime + stime of the host process, one core = 100%): 0.7% with the watch alone, 0.5% with fast alerts on, on this workstation. The whole of a look on the host is the fake kvmd round trip, decoding the 1920 x 1080 JPEG and reducing it to the 128 x 72 grey grid.
- The grey grid alone, sharp on this machine, 40 reads of a 1920 x 1080 JPEG: median 3.1 ms, max 3.6 ms.
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
| the watch alone (fast alerts off) looks every 3 s | status 200 | pass |
| fast alerts switch on with the watch on | status 200 | pass |
| fast alerts look every second; the whole screen is still compared every third look | 30 snapshots in 30 s with fast alerts on, 10 with them off; host CPU 0.7% off, 0.5% on (one core = 100%, this machine) | pass |
| the OCR worker is a process of its own and is warm before the first toast | host pid 1121496, child processes 1123818 | pass |
| each notification says what the toast said: a call is 'Incoming call: <who>' with urgency high and a 60 s TTL, mail and chat carry the sender and the message with urgency normal | 10 of 10 as expected | pass |
| no network call for the screen: with no rule nothing went to OpenRouter | 0 calls to the fake OpenRouter while 10 toasts were shown (the two changes of the whole desktop between them are the whole-screen path's and are not counted) | pass |
| the screen's words are in neither the check log nor the host's output | none of Berg, Carter, Shah, Lunch, Invoice, ticket, calling found in 12 log lines or 7 output lines | pass |
| every toast was noticed once: no second notification from the slow path, no repeat | 10 notifications for 10 toasts; 11 fast checks, 1 whole-screen checks (none pushed) | pass |
| a toast that is up for only 2 s (gone at, or just before, the look that confirms it) is still notified | notified: {"title":"Teams","body":"…","tag":"pikvm-alert-613847d6","url":"/app/","badge":1} | pass |
| the summary switches on with a key and fast alerts on | status 200 | pass |
| with the summary on, each pop-up's body is the model's sentence and the call's is not summarised | bodies [44,59,43] characters; call title Incoming call: Kit Moreno | pass |
| the summary request carries the text and no image, and is made for two pop-ups out of three | 2 OpenRouter calls: summarise, summarise; image field on none | pass |
| the log says the summary was used, with its time, and holds no text | summary ms 356, 354 (the fake answers after 350 ms) | pass |

14 of 14 passed.
