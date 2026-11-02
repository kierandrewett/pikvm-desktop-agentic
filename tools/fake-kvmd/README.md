# fake-kvmd

A kvmd simulator for end-to-end tests. The console talks to it exactly as it
talks to a PiKVM, and a test can then read back precisely which HID input the
console sent. It never touches a real PiKVM.

It is TypeScript run directly by Node (type stripping, no build step). The only
dependency is `ws`, which the repo already has.

## Run

From the repository root:

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning tools/fake-kvmd/server.ts --port 4510
```

`--port` defaults to `PORT` or 4510 (`0` picks a free port); `--host` defaults
to `HOST` or `127.0.0.1`. The first line printed is the URL.

From a test, import it instead:

```ts
import { startFakeKvmd } from "../../tools/fake-kvmd/server.ts";

const fake = await startFakeKvmd({ port: 0 });
// fake.url, fake.port
await fake.close();
```

## Pointing the web host at it

```sh
PIKVM_URL=http://127.0.0.1:4510 PIKVM_PASSWORD=anything PORT=8080 node dist/web-server.js
```

kvmd auth is not checked: `X-KVMD-User`, `X-KVMD-Passwd`, `Authorization` and
cookies are accepted and ignored, so any password works.

## What it serves

All kvmd answers use the `{"ok": true, "result": ...}` envelope; errors are
`{"ok": false, "result": {"error", "error_msg"}}` with a 4xx/5xx status.

| Route | Behaviour |
|---|---|
| `WS /api/ws` | On connect sends `hid`, `hid_keymaps`, `streamer`, `info`, `atx`, `msd`, `gpio`, `ocr`, then `loop` (marks the initial bundle complete). `{"event_type":"ping"}` (or a bare `ping`) gets a `pong`. Every client message is recorded. |
| `key` / `mouse_move` / `mouse_button` / `mouse_wheel` / `mouse_relative` | Recorded with timestamps. A `CapsLock` press (also `ScrollLock`, `NumLock`) flips the LED and broadcasts an `hid` event with `keyboard.leds`. |
| `POST /api/hid/set_params?mouse_output=usb\|usb_rel` | Switches mouse mode and broadcasts an `hid` event with `mouse.absolute` and `mouse.outputs`. `jiggler=0\|1` also works. Anything else is a 400. |
| `POST /api/hid/print?limit=&delay=&keymap=` | Records the text body (`prints` in `/__fake/hid`). |
| `POST /api/hid/set_connected`, `/api/hid/reset` | Update state and emit an `hid` event. |
| `GET /streamer/stream` | MJPEG (`multipart/x-mixed-replace`), 10 fps of a 320x180 colour-bar JPEG embedded in `frame.ts`. |
| `GET /streamer/snapshot`, `/api/streamer/snapshot` | The same JPEG. With `ocr=1` it returns plain text. 503 when the source is offline unless `allow_offline=1`. |
| `GET /streamer/state` | `{source: {online, resolution, ...}}`. |
| `WS /janus/ws` and `GET /janus/ws` | Refused with 503, so the console falls back to MJPEG. |
| `POST /api/streamer/set_params`, `/api/streamer/reset` | Update the applied params and emit a `streamer` event. |
| `POST /api/atx/click?button=power\|power_long\|reset` | Flips the power LED (short press) or clears it (long press) and emits `atx`. |
| `POST /api/msd/set_params`, `set_connected`, `write`, `write_remote`, `remove`, `reset` | A small in-memory image store; emits `msd`. Connecting with no image selected is a 409, as in kvmd. |
| `POST /api/gpio/switch`, `/api/gpio/pulse` | One output, `relay0`; emits `gpio`. |
| `GET /api/log`, `/api/info`, `/api/auth/check` | Minimal plausible bodies. |
| `GET /api/hid`, `/api/atx`, `/api/msd`, `/api/gpio`, `/api/streamer` | The current state, as in the matching event. |

## Control API (`/__fake/*`)

Plain JSON, not the kvmd envelope. `seq` numbers all records in one order;
`?since=<seq>` on the GET routes returns only newer ones.

| Route | |
|---|---|
| `GET /__fake/hid[?type=key][&since=N]` | `{events, prints, state}`. Each event is `{seq, ts, t, client, event_type, event}`: `ts` is epoch ms, `t` is ms since start (sub-ms, for measuring gaps between inputs). Each print is `{seq, ts, t, text, limit, delay, keymap}`. |
| `GET /__fake/messages` | Every raw client WebSocket message, pings included. |
| `GET /__fake/requests` | Every kvmd HTTP request: method, path, query, content type and text body (bodies over 64 KiB log only `bodyLength`). |
| `GET /__fake/state` | Clients, LEDs, mouse mode, keys and buttons held, ATX, MSD, GPIO. |
| `POST /__fake/reset` | Clears all logs and state; connected clients get fresh `hid`, `streamer`, `atx`, `msd` and `gpio` events. |
| `POST /__fake/event` | Body `{"event_type": "...", "event": {...}}` is pushed to every connected client as-is. It does not change the fake's own state. |
| `POST /__fake/drop[?graceful=1][&refuse_ms=N]` | Closes every WebSocket (abruptly by default, so the client sees 1006). `refuse_ms` makes new `/api/ws` connections fail with 503 for that long, to exercise reconnect backoff. |
| `POST /__fake/source?online=0\|1` | Marks the video source offline/online and emits a `streamer` event. |
| `POST /__fake/picture?name=bars\|changed` | Which picture the stream and snapshots serve: the colour bars, or a dialog-sized change (a light window over a dark desktop), so a test can make the target's screen change. Reset by `/__fake/reset`. |

Example:

```sh
curl -s http://127.0.0.1:4510/__fake/hid | jq '.events[] | {event_type, event}'
curl -s -X POST http://127.0.0.1:4510/__fake/drop?refuse_ms=2000
```
