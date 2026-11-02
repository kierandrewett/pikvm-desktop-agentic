# E2E run: WebRTC and audio against the real PiKVM, video only (2026-11-02)

Host: `node dist/web-server.js` on loopback, pointed at the real PiKVM from the desktop app's config (credentials from the config, never printed). Browser: headless Chrome through puppeteer-core. Script: `apps/web/e2e/kvm-real-video.mjs`.

Input was impossible by construction. An init script, installed before the page's own scripts, dropped every frame on the kvmd event socket except `ping` and rejected every non-GET request to `/api/`. The run performed no pointer or keyboard action. No screenshot of the target is kept.

| Case | Observed | Result |
| --- | --- | --- |
| WebRTC video took over from MJPEG | the <video> is shown, playing, with a size | pass |
| video frames advance | 2 then 185 frames in 3 s (61.0 fps); currentTime 0.03 to 3.04; dropped 4 | pass |
| audio track present | 1 audio track(s) [{"state":"live","enabled":true,"muted":false}]; 1 video track(s) | pass |
| resolution label correct | ["1920 × 1080  ·  MJPEG","1920 × 1080  ·  HD · WebRTC🔊"]; <video> is 1920x1080 | pass |
| status chip and audio buttons | chip "Live"; speaker true (pressed true), mic true | pass |
| guard: zero HID frames and zero non-GET /api/ requests left the page | event-socket frames sent: {}; blocked frames: []; blocked requests: []; GETs: 5 | pass |
| no page errors | clean | pass |
| guard self-test: injected HID frames and POSTs are stopped before the network | 2 injected frames blocked: 2; 5 fetch POSTs rejected: 5; blocked requests logged: 6 of 6 (5 fetch + 1 XHR) | pass |

8 of 8 passed.
