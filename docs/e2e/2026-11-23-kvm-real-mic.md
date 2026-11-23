# E2E run: the microphone and the link governor against the real PiKVM (2026-11-23)

Web code: `73f08969` (K126 from `d97a67a4`, the Firefox meter from `73f08969`). Host: `node dist/web-server.js` on
127.0.0.1:8098, pointed at the real PiKVM from the desktop app's config (credentials never printed). Browsers: headless
Chrome and Firefox 155 through puppeteer-core 24.35.

## Safety

- An init script drops every frame on the kvmd event socket except `ping` and rejects every non-GET request to `/api/`.
  Every run ended with `wsBlocked: []` and `httpBlocked: []`.
- The microphone is silent. Chrome uses `--use-file-for-fake-audio-capture=~/.cache/pikvm-wip/silence.wav` (120 s of
  zeros). Firefox uses the monitor of a PipeWire null sink (`pactl load-module module-null-sink sink_name=pikvm_silence`,
  pref `media.audio_loopback_dev = "Monitor of pikvm_silence"`). The scripts read the source's label first and refuse to
  turn the mic on unless it is the silent source. The first Firefox attempt picked the real USB microphone and was refused
  there; the pref fixed it.
- Kieran approved sending a silent mic to the target for this run.

## Failure modes checked

1. Turning the mic on restarts the session; the restart never comes back (stuck on MJPEG).
2. The restart comes back but sends no mic audio.
3. The meter stays at 0 while mic audio is sent (reported on Firefox for Android).
4. A weak-link verdict with the mic on holds WebRTC: reduced MJPEG, mic button gone, meeting cut (reported).
5. The fix suppresses the governor everywhere (the control must still hold with the mic off).
6. The Firefox meter fallback makes an AudioContext in Chromium too (the stats there already have levels).

## Results

| Case | Command | Observed | Result |
| --- | --- | --- | --- |
| 1, 2 Firefox | `BROWSER=firefox node apps/web/e2e/kvm-real-mic.mjs` | WebRTC back 3 s after the mic click; sender track live, unmuted; outbound audio packets 32 then 236 four seconds later; Pi log `us_p_aplay Playback opened` at 14:00:35 for this session | pass |
| 1, 2 Chrome | `BROWSER=chrome node apps/web/e2e/kvm-real-mic.mjs` | WebRTC back 3 s after the click; outbound audio packets 26 then 229 | pass |
| 3 | both, stats dump | Firefox: `media-source` and `outbound-rtp` audio entries exist with `audioLevel` null; Chrome: `media-source` `audioLevel` 0. Before `73f08969` the Firefox meter could only show 0 | cause confirmed |
| 6 | both, AudioContext counter | Chrome 0, Firefox 1 (the mic fallback) | pass |
| 5 | `BROWSER=chrome MIC=off node apps/web/e2e/kvm-real-mic-governor.mjs` | `[governor] hold 60 s: samples` 10 s after the bad RTT; video gone and mic button gone from then on | pass (the governor still works) |
| 4 | `BROWSER=chrome MIC=on node apps/web/e2e/kvm-real-mic-governor.mjs` | `[governor] verdict (samples) ignored: microphone or camera is on`; the video played and the mic button stayed On for all 20 s | pass |

Timelines (one sample a second, V = video playing, M/m = mic on/off, x = no mic button):

- MIC=off: `Vm Vm Vm Vm Vm Vm Vm Vm Vm Vm -x -x -x -x -x -x -x -x -x -x`
- MIC=on: `VM` for all 20 samples

## Not shown

- The meter moving with real sound: the runs only ever sent silence, so both meters read 0. The fallback was not seen
  above 0.
- Firefox for Android itself: the runs used desktop Firefox. The phone's Firefox had no debugger socket open
  (`/proc/net/unix` listed none), so its track and RTP counters were not read.
- That mic RTP kept flowing through the K126 window: the governor run read the button and the video, not the
  `outbound-rtp` counters.
- Sound reaching the target. In the Firefox run, the Pi received the mic audio and then logged `Can't play to PCM
  playback: Input/output error` one second later, as it did at 10:59, 11:01 and 11:28 today. The Pi keeps retrying and
  logs `Playing resumed` once the target reads from the PiKVM USB microphone. The error usually means the target is not
  recording from that device (the meeting app or the Windows default input is another microphone).

## The mic across a reconnect (K111), 14:57 to 14:58

Failure modes: 7. A session that replaces a dropped one comes back with the mic off while the button says On, or says
Off and the person does not notice (seen on the phone after the 14:07 deploy). 8. The replacement sends no mic audio.

| Case | Command | Observed | Result |
| --- | --- | --- | --- |
| 7, 8 Chrome | `BROWSER=chrome node apps/web/e2e/kvm-real-mic-reconnect.mjs` | mic on, 27 packets sent; Janus socket closed by the page at 14:57:59; a new peer connection (3rd) played by 14:58:08 with the mic button still On and outbound audio packets 156 then 307 three seconds later; no mic notice | pass |
| 7, 8 Firefox | `BROWSER=firefox node apps/web/e2e/kvm-real-mic-reconnect.mjs` | the same: socket closed 14:58:20, 3rd peer connection sending, packets 162 then 312, button On | pass |

The Pi log shows the sessions being replaced (14:57:59 destroyed, 14:58:00 created; 14:58:20 destroyed, 14:58:21
created) but no new `Playback opened`, because the phone's mic had held the Pi's playback device open since 14:21:22;
the Pi logs that line only when it opens the device. Not shown: the capture-error path (`onMicFailed`), which needs the
device to vanish between the click and the reconnect.
