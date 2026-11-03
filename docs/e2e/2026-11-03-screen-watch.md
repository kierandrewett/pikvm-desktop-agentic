# E2E run: the screen watch (2026-11-03)

<!-- fakes:start -->
## Run against the fakes

Stack (`apps/web/e2e/watch-stack.mjs`): the web host (`node dist/web-server.js`) with the chat server in it, in front of `tools/fake-kvmd`, whose picture the run changes with `POST /__fake/picture?name=custom` (two frames drawn with sharp: a terminal installing a package, and the same with a failure dialog); `tools/fake-openrouter` as OpenRouter (key stored the way Settings, Providers stores it); `tools/fake-push`, a push service that decrypts what it is sent and checks the VAPID signature. The browser is headless Chrome in the iPhone 13 profile with Safari's `navigator.standalone` set, subscribing for real through its own push service. Pace for the run: look every 2 s, settle 3 s, one check per 20 s, 4 a day (`PIKVM_WATCH_*`; the defaults are 3 s, 6 s, 60 s and 200). No real PiKVM or OpenRouter is touched.

| Case | Observed | Result |
| --- | --- | --- |
| threshold: sub-threshold noise and a caret stay under it; a new line, a dialog's text and a dialog opening are over it | threshold 0.3% of 9216 cells, cell delta 10; the same frame re-encoded at JPEG quality 60: 0.00% under; the same frame with +-3 grey noise on every pixel: 0.00% under; a caret blinking: 0.11% under; a dialog opening: 16.51% over; a dialog's text and colour changing (failed -> done): 1.64% over | pass |
| no OpenRouter key: the page says what to add, and the switch cannot be turned on | switch {"checked":false,"disabled":true}; server: canEnable={"ok":false,"reason":"Add an OpenRouter key in Settings, Providers first. The watch asks an image model what t | pass |
| the server refuses to switch it on without a key (409) and nothing polls the PiKVM | 409 "Add an OpenRouter key in Settings, Providers first. The watch asks an "; snapshots 0 -> 0 over 5 s | pass |
| an iPhone in a Safari tab (not installed) is told to add the app to the Home Screen | switch {"checked":false,"disabled":true}; the message names Add to Home Screen | pass |
| switching on in the installed app: permission, a real push subscription, the server told, the watch running | enabled=true running=true server devices=1; the browser's subscription is on fcm.googleapis.com | pass |
| it watches with no browser page open: the page is closed and the PiKVM is still being looked at | 3 snapshots in 6.5 s with no page open (interval 2 s) | pass |
| a blinking caret and codec-sized noise cost nothing: no model is asked | model calls 0 -> 0; log lines 0 | pass |
| a screen that never settles (alternating pictures) costs nothing, and coming back to what was there is not a change | model calls 0 -> 0; log lines 0 | pass |
| the screen changes and settles: one check (the frame before, the new frame, one decision) and one push | describe x2 (the earlier frame, then the new one, hashes match what the kvmd served), decide x1; fake device got 1 push: {"title":"PiKVM","body":"A dialog titled Installation failed says: could not configure postgresql-16, disk full. A terminal is behind it.","tag":"pikvm-screen","url":"/app/"}; log: pushed | pass |
| the key and the descriptions went as stored: Bearer key from Settings, Jev's state is {previous, current, rule} | image model google/gemma-3-12b-it, Jev typesafe/jev-1.14, rule "(none)" | pass |
| the VAPID signature verifies, the payload is aes128gcm for that device, and the push names the origin it subscribed from | signature true, sub https://kvm.example.org, aud http://127.0.0.1:14720, ttl 3600 | pass |
| the check log says why: score, both descriptions, Jev's answer, the model, the cost, pushed | {"t":1793713821674,"at":"2026-11-03T13:50:21.674Z","kind":"change","score":0.16514756944444445,"rule":"","model":"google/gemma-3-12b-it","asked":true,"previous":"A terminal on Ubuntu runs apt ...","description":"A dialog titled Installation f...","noul":0.96,"costUsd":0.00012,"outcome":"pushed","push":{"sent":2,"removed":0,"failed":0}} | pass |
| the real Chrome got the notification too (its own push service delivered it to the worker) | [{"title":"PiKVM","body":"A dialog titled Installation failed says: could not configure postgresql-16, disk full. A terminal is behind it.","tag":"pikvm-screen"}] | pass |
| Jev not decisive (0.5): a change is checked, logged as undecided, and nothing is pushed | outcome undecided, noul 0.5, reason "Jev's answer was not decisive, so nothing was sent", pushes 1 -> 1 | pass |
| Jev says no (0.03): checked, logged as no, nothing pushed | outcome no, noul 0.03, pushes unchanged at 1 | pass |
| two changes inside the minimum gap are not two checks: the first is replaced, the newest is checked once the gap is over | Jev asked 0 more time(s) (the request was the first check's: answered from the cache, free); log: skipped (replaced by a newer change before the mi...) then pushed; 19 s | pass |
| the daily cap holds (4 here): the fifth change asks nothing and the log says so | 4 checks asked, then: skipped "daily cap of 4 checks reached"; model calls 6 -> 6; the page's count askedToday=4 | pass |
| Send test notification from the page reaches the devices; an expired one (410) is removed | devices 3 -> 2; the fake device received 1 test push; page says "Sent to 2 devices. 1 expired device was removed."; log: test pushed | pass |
| the key removed from Settings: the watch can no longer be switched on (409), and a change while it runs is logged without a model call | canEnable.ok=false; the change was logged "no OpenRouter key in Settings, Providers"; model calls 6 -> 6; switching on: 409 | pass |
| a restart resumes the watch with no browser open, for whoever had it on | after the restart: enabled=true running=true; snapshots 69 -> 71 in 5 s | pass |
| switching off stops it: the PiKVM is no longer asked for snapshots | snapshots 71 -> 71 over 7 s; running=false | pass |
| the files: settings and log 0600 in a 0700 directory, the VAPID key file 0600, no secret in the log, the page or the host's output | {"watchDir":"700","settings":"600","log":"600","subscriptions":"600","vapid":"600"}; the provider key, the VAPID private key and the PiKVM password appear in none of them (leaked=false) | pass |

22 of 22 passed.

Screenshots:

- [01-no-key](screen-watch/01-no-key.png)
- [02-not-installed](screen-watch/02-not-installed.png)
- [03-ready](screen-watch/03-ready.png)
- [04-on](screen-watch/04-on.png)
- [05-log-after-push](screen-watch/05-log-after-push.png)
- [06-test-sent](screen-watch/06-test-sent.png)
- [07-key-removed](screen-watch/07-key-removed.png)
<!-- fakes:end -->

<!-- real:start -->
## Real smoke: the real image model and the real Jev

Script: `apps/web/e2e/watch-real.e2e.mjs`. The host is the real web host; the PiKVM is `tools/fake-kvmd` serving two frames drawn with sharp (a terminal installing a package, and the same with a dialog over it), the key is the one in `~/.env` (`GNOBLIN_OPENROUTER_API_KEY`), stored through Settings, Providers. Image model: **google/gemma-3-12b-it** (the default; `google/gemma-3-12b-it`). Decision model: **typesafe/jev-1.14** at `https://openrouter.ai/api/alpha/decisions`. Rule: "tell me when the install finishes or an error shows". Pace: look every 2 s, settle 3 s, one check per 5 s.

| Step | Expected | Jev's probability (noul) | Outcome | Cost (OpenRouter) | Asked |
| --- | --- | --- | --- | --- | --- |
| install fails: a dialog opens over the terminal | a yes (>= 0.85), pushed | 0.95 | pushed | $0.000092 | true |
| the dialog changes to 'Installation complete' | a yes (>= 0.85), pushed | 0.87 | pushed | $0.000050 | true |
| the terminal is back at 68%, nothing to report | no notification (< 0.85) | 0.17 | undecided (Jev's answer was not decisive, so nothing was sent) | $0.000055 | true |

Total reported by OpenRouter for 3 checks: **$0.000196**. Pushes the fake device decrypted: 2.

What the models said, check by check:

1. **install fails: a dialog opens over the terminal**
   - previous: Progress: [ 68% ] [########################################...] The application is a terminal window on Ubuntu. The line above says "Setting up postgresql-16 (16.4-1) ...".
   - current: Installation failed. The window is a terminal window on Ubuntu, showing the output of a command to install PostgreSQL. The lines "Error: could not configure postgresql-16." and "dpkg returned exit status 1 (disk full)." are also visible.
   - diff score 16.5% of cells; Jev 0.95; pushed
2. **the dialog changes to 'Installation complete'**
   - previous: Installation failed. The window is a terminal window on Ubuntu, showing the output of a command to install PostgreSQL. The lines "Error: could not configure postgresql-16." and "dpkg returned exit status 1 (disk full)." are also visible.
   - current: Installation complete. The window is a terminal on Ubuntu. It says "PostgreSQL 16 was installed successfully."
   - diff score 1.6% of cells; Jev 0.87; pushed
3. **the terminal is back at 68%, nothing to report**
   - previous: Installation complete. The window is a terminal on Ubuntu. It says "PostgreSQL 16 was installed successfully."
   - current: Progress: [ 68% ] [########################################...] The application is a terminal window on Ubuntu. The line above says "Setting up postgresql-16 (16.4-1) ...".
   - diff score 16.6% of cells; Jev 0.17; undecided

The notifications' bodies, as the fake device decrypted them:

- `{"title":"PiKVM","body":"Installation failed. The window is a terminal window on Ubuntu, showing the output of a command to install PostgreSQL.","tag":"pikvm-screen","url":"/app/"}`
- `{"title":"PiKVM","body":"Installation complete. The window is a terminal on Ubuntu.","tag":"pikvm-screen","url":"/app/"}`

3 of 3 steps as expected.
<!-- real:end -->
