# Feature parity with the real PiKVM interface

Goal: our console should do everything the stock kvmd web UI does, so there is never
a reason to fall back to "Full PiKVM UI".

## Where the reference comes from

`pikvm.har` in the repo root is a capture of the real UI. It contains the full
`/share/js/kvm/*.js` source, which is the authoritative feature inventory — read it
rather than guessing at the API:

```
python3 -c "
import json, os
h = json.load(open('pikvm.har'))
os.makedirs('/tmp/kvmd', exist_ok=True)
for e in h['log']['entries']:
    t = e['response'].get('content', {}).get('text')
    u = e['request']['url'].split('?')[0]
    if t and u.endswith(('.js', '.css')):
        open('/tmp/kvmd/' + u.split('/')[-1], 'w').write(t)
"
```

Upstream is `pikvm/kvmd` on GitHub; the same files live under `web/share/js/kvm/`.

## The kvmd API surface the real UI drives

| Endpoint | What it does |
|---|---|
| `api/atx/click?button=power\|power_long\|reset` | ATX power control (409 = another client busy) |
| `api/hid/set_params?jiggler=` | Pi-side mouse jiggler |
| `api/hid/set_params?keyboard_output=\|mouse_output=` | HID output mode |
| `api/hid/set_connected?connected=` | Attach/detach the USB HID |
| `api/hid/reset` | Reset the HID |
| `api/hid/print` | Type a whole string via the Pi's keymap |
| `api/msd/*` (`write`, `write_remote`, `set_params`, `set_connected`, `read`, `remove`, `reset`) | Mass storage: upload/mount ISOs |
| `api/gpio`, `api/gpio/switch`, `api/gpio/pulse` | User GPIO switches and pulses |
| `api/streamer/set_params` | Quality, FPS, resolution, orientation, H264 bitrate/GOP |
| `api/streamer/reset`, `api/streamer/snapshot` | Restart the stream, take a screenshot |
| `api/switch/*` | Multi-port KVM switch: active port, EDID, colours, beacon |
| `api/log` | System log viewer |
| `api/ws`, `api/media/ws`, `janus/ws` | State + input, audio, WebRTC |

State arrives as events on `api/ws`: `hid`, `atx`, `msd`, `gpio`, `streamer`,
`keymaps`, `ocr`, `switch`.

## Gap list

Ordered by how much a KVM operator actually reaches for it.

- [x] **Pi-side mouse jiggler** — `hid.jiggler.{enabled,active}` + `set_params?jiggler=`.
      Runs on the Pi, so the target stays awake even with our app closed. Our own
      nudger stays as the fallback for boards that do not expose it.
- [x] **ATX power control** — power / power_long / reset, with the power LED on the
      titlebar button. Confirms before every action; 409 means another client has it.
- [x] **Type text on the target** — `api/hid/print`, prefilled from this machine's
      clipboard. kvmd types it with its own keymap, so it is layout-correct and far
      faster than sending it key by key. The text is made typable first (curly quotes,
      CRLF, zero-width marks, ligatures and full-width letters become plain ones;
      emoji and other characters no keyboard has are left out and counted). It is the
      only way this machine's clipboard reaches the target: Ctrl+C and Ctrl+V on the
      screen are the target's own, sent as keys.
- [x] **Stream controls** — resolution, quality, target FPS, H264 bitrate/GOP, stream
      reset. Ranges come from the Pi's own `limits`, and each row hides unless the Pi
      reports the matching feature.
- [x] **Screenshot** — `api/streamer/snapshot`, saved as a timestamped JPEG.
- [ ] **Stream orientation** — the real UI rotates client-side (0/90/180/270) and
      remaps input to match. Ours would need the same remap through the existing
      zoom/pan transform, so it is its own piece of work rather than another slider.
- [x] **Health** — no video signal, HID detached, undervoltage, thermal throttling,
      fan failure. Collapsed into one indicator that is hidden while everything is
      fine, rather than the stock UI's ten always-on LEDs.
- [x] **HID attach/detach + reset** — recover a wedged USB gadget without SSH.
- [x] **Mass storage** — upload an ISO with a progress bar, or have the Pi fetch one
      from a URL; select, mount as CD/DVD or flash, read-only or writable, delete,
      reset. Multi-part storage prefixes are not exposed (the default part is used).
- [x] **GPIO** — user-defined switches and pulses. Verified against a live v4plus,
      which exposes `__v3_usb_breaker__` and `__v4_locator__`.
- [x] **About** — hostname, model, kvmd/streamer versions, CPU temperature, fan RPM.
- [x] **System log viewer** — `api/log`, as a refreshable snapshot rather than the
      real UI's endless follow stream.
- [ ] **Input recorder** — record, replay, loop, save/load HID scripts.
- [x] **OCR text selection** — drag a region, kvmd runs tesseract over that part of
      the current frame and returns the text. Coordinates go through the same fracAt
      mapping the pointer uses, so it stays correct under any zoom or pan.
- [ ] **Multi-port KVM switch** — active port, per-port EDID, colours, beacon.

## Verified against live hardware

The event shapes above are not guesses. With the app running, this reads the real
state socket through its proxy (read-only — it only listens):

```
node -e '
const WebSocket = require("ws");
const ws = new WebSocket("ws://127.0.0.1:25650/api/ws");
ws.on("message", (r) => { const m = JSON.parse(r); console.log(m.event_type, JSON.stringify(m.event)); });
setTimeout(() => process.exit(0), 20000);
'
```

Confirmed on a PiKVM v4plus (kvmd 4.150): `atx`, `hid`, `hid_keymaps`, `msd`,
`streamer`, `gpio`, `ocr`, `switch`, and `info`. Two things worth knowing:

- `info` arrives as SEPARATE partial events — `{auth}`, `{node}`, `{meta}`,
  `{uptime}`, `{health}`, `{system}`, `{fan}`, `{extras}` — one key at a time, a few
  seconds apart. Anything reading it must merge, never replace.
- `hid.connected` is `null` on this board, not a boolean. Only an explicit `false`
  means detached.

## Notes

- Everything here goes through our reverse proxy, so the console calls these on its
  own origin and the proxy injects the Pi's auth. No CORS, no second login.
- Destructive actions (ATX, MSD, HID reset) need a confirm step. The real UI has a
  per-feature "ask" toggle; match that rather than inventing something else.
