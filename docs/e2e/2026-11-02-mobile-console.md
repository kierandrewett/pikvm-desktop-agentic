# E2E run: mobile console on the headless web host (2026-11-02)

Covers commits `f610350` (headless web host) and `b19b997` (touch dock, touch
modes, soft-keyboard mirror, Caps Lock sync).

The token login these runs used was replaced by Pocket ID sign-in in
`7786b08`. That change was checked on the deployed host instead:

| Case | Observed | Result |
| --- | --- | --- |
| `/`, `/_agent/api/state`, `/api/info` signed out | 302 to `id.drewett.dev/authorize` with S256 PKCE | pass |
| `/_agent/manifest.webmanifest`, `/_agent/icon.png` signed out | 200 | pass |
| Container on `intranet` reaching `kvm:8080` | name does not resolve | pass |
| Container on `kvm-internal` reaching the Pi | HTTPS answered | pass |
| Full sign-in in desktop Chrome (consent accepted) | console "Live · HD", `/_agent/api/state` 200, `/api/info` 200 | pass |

## Environment

- Host under test: `node dist/web-server.js` on the workstation (port 8099),
  then the deployed container at `https://kvm.drewett.dev` (bsociety, private
  Caddy, tailnet only).
- Target: the real PiKVM at `pikvm.tail93a99.ts.net`. Video and the HID socket
  were live; the target was in use, so NO input was sent to it (see below).
- Browser: headless Google Chrome via the omp `browser` helper, emulated as
  `iPhone 13` (390x844, touch, coarse pointer).

## Dry-run harness

Every HID send and every state-changing kvmd call is intercepted in the page,
recorded, and dropped. Inbound kvmd events still arrive, and the tests inject
fake ones (LED state, mouse mode) through the captured socket.

```js
// Added with tab.addInitScript() before the console loads.
(() => {
    window.__hidLog = [];
    window.__fetchLog = [];
    window.__wss = [];
    const OrigWS = window.WebSocket;
    const origSend = OrigWS.prototype.send;
    window.WebSocket = function (url, p) {
        const ws = p ? new OrigWS(url, p) : new OrigWS(url);
        if (String(url).includes("/api/ws")) window.__wss.push(ws);
        return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    OrigWS.prototype.send = function (d) {
        if (String(this.url).includes("/api/ws")) {
            window.__hidLog.push(JSON.parse(d));
            return;
        }
        return origSend.call(this, d);
    };
    const of = window.fetch;
    window.fetch = function (u, o) {
        const s = String((u && u.url) || u);
        if (/\/api\/(hid\/set_params|hid\/print|atx|hid\/events)/.test(s)) {
            window.__fetchLog.push(s);
            return Promise.resolve(new Response('{"ok":true,"result":{}}', { status: 200 }));
        }
        return of.apply(this, arguments);
    };
})();
```

Touch gestures were driven with CDP `Input.dispatchTouchEvent` (one and two
touch points, 16-18ms between moves). Keyboard cases set the hidden field's
value and dispatched `InputEvent`, `CompositionEvent` and `KeyboardEvent`
(including `modifierCapsLock`) on `#kbd`.

## Results

| Case | Observed on the wire | Result |
| --- | --- | --- |
| Trackpad drag, Pi relative | `mouse_relative` 44,17 per 10px finger step | pass |
| Trackpad drag, Pi absolute | `mouse_move` (abs) + one `set_params?mouse_output=usb_rel` | pass |
| Tap | left down/up | pass |
| Long-press 650ms | right down/up | pass |
| Two-finger tap | right down/up only | pass |
| Two-finger drag up | 3x `mouse_wheel` y -1, no buttons | pass |
| Pinch, Pi relative | one homing event (48 x -127,-127), zoom 3.4x, view centred on the parked corner | pass |
| Drag while zoomed | relative deltas, view translate tracks the cursor | pass |
| Switch to Touch mode | `set_params?mouse_output=usb` | pass |
| Direct tap while Pi relative | nothing sent until a hid report says absolute, then left down/up | pass |
| Direct tap off the picture | nothing sent (fixed during the run) | pass |
| Soft keyboard "Hi" | Shift+H, I | pass |
| Autocorrect "teh " -> "the " | Space T E H, Backspace x2, H E Space | pass |
| Dictation with U+FFFC placeholder, then rewrite | placeholder ignored; 11 Backspaces then "Hello world." | pass |
| Smart quote "don’t" | D O N Quote T | pass |
| Enter | Enter; field reset to the pad | pass |
| Backspace on empty field | Backspace; pad restored | pass |
| Composition h/he/hey | H E Y | pass |
| LED caps on | Caps key lit, aria-pressed true | pass |
| Type "aB" with target caps on | Shift+A, B (with Caps on, that should type "aB") | pass |
| Caps key tap | CapsLock; stale LED report during pending ignored | pass |
| Host Caps Lock on (first reading) | CapsLock before the key | pass |
| Soft-keyboard event after that | nothing (initially sent a CapsLock; fixed) | pass |
| Windows-style Caps off (keydown + keyup) | one CapsLock, reconcile found no mismatch | pass |
| macOS-style keyup-only Caps off | reconcile sent CapsLock | pass |
| Keyboard open (visualViewport 470px) | `.app` 470px, dock bottom at 470, `kb-open` set | pass |
| Deployed host | login redirect, 401 without session, wrong token rejected, HID socket open through Caddy, stream live, LED read | pass |

Unit suite on the committed tree (clean worktree): 314 pass, 0 fail.

Follow-up run (loopback-only host, same harness):

| Case | Observed | Result |
| --- | --- | --- |
| Direct double tap while the Pi is relative | nothing sent; after the absolute report, move + click, move + click, in order | pass |
| ⋯ menu with the keyboard open (visual viewport 470px) | menu 8..462px, max-height 454px, scrolls | pass |
| Trackpad drag while the Pi is absolute and Rel is wanted | nothing sent (no absolute jump); after the relative report, the held travel as `mouse_relative` 127,106 / 127,0 / 11,0 | pass |
| Caps key, then "a" straight after (the Pi's LED had reported off) | CapsLock, then Shift+A (with Caps now on, that should type `a`) | pass |
| Dock with a terminal (picture / terminal / dock) | 0..464 / 464..751 / 751..844; trackpad cursor dot follows the picture on resize | pass |

HID was intercepted throughout, so "should type" is what the captured sequence
means for the target, not something read back from it.

## Not covered

A real phone: the iOS and Android soft keyboards, dictation, and the feel of
the gestures. Headless Chrome cannot raise a system keyboard, so the keyboard
cases above replay the event patterns those keyboards are documented to send;
they are not proof of the devices. Check these on the phone at
`https://kvm.drewett.dev`.

Known limit: dictation or typing of characters outside the US/UK key maps
(accented letters, emoji) sends nothing for those characters. Use "Paste text
to the target" for such text; kvmd types it with its own keymap.
