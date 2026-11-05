# E2E run: fast alerts (2026-11-05)

A pop-up in the corner of the screen, from the moment it appears on the (fake) PiKVM to the notification arriving at the (fake) push service. The stack is the real web host with its own local OCR; the PiKVM, the push service and OpenRouter are the fakes in `tools/`.

## Command and environment

```sh
yarn build
node scripts/fetch-ocr.mjs                 # the PP-OCRv4 models, pinned in deploy/ocr.lock
SHARP_MODULES=~/.cache/pikvm-e2e/sharp/node_modules OCR_NODE_MODULES=~/.cache/pikvm-e2e/ocr-bench/node_modules OCR_MODELS=builds/ocr/models \
  node apps/web/e2e/watch-fast.e2e.mjs --runs 10
```

- Machine: AMD Ryzen 7 5800X 8-Core Processor x16, load average at the start 4.55 4.94 5.85; Node v22.22.2; commit 5664f977 plus the working tree; onnxruntime-node 1.31.1, 2 threads in the OCR worker.
- Frames: 1920 x 1080 JPEG (quality 85, 137 KB for the idle desktop) drawn with sharp: a Windows-like desktop, a taskbar with a clock, and Outlook, Teams and Teams-call toasts at 100% scale in Open Sans (dark and white desktops alternating). Each toast has its own name and text.
- Pace: the production defaults. The whole screen every 3 s with a 6 s settle and a 60 s gap; fast alerts every 1 s, held 1.2 s, a 4 s gap, 500 a day. The toast is shown at a random moment against the 1 s look cycle, stays 2.5 s (a call 4 s), then the desktop is back for 6 s.
- Rule: none. So the fast path makes no network call at all.

## What was NOT measured

- The push service on a real network. The fake push service is on loopback; a real FCM or Apple push adds its own delay (tens to hundreds of ms, sometimes seconds for a device that is asleep) after the host's send. Nothing here says how long a phone takes to show the notification.
- A vision model or Jev. The fast path with no rule uses neither, so there is no model latency to measure. The fallback (OCR timed out, or too few words, and a key is set) and a user's rule do call OpenRouter; their latency is not measured.
- A real Pi. The fake kvmd answers a snapshot from memory; a real Pi's snapshot was measured by hand at 75 to 140 ms for a 123 KB JPEG (reported by the main agent, not by this run). The time to capture and encode is inside it and is not part of these numbers beyond the fake's.
- The Xeon the image runs on: this is a workstation. The OCR benchmark on that Xeon is in `2026-11-05-fast-alerts-ocr.md`.

## Latency, toast to notification

10 toasts. "Toast to push" is measured outside the host, from the moment the fake PiKVM started serving the toast to the fake push service receiving it; the other columns are the host's own timestamps for the same toast (`checks.jsonl`).

| | min | median | max |
| --- | --- | --- | --- |
| **Toast to notification at the push service** | 1293 ms | 1813 ms | 2254 ms |
| Toast to the first look that saw it (waiting for the next 1 s look, and the snapshot) | 11 ms | 504 ms | 975 ms |
| First look to confirming look (the 1.2 s hold) | 1202 ms | 1202 ms | 1203 ms |
| Frame captured to notification sent (what the log calls totalMs) | 78 ms | 106 ms | 157 ms |
| First look to notification sent | 1279 ms | 1307 ms | 1359 ms |
| Crop and OCR (confirming look to text ready) | 73 ms | 101 ms | 137 ms |
| of which the OCR read itself | 63 ms | 90 ms | 125 ms |
| Decision (no rule: none) | 0 ms | 0 ms | 0 ms |
| Push send (the host's request to the fake push service answering) | 4 ms | 5 ms | 19 ms |

| # | kind | desktop | toast to push | first look to push | capture to push | wait for look | hold | crop + OCR | OCR | push | urgency / TTL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | email | dark | 1447 ms | 1359 ms | 157 ms | 89 ms | 1203 ms | 137 ms | 125 ms | 19 ms | normal / 300 s |
| 2 | teams | dark | 1330 ms | 1288 ms | 87 ms | 42 ms | 1202 ms | 81 ms | 70 ms | 5 ms | normal / 300 s |
| 3 | call | dark | 2004 ms | 1279 ms | 78 ms | 725 ms | 1202 ms | 73 ms | 63 ms | 4 ms | high / 60 s |
| 4 | email | dark | 1914 ms | 1318 ms | 117 ms | 597 ms | 1202 ms | 112 ms | 101 ms | 4 ms | normal / 300 s |
| 5 | teams | dark | 2254 ms | 1280 ms | 79 ms | 975 ms | 1203 ms | 73 ms | 64 ms | 4 ms | normal / 300 s |
| 6 | call | bright | 1411 ms | 1317 ms | 117 ms | 94 ms | 1202 ms | 110 ms | 99 ms | 5 ms | high / 60 s |
| 7 | email | bright | 1541 ms | 1282 ms | 81 ms | 260 ms | 1202 ms | 75 ms | 64 ms | 5 ms | normal / 300 s |
| 8 | teams | bright | 2210 ms | 1307 ms | 106 ms | 903 ms | 1202 ms | 101 ms | 90 ms | 4 ms | normal / 300 s |
| 9 | call | bright | 1813 ms | 1309 ms | 108 ms | 504 ms | 1202 ms | 103 ms | 91 ms | 4 ms | high / 60 s |
| 10 | email | bright | 1293 ms | 1283 ms | 82 ms | 11 ms | 1202 ms | 76 ms | 64 ms | 5 ms | normal / 300 s |

## Cost of looking every second

- Snapshots in 30 s: 10 with the watch alone (every 3 s), 30 with fast alerts on (every 1 s, plus one extra look per pending pop-up).
- The host's CPU over those 30 s idle windows (utime + stime of the host process, one core = 100%): 0.7% with the watch alone, 0.5% with fast alerts on, on this workstation. The whole of a look on the host is the fake kvmd round trip, decoding the 1920 x 1080 JPEG and reducing it to the 128 x 72 grey grid.
- The grey grid alone, sharp on this machine, 40 reads of a 1920 x 1080 JPEG: median 3.2 ms, max 4.8 ms.
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
| the OCR worker is a process of its own and is warm before the first toast | host pid 817760, child processes 820524 | pass |
| each notification says what the toast said: a call is 'Incoming call: <who>' with urgency high and a 60 s TTL, mail and chat carry the sender and the message with urgency normal | 10 of 10 as expected | pass |
| no network call for the screen: with no rule nothing went to OpenRouter | 0 calls to the fake OpenRouter while 10 toasts were shown (the two changes of the whole desktop between them are the whole-screen path's and are not counted) | pass |
| the screen's words are in neither the check log nor the host's output | none of Berg, Carter, Shah, Lunch, Invoice, ticket, calling found in 12 log lines or 7 output lines | pass |
| every toast was noticed once: no second notification from the slow path, no repeat | 10 notifications for 10 toasts; 11 fast checks, 1 whole-screen checks (none pushed) | pass |
| a toast that is up for only 2 s (gone at, or just before, the look that confirms it) is still notified | notified: {"title":"Teams","body":"…","tag":"pikvm-alert-613847d6","url":"/app/","badge":1} | pass |

10 of 10 passed.
