# E2E: the shared cursor (2026-11-03)

Host under test: `node dist/web-server.js` (http://127.0.0.1:8171) in front of `tools/fake-kvmd`. Two real Chrome pages on it at once: a 1400x900 desktop page driven with the mouse, and an iPhone 13 page (touch, coarse pointer) driven with raw CDP touch events on the trackpad. Script: `apps/web/e2e/cursor-sync.e2e.mjs`; how to run it: `docs/e2e/README.md`.

Each page records every change to its drawn cursor (the trackpad blob, and the marker for somebody else's pointer) on the clock the runner shares; the truth is what the fake kvmd received. A point is "there" when the drawn hotspot is within 2 px of the point the fake's last `mouse_move` names, mapped onto that page's own picture box. Latency is from the moving page's last input event to the first redraw of the other page at the point (an upper bound: the input is counted from just before it is sent).

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| iPhone 13 | before anything has moved the pointer the host knows of, the phone draws no pointer of somebody else's | marker shown false (the phone's own blob is its own: shown true) | pass |
| iPhone 13 | the desktop's mouse moves over the picture: the phone's blob is at the matching point (within 2 px) within 200 ms | kvmd got -14745,2458; phone blob at 107.3,333.7 131 ms after the last mouse event | pass |
| iPhone 13 | it was the desktop that sent the moves: the phone sent none (nothing is echoed back to kvmd) | 6 moves, 0 from any other socket | pass |
| Desktop 1400x900 | the desktop does not draw a pointer of somebody else's for its own moves | marker shown false | pass |
| iPhone 13 | a fast mouse (90 moves at 8 ms) ends with the phone on the last point, within the budget, and about one update per frame | last point 8 ms after the last event; the blob was redrawn 83 times for 90 moves over 900+ ms | pass |
| Desktop 1400x900 | a trackpad drag on the phone: the desktop's marker for somebody else's pointer is at the matching point (within 2 px) within 200 ms | kvmd got 6956,-25254 from the phone; desktop marker at 866.3,175.3 16 ms after the last touch move | pass |
| Desktop 1400x900 | when the desktop's mouse moves again the marker goes, and the desktop is the one cursor | marker shown false | pass |
| iPhone 13 | and the phone's blob has followed the desktop back | blob at 195.0,325.5 | pass |
| Desktop 1400x900 + iPhone 13 | both moving at once: neither cursor jumps to the other's, and when both stop they agree | desktop marker shown in 0 of 24 changes while its mouse moved; the phone's blob moved at most 3.7 px between two redraws with 0 large reversals over 87 redraws; last write came from the phone; phone blob at 390.0,302.0 (truth 390.0,302.0); desktop marker shown true at 1400.0,387.3 (truth 1400.0,387.3) | pass |
| Desktop 1400x900 + iPhone 13 | after a second more, the page that did not write last shows the cursor at the target's point and the other page is not moving | last writer: phone; phone blob 390.0,302.0 vs 390.0,302.0; desktop marker shown true at 1400.0,387.3 vs 1400.0,387.3 | pass |
| iPhone 13 | a reloaded phone draws the host's current position within 2 s of its picture being live | blob at 273.0,292.6 (truth 273.0,292.6) 150 ms after the reload | pass |
| Desktop 1400x900 | a reloaded desktop draws the host's current position (it was put there by another client) as the marker | marker at 1181.1,417.2 (truth 1181.1,417.2) | pass |
| Desktop 1400x900 + iPhone 13 | no page error or console error in either page | clean | pass |

Screenshots: [the phone follows the desktop](cursor-sync/phone-follows-desktop.png), [the desktop shows the phone's pointer](cursor-sync/desktop-shows-phone.png), [the phone again after the desktop moves](cursor-sync/phone-follows-desktop-again.png), [both pages after both moved](cursor-sync/phone-after-both.png) and [desktop](cursor-sync/desktop-after-both.png), [the desktop after a reload](cursor-sync/desktop-after-reload.png).
