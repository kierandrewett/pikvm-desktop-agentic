/*
 * PiKVM web console — manual keyboard/mouse + live screen, with the agent chat
 * below. It reuses the existing reverse proxy: native PiKVM targets use their
 * MJPEG/WebRTC stream, while VNC lab adapters advertise a snapshot feed through
 * /api/info. Input always uses the target's HID WebSocket (/api/ws) with the exact
 * JSON the desktop control core sends.
 *
 * The pure helpers (key map, coordinate maths, stream URL) are exported for the
 * node smoke test; everything below `if (typeof window === "undefined")` is the
 * browser wiring.
 */
(function () {
    "use strict";

    /* ----------------------------------------------------------------- *
     * Pure helpers (unit-tested in scripts/smoke-proxy.ts)
     * ----------------------------------------------------------------- */

    // US-QWERTY physical layout mirrored from src/human-typing.ts so a key typed
    // here actuates the same physical key the agent's typing engine would.
    var ROWS = ["`1234567890-=", "qwertyuiop[]\\", "asdfghjkl;'", "zxcvbnm,./"];
    var SHIFT_ROWS = ["~!@#$%^&*()_+", "QWERTYUIOP{}|", 'ASDFGHJKL:"', "ZXCVBNM<>?"];
    var CODE_ROWS = [
        "Backquote Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 Minus Equal".split(" "),
        "KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP BracketLeft BracketRight Backslash".split(" "),
        "KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL Semicolon Quote".split(" "),
        "KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash".split(" "),
    ];
    var US_MAP = {};
    for (var r = 0; r < ROWS.length; r++) {
        for (var c = 0; c < ROWS[r].length; c++) {
            var code = CODE_ROWS[r][c];
            US_MAP[ROWS[r][c]] = { code: code, shift: false };
            var sh = SHIFT_ROWS[r][c];
            if (sh) US_MAP[sh] = { code: code, shift: true };
        }
    }
    US_MAP[" "] = { code: "Space", shift: false };
    // UK ISO overrides (mirrors UK_OVERRIDES in human-typing.ts).
    var UK_MAP = {
        '"': { code: "Digit2", shift: true },
        "@": { code: "Quote", shift: true },
        "#": { code: "Backslash", shift: false },
        "~": { code: "Backslash", shift: true },
        "\\": { code: "IntlBackslash", shift: false },
        "|": { code: "IntlBackslash", shift: true },
        "£": { code: "Digit3", shift: true },
        "¬": { code: "Backquote", shift: true },
    };

    /** Map a single character to a physical key + shift state for the layout. */
    function charToKey(ch, layout) {
        if (layout === "uk" && UK_MAP[ch]) return UK_MAP[ch];
        return US_MAP[ch] || null;
    }

    /** Fraction (0..1) within the screen -> PiKVM absolute coord (-32768..32767). */
    function fracToNorm(f) {
        var v = Math.round(f * 65534) - 32767;
        return Math.max(-32768, Math.min(32767, v));
    }

    /** ustreamer MJPEG path with the per-browser quirk param the PiKVM UI uses. */
    function streamPath(key, ua) {
        ua = ua || "";
        var p = "/streamer/stream?key=" + encodeURIComponent(key);
        var isIOS = /iPad|iPhone|iPod/.test(ua);
        var isSafari = /Safari/.test(ua) && !/Chrome|CriOS|Chromium|Android/.test(ua);
        var isBlink = /Chrome|CriOS|Chromium/.test(ua);
        if (isIOS || isSafari) p += "&dual_final_frames=1";
        else if (isBlink) p += "&advance_headers=1";
        return p;
    }

    /** Select a screen transport from the target's advertised capabilities. */
    function streamModeForInfo(info) {
        var extras = info && info.result && info.result.extras;
        return extras && extras.vnc_lab && extras.vnc_lab.enabled === true ? "snapshot" : "native";
    }

    /** The widest the conversation panel can actually be drawn right now.
     *
     * --chat-max is only the ceiling on a wide window: the grid also refuses to
     * shrink the live screen past --screen-min, so on a narrow one the binding
     * limit is the viewport minus that reserve. At the 900px minimum window the
     * real ceiling is 600px, not 1100. The drag, the End key and the divider's
     * announced maximum all resolve through here so none of them can offer a
     * width the layout will then refuse to render. */
    function panelCeiling(viewportW, screenMin, minW, maxW) {
        return Math.max(minW, Math.min(maxW, (Number(viewportW) || 0) - screenMin));
    }

    /* The modifiers a chord can hold. Left-hand codes because that is what the
     * target expects for a plain modifier; AltGr is the exception worth offering
     * separately, since on a UK layout it is the only way to reach several
     * characters and it is genuinely a different key from Alt. */
    var MACRO_MODS = [
        ["ControlLeft", "Ctrl"],
        ["AltLeft", "Alt"],
        ["ShiftLeft", "Shift"],
        ["MetaLeft", "Super"],
        ["AltRight", "AltGr"],
    ];

    /* The chord's key, offered as a list instead of recorded from a real press.
     *
     * A recorder can only ever capture what the HOST desktop lets through, and
     * the chords most worth keeping as a macro are exactly the ones it does not:
     * Super+L locks the session before the page sees it, Ctrl+Alt+F2 switches
     * virtual terminal, and a compositor takes most Super combinations for
     * itself. Picking the key also means a macro can use a key this keyboard
     * does not physically have — F13-F24, or a numpad on a laptop. */
    function macroKeyGroups() {
        var letters = [];
        for (var i = 0; i < 26; i++) {
            var ch = String.fromCharCode(65 + i);
            letters.push(["Key" + ch, ch]);
        }
        var digits = [];
        for (var d = 0; d <= 9; d++) digits.push(["Digit" + d, String(d)]);
        var fkeys = [];
        for (var f = 1; f <= 24; f++) fkeys.push(["F" + f, "F" + f]);
        var numpad = [];
        for (var n = 0; n <= 9; n++) numpad.push(["Numpad" + n, "Numpad " + n]);
        numpad.push(
            ["NumpadEnter", "Numpad Enter"],
            ["NumpadAdd", "Numpad +"],
            ["NumpadSubtract", "Numpad -"],
            ["NumpadMultiply", "Numpad *"],
            ["NumpadDivide", "Numpad /"],
            ["NumpadDecimal", "Numpad ."],
        );
        return [
            ["Letters", letters],
            ["Digits", digits],
            ["Function", fkeys],
            [
                "Editing",
                [
                    ["Enter", "Enter"],
                    ["Tab", "Tab"],
                    ["Space", "Space"],
                    ["Backspace", "Backspace"],
                    ["Delete", "Delete"],
                    ["Insert", "Insert"],
                    ["Escape", "Escape"],
                ],
            ],
            [
                "Navigation",
                [
                    ["Home", "Home"],
                    ["End", "End"],
                    ["PageUp", "Page Up"],
                    ["PageDown", "Page Down"],
                    ["ArrowUp", "Arrow Up"],
                    ["ArrowDown", "Arrow Down"],
                    ["ArrowLeft", "Arrow Left"],
                    ["ArrowRight", "Arrow Right"],
                ],
            ],
            [
                "Punctuation",
                [
                    ["Minus", "- minus"],
                    ["Equal", "= equals"],
                    ["BracketLeft", "[ bracket"],
                    ["BracketRight", "] bracket"],
                    ["Backslash", "\\ backslash"],
                    ["Semicolon", "; semicolon"],
                    ["Quote", "' quote"],
                    ["Backquote", "` backquote"],
                    ["Comma", ", comma"],
                    ["Period", ". period"],
                    ["Slash", "/ slash"],
                ],
            ],
            ["Numpad", numpad],
            [
                "System",
                [
                    ["PrintScreen", "Print Screen"],
                    ["ScrollLock", "Scroll Lock"],
                    ["Pause", "Pause"],
                    ["CapsLock", "Caps Lock"],
                    ["NumLock", "Num Lock"],
                    ["ContextMenu", "Menu"],
                ],
            ],
        ];
    }

    /** Where a point sits inside a box, as 0..1 fractions.
     *
     * `clamp` is the drag case: a button is held, so a pointer that has left the
     * picture is still part of the same gesture and pins to the nearest edge.
     * Without it an outside point is not a KVM point at all and returns null. */
    function fracInBox(box, x, y, clamp) {
        if (!box || !(box.w > 0) || !(box.h > 0)) return null;
        var fx = (x - box.left) / box.w;
        var fy = (y - box.top) / box.h;
        if (clamp) return { fx: Math.max(0, Math.min(1, fx)), fy: Math.max(0, Math.min(1, fy)) };
        if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
        return { fx: fx, fy: fy };
    }

    var pure = {
        charToKey: charToKey,
        fracToNorm: fracToNorm,
        streamPath: streamPath,
        streamModeForInfo: streamModeForInfo,
        panelCeiling: panelCeiling,
        fracInBox: fracInBox,
        macroKeyGroups: macroKeyGroups,
        MACRO_MODS: MACRO_MODS,
        macroGlyph: macroGlyph,
    };
    if (typeof module !== "undefined" && module.exports) module.exports = pure;
    if (typeof window === "undefined") return; // node test: stop before DOM wiring

    /* Titlebar state the shared buttons are drawn from.
     *
     * Declared HERE, before anything else in this file runs, for two reasons
     * learned the hard way. Their painters live in this outer scope, so state
     * inside the desktop block is state those painters silently cannot see. And
     * `var` hoists the declaration but not the assignment: the ATX handler fires
     * during early setup, so an object initialised further down was still
     * undefined when the first power event arrived — which threw, and took the
     * whole desktop bring-up with it before the console had even been marked as
     * a desktop console.
     *
     * The specs are built from the latest word each painter said rather than
     * re-derived, so a titlebar button cannot drift from the in-page control
     * that reports the same state in words. */
    var avState = {
        visible: false,
        audio: { on: false, warn: false, label: "" },
        mic: { on: false, warn: false, label: "" },
    };
    var repaintAv = function () {};
    var tbState = {
        health: { visible: false, error: false, label: "Health" },
        power: { visible: false, on: false, busy: false, label: "Power" },
    };
    var repaintTbState = function () {};
    /* Pinned macros are a LIST, rebuilt whenever they are edited, so this is a
     * full re-render rather than an update of known buttons. Declared here with
     * the rest for the same reason: paintMacroButtons is called from loadMacros
     * and from every save, both of which can run before the desktop block. */
    var repaintMacroButtons = function () {};

    /* What a keydown means (chord / character / swallow) is decided by key-chord.js —
     * pure, shared by both keyboard paths, and covered by tests. This file keeps the
     * parts that need the DOM and the socket: gating, dedupe, and the send queue.
     *
     * Bound HERE, at the top, because `var` hoists the declaration but not the
     * assignment: bound further down it was still undefined when the modifier
     * mirror reached for it, which threw and killed every line of this file
     * below that point — titlebar, keyboard handlers, the lot. */
    var KeyChord = window.KeyChord;

    // True while the agent is driving the target — user HID input is dropped then.
    var agentActing = false;
    var clearRegionMapForManualInput = function () {};
    function noteManualKvmInput() {
        if (!agentActing) clearRegionMapForManualInput();
    }
    function blockKvmInput(e) {
        if (!agentActing) return false;
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopImmediatePropagation) e.stopImmediatePropagation();
        if (e && e.stopPropagation) e.stopPropagation();
        return true;
    }

    /* ----------------------------------------------------------------- *
     * HID WebSocket client — same protocol as src/pikvm-control.ts
     * ----------------------------------------------------------------- */

    /** kvmd's own keymap set ({default, available}) from the hid_keymaps event. */
    var kvmdKeymaps = null;

    var hid = (function () {
        var ws = null;
        var open = false;
        /* Whether this socket has ever reached a definite outcome.
         *
         * "Not open" means two different things: still making the very first
         * connection, which is normal and already has a "Connecting" overlay,
         * or an attempt that has actually resolved — opened, or been refused
         * or dropped. Only the second is worth reporting, and both halves of
         * it are: a socket that worked and stopped, and one that never came up
         * at all because kvmd is down or the credentials are wrong. Input is
         * equally dead either way. */
        var everSettled = false;
        var connecting = false;
        /* Input queued while the socket is down, as {at, obj}.
         *
         * The queue exists so a momentary blip does not swallow a keystroke —
         * the reconnect is on a 1.2s timer, so the gap it is built for is about
         * a second. It had no age limit, and a 1.2s blip and a Pi reboot were
         * treated identically. Measured: killed the socket, typed a, b and c
         * (nothing delivered, chip correctly reading "input offline"), waited
         * twenty seconds and let it reconnect —
         *
         *     delivered ON RECONNECT, 20s later:
         *     key:KeyA:true, key:KeyA:false, key:KeyB:true, key:KeyB:false,
         *     key:KeyC:true, key:KeyC:false
         *
         * — all six fired at once into whatever the target was showing by then.
         * After a reboot that is characters typed at the old screen landing in
         * a boot menu, a login prompt or a shell. A keystroke is only worth
         * delivering while it is still current. */
        var queue = [];
        var QUEUE_STALE_MS = 2000;
        /* A key or button going UP is never dropped, however old.
         *
         * If the down went out before the socket died and the up is dropped as
         * stale, the target holds that key forever — far worse than losing a
         * character. send() already carves out the same exception for the agent
         * taking over, and for the same reason, so the two share this. */
        function isRelease(obj) {
            var ev = obj && obj.event;
            return !!(ev && ev.state === false && (obj.event_type === "key" || obj.event_type === "mouse_button"));
        }
        var onStatus = null;
        var retry = null;
        // The TARGET's real Caps Lock state, read from the Pi's keyboard LED reports
        // (the ground truth). `capsKnown` stays false until the Pi actually sends one,
        // so we can fall back safely on setups that don't report LEDs.
        var targetCaps = false;
        var capsKnown = false;
        var capsCorrecting = false; // guards the auto-off toggle from looping
        // Target mouse pointer mode, read from the Pi's hid events. This client always
        // drives the cursor with ABSOLUTE moves, so a Pi stuck in relative mode makes the
        // pointer un-trackable — we auto-switch it to absolute when the user's mouse
        // enters the surface (see ensureAbsolute). null = unknown until the first hid event.
        var mouseAbsolute = null; // true | false | null
        var mouseOutputs = []; // available outputs, e.g. ["usb","usb_rel"]
        var absSwitchAt = 0; // last switch attempt (ms) — throttle while it applies
        var absSwitchBusy = false;

        function url() {
            return (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/api/ws";
        }
        function connect() {
            if (open || connecting) return;
            connecting = true;
            try {
                ws = new WebSocket(url());
            } catch (e) {
                connecting = false;
                schedule();
                return;
            }
            ws.onopen = function () {
                open = true;
                everSettled = true;
                connecting = false;
                if (onStatus) onStatus(true);
                var q = queue;
                queue = [];
                var now = Date.now();
                q.forEach(function (item) {
                    if (isRelease(item.obj) || now - item.at < QUEUE_STALE_MS) raw(item.obj);
                });
            };
            ws.onclose = function () {
                open = false;
                // A refused connection closes too, which is exactly the signal
                // wanted: the attempt resolved, and the answer was no.
                everSettled = true;
                connecting = false;
                if (onStatus) onStatus(false);
                schedule();
            };
            ws.onerror = function () {
                try {
                    ws.close();
                } catch (e) {}
            };
            ws.onmessage = function (ev) {
                // Watch the target's caps-lock LED. We type letter case from the HOST's
                // e.key (synchronous, race-free), which is only correct when the TARGET's
                // caps is OFF — so if its LED ever shows ON, toggle it back off once.
                // Format varies by kvmd version — probe the likely paths defensively.
                try {
                    var d = JSON.parse(ev.data);
                    var ed = d && d.event;
                    // ATX power state: {enabled, busy, leds:{power, hdd}}. Deltas are
                    // partial, so the module merges rather than replaces.
                    if (d && d.event_type === "atx") atx.setState(ed);
                    // The Pi's configured keymaps — paste-as-keys needs the name kvmd
                    // itself uses, not our send-side US/UK layout.
                    if (d && d.event_type === "hid_keymaps" && ed && ed.keymaps) {
                        kvmdKeymaps = ed.keymaps;
                        /* And repaint the control, rather than waiting for the
                         * next time the paste dialog is opened.
                         *
                         * fillKeymaps only ran from openPasteDialog, so a
                         * keymaps event that landed while the dialog was
                         * already open never reached the select — it stayed
                         * hidden for the life of that dialog. kvmd sends this
                         * on every ws connection, so it happens on the first
                         * one if the dialog is opened quickly enough, and again
                         * on every reconnect, which is exactly when someone may
                         * be sitting in the dialog composing text.
                         *
                         * Every other subsystem already repaints its dialog
                         * from an event; this control was the one reading a
                         * value nothing told it had changed. */
                        fillKeymaps();
                    }
                    // Streamer features/limits/applied — what the settings dialog drives.
                    if (d && d.event_type === "streamer") setStreamerState(ed);
                    // Pi health (throttling, fan) and the source/HID online flags feed
                    // the one warning indicator.
                    if (d && d.event_type === "info") health.setInfo(ed);
                    if (d && d.event_type === "streamer" && ed && ed.streamer) health.setSource(ed.streamer.source);
                    if (d && d.event_type === "hid") health.setHid(ed);
                    if (d && d.event_type === "msd") msd.setState(ed);
                    if (d && d.event_type === "gpio") gpio.setState(ed);
                    if (d && d.event_type === "ocr") setOcrState(ed);
                    var leds = ed && ((ed.keyboard && ed.keyboard.leds) || ed.leds);
                    if (leds && typeof leds.caps === "boolean") {
                        targetCaps = leds.caps;
                        capsKnown = true;
                        if (leds.caps && open && !capsCorrecting && !agentActing) {
                            capsCorrecting = true;
                            raw({ event_type: "key", event: { key: "CapsLock", state: true } });
                            setTimeout(function () {
                                raw({ event_type: "key", event: { key: "CapsLock", state: false } });
                            }, 12);
                            setTimeout(function () {
                                capsCorrecting = false;
                            }, 500);
                        }
                    }
                    // Track the target's mouse mode (hid events carry it as a delta, so only
                    // overwrite the fields actually present in this message).
                    var mouse = ed && ed.mouse;
                    if (mouse) {
                        if (typeof mouse.absolute === "boolean") mouseAbsolute = mouse.absolute;
                        if (mouse.outputs && Array.isArray(mouse.outputs.available)) mouseOutputs = mouse.outputs.available;
                        // Fall back to the active-output name when 'absolute' isn't reported.
                        if (mouseAbsolute === null && mouse.outputs && typeof mouse.outputs.active === "string")
                            mouseAbsolute = mouse.outputs.active === "usb";
                    }
                } catch (e) {}
            };
        }
        function schedule() {
            if (retry) return;
            retry = setTimeout(function () {
                retry = null;
                connect();
            }, 1200);
        }
        function raw(obj) {
            try {
                ws.send(JSON.stringify(obj));
            } catch (e) {}
        }
        function send(obj) {
            // While the AGENT is in control, the user must NOT be able to drive the
            // target — drop all user HID input (mouse/keys) at the source. The agent's
            // own input goes through the server-side control core, not this socket.
            if (agentActing) {
                // Release events are allowed through so a button/key held just before
                // automation starts cannot get stuck down on the target.
                if (!isRelease(obj)) return;
            }
            if (open && ws && ws.readyState === 1) raw(obj);
            else {
                if (queue.length < 256) queue.push({ at: Date.now(), obj: obj });
                connect();
            }
        }
        return {
            connect: connect,
            isOpen: function () {
                return open;
            },
            /** Has a connection attempt ever resolved? See `everSettled`. */
            everSettled: function () {
                return everSettled;
            },
            setStatus: function (cb) {
                onStatus = cb;
            },
            key: function (codeName, state) {
                send({ event_type: "key", event: { key: codeName, state: !!state } });
            },
            move: function (x, y) {
                send({ event_type: "mouse_move", event: { to: { x: x, y: y } } });
            },
            button: function (b, state) {
                send({ event_type: "mouse_button", event: { button: b, state: !!state } });
            },
            wheel: function (dx, dy) {
                send({ event_type: "mouse_wheel", event: { delta: { x: dx, y: dy } } });
            },
            /** A RELATIVE mouse nudge — wakes a sleeping/no-signal display where an
             *  absolute position report alone often won't. Routed to the Pi's relative
             *  mouse endpoint (a no-op if the Pi is absolute-only). */
            relative: function (dx, dy) {
                send({ event_type: "mouse_relative", event: { delta: { x: Math.round(dx), y: Math.round(dy) }, squash: true } });
            },
            /** The target's pointer mode, or null if not yet known. */
            isRelative: function () {
                return mouseAbsolute === false;
            },
            /** Switch the Pi to ABSOLUTE pointer mode if it's currently relative and an
             *  absolute output ("usb") is available. This client always sends absolute
             *  moves, so a relative-mode Pi can't track the cursor — call this when the
             *  user's mouse enters the surface to recover it. Idempotent + throttled: a
             *  no-op once the Pi reports absolute, and at most one POST per few seconds
             *  while the change applies (a fresh hid event then flips mouseAbsolute true). */
            ensureAbsolute: function () {
                if (mouseAbsolute !== false) return; // unknown or already absolute
                if (mouseOutputs.indexOf("usb") < 0) return; // no absolute output to switch to
                var now = Date.now();
                if (absSwitchBusy || now - absSwitchAt < 3000) return;
                absSwitchAt = now;
                absSwitchBusy = true;
                fetch("/api/hid/set_params?mouse_output=usb", { method: "POST", cache: "no-store" })
                    .catch(function () {})
                    .then(function () {
                        absSwitchBusy = false;
                    });
            },
            /** The target's current Caps Lock state (from its keyboard LED). */
            capsOn: function () {
                return targetCaps;
            },
            /** Whether the Pi actually reports the caps LED (so we can trust capsOn). */
            capsKnown: function () {
                return capsKnown;
            },
        };
    })();

    /* ----------------------------------------------------------------- *
     * Transient messages
     * ----------------------------------------------------------------- */

    var toastEl = document.getElementById("toast");
    var toastTimer = null;
    /** Say something briefly over the stream. `error` styles it red and holds it
     *  longer, because a failed power action is worth actually reading.
     *  `sticky` keeps it up until something replaces or clears it — for work
     *  that outlasts the normal dwell and would otherwise look abandoned. */
    /* Write text only when it differs.
     *
     * The repaint functions run on every kvmd event — info, hid, streamer, msd,
     * gpio — and a real Pi sends those constantly. Reassigning textContent
     * replaces the text node even when the string is identical, which throws
     * away any selection inside it and, in a live region, announces again.
     * Swept the document with a MutationObserver while pushing five rounds of
     * IDENTICAL state:
     *
     *     health-ok          30 rewrites
     *     health-hid-state   30
     *     sp-*-value         15 each
     *     msd-status          5
     *     msd-free            5
     *
     * none of which had changed. b767219 fixed two of these one at a time; this
     * is the same rule in one place so the next repaint added here gets it by
     * default rather than by remembering.
     *
     * Only for repaint paths. Somewhere that rebuilds on a user action — the
     * macro editor, the log body — is not this, and should not pretend to be. */
    function setText(el, text) {
        if (el && el.textContent !== text) el.textContent = text;
    }

    /* The same rule for attributes, where one of them is not merely wasted work.
     *
     * aria-valuetext is what a screen reader reads for a slider, and Chromium
     * raises a value-changed event on the WRITE, not on the value differing. The
     * stream sliders are repainted by every streamer event, and controlBusy only
     * skips a control the user is actively dragging — so a slider that is merely
     * FOCUSED got its value re-announced on each event while sitting untouched.
     * Measured: six identical streamer pushes, six announcements of "80%".
     *
     * Same family as the pill that re-announced itself every five seconds, and
     * fixed the same way. min, max and hidden are properties rather than
     * attributes but reflect onto one, so they get the same guard — those are
     * only churn, but the rule is easier to keep than to remember to apply. */
    function setAttr(el, name, value) {
        if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
    }

    function setProp(el, name, value) {
        if (el && el[name] !== value) el[name] = value;
    }

    /* Empty a toast once it has finished fading, not the moment it starts.
     *
     * Both toasts hide by going to opacity 0 over 0.25s, and both have to be
     * emptied afterwards because opacity does not take an element out of the
     * accessibility tree — a toast that is visually gone otherwise keeps its
     * last message readable to a screen reader for the life of the window.
     *
     * Doing the two together is what this exists to avoid. Measured at the
     * moment the class comes off: opacity 1.00, text already gone — so the pill
     * visibly becomes an empty rounded box and then fades out over a quarter of
     * a second. Wait out the transition instead, and skip the clear if
     * something new has been shown in the meantime.
     *
     * A timer rather than transitionend: prefers-reduced-motion drops the
     * transition, and then that event never fires and the text never clears. */
    var TOAST_FADE_MS = 300;
    function emptyWhenFaded(host, els) {
        if (!host) return;
        setTimeout(function () {
            if (host.classList.contains("show")) return;
            for (var i = 0; i < els.length; i++) setText(els[i], "");
        }, TOAST_FADE_MS);
    }

    function toast(msg, error, sticky) {
        if (!toastEl) return;
        /* An error and a confirmation were both announced politely, which means
         * a screen reader can hold "Power action failed" until the user happens
         * to go idle, or drop it behind the next message. Errors interrupt;
         * everything else waits its turn.
         *
         * Set BEFORE the text on purpose: a live region is read according to the
         * politeness it had when the content changed, so flipping it afterwards
         * announces the previous message's urgency, or nothing at all. */
        toastEl.setAttribute("role", error ? "alert" : "status");
        toastEl.setAttribute("aria-live", error ? "assertive" : "polite");
        toastEl.textContent = msg;
        toastEl.classList.toggle("is-error", !!error);
        toastEl.classList.add("show");
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = null;
        if (sticky) return;
        toastTimer = setTimeout(
            function () {
                toastEl.classList.remove("show");
                emptyWhenFaded(toastEl, [toastEl]);
            },
            error ? 6000 : 2600,
        );
    }
    function hideToast() {
        if (!toastEl) return;
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = null;
        toastEl.classList.remove("show");
        /* The sticky "Reading the screen…" is dismissed through here when the
         * OCR text arrives, and it kept sitting in the live region afterwards —
         * with role=alert still on it whenever the last message had been an
         * error, which is the most urgent thing a page can leave lying around. */
        emptyWhenFaded(toastEl, [toastEl]);
    }

    /* ----------------------------------------------------------------- *
     * ATX power control (kvmd api/atx/click)
     * ----------------------------------------------------------------- */

    var atx = (function () {
        // {enabled, busy, leds:{power,hdd}} from the `atx` event on /api/ws.
        // null until the Pi tells us; a board with no ATX wiring reports enabled:false.
        var state = null;
        var listeners = [];
        function emit() {
            for (var i = 0; i < listeners.length; i++) listeners[i](state);
        }
        return {
            setState: function (s) {
                if (!s) {
                    state = null;
                    emit();
                    return;
                }
                var next = state || { leds: {} };
                if (s.enabled !== undefined) next.enabled = s.enabled;
                if (s.busy !== undefined) next.busy = s.busy;
                if (s.leds !== undefined) next.leds = s.leds || {};
                state = next;
                emit();
            },
            onChange: function (cb) {
                listeners.push(cb);
                cb(state);
            },
            /** Does this Pi actually have ATX wiring? */
            available: function () {
                return !!(state && state.enabled);
            },
            /** True while kvmd is mid-operation — the buttons are dead then. */
            busy: function () {
                return !!(state && state.busy);
            },
            /** Target power LED, or null when unknown. */
            powered: function () {
                return state && state.leds ? !!state.leds.power : null;
            },
            /**
             * Press an ATX button. `power` is a short press (the OS sees it and shuts
             * down cleanly), `power_long` holds it (a hard cut), `reset` is the reset
             * line. Goes through our proxy, so the Pi's auth is injected for us.
             */
            click: function (button) {
                return fetch("/api/atx/click?button=" + encodeURIComponent(button), { method: "POST", cache: "no-store" })
                    .then(function (r) {
                        if (r.status === 409) {
                            // kvmd serialises ATX across clients.
                            toast("Another client is using the power controls. Try again in a moment.", true);
                            return false;
                        }
                        if (!r.ok) {
                            toast("Power action failed (" + r.status + ")", true);
                            return false;
                        }
                        return true;
                    })
                    .catch(function (e) {
                        toast("Power action failed: " + (e && e.message ? e.message : "network error"), true);
                        return false;
                    });
            },
        };
    })();

    /* The three ATX actions, in the order the real PiKVM UI lists them. `warn` is the
     * confirmation text: every one of these can cost the operator unsaved work, so
     * none of them fire on a single stray click. */
    var ATX_ACTIONS = [
        { id: "power", label: "Power button", warn: "Press the power button?\n\nThe target will start up, or shut down cleanly if it is running." },
        { id: "power_long", label: "Power button (hold 5s)", warn: "Hold the power button for 5 seconds?\n\nThis cuts the power without asking the OS. Unsaved work will be lost." },
        { id: "reset", label: "Reset", warn: "Press the reset button?\n\nThe target restarts immediately. Unsaved work will be lost." },
    ];
    /* Web/mobile: the ATX entries live in the ⋯ menu, revealed once the Pi says it
     * has the wiring. Desktop adds them to the native menu and the titlebar button
     * as well; both routes call runAtxAction, so there is one code path. */
    document.querySelectorAll("[data-atx]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            runAtxAction(btn.getAttribute("data-atx"));
        });
    });
    atx.onChange(function () {
        var show = atx.available();
        var busy = atx.busy();
        document.querySelectorAll("[data-atx]").forEach(function (btn) {
            btn.hidden = !show;
            btn.disabled = busy;
        });
        ["atx-sep", "atx-sep-end"].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.hidden = !show;
        });
        var powered = atx.powered();
        tbState.power = {
            visible: !!show,
            on: powered === true && !busy,
            busy: !!busy,
            label: !show ? "Power" : busy ? "Power — busy" : powered ? "Power — target is on" : "Power — target is off",
        };
        repaintTbState();
    });

    /* ----------------------------------------------------------------- *
     * Macros: user-defined input the target receives
     * ----------------------------------------------------------------- */

    /* Stored server-side as macros.json beside the app's other settings, so the
     * same list reaches desktop and phone and can be hand-edited on disk. A
     * macro is a list of steps because the useful ones rarely are one chord:
     * "open the run box, type a path, press enter" is three. */
    var macros = [];
    var macroDlg = document.getElementById("macro-dlg");
    var macroSelected = null; // id being edited
    /* Set by an edit that MOVES the control it was fired from, so the repaint
     * can follow it instead of restoring focus to the old position. */
    var pendingMacroFocus = null;
    /* React roots mounted inside the step list. paintMacroEditor clears that
     * list wholesale, so each rebuild must unmount what it is about to throw
     * away — otherwise every save leaves another live root attached to detached
     * nodes. */
    var stepRoots = [];
    function dropStepRoots() {
        stepRoots.forEach(function (r) {
            try {
                r.unmount();
            } catch (e) {}
        });
        stepRoots = [];
    }

    /* A small set of real icons, so a macro button is picked rather than typed.
     * Lucide geometry (MIT), inlined because the console ships no icon library
     * and one <svg> beats a font request. Macros written before the picker may
     * still carry a literal glyph, which renders as text. */
    var MACRO_ICONS = {
        camera: ["M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z", "M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
        monitor: ["M3 4h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M8 21h8M12 17v4"],
        terminal: ["m4 17 6-6-6-6", "M12 19h8"],
        power: ["M12 2v10", "M18.4 6.6a9 9 0 1 1-12.8 0"],
        lock: ["M4 11h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z", "M7 11V7a5 5 0 0 1 10 0v4"],
        refresh: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"],
        folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"],
        search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "m21 21-4.3-4.3"],
        clipboard: ["M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2", "M9 2h6a1 1 0 0 1 1 1v3H8V3a1 1 0 0 1 1-1z"],
        play: ["m6 3 14 9-14 9V3z"],
        save: ["M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7", "M7 3v4a1 1 0 0 0 1 1h7"],
        keyboard: ["M2 6h20a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z", "M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"],
        download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"],
        upload: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m17 8-5-5-5 5", "M12 3v12"],
        star: ["M11.5 2.8a.6.6 0 0 1 1 0l2.4 5 5.4.8a.6.6 0 0 1 .3 1l-3.9 3.8.9 5.4a.6.6 0 0 1-.9.6L12 16.9l-4.8 2.5a.6.6 0 0 1-.9-.6l.9-5.4L3.3 9.6a.6.6 0 0 1 .3-1l5.4-.8z"],
        bell: ["M10.3 21a1.94 1.94 0 0 0 3.4 0", "M21 19H3l1.6-2.4A6 6 0 0 0 6 13V9a6 6 0 0 1 12 0v4a6 6 0 0 0 1.4 3.6z"],
        copy: ["M10 9h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
        zap: ["M4 14a1 1 0 0 1-.8-1.6l9.4-11a1 1 0 0 1 1.7.9L13 10h6a1 1 0 0 1 .8 1.6l-9.4 11a1 1 0 0 1-1.7-.9L11 14z"],
        maximize: ["M8 3H5a2 2 0 0 0-2 2v3", "M21 8V5a2 2 0 0 0-2-2h-3", "M3 16v3a2 2 0 0 0 2 2h3", "M16 21h3a2 2 0 0 0 2-2v-3"],
        command: ["M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"],
        trash: ["M3 6h18", "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2", "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"],
        settings: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"],
    };
    var MACRO_ICON_NAMES = Object.keys(MACRO_ICONS);

    /** Build the <svg> for a named icon, or null when it is a legacy glyph. */
    function macroIconSvg(name) {
        var paths = MACRO_ICONS[name];
        if (!paths) return null;
        var NS = "http://www.w3.org/2000/svg";
        var svg = document.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.setAttribute("aria-hidden", "true");
        paths.forEach(function (d) {
            var path = document.createElementNS(NS, "path");
            path.setAttribute("d", d);
            svg.appendChild(path);
        });
        return svg;
    }

    /** Human-readable chord, e.g. "Ctrl + Shift + S". */
    function chordLabel(step) {
        var names = {
            ControlLeft: "Ctrl",
            ControlRight: "Ctrl",
            AltLeft: "Alt",
            AltRight: "AltGr",
            ShiftLeft: "Shift",
            ShiftRight: "Shift",
            MetaLeft: "Super",
            MetaRight: "Super",
        };
        var parts = (step.mods || []).map(function (m) {
            return names[m] || m;
        });
        parts.push(String(step.code || "").replace(/^Key|^Digit/, ""));
        return parts.join(" + ");
    }


    function loadMacros() {
        return fetch("/_agent/api/macros", { cache: "no-store" })
            .then(function (r) {
                return r.ok ? r.json() : { macros: [] };
            })
            .then(function (d) {
                macros = (d && d.macros) || [];
                paintMacroButtons();
                paintMacroEditor();
            })
            .catch(function () {
                /* no macros is a fine state; the editor still opens */
            });
    }

    function saveMacros() {
        return fetch("/_agent/api/macros", {
            method: "PUT",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ macros: macros }),
        })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            })
            .then(function (d) {
                /* The server normalises (drops empty steps, dedupes ids), so
                 * adopt what it stored rather than what we sent — EXCEPT for a
                 * macro still being built.
                 *
                 * A new macro starts with one empty chord, which the server
                 * drops, which leaves it with no steps, which makes the server
                 * drop the macro itself. Adopting that answer wholesale deleted
                 * the draft the editor was sitting on: picking an icon, renaming
                 * it, or toggling pinned all saved, and all three wiped the very
                 * macro they were editing. Only the edits that happened to give
                 * it a usable step survived.
                 *
                 * Drafts stay in place, in order, until they earn a place on the
                 * server. closeMacroEditor still discards them on the way out. */
                var stored = (d && d.macros) || [];
                var byId = {};
                stored.forEach(function (m) {
                    byId[m.id] = m;
                });
                /* Put back the steps the server dropped, where they were.
                 *
                 * The draft rule above is applied to whole MACROS and stops
                 * there, so a half-built step inside a macro the server does
                 * store was adopted away mid-edit. cleanStep returns null for a
                 * chord with no code, so the natural way to build one — add the
                 * combo, pick the modifiers, then pick the key — deleted itself
                 * on the first modifier press:
                 *
                 *     add key combo : ["text x", "chord key='' "]
                 *     press Ctrl    : ["text x"]
                 *
                 * The step was gone with nothing said, and the only order that
                 * worked was key first, which nothing tells you. A new text
                 * step and a zero pause have the same problem.
                 *
                 * Re-inserted at the index it had rather than appended: a macro
                 * is a sequence and putting a step back in the wrong place is
                 * its own kind of wrong. Ascending order, so each splice lands
                 * before the later ones are placed. */
                var withDrafts = function (stored, local) {
                    var drafts = [];
                    (local.steps || []).forEach(function (st, i) {
                        if (!stepWouldPersist(st)) drafts.push({ at: i, step: st });
                    });
                    if (!drafts.length) return stored;
                    var steps = (stored.steps || []).slice();
                    drafts.forEach(function (d) {
                        steps.splice(Math.min(d.at, steps.length), 0, d.step);
                    });
                    var out = {};
                    for (var k in stored) if (Object.prototype.hasOwnProperty.call(stored, k)) out[k] = stored[k];
                    out.steps = steps;
                    return out;
                };
                var merged = [];
                macros.forEach(function (m) {
                    if (byId[m.id]) {
                        merged.push(withDrafts(byId[m.id], m));
                        delete byId[m.id];
                    } else if (!macroWouldPersist(m)) {
                        merged.push(m);
                    }
                });
                // Anything the server knows about that we did not send.
                stored.forEach(function (m) {
                    if (byId[m.id]) merged.push(m);
                });
                macros = merged;
                paintMacroButtons();
                paintMacroEditor();
            })
            .catch(function (e) {
                toast("Could not save macros: " + (e && e.message ? e.message : "network error"), true);
            });
    }

    /** Run a macro's steps in order, through the same queue manual keys use. */
    function runMacro(macro) {
        if (!macro) return;
        if (agentActing) {
            // Silently doing nothing is the worst answer: the user cannot tell a
            // blocked macro from one whose chord the target ignored.
            toast("The agent is driving the target — macros are held until it stops.", true);
            return;
        }
        if (macroRunning) {
            /* Reachable from the send-keys menu, which has no disabled state to
             * show. Saying so beats dropping the click in silence. */
            toast(macroRunning.label + " is still running", true);
            return;
        }
        noteManualKvmInput();
        macroRunning = macro;
        paintMacroButtons();
        repaintPasteActions(); // the paste dialog may be open on top of this
        var i = 0;
        /* The two ways a run ends, so macroRunning cannot be left set.
         *
         * Every branch reaches one of them: a chord waits on afterKeys, which
         * drainKeys always fires from a timer whatever the socket is doing; the
         * text step settles its fetch both ways; a delay is a plain timeout. So
         * the chain cannot stall and leave macros disabled for good. */
        var done = function () {
            macroRunning = null;
            paintMacroButtons();
            repaintPasteActions();
        };
        /* A step that did not happen stops the run.
         *
         * A macro is an ordered sequence and the later steps assume the earlier
         * ones landed — "type the username, Tab, type the password, Enter"
         * carries on into the wrong field and then submits it if the first step
         * silently did nothing. Carrying on was never a decision anyone wrote
         * down: the text step chained .catch(...).then(next), so next ran on
         * failure as well, which reads like the shape of the chain rather than
         * an intent. */
        var stopped = function (problem) {
            var left = macro.steps.length - i;
            done();
            toast(
                macro.label + " stopped: " + problem +
                    (left > 0 ? " — " + left + " later step" + (left === 1 ? "" : "s") + " not sent." : ""),
                true,
            );
        };
        var next = function () {
            if (i >= macro.steps.length) {
                done();
                // A macro's whole effect happens on the OTHER machine, so without
                // this the click has no visible consequence here at all — and a
                // chord the target ignored looks identical to one never sent.
                toast(macro.label + " sent");
                return;
            }
            var step = macro.steps[i++];
            if (step.type === "chord") {
                /* Wait for the chord to finish, not for sendChord to return.
                 *
                 * It returns immediately — the chord is played out of a queue
                 * over several timeouts — so advancing on setTimeout(next, 0)
                 * started the NEXT step while the modifiers were still held
                 * down on the target. A macro of "Ctrl+Alt+Delete, then type
                 * hi" sent ControlLeft down, AltLeft down, then the text, and
                 * only then Delete: the target received Ctrl+Alt+h and
                 * Ctrl+Alt+i rather than "hi".
                 *
                 * The other two step types already wait for themselves — text
                 * on the fetch's .then, delay on its own timer. This one did
                 * not. */
                sendChord(step.mods || [], step.code, false);
                afterKeys(next);
                return;
            }
            if (step.type === "text") {
                // kvmd types it with its own keymap — faster and layout-correct.
                fetch("/api/hid/print?limit=0&delay=0.02", {
                    method: "POST",
                    cache: "no-store",
                    headers: { "Content-Type": "text/plain" },
                    body: step.text,
                })
                    /* Both outcomes, and the status checked as well as the
                     * rejection. A 4xx or 5xx RESOLVES the promise, so the old
                     * lone .catch never saw one: with kvmd answering 500 the run
                     * still finished and toasted "<macro> sent", which is a
                     * positive claim that the text reached the target when
                     * nothing had been typed at all. The paste dialog — the same
                     * endpoint, the other way in — has always checked r.ok.
                     *
                     * Two-argument then rather than .then().catch(): the handler
                     * belongs to the fetch, so a throw inside next() is not
                     * caught here and misreported as a failure to type. */
                    .then(
                        function (r) {
                            if (r.status === 413) {
                                stopped("that step is too much text to type in one go");
                                return;
                            }
                            if (!r.ok) {
                                stopped("text step failed (" + r.status + ")");
                                return;
                            }
                            next();
                        },
                        function (e) {
                            stopped("text step failed: " + (e && e.message ? e.message : "network error"));
                        },
                    );
                return;
            }
            if (step.type === "delay") {
                setTimeout(next, step.ms);
                return;
            }
            next();
        };
        next();
    }

    /** A macro's own label, as HTML, for the icon slot.
     *
     *  Escaped because a macro label is user input and this goes in as markup —
     *  the icon itself is our own SVG, but the fallback is whatever they typed. */
    /** What to draw when the icon name did not resolve to one of ours.
     *
     *  This used to be `m.icon || initials`, which reads the wrong question. A
     *  MISSING icon fell through to the label's initials, correctly — but an
     *  UNRECOGNISED one is a non-empty string, so it short-circuited and the
     *  name itself was drawn into a 15px box: a titlebar button rendering
     *  "not-a-real-icon" clipped inside 30px. Unrecognised is the likelier of
     *  the two in practice, since it is what a macro written by another version
     *  of this app, or an icon since dropped from MACRO_ICONS, looks like.
     *
     *  A one or two character value is kept as-is, so a literal glyph still
     *  works; anything longer is data we cannot draw, and the label's initials
     *  say more about the macro than a broken name does. */
    function macroGlyph(macro) {
        var icon = typeof macro.icon === "string" ? macro.icon.trim() : "";
        if (icon && Array.from(icon).length <= 2) return icon;
        return macro.label.slice(0, 2).toUpperCase();
    }

    function macroFallbackHtml(text) {
        return String(text).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
    }
    /* The macro playing right now, or null.
     *
     * runMacro builds a per-run chain with its own step index, and nothing
     * stopped a second one starting on top of the first. The steps then group
     * across runs rather than interleaving cleanly: fired three times 120ms
     * apart, a macro of "Ctrl+Alt+Delete, pause 300ms, type hello, Enter" sent
     *
     *     CAD  CAD  CAD  hello Enter  hello Enter  hello Enter
     *
     * so the pause — which is there precisely to let the target catch up before
     * anything is typed — was honoured for the first run and defeated for the
     * other two. On a log-in macro that is the password typed into whatever the
     * second and third CADs left on screen.
     *
     * A macro is exactly where this happens, because the click has no visible
     * consequence on THIS machine: the toast only appears when the run
     * finishes, so during a long one there is nothing at all to say it started,
     * and clicking again is the natural thing to do. */
    var macroRunning = null;
    function pinnedMacroSpecs() {
        return macros
            .filter(function (m) {
                return m.pinned !== false;
            })
            .map(function (m) {
                var svg = macroIconSvg(m.icon);
                return {
                    id: "macro:" + m.id,
                    label: m.label,
                    // macroIconSvg builds a node; the spec wants markup.
                    icon: svg ? svg.outerHTML : macroFallbackHtml(macroGlyph(m)),
                    /* Disabled while any macro plays, not just this one: they
                     * share the key queue and the target, so two at once
                     * garbles both. It is also the only feedback that one is
                     * running, which is the same answer the paste dialog and
                     * the MSD upload already give for an action in flight. */
                    disabled: !!macroRunning,
                    onSelect: function () {
                        runMacro(m);
                    },
                };
            });
    }
    function paintMacroButtons() {
        repaintMacroButtons();
        paintMacroMenu();
    }

    /* The same pinned macros, in the web/mobile overflow menu.
     *
     * The titlebar is where they live on the desktop and it does not exist
     * anywhere else, so on a phone a macro could be created, named, given an
     * icon and ticked "Show in the titlebar" — and then never run, because
     * nothing outside that titlebar could fire one. The editor was reachable
     * and the thing it edits was not.
     *
     * Rendered rather than declared because the set changes; the separator goes
     * with them so an empty list leaves no stray rule behind. */
    function paintMacroMenu() {
        var host = document.getElementById("macro-run-list");
        var sep = document.getElementById("macro-run-sep");
        if (!host) return;
        var pinned = macros.filter(function (m) {
            return m.pinned !== false;
        });
        if (sep) sep.hidden = !pinned.length;
        var key = pinned
            .map(function (m) {
                return m.id + ":" + m.label;
            })
            .join("|");
        if (host.getAttribute("data-set") === key) return;
        host.setAttribute("data-set", key);
        host.innerHTML = "";
        pinned.forEach(function (m) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "more-item";
            btn.textContent = m.label;
            btn.addEventListener("click", function () {
                runMacro(m);
            });
            host.appendChild(btn);
        });
    }

    /* ---- editor ---- */

    function macroById(id) {
        for (var i = 0; i < macros.length; i++) if (macros[i].id === id) return macros[i];
        return null;
    }

    function paintMacroEditor() {
        if (!macroDlg || macroDlg.hidden) return;
        var list = document.getElementById("macro-list");
        if (list) {
            list.innerHTML = "";
            macros.forEach(function (m) {
                var btn = document.createElement("button");
                btn.type = "button";
                btn.className = m.id === macroSelected ? "active" : "";
                var rowIcon = macroIconSvg(m.icon);
                if (rowIcon) {
                    rowIcon.classList.add("macro-row-icon");
                    btn.appendChild(rowIcon);
                }
                btn.appendChild(document.createTextNode(m.label));
                btn.addEventListener("click", function () {
                    macroSelected = m.id;
                    paintMacroEditor();
                });
                list.appendChild(btn);
            });
            /* An empty column with a divider beside it says nothing about what
               it is or how it gets filled. */
            if (!macros.length) {
                var none = document.createElement("p");
                none.className = "dlg-note macro-list-empty";
                none.textContent = "No macros yet.";
                /* The list column says the list is empty; the editor column
                   beside it says what to do about it. Saying both in both
                   places just reads as a rendering fault. */
                list.appendChild(none);
            }
        }
        var macro = macroById(macroSelected);
        var form = document.getElementById("macro-form");
        var empty = document.getElementById("macro-empty");
        if (form) form.hidden = !macro;
        if (empty) {
            empty.hidden = !!macro;
            /* "Select a macro" was shown whether or not there was one to
               select. With none saved it asked for a choice from an empty list
               and named no way out of that; the button that makes one is in the
               actions row, so say what it is called. */
            empty.textContent = macros.length
                ? "Select a macro to edit it."
                : "Use New macro to add one.";
        }
        if (!macro) return;

        var labelEl = document.getElementById("macro-label");
        var pinnedEl = document.getElementById("macro-pinned");
        if (labelEl && document.activeElement !== labelEl) labelEl.value = macro.label;
        if (pinnedEl) pinnedEl.checked = macro.pinned !== false;

        var icons = document.getElementById("macro-icons");
        if (icons) {
            icons.innerHTML = "";
            /* "No icon" — the state every macro starts in, and the only one this
             * group could not get back to.
             *
             * The grid was the twenty-two named icons and nothing else, and the
             * handler assigns macro.icon unconditionally, so choosing one was a
             * one-way door: a macro made, seen in the titlebar as its initials,
             * then given the power icon, could never go back to the initials.
             * It is also odd as a radiogroup — it opens with nothing checked on
             * a new macro and had no way to return to that.
             *
             * The choice previews what it does rather than showing an abstract
             * "off" mark: macroGlyph with no icon is exactly what the titlebar
             * would draw, which is the macro's first two letters. */
            var iconSet = typeof macro.icon === "string" && macro.icon.trim() !== "";
            var noIcon = document.createElement("button");
            noIcon.type = "button";
            noIcon.className = "macro-icon" + (iconSet ? "" : " active");
            noIcon.setAttribute("role", "radio");
            noIcon.setAttribute("aria-checked", String(!iconSet));
            noIcon.setAttribute("aria-label", "No icon");
            noIcon.title = "No icon";
            noIcon.textContent = macroGlyph({ icon: "", label: macro.label });
            noIcon.addEventListener("click", function () {
                macro.icon = "";
                void saveMacros();
            });
            icons.appendChild(noIcon);
            MACRO_ICON_NAMES.forEach(function (name) {
                var choice = document.createElement("button");
                choice.type = "button";
                choice.className = "macro-icon" + (macro.icon === name ? " active" : "");
                choice.setAttribute("role", "radio");
                choice.setAttribute("aria-checked", String(macro.icon === name));
                choice.setAttribute("aria-label", name);
                choice.title = name;
                var svg = macroIconSvg(name);
                if (svg) choice.appendChild(svg);
                choice.addEventListener("click", function () {
                    macro.icon = name;
                    void saveMacros();
                });
                icons.appendChild(choice);
            });
        }

        var steps = document.getElementById("macro-steps");
        if (!steps) return;
        /* Every edit saves, every save repaints this whole list, so without
         * putting focus back the ring lands on the body after each change — and
         * building one chord now means several changes in a row (three
         * modifiers, then the key). Controls carry a stable data-fk so the
         * equivalent one can be found again in the rebuilt rows. */
        /* Read where focus is BEFORE unmounting anything. Dropping the roots
         * destroys the button that currently has it, so asking afterwards always
         * answers "the body" — which is how this managed to restore nothing at
         * all while looking correct. */
        var active = document.activeElement;
        var refocus =
            pendingMacroFocus ||
            (active && steps.contains(active)
                ? active.getAttribute("data-fk") || active.getAttribute("data-tb")
                : null);
        pendingMacroFocus = null;
        dropStepRoots();
        steps.innerHTML = "";
        macro.steps.forEach(function (step, index) {
            var row = document.createElement("div");
            row.className = "macro-step";
            var kind = document.createElement("span");
            kind.className = "macro-kind";
            kind.textContent = step.type === "chord" ? "Keys" : step.type === "text" ? "Text" : "Pause";
            row.appendChild(kind);

            if (step.type === "chord") {
                var mods = document.createElement("div");
                mods.className = "macro-mods";
                mods.setAttribute("role", "group");
                mods.setAttribute("aria-label", "Modifier keys for step " + (index + 1));
                var shared = window.pikvmShared;
                var modSpecs = MACRO_MODS.map(function (m) {
                    var mcode = m[0];
                    var on = (step.mods || []).indexOf(mcode) >= 0;
                    return {
                        // The focus key IS the id, so the restoration above finds
                        // it by data-tb exactly as it finds the rest by data-fk.
                        id: "m" + index + ":" + mcode,
                        label: m[1],
                        // Keeps .macro-mod, whose is-on state is already expressed
                        // in this stylesheet; the component supplies the rest.
                        className: "dlg-btn macro-mod" + (on ? " is-on" : ""),
                        /* And say so, rather than leaving it to the colour.
                         *
                         * Which modifiers are armed IS the step — "Ctrl+Alt+
                         * Delete" and "Delete" differ by nothing else — and the
                         * accessibility tree said nothing about it. Measured on
                         * the seeded chord with Ctrl and Alt held:
                         *
                         *     Ctrl   is-on  aria-pressed=null
                         *     Alt    is-on  aria-pressed=null
                         *     Shift  off    aria-pressed=null
                         *
                         * so all five read identically and the chord could not
                         * be read back at all. The touch drawer's sticky
                         * modifiers were fixed for exactly this; these are the
                         * same control in the editor and were missed.
                         *
                         * role=switch rather than aria-pressed because that is
                         * what this renderer supports: mountButtons maps
                         * role+checked and ignores `pressed`, which only
                         * mountIconButtons reads — probed both to be sure. It
                         * is also how every GPIO row states its on/off through
                         * the same function, and renderPlainButtons already
                         * agrees, so the no-bundle path says the same thing. */
                        role: "switch",
                        checked: on,
                        onSelect: function () {
                            step.mods = step.mods || [];
                            var at = step.mods.indexOf(mcode);
                            if (at >= 0) step.mods.splice(at, 1);
                            else step.mods.push(mcode);
                            void saveMacros();
                        },
                    };
                });
                if (shared && shared.mountButtons) {
                    stepRoots.push(shared.mountButtons(mods, modSpecs));
                } else {
                    renderPlainButtons(mods, modSpecs);
                }
                row.appendChild(mods);

                var keySel = document.createElement("select");
                keySel.className = "dlg-select macro-key";
                keySel.setAttribute("aria-label", "Key for step " + (index + 1));
                keySel.setAttribute("data-fk", "k" + index);
                var blank = document.createElement("option");
                blank.value = "";
                blank.textContent = "Choose a key…";
                keySel.appendChild(blank);
                macroKeyGroups().forEach(function (group) {
                    var og = document.createElement("optgroup");
                    og.label = group[0];
                    group[1].forEach(function (k) {
                        var opt = document.createElement("option");
                        opt.value = k[0];
                        opt.textContent = k[1];
                        og.appendChild(opt);
                    });
                    keySel.appendChild(og);
                });
                keySel.value = step.code || "";
                /* A macro written before this list existed — or by hand, or by
                 * the agent — can hold a code the list does not carry. Without
                 * this the select would quietly show "Choose a key…" for a macro
                 * that has a perfectly good key, and the next edit would look
                 * like the user had cleared it. */
                if (step.code && keySel.value !== step.code) {
                    var kept = document.createElement("option");
                    kept.value = step.code;
                    kept.textContent = step.code;
                    keySel.appendChild(kept);
                    keySel.value = step.code;
                }
                keySel.addEventListener("change", function () {
                    step.code = keySel.value;
                    void saveMacros();
                });
                row.appendChild(keySel);
            } else if (step.type === "text") {
                var text = document.createElement("input");
                text.type = "text";
                text.className = "dlg-text dlg-grow";
                text.setAttribute("aria-label", "Text for step " + (index + 1));
                text.setAttribute("data-fk", "t" + index);
                text.value = step.text || "";
                text.addEventListener("change", function () {
                    step.text = text.value;
                    void saveMacros();
                });
                row.appendChild(text);
            } else {
                var ms = document.createElement("input");
                ms.type = "number";
                ms.className = "dlg-text";
                ms.style.width = "7rem";
                ms.min = "10";
                ms.max = "10000";
                ms.setAttribute("aria-label", "Pause for step " + (index + 1) + ", milliseconds");
                ms.setAttribute("data-fk", "d" + index);
                ms.value = String(step.ms || 200);
                ms.addEventListener("change", function () {
                    step.ms = Number(ms.value) || 200;
                    void saveMacros();
                });
                row.appendChild(ms);
                var unit = document.createElement("span");
                unit.className = "dlg-hint";
                unit.textContent = "ms";
                row.appendChild(unit);
            }

            // Order is the whole point of a multi-step macro — "type the path,
            // THEN press enter" — so it has to be changeable after the fact.
            var moveSpec = function (delta, glyph) {
                return {
                    id: (delta < 0 ? "u" : "n") + index,
                    label: glyph,
                    // "↑" is a glyph, not a name.
                    ariaLabel: delta < 0 ? "Move step up" : "Move step down",
                    className: "dlg-btn macro-move",
                    disabled: delta < 0 ? index === 0 : index === macro.steps.length - 1,
                    onSelect: function () {
                        var to = index + delta;
                        var moved = macro.steps.splice(index, 1)[0];
                        macro.steps.splice(to, 0, moved);
                        // Follow the step to its new position, so a second press
                        // keeps moving the SAME step rather than whatever slid
                        // into the slot the pointer happens to be over.
                        pendingMacroFocus = (delta < 0 ? "u" : "n") + to;
                        void saveMacros();
                    },
                };
            };
            /* Kept in one box so a wrapped chord row cannot leave the up arrow on
             * the first line and the down arrow on the second, which reads as a
             * broken layout rather than as one set of controls. */
            var actions = document.createElement("div");
            actions.className = "macro-actions";
            var actionSpecs = [];
            // Nothing to reorder in a one-step macro — and a permanently disabled
            // pair of arrows reads as a rendering fault rather than as a control.
            if (macro.steps.length > 1) {
                actionSpecs.push(moveSpec(-1, "↑"), moveSpec(1, "↓"));
            }
            actionSpecs.push({
                id: "r" + index,
                label: "Remove",
                ariaLabel: "Remove step " + (index + 1),
                className: "dlg-btn",
                onSelect: function () {
                    macro.steps.splice(index, 1);
                    if (!macro.steps.length) macro.steps.push({ type: "chord", mods: [], code: "" });
                    // Land on the row that took its place, or the new last row.
                    pendingMacroFocus = "r" + Math.min(index, macro.steps.length - 1);
                    void saveMacros();
                },
            });
            var sharedRow = window.pikvmShared;
            if (sharedRow && sharedRow.mountButtons) {
                stepRoots.push(sharedRow.mountButtons(actions, actionSpecs));
            } else {
                renderPlainButtons(actions, actionSpecs);
            }
            row.appendChild(actions);
            steps.appendChild(row);
        });
        if (refocus) {
            /* Either attribute: controls this file builds carry data-fk, and the
             * ones the shared component library draws carry data-tb with the same
             * key. One lookup, so a row can mix the two without the restoration
             * quietly missing half of it. */
            var find = function (key) {
                return steps.querySelector('[data-fk="' + key + '"]') || steps.querySelector('[data-tb="' + key + '"]');
            };
            var back = find(refocus);
            // A move can push the step to an end, which disables the arrow that
            // got it there; the opposite one is still under the pointer.
            if (back && back.disabled && /^[un]/.test(refocus)) {
                back = find((refocus[0] === "u" ? "n" : "u") + refocus.slice(1));
            }
            if (back && !back.disabled) back.focus();
        }

        /* A step with no key (or no text) is dropped by the server's validation,
         * and a macro left with none is dropped whole — so a new macro closed
         * before its key is chosen just vanishes. Say that, rather than letting
         * the work disappear silently. */
        var incomplete = macro.steps.filter(function (step) {
            return !stepWouldPersist(step);
        }).length;
        var unsaved = document.getElementById("macro-unsaved");
        if (unsaved) {
            unsaved.hidden = incomplete === 0;
            unsaved.textContent =
                incomplete === 0
                    ? ""
                    : incomplete === macro.steps.length
                      ? "Not saved yet — choose the key or enter the text below and it will be kept."
                      : incomplete === 1
                        ? "One step is still empty; it will be dropped when saved."
                        : incomplete + " steps are still empty; they will be dropped when saved.";
        }
    }

    /* The server drops any step it cannot use, and a macro left with none goes
     * with them (see cleanStep in src/macros.ts). These two mirror that rule so
     * the editor never shows a macro that will not survive its next save. */
    function stepWouldPersist(step) {
        if (!step) return false;
        if (step.type === "chord") return !!step.code;
        if (step.type === "text") return !!step.text;
        if (step.type === "delay") return Number(step.ms) > 0;
        return false;
    }
    function macroWouldPersist(macro) {
        return !!(macro && macro.label && macro.steps && macro.steps.some(stepWouldPersist));
    }

    function openMacroEditor() {
        if (!macroDlg) return;
        closeOtherDialogs(macroDlg);
        macroDlg.hidden = false;
        if (!macroSelected && macros.length) macroSelected = macros[0].id;
        paintMacroEditor();
    }
    function closeMacroEditor() {
        if (macroDlg) macroDlg.hidden = true;
        // A new macro is held locally until it does something, because the
        // server will not store one with no usable step. Keeping that draft
        // after the dialog closes lists a macro that exists nowhere else and
        // vanishes on the next save, so let it go the moment the user leaves.
        var kept = macros.filter(macroWouldPersist);
        if (kept.length !== macros.length) {
            macros = kept;
            if (!macroById(macroSelected)) macroSelected = macros.length ? macros[0].id : null;
            paintMacroButtons();
            paintMacroEditor();
        }
        refocusKbd();
    }
    /* Mount a dialog's action row with the shared library.
     *
     * The bundle is a module and has not run when this file does, so every
     * caller would otherwise write the same poll. Returns nothing: these rows
     * are static, and the ones that are not keep their own update handle. */
    /* Plain buttons from the same specs, for when the shared component library
     * is not there.
     *
     * It is served from this app's own origin, so "not there" means a build or
     * packaging fault rather than a slow network — but that is exactly the case
     * worth surviving: without a fallback a dialog opens with NO buttons at
     * all, including Done, and the only way out is Escape, which in a KVM
     * console is a key people reasonably expect to reach the target. A dialog
     * you cannot leave is worse than an unstyled one.
     *
     * Marked data-fk rather than data-tb, matching the other controls this file
     * builds itself, so focus restoration finds them either way. */
    function renderPlainButtons(host, specs) {
        host.innerHTML = "";
        specs.filter(function (spec) { return !spec.hidden; }).forEach(function (spec) {
            var b = document.createElement("button");
            b.type = "button";
            b.className = spec.className || "dlg-btn" + (spec.variant === "default" ? " primary" : "");
            b.textContent = spec.label;
            if (spec.ariaLabel) b.setAttribute("aria-label", spec.ariaLabel);
            if (spec.ariaLabelledBy) b.setAttribute("aria-labelledby", spec.ariaLabelledBy);
            if (spec.role) {
                b.setAttribute("role", spec.role);
                b.setAttribute("aria-checked", spec.checked ? "true" : "false");
            }
            b.setAttribute("data-fk", spec.id);
            b.disabled = !!spec.disabled;
            b.addEventListener("click", spec.onSelect);
            host.appendChild(b);
        });
        return { update: function (next) { renderPlainButtons(host, next); } };
    }

    /** A dialog control by key, whichever way it was drawn.
     *
     *  Markup this file owns uses an id; the shared component library sets
     *  data-tb; the no-bundle fallback sets data-fk. Focus restoration already
     *  had to look across the last two, and a plain getElementById silently
     *  stopped resolving anything the migration touched. */
    function dialogControl(key) {
        return (
            document.getElementById(key) ||
            document.querySelector('[data-tb="' + key + '"]') ||
            document.querySelector('[data-fk="' + key + '"]')
        );
    }

    function mountDialogActions(hostId, specs) {
        var mounted = null;
        function tryMount() {
            var shared = window.pikvmShared;
            var host = document.getElementById(hostId);
            if (!shared || !shared.mountButtons || !host || mounted) return !!mounted;
            mounted = shared.mountButtons(host, specs());
            return true;
        }
        if (!tryMount()) {
            var tries = 0;
            var timer = setInterval(function () {
                if (tryMount()) return clearInterval(timer);
                if (++tries <= 100) return;
                clearInterval(timer);
                var host = document.getElementById(hostId);
                if (host) mounted = renderPlainButtons(host, specs());
            }, 50);
        }
        return { update: function () { if (mounted) mounted.update(specs()); } };
    }

    (function wireMacroEditor() {
        /* The dialog's buttons are drawn by the shared component library, so a
         * dialog action looks the same here as it does in the conversation. The
         * console keeps owning what each one does; the specs only say what to
         * draw and when it is available. */
        function addStep(kind) {
            var macro = macroById(macroSelected);
            if (!macro) return;
            if (kind === "chord") macro.steps.push({ type: "chord", mods: [], code: "" });
            else if (kind === "text") macro.steps.push({ type: "text", text: "" });
            else macro.steps.push({ type: "delay", ms: 200 });
            paintMacroEditor();
        }
        function newMacro() {
            var macro = {
                id: "macro-" + Date.now().toString(36),
                label: "New macro",
                icon: "command",
                pinned: true,
                steps: [{ type: "chord", mods: [], code: "" }],
            };
            macros.push(macro);
            macroSelected = macro.id;
            // Not saved yet: a step with no key is dropped by the server's
            // validation, so it only persists once it does something.
            paintMacroEditor();
        }
        function deleteMacro() {
            var macro = macroById(macroSelected);
            if (!macro) return;
            if (!window.confirm('Delete the macro "' + macro.label + '"?')) return;
            macros = macros.filter(function (m) {
                return m.id !== macro.id;
            });
            macroSelected = macros.length ? macros[0].id : null;
            /* Deleting the LAST one takes the whole form away, and with it the
             * button that was just pressed — so focus fell to the body while the
             * dialog was still open. Measured with one macro, Delete macro
             * focused and clicked: activeElement BODY, the dialog up, and
             * nothing but the Tab trap to climb back in with.
             *
             * Every other action here already lands somewhere: removing a step
             * goes to the row that took its place, and Delete keeps its own
             * button while other macros remain. pendingMacroFocus cannot cover
             * this one because it is consumed by the step repaint, which does
             * not run when there are no steps to draw.
             *
             * New macro is where it goes, because that is what the empty state
             * left behind tells you to press. */
            var emptied = !macros.length;
            saveMacros().then(function () {
                if (!emptied) return;
                var add = dialogControl("macro-new");
                if (add && add.focus) add.focus();
            });
        }
        function stepActionSpecs() {
            return [
                { id: "add-chord", label: "Add key combo", onSelect: function () { addStep("chord"); } },
                { id: "add-text", label: "Add text", onSelect: function () { addStep("text"); } },
                { id: "add-delay", label: "Add pause", onSelect: function () { addStep("delay"); } },
                /* Destructive, and pushed away from the three above it.
                 *
                 * It sat fourth in a row reading "Add key combo, Add text, Add
                 * pause, Delete macro", styled identically to the three that
                 * add a step and immediately beside the last of them. A slip of
                 * one button width was the difference between adding a pause
                 * and destroying the macro. It does confirm, but a confirm is
                 * not a reason to lay the button out as if it were harmless. */
                { id: "macro-delete", label: "Delete macro", variant: "destructive", onSelect: deleteMacro },
            ];
        }
        function dialogActionSpecs() {
            return [
                { id: "macro-new", label: "New macro", onSelect: newMacro },
                // The one affirmative action in the row, so the one filled button.
                { id: "macro-close", label: "Done", variant: "default", onSelect: closeMacroEditor },
            ];
        }
        var macroStepActions = null;
        var macroDialogActions = null;
        function mountMacroButtons() {
            var shared = window.pikvmShared;
            if (!shared || !shared.mountButtons) return false;
            var stepHost = document.getElementById("macro-step-actions");
            var actionHost = document.getElementById("macro-dlg-actions");
            if (stepHost && !macroStepActions) macroStepActions = shared.mountButtons(stepHost, stepActionSpecs());
            if (actionHost && !macroDialogActions) macroDialogActions = shared.mountButtons(actionHost, dialogActionSpecs());
            return !!(macroStepActions && macroDialogActions);
        }
        if (!mountMacroButtons()) {
            var tries = 0;
            var timer = setInterval(function () {
                if (mountMacroButtons() || ++tries > 100) clearInterval(timer);
            }, 50);
        }
        var labelInput = document.getElementById("macro-label");
        if (labelInput) {
            labelInput.addEventListener("change", function () {
                var macro = macroById(macroSelected);
                if (!macro) return;
                macro.label = labelInput.value.trim() || "Macro";
                void saveMacros();
            });
        }
        var pinned = document.getElementById("macro-pinned");
        if (pinned) {
            pinned.addEventListener("change", function () {
                var macro = macroById(macroSelected);
                if (!macro) return;
                macro.pinned = pinned.checked;
                void saveMacros();
            });
        }
        if (macroDlg) {
            macroDlg.addEventListener("mousedown", function (e) {
                if (e.target === macroDlg) closeMacroEditor();
            });
            macroDlg.addEventListener("keydown", function (e) {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    closeMacroEditor();
                }
            });
        }
        void loadMacros();
    })();

    /* ----------------------------------------------------------------- *
     * Pi log (kvmd api/log)
     * ----------------------------------------------------------------- */

    var logDlg = document.getElementById("log-dlg");

    /* Measured against this Pi: an hour is 2MB over ~4s, a day 18MB over ~27s,
     * and everything 54MB over ~58s. A static "loading…" for a minute is
     * indistinguishable from a hang, so the body streams and reports how much
     * has arrived — and a new window or a close aborts the one in flight
     * instead of leaving tens of megabytes downloading into a closed dialog. */
    var logAbort = null;
    var logHasText = false;
    var logActions = null;
    function logActionSpecs() {
        return [
            {
                id: "log-copy",
                label: "Copy",
                disabled: !logHasText,
                onSelect: function () {
                    var body = document.getElementById("log-body");
                    if (body && logHasText) copyText(body.textContent, "Log copied");
                },
            },
            { id: "log-close", label: "Done", variant: "default", onSelect: closeLogDialog },
        ];
    }
    function repaintLogActions() {
        if (logActions) logActions.update(logActionSpecs());
    }

    function loadLog() {
        var body = document.getElementById("log-body");
        var seekEl = document.getElementById("log-seek");
        if (!body) return;
        if (logAbort) logAbort.abort();
        var controller = new AbortController();
        logAbort = controller;
        var seek = seekEl ? seekEl.value : "3600";
        logHasText = false;
        repaintLogActions();
        body.textContent = "Loading…";
        // follow=0: a snapshot, not a stream. The real UI opens a following tab, which
        // never ends and is the wrong shape for a dialog opened to answer one question.
        fetch("/api/log?seek=" + encodeURIComponent(seek) + "&follow=0", { cache: "no-store", signal: controller.signal })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                if (!r.body || !r.body.getReader) return r.text();
                // Read it progressively so the wait shows movement.
                var reader = r.body.getReader();
                var chunks = [];
                var received = 0;
                var pump = function () {
                    return reader.read().then(function (res) {
                        if (res.done) {
                            var merged = new Uint8Array(received);
                            var at = 0;
                            for (var i = 0; i < chunks.length; i++) {
                                merged.set(chunks[i], at);
                                at += chunks[i].length;
                            }
                            return new TextDecoder("utf-8").decode(merged);
                        }
                        chunks.push(res.value);
                        received += res.value.length;
                        body.textContent = "Loading… " + humanBytes(received);
                        return pump();
                    });
                };
                return pump();
            })
            .then(function (t) {
                if (controller.signal.aborted) return;
                var capped = capLog(t);
                /* "Loading…", "(nothing in this window)" and the error below are
                 * all MESSAGES in the same box the log lands in. Copy used to
                 * take whichever was showing and report "Log copied", so a user
                 * who pressed it early got the word "Loading…" on their
                 * clipboard and no sign anything was wrong. */
                logHasText = !!capped;
                repaintLogActions();
                body.textContent = capped || "(nothing in this window)";
                body.scrollTop = body.scrollHeight; // newest last
            })
            .catch(function (e) {
                if (e && e.name === "AbortError") return;
                logHasText = false;
                repaintLogActions();
                body.textContent = "Could not read the log: " + (e && e.message ? e.message : "network error");
            });
    }
    /* An hour of this Pi's journal is ~7,200 lines and 1.45MB, which took 155ms
     * just to lay out — jank on every open and refresh, and "everything" is far
     * worse. Keep the newest lines, which is what anyone opening a log wants,
     * and SAY what was dropped rather than quietly truncating. */
    var LOG_MAX_LINES = 1500;
    function capLog(text) {
        if (!text) return text;
        var lines = text.split("\n");
        var dropped = lines.length - LOG_MAX_LINES;
        if (dropped <= 0) return text;
        return (
            "… " + dropped + " earlier lines not shown. Narrow the window above, " +
            "or read the full journal on the Pi.\n\n" +
            lines.slice(-LOG_MAX_LINES).join("\n")
        );
    }

    function openLogDialog() {
        if (!logDlg) return;
        closeOtherDialogs(logDlg);
        logDlg.hidden = false;
        loadLog();
    }
    function closeLogDialog() {
        // Do not leave tens of megabytes downloading into a dialog nobody is
        // looking at.
        if (logAbort) logAbort.abort();
        if (logDlg) logDlg.hidden = true;
        refocusKbd();
    }
    (function wireLogDialog() {
        mountDialogActions("log-refresh-host", function () {
            return [{ id: "log-refresh", label: "Refresh", onSelect: loadLog }];
        });
        var seek = document.getElementById("log-seek");
        if (seek) seek.addEventListener("change", loadLog);
        logActions = mountDialogActions("log-dlg-actions", logActionSpecs);
        if (logDlg) {
            logDlg.addEventListener("mousedown", function (e) {
                if (e.target === logDlg) closeLogDialog();
            });
            logDlg.addEventListener("keydown", function (e) {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    closeLogDialog();
                }
            });
        }
    })();

    /** Copy text, falling back to a hidden textarea where the async API is refused. */
    function copyText(text, okMsg) {
        var done = function () {
            toast(okMsg || "Copied");
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard
                .writeText(text)
                .then(done)
                .catch(function () {
                    legacyCopy(text, done);
                });
            return;
        }
        legacyCopy(text, done);
    }
    function legacyCopy(text, done) {
        try {
            var ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            // execCommand reports a refusal by RETURNING FALSE, not by throwing,
            // so ignoring the result meant a blocked copy still said "Copied"
            // and the user went on to paste whatever was there before. A silent
            // failure is bad; one that claims success is worse.
            var copied = document.execCommand("copy");
            ta.remove();
            if (copied) done();
            else toast("Could not copy", true);
        } catch (e) {
            toast("Could not copy", true);
        }
    }

    /* ----------------------------------------------------------------- *
     * OCR: read text off the live picture (kvmd snapshot?ocr=1)
     * ----------------------------------------------------------------- */

    /* kvmd runs tesseract over a region of the CURRENT frame and returns plain text.
     * The region is in SOURCE-frame pixels, so the drag is converted through fracAt —
     * the same mapping the pointer uses — which means it stays correct under any zoom
     * or pan. Verified available on this Pi: the `ocr` event reports enabled with the
     * eng language pack. */
    var ocrLangs = null;
    var ocrPicking = false;
    var ocrDrag = null;
    var ocrRect = null;
    var ocrHint = null;

    function ocrAvailable() {
        return !!(ocrLangs && ocrLangs.enabled);
    }
    function setOcrState(s) {
        if (!s) return;
        ocrLangs = { enabled: !!s.enabled, langs: s.langs || null };
        var btn = document.getElementById("ocr-btn");
        if (btn) btn.hidden = !ocrAvailable();
    }

    /** Is there actually a picture on screen to aim at?
     *
     *  Set when a frame has painted, and kept while a frozen one is held, so it
     *  answers "is there something to look at" rather than "is the stream live". */
    function screenHasPicture() {
        return !!(pane && pane.classList.contains("has-frame"));
    }
    function startOcrPick() {
        if (!ocrAvailable() || ocrPicking) return;
        /* The request itself would work — it carries allow_offline=1, so the Pi
         * answers from its own frame whatever the local stream is doing, the
         * same as Save screenshot. The PICKING is what does not: this asks the
         * user to drag a rectangle over the text they want, and with nothing on
         * screen they would be choosing coordinates on a picture they cannot
         * see. Screenshot needs no aiming, which is why it stays available and
         * this does not. */
        if (!screenHasPicture()) {
            toast("No picture to read from yet", true);
            return;
        }
        ocrPicking = true;
        pane.classList.add("ocr-picking");
        ocrHint = document.createElement("div");
        ocrHint.className = "ocr-hint";
        ocrHint.textContent = "Drag over the text to read  ·  Esc to cancel";
        pane.appendChild(ocrHint);
    }
    function endOcrPick() {
        ocrPicking = false;
        ocrDrag = null;
        pane.classList.remove("ocr-picking");
        if (ocrRect) {
            ocrRect.remove();
            ocrRect = null;
        }
        if (ocrHint) {
            ocrHint.remove();
            ocrHint = null;
        }
    }
    /** True while the OCR picker owns the pointer, so KVM input stays out of the way. */
    function ocrPickingNow() {
        return ocrPicking;
    }
    function ocrPointerDown(e) {
        var f = fracAt(e.clientX, e.clientY);
        if (!f) return;
        ocrDrag = { x0: e.clientX, y0: e.clientY, f0: f };
        ocrRect = document.createElement("div");
        ocrRect.className = "ocr-rect";
        pane.appendChild(ocrRect);
        ocrPointerMove(e);
    }
    function ocrPointerMove(e) {
        if (!ocrDrag || !ocrRect) return;
        var pr = pane.getBoundingClientRect();
        var x = Math.min(ocrDrag.x0, e.clientX) - pr.left;
        var y = Math.min(ocrDrag.y0, e.clientY) - pr.top;
        ocrRect.style.left = x + "px";
        ocrRect.style.top = y + "px";
        ocrRect.style.width = Math.abs(e.clientX - ocrDrag.x0) + "px";
        ocrRect.style.height = Math.abs(e.clientY - ocrDrag.y0) + "px";
    }
    function ocrPointerUp(e) {
        if (!ocrDrag) {
            endOcrPick();
            return;
        }
        var f1 = fracAt(e.clientX, e.clientY);
        var f0 = ocrDrag.f0;
        // A click rather than a drag, or a drag that ended off the picture: nothing to read.
        if (!f1 || (Math.abs(e.clientX - ocrDrag.x0) < 6 && Math.abs(e.clientY - ocrDrag.y0) < 6)) {
            endOcrPick();
            return;
        }
        var w = geomW();
        var h = geomH();
        var left = Math.round(Math.min(f0.fx, f1.fx) * w);
        var right = Math.round(Math.max(f0.fx, f1.fx) * w);
        var top = Math.round(Math.min(f0.fy, f1.fy) * h);
        var bottom = Math.round(Math.max(f0.fy, f1.fy) * h);
        endOcrPick();
        runOcr(left, top, right, bottom);
    }
    function runOcr(left, top, right, bottom) {
        var langs = ocrLangs && ocrLangs.langs && ocrLangs.langs["default"];
        var q = ["allow_offline=1", "ocr=1", "ocr_left=" + left, "ocr_top=" + top, "ocr_right=" + right, "ocr_bottom=" + bottom];
        if (langs && langs.length) q.push("ocr_langs=" + encodeURIComponent(langs.join(",")));
        // Measured at ~6s for a full screen against a real Pi, well past the
        // toast's normal dwell — so it has to stay up until the text arrives,
        // or the UI goes quiet mid-operation and reads as a failure.
        toast("Reading the screen…", false, true);
        fetch("/api/streamer/snapshot?" + q.join("&"), { cache: "no-store" })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.text();
            })
            .then(function (text) {
                var out = document.getElementById("ocr-text");
                var dlg = document.getElementById("ocr-dlg");
                hideToast();
                var found = text.replace(/\s+$/, "");
                /* The "nothing here" line is a MESSAGE, not a result. It used to
                 * go into the same box as real text, so Copy would put the
                 * sentence "(no text found in that region)" on the clipboard and
                 * report "Text copied" — which is both useless and untrue. */
                ocrHasText = found.length > 0;
                if (out) out.value = found || "(no text found in that region)";
                repaintOcrActions();
                if (dlg) {
                    closeOtherDialogs(dlg);
                    dlg.hidden = false;
                }
                if (out) out.focus();
            })
            .catch(function (e) {
                toast("Could not read the screen: " + (e && e.message ? e.message : "network error"), true);
            });
    }
    function closeOcrDialog() {
        var dlg = document.getElementById("ocr-dlg");
        if (dlg) dlg.hidden = true;
        refocusKbd();
    }
    var ocrHasText = false;
    var ocrActions = null;
    function repaintOcrActions() {
        if (ocrActions) ocrActions.update(ocrActionSpecs());
    }
    function ocrActionSpecs() {
        return [
            {
                id: "ocr-copy",
                label: "Copy",
                disabled: !ocrHasText,
                onSelect: function () {
                    var out = document.getElementById("ocr-text");
                    if (out && ocrHasText) copyText(out.value, "Text copied");
                },
            },
            { id: "ocr-close", label: "Done", variant: "default", onSelect: closeOcrDialog },
        ];
    }

    (function wireOcrDialog() {
        var dlg = document.getElementById("ocr-dlg");
        ocrActions = mountDialogActions("ocr-dlg-actions", ocrActionSpecs);
        if (dlg) {
            dlg.addEventListener("mousedown", function (e) {
                if (e.target === dlg) closeOcrDialog();
            });
            dlg.addEventListener("keydown", function (e) {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    closeOcrDialog();
                }
            });
        }
        // Esc cancels an in-progress pick, before the KVM forwarder sees the key.
        document.addEventListener(
            "keydown",
            function (e) {
                if (ocrPicking && e.key === "Escape") {
                    e.stopPropagation();
                    e.preventDefault();
                    endOcrPick();
                }
            },
            true,
        );
    })();
    /* ----------------------------------------------------------------- *
     * Mass storage (kvmd api/msd/*)
     * ----------------------------------------------------------------- */

    function humanBytes(n) {
        if (typeof n !== "number" || !isFinite(n)) return "";
        var u = ["B", "KB", "MB", "GB", "TB"];
        var i = 0;
        while (n >= 1024 && i < u.length - 1) {
            n /= 1024;
            i++;
        }
        return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + " " + u[i];
    }

    /* State from the `msd` event: {enabled, online, busy, drive, storage}. `drive` is
     * what the target sees (image, cdrom, rw, connected); `storage` is what the Pi is
     * holding (images, parts, uploading). Both are null while offline, so every read
     * goes through the guards below rather than trusting the shape. */
    var msd = (function () {
        var state = null;
        var listeners = [];
        function emit() {
            for (var i = 0; i < listeners.length; i++) listeners[i]();
        }
        return {
            setState: function (s) {
                if (!s) {
                    state = null;
                    emit();
                    return;
                }
                var next = state || { storage: {} };
                if (s.enabled !== undefined) next.enabled = s.enabled;
                if (s.online !== undefined) next.online = s.online;
                if (s.busy !== undefined) next.busy = s.busy;
                if (s.drive) next.drive = s.drive;
                if (s.storage) {
                    next.storage = next.storage || {};
                    if (s.storage.parts !== undefined) next.storage.parts = s.storage.parts;
                    if (s.storage.images !== undefined) next.storage.images = s.storage.images;
                    if (s.storage.uploading !== undefined) next.storage.uploading = s.storage.uploading;
                    if (s.storage.downloading !== undefined) next.storage.downloading = s.storage.downloading;
                }
                state = next;
                emit();
            },
            onChange: function (cb) {
                listeners.push(cb);
                cb();
            },
            /** Does this Pi have mass storage at all? */
            available: function () {
                return !!(state && state.enabled);
            },
            online: function () {
                return !!(state && state.online);
            },
            busy: function () {
                return !!(state && state.busy);
            },
            drive: function () {
                return (state && state.drive) || null;
            },
            images: function () {
                return (state && state.storage && state.storage.images) || {};
            },
            /** A transfer the PI is running, as {name, written, size}, or null.
             *
             *  setState has stored storage.downloading and storage.uploading
             *  since it was written and nothing ever read them, so a remote
             *  download showed an indeterminate bar and "the Pi is downloading
             *  it…" for its whole length — which for a multi-gigabyte ISO over
             *  a slow link is minutes of a UI that cannot say whether it is
             *  nearly done or barely started. startMsdUpload's own comment
             *  says progress "comes back on the msd event"; this is the half
             *  that was missing.
             *
             *  Shapes are read defensively rather than pinned to one guess.
             *  Anything without two usable numbers returns null and the caller
             *  keeps the indeterminate bar, so the worst case is exactly what
             *  happens today. */
            transfer: function () {
                var st = state && state.storage;
                var t = (st && (st.downloading || st.uploading)) || null;
                if (!t || typeof t !== "object") return null;
                var done = typeof t.written === "number" ? t.written : typeof t.current === "number" ? t.current : null;
                var total = typeof t.size === "number" ? t.size : typeof t.total === "number" ? t.total : null;
                if (done === null || typeof total !== "number" || total <= 0) return null;
                return { name: typeof t.name === "string" ? t.name : "", written: done, size: total };
            },
            /** Free bytes on the default storage part, or null. */
            free: function () {
                var parts = state && state.storage && state.storage.parts;
                if (!parts) return null;
                var names = Object.keys(parts);
                if (!names.length) return null;
                var p = parts[""] !== undefined ? parts[""] : parts[names[0]];
                return p && typeof p.free === "number" ? p.free : null;
            },
            /** A plain sentence for the top of the dialog. */
            summary: function () {
                /* Not knowing yet and knowing there is none are different
                 * answers, and this said the second for both. The dialog can be
                 * opened before the first msd event lands, and it then told the
                 * user their PiKVM has no mass storage — a definite claim built
                 * from an absence of data, about hardware they may well have. */
                if (!state) return "Checking the drive…";
                if (!state.enabled) return "This PiKVM has no mass storage.";
                if (!state.online) return "The drive is offline.";
                var d = state.drive;
                var what;
                if (!d) {
                    what = "The drive is idle.";
                } else if (d.connected) {
                    what = "Mounted on the target: " + (d.image ? d.image.name : "(no image)") + " as " + (d.cdrom ? "a CD/DVD" : "a flash drive") + (d.rw ? ", writable" : ", read-only") + ".";
                } else if (d.image) {
                    what = "Ready to mount " + d.image.name + " (" + humanBytes(d.image.size) + ").";
                } else {
                    what = "No image selected.";
                }
                /* And say when the drive is working, because that is the one
                 * state the sentence did not cover and the only one that leaves
                 * every control dead with no reason on screen.
                 *
                 * kvmd sets busy while it mounts, unmounts or resets — the USB
                 * gadget takes a moment, longer on a drive that is misbehaving —
                 * and paintMsd correctly greys the whole form for the duration.
                 * The note meanwhile still read "Ready to mount ubuntu.iso",
                 * which is a form claiming to be ready and refusing to act.
                 *
                 * Appended rather than replacing what: which image is mounted is
                 * still the useful part, and the state does not say WHICH
                 * operation is running, so the wording does not guess. Each GPIO
                 * row already carries its own "busy" for exactly this reason. */
                if (state.busy) return what + " The drive is busy, so nothing can be changed just now.";
                return what;
            },
            setParam: function (name, value) {
                return fetch("/api/msd/set_params?" + encodeURIComponent(name) + "=" + encodeURIComponent(value), { method: "POST", cache: "no-store" })
                    .then(function (r) {
                        if (!r.ok) toast("Could not set the drive " + name + " (" + r.status + ")", true);
                        return r.ok;
                    })
                    /* The catch its neighbour below already had.
                     *
                     * An HTTP error toasted and resolved, so the caller's
                     * .then(paintMsd) still ran and the control snapped back to
                     * the drive's real setting. A NETWORK error did neither: the
                     * promise rejected, nothing was said, and the select was
                     * left showing the value that never arrived. Change the mode
                     * with the Pi unreachable and the dialog read CD/DVD while
                     * the drive stayed a flash drive, silently — and which of
                     * the two it is decides what the target boots.
                     *
                     * Resolving false rather than rethrowing is what lets the
                     * repaint run, which is the half that corrects the control. */
                    .catch(function (e) {
                        toast("Mass storage: " + (e && e.message ? e.message : "network error"), true);
                        return false;
                    });
            },
            setConnected: function (on) {
                return fetch("/api/msd/set_connected?connected=" + (on ? 1 : 0), { method: "POST", cache: "no-store" })
                    .then(function (r) {
                        /* Present tense, because that is what a 200 means here.
                         *
                         * kvmd accepting the request is not the drive being
                         * connected — the msd event confirms that separately,
                         * and the dialog already says so in full once it
                         * arrives. Claiming "Mounted on the target" at the
                         * moment the request returned put a success toast on
                         * screen beside a dialog still reading "Ready to mount"
                         * with the Mount button still offered: two things
                         * contradicting each other at once, and the toast was
                         * the one that could be wrong.
                         *
                         * This file already words the other in-flight actions
                         * this way — "the Pi is downloading it…", "Reading the
                         * screen…", and ATX saying "sent" rather than claiming
                         * the machine powered off. */
                        toast(
                            r.ok
                                ? on
                                    ? "Mounting on the target…"
                                    : "Unmounting…"
                                : "Could not " + (on ? "mount" : "unmount") + " (" + r.status + ")",
                            !r.ok,
                        );
                    })
                    .catch(function (e) {
                        toast("Mass storage: " + (e && e.message ? e.message : "network error"), true);
                    });
            },
        };
    })();

    /* ----------------------------------------------------------------- *
     * Health: why is this not working?
     * ----------------------------------------------------------------- */

    /* The stock UI scatters ten separate LEDs across its navbar. Most of the time all
     * of them are green and none of them are worth the space, so we collapse them into
     * one indicator that is INVISIBLE while everything is fine and names the actual
     * problem when it is not. Sources: the `info` event (Pi throttling + fan), the
     * `streamer` event (is there a video signal) and the `hid` event (is the USB
     * keyboard/mouse actually attached to the target). */
    var health = (function () {
        var info = null;
        var source = null;
        var hidState = null;
        var listeners = [];
        function changed() {
            for (var i = 0; i < listeners.length; i++) listeners[i]();
        }
        /** A throttling flag counts as a problem now, or recently unless kvmd says to
         *  ignore the past. "Past" is downgraded to a warning, matching the real UI. */
        function flag(flags, name, ignorePast) {
            var f = flags && flags[name];
            if (!f) return null;
            if (f.now) return "now";
            if (f.past && !ignorePast) return "past";
            return null;
        }
        return {
            setInfo: function (s) {
                if (!s) return;
                info = info || {};
                if (s.health !== undefined) info.health = s.health;
                if (s.fan !== undefined) info.fan = s.fan;
                if (s.system !== undefined) info.system = s.system;
                if (s.node !== undefined) info.node = s.node;
                changed();
            },
            setSource: function (s) {
                source = s || null;
                changed();
            },
            setHid: function (s) {
                if (!s) return;
                hidState = hidState || {};
                if (s.online !== undefined) hidState.online = s.online;
                if (s.connected !== undefined) hidState.connected = s.connected;
                /* busy arrives in every hid event and used to be dropped here,
                 * so nothing downstream could act on it. MSD, ATX and GPIO all
                 * thread their own busy through; this was the one that did not,
                 * which is why the keyboard/mouse row said "attached" and
                 * offered to detach while the Pi was mid-reset. */
                if (s.busy !== undefined) hidState.busy = s.busy;
                changed();
            },
            onChange: function (cb) {
                listeners.push(cb);
                cb();
            },
            /** kvmd's reported versions/hostname, for the About block. */
            info: function () {
                return info;
            },
            /** Is the USB HID attached? null when the Pi doesn't say. */
            hidConnected: function () {
                return hidState && hidState.connected !== undefined ? hidState.connected : null;
            },
            /** Is the Pi's HID gadget up? Some boards report this while leaving
             *  `connected` null, which is the only signal they give. */
            hidOnline: function () {
                return hidState && hidState.online !== undefined ? hidState.online : null;
            },
            /** Is the Pi working on the HID right now (a reset, an attach)? */
            hidBusy: function () {
                return !!(hidState && hidState.busy);
            },
            /** Has the Pi told us ANYTHING yet?
             *
             *  An empty problem list means two different things and the dialog
             *  read them as one: nothing is wrong, or nothing is known. All
             *  three of these start null and only an event fills them. */
            reported: function () {
                return !!(info || source || hidState);
            },
            /**
             * Everything currently wrong, worst first. Each is {level, text} where
             * level is "error" or "warn" — an empty list means there is nothing to say.
             */
            problems: function () {
                var out = [];
                if (source && source.online === false) {
                    out.push({ level: "error", text: "No video signal from the target" });
                }
                if (hidState && hidState.connected === false) {
                    out.push({ level: "error", text: "Keyboard and mouse are detached from the target" });
                } else if (hidState && hidState.online === false) {
                    out.push({ level: "error", text: "The Pi's USB keyboard/mouse is offline" });
                }
                var th = info && info.health && info.health.throttling;
                if (th && th.parsed_flags) {
                    var uv = flag(th.parsed_flags, "undervoltage", th.ignore_past);
                    if (uv) {
                        out.push({
                            level: uv === "now" ? "error" : "warn",
                            text: uv === "now" ? "The Pi is undervolted — check the power supply and cable" : "The Pi was undervolted recently",
                        });
                    }
                    var fc = flag(th.parsed_flags, "freq_capped", th.ignore_past);
                    if (fc) {
                        out.push({
                            level: fc === "now" ? "error" : "warn",
                            text: fc === "now" ? "The Pi is overheating and has been throttled" : "The Pi was throttled by heat recently",
                        });
                    }
                }
                var fan = info && info.fan;
                if (fan && fan.monitored && fan.state && fan.state.fan) {
                    if (!fan.state.fan.ok) out.push({ level: "error", text: "The Pi's fan has failed" });
                    else if (fan.state.fan.last_fail_ts >= 0) out.push({ level: "warn", text: "The Pi's fan failed earlier" });
                }
                return out;
            },
        };
    })();

    /* ----------------------------------------------------------------- *
     * GPIO (kvmd api/gpio/switch, api/gpio/pulse)
     * ----------------------------------------------------------------- */

    /* User-defined outputs: relays, the v3 USB breaker, the v4 locator LED. The model
     * describes what exists ({switch, pulse:{max_delay}, hw}), the state says whether
     * each one is on ({online, state, busy}). Verified against a live v4plus, which
     * exposes __v3_usb_breaker__ and __v4_locator__. */
    var GPIO_LABELS = {
        __v3_usb_breaker__: "USB power to the target",
        __v4_locator__: "Locator LED",
    };
    /* Channels where a stray click has a real cost. Cutting the target's USB pulls
     * the keyboard, mouse and any mounted image out from under it. */
    var GPIO_CONFIRM = { __v3_usb_breaker__: "Switch the target's USB power?\n\nThe keyboard, mouse and any mounted image disconnect." };

    function gpioLabel(name) {
        if (GPIO_LABELS[name]) return GPIO_LABELS[name];
        // kvmd wraps its built-ins in double underscores; a user channel is plain.
        return name.replace(/^__|__$/g, "").replace(/_/g, " ");
    }

    var gpio = (function () {
        var model = null;
        var state = null;
        var listeners = [];
        return {
            setState: function (s) {
                if (!s) return;
                if (s.model !== undefined) model = s.model;
                if (s.state !== undefined) state = s.state;
                for (var i = 0; i < listeners.length; i++) listeners[i]();
            },
            onChange: function (cb) {
                listeners.push(cb);
                cb();
            },
            /** Output channels, or an empty list when this Pi has none wired. */
            outputs: function () {
                var scheme = model && model.scheme && model.scheme.outputs;
                if (!scheme) return [];
                return Object.keys(scheme).map(function (name) {
                    var st = (state && state.outputs && state.outputs[name]) || {};
                    return {
                        name: name,
                        label: gpioLabel(name),
                        canSwitch: !!scheme[name].switch,
                        canPulse: !!(scheme[name].pulse && scheme[name].pulse.max_delay > 0),
                        online: st.online !== false,
                        on: !!st.state,
                        busy: !!st.busy,
                    };
                });
            },
            switchTo: function (name, on) {
                return fetch("/api/gpio/switch?channel=" + encodeURIComponent(name) + "&state=" + (on ? 1 : 0), { method: "POST", cache: "no-store" })
                    .then(function (r) {
                        if (!r.ok) toast("Could not switch " + gpioLabel(name) + " (" + r.status + ")", true);
                    })
                    .catch(function (e) {
                        toast("GPIO: " + (e && e.message ? e.message : "network error"), true);
                    });
            },
            pulse: function (name) {
                return fetch("/api/gpio/pulse?channel=" + encodeURIComponent(name), { method: "POST", cache: "no-store" })
                    .then(function (r) {
                        if (!r.ok) toast("Could not pulse " + gpioLabel(name) + " (" + r.status + ")", true);
                    })
                    .catch(function (e) {
                        toast("GPIO: " + (e && e.message ? e.message : "network error"), true);
                    });
            },
        };
    })();

    /* ----------------------------------------------------------------- *
     * HID recovery (kvmd api/hid/set_connected, api/hid/reset)
     * ----------------------------------------------------------------- */

    /** Attach or detach the emulated USB keyboard/mouse from the target. Detaching is
     *  how you make the target forget the Pi is there; attaching is how you get back a
     *  HID the target stopped talking to. */
    function setHidConnected(on) {
        return fetch("/api/hid/set_connected?connected=" + (on ? 1 : 0), { method: "POST", cache: "no-store" })
            .then(function (r) {
                /* Present tense, for the same reason the mount toast is.
                 *
                 * A 200 is kvmd taking the request; the hid event reports what
                 * actually happened. Claiming "detached" on the response put
                 * that toast on screen beside a row still reading "attached"
                 * and a button still offering to Detach. */
                toast(
                    r.ok
                        ? on
                            ? "Attaching the keyboard and mouse…"
                            : "Detaching the keyboard and mouse…"
                        : "Could not " + (on ? "attach" : "detach") + " the keyboard and mouse (" + r.status + ")",
                    !r.ok,
                );
            })
            .catch(function (e) {
                toast("Could not " + (on ? "attach" : "detach") + " the keyboard and mouse: " + (e && e.message ? e.message : "network error"), true);
            });
    }

    /** Reset the Pi's HID stack — the fix for a keyboard the target has stopped
     *  responding to, without reaching for SSH. */
    function resetHid() {
        if (!window.confirm("Reset the keyboard and mouse?\n\nThe target briefly sees the USB device disappear and come back.")) return;
        fetch("/api/hid/reset", { method: "POST", cache: "no-store" })
            .then(function (r) {
                toast(r.ok ? "Keyboard and mouse reset" : "Could not reset the keyboard and mouse (" + r.status + ")", !r.ok);
            })
            .catch(function (e) {
                toast("Could not reset the keyboard and mouse: " + (e && e.message ? e.message : "network error"), true);
            });
    }

    var msdDlg = document.getElementById("msd-dlg");
    var msdUpload = null; // the in-flight XMLHttpRequest, or null
    /* Whether that upload is the Pi fetching a URL rather than us sending a
     * file. A local one measures itself from xhr.upload.onprogress; only a
     * remote one has to take its numbers from the Pi's own state, and mixing
     * the two would have them fighting over the same bar. */
    var msdUploadRemote = false;

    /* True while the user has this control open, and not to be written to.
     *
     * A native <select> closes its dropdown the moment anything rewrites it —
     * setting .value, replacing its options, or toggling .disabled all shut the
     * list under the pointer. kvmd pushes streamer and MSD state continuously
     * and unprompted, so a dialog that repaints on every event kept closing its
     * own dropdown while the user was reading it. Skip the control while it has
     * focus and repaint once it lets go, so nothing ends up stale either. */
    function controlBusy(el, repaint) {
        if (!el) return false;
        /* Focus is not the same thing as the dropdown being open.
         *
         * This skipped the control whenever it merely HELD focus, and a dialog
         * gives its first control focus as it opens — so the MSD image picker
         * was frozen from the moment the dialog appeared, before the user had
         * touched anything. Open Mass storage, then finish an upload:
         *
         *     dialog open, storage empty : focus=msd-image, "no images uploaded"
         *     two images arrive          : focus=msd-image, "no images uploaded"
         *     2.5s later                 : focus=msd-image, "no images uploaded"
         *     after focus moves off      : 3 options, "— select an image —"
         *
         * The list never caught up while the picker sat there focused, and
         * nothing on screen said the way out was to click somewhere else. Same
         * for anything else tabbed to and left alone — the stream dialog's
         * resolution select and its sliders go through here too.
         *
         * A press is what can open a dropdown or start a drag, so that is what
         * marks the control as engaged; focus alone never opens anything. Keys
         * count because Alt+Down opens the list and the arrows work a slider.
         * Cleared on blur, which is also when the catch-up repaint runs. */
        if (el.getAttribute("data-busy-wired") !== "1") {
            el.setAttribute("data-busy-wired", "1");
            var engage = function () {
                el.setAttribute("data-engaged", "1");
            };
            el.addEventListener("pointerdown", engage);
            el.addEventListener("keydown", engage);
            el.addEventListener("blur", function () {
                el.removeAttribute("data-engaged");
            });
        }
        if (document.activeElement !== el || el.getAttribute("data-engaged") !== "1") return false;
        if (el.getAttribute("data-catchup") !== "1") {
            el.setAttribute("data-catchup", "1");
            el.addEventListener(
                "blur",
                function () {
                    el.removeAttribute("data-catchup");
                    repaint();
                },
                { once: true },
            );
        }
        return true;
    }

    function paintMsd() {
        if (!msdDlg || msdDlg.hidden) return;
        /* Nothing below this works without the hardware.
         *
         * The dialog said "This PiKVM has no mass storage." and then drew the
         * whole form under it — image, mode, writable, mount, delete, upload,
         * image URL — greyed out, 438px of controls for a device that is not
         * fitted. The stream dialog next door already answers this exact
         * question the other way: when the Pi reports nothing adjustable it
         * collapses to the one sentence, which is why it has sp-empty.
         *
         * available() is false before the first msd event too, and the note
         * says "Checking the drive…" then rather than claiming there is none,
         * so an unknown drive reads as unknown rather than as absent. */
        var have = msd.available();
        setProp(document.getElementById("msd-form"), "hidden", !have);
        var online = msd.online();
        var busy = msd.busy();
        var d = msd.drive() || {};
        var connected = !!d.connected;
        // While the drive is connected the target owns it — kvmd rejects any change,
        // so the controls that would make one are disabled rather than left to fail.
        var settable = online && !connected && !busy && !msdUpload;

        var status = document.getElementById("msd-status");
        setText(status, msd.summary());

        var sel = document.getElementById("msd-image");
        if (sel && !controlBusy(sel, paintMsd)) {
            var images = msd.images();
            var names = Object.keys(images).sort(function (a, b) {
                return (images[b].mod_ts || 0) - (images[a].mod_ts || 0);
            });
            var key = names.join(",");
            if (sel.getAttribute("data-set") !== key) {
                sel.setAttribute("data-set", key);
                sel.innerHTML = "";
                var none = document.createElement("option");
                none.value = "";
                none.textContent = names.length ? "— select an image —" : "no images uploaded";
                sel.appendChild(none);
                for (var i = 0; i < names.length; i++) {
                    var o = document.createElement("option");
                    o.value = names[i];
                    o.textContent = names[i] + "  (" + humanBytes(images[names[i]].size) + ")";
                    sel.appendChild(o);
                }
            }
            sel.value = d.image && d.image.in_storage ? d.image.name : "";
            sel.disabled = !settable;
        }

        var mode = document.getElementById("msd-mode");
        if (mode && !controlBusy(mode, paintMsd)) {
            mode.value = d.cdrom ? "1" : "0";
            mode.disabled = !settable;
        }
        var rw = document.getElementById("msd-rw");
        if (rw) {
            rw.checked = !!d.rw;
            // A CD/DVD is read-only by definition, so the toggle only applies to flash.
            rw.disabled = !settable || !!d.cdrom;
        }

        var file = document.getElementById("msd-file");
        var url = document.getElementById("msd-url");
        if (file) file.disabled = !settable;
        if (url) url.disabled = !settable;

        /* The dialog's own buttons are drawn from state rather than poked at
         * directly, so mounting them through the shared component library is a
         * matter of writing the flags down here and repainting. */
        msdBody.connected = connected;
        msdBody.canConnect = !!(online && d.image && !connected && !busy);
        msdBody.canDisconnect = !!(online && connected && !busy);
        msdBody.canRemove = !!(settable && d.image && d.image.removable);
        msdBody.uploading = !!msdUpload;
        msdBody.canUpload = !!(settable && ((file && file.files && file.files.length) || (url && url.value.trim())));
        repaintMsdBody();
        msdResetEnabled = online && !busy && !msdUpload;
        msdAvailable = have;
        repaintMsdActions();

        var free = document.getElementById("msd-free");
        if (free) {
            var f = msd.free();
            setText(free, f === null ? "" : humanBytes(f) + " free");
        }

        /* A remote download's progress belongs to the Pi, so it arrives here on
         * the msd event rather than from an XHR we can measure. Only while OUR
         * remote upload is in flight: a local one is measuring itself and a
         * transfer started by another client is not this dialog's bar to move.
         * No usable numbers leaves the indeterminate bar exactly as it was. */
        if (msdUpload && msdUploadRemote) {
            var tr = msd.transfer();
            if (tr) {
                var pct = Math.max(0, Math.min(100, Math.round((tr.written / tr.size) * 100)));
                setMsdProgress(pct, pct + "%  ·  " + humanBytes(tr.written) + " of " + humanBytes(tr.size));
            } else {
                /* Back to "working, length unknown". Leaving the last percentage
                 * standing would keep claiming a measurement we no longer have,
                 * which is the same lie a determinate bar pinned at 0 tells and
                 * the reason this one starts out indeterminate. Measured: the Pi
                 * reporting 98% and then a state with no numbers left the bar
                 * frozen at 98% for the rest of the transfer. */
                setMsdProgress(undefined, "the Pi is downloading it…");
            }
        }
    }
    msd.onChange(paintMsd);
    // The menu entry has to track availability even while the dialog is closed, so it
    // is painted separately from the dialog body (which short-circuits when hidden).
    msd.onChange(function () {
        var btn = document.getElementById("msd-btn");
        if (btn) btn.hidden = !msd.available();
    });

    /* `pct` null hides the row, a number fills the bar, and anything else shows
     * the bar with NO measurement.
     *
     * That third state is the remote download: the Pi fetches the image itself
     * and reports nothing back on the way, so there is no local number. It used
     * to be drawn as a determinate bar pinned at 0, which claims a measurement
     * the browser does not have and reads as an upload that has stalled at the
     * start. A <progress> with no value attribute is indeterminate and says
     * "working, length unknown", which is the true statement. */
    function setMsdProgress(pct, label) {
        var row = document.getElementById("msd-progress-row");
        var bar = document.getElementById("msd-progress");
        var val = document.getElementById("msd-progress-value");
        if (row) row.hidden = pct === null;
        if (bar) {
            if (typeof pct === "number") bar.value = pct;
            else if (pct !== null) bar.removeAttribute("value");
        }
        setText(val, label || "");
    }

    /* Uploads use XMLHttpRequest, not fetch: fetch still cannot report upload progress,
     * and an ISO is big enough that a bar is the difference between "working" and
     * "frozen". remove_incomplete=1 so an aborted upload does not leave a half image
     * in storage pretending to be bootable. */
    function startMsdUpload() {
        var file = document.getElementById("msd-file");
        var urlEl = document.getElementById("msd-url");
        var remote = urlEl && urlEl.value.trim();
        var picked = file && file.files && file.files[0];
        if (!picked && !remote) return;

        var xhr = new XMLHttpRequest();
        msdUpload = xhr;
        msdUploadRemote = !picked && !!remote;
        // A local upload measures itself; a remote one has nothing to measure.
        setMsdProgress(remote ? undefined : 0, remote ? "starting…" : "0%");
        paintMsd();

        var done = function (okMsg, errMsg) {
            msdUpload = null;
            msdUploadRemote = false;
            setMsdProgress(null, "");
            if (file) file.value = "";
            if (urlEl) urlEl.value = "";
            if (errMsg) toast(errMsg, true);
            else if (okMsg) toast(okMsg);
            paintMsd();
        };

        if (remote) {
            // The Pi fetches it itself; progress comes back on the msd event rather
            // than from us, so there is nothing to measure locally.
            xhr.open("POST", "/api/msd/write_remote?url=" + encodeURIComponent(remote) + "&remove_incomplete=1", true);
            setMsdProgress(undefined, "the Pi is downloading it…");
        } else {
            xhr.open("POST", "/api/msd/write?image=" + encodeURIComponent(picked.name) + "&remove_incomplete=1", true);
            xhr.upload.onprogress = function (e) {
                if (!e.lengthComputable) return;
                var pct = Math.round((e.loaded / e.total) * 100);
                setMsdProgress(pct, pct + "%  ·  " + humanBytes(e.loaded) + " of " + humanBytes(e.total));
            };
        }
        xhr.onload = function () {
            if (xhr.status === 200) done(remote ? "Image downloaded to the Pi" : "Uploaded " + picked.name, null);
            else done(null, "Upload failed (" + xhr.status + ")");
        };
        xhr.onerror = function () {
            done(null, "Upload failed: network error");
        };
        xhr.onabort = function () {
            /* A confirmation, not a failure.
             *
             * This went through the error channel, so pressing Abort answered
             * with a red toast at role=alert and aria-live=assertive, held for
             * six seconds — measured exactly that. The rule is written on toast
             * itself: errors interrupt, everything else waits its turn. An
             * abort the user just asked for is the second kind, and nothing
             * else in this file treats a deliberate cancel as a fault — closing
             * the log mid-load and escaping an OCR pick both say nothing at
             * all. This one still speaks, because an upload is long enough that
             * confirming it stopped is worth a line, but politely. */
            done("Upload aborted", null);
        };
        xhr.send(remote ? null : picked);
    }

    /* Declared BEFORE the wiring below, not after it.
     *
     * wireMsdDialog runs as it is reached, and a `var x = null` further down
     * the file executes AFTERWARDS — so declaring these below the wiring set
     * every mount handle back to null the moment control passed the line.
     * repaint then saw null and did nothing, forever: Reset drive sat
     * permanently disabled and the dialog's buttons never tracked the drive.
     * Nothing threw, which is exactly why it survived. */
    /* The dialog BODY buttons, as state rather than five elements poked at from
     * paintMsd. Mount/Unmount swap places on `connected`, Start upload/Abort on
     * `uploading` — a pair of buttons occupying one slot, which is why they are
     * hidden rather than disabled. */
    var msdBody = {
        connected: false,
        canConnect: false,
        canDisconnect: false,
        canRemove: false,
        uploading: false,
        canUpload: false,
    };
    var msdDriveActions = null;
    var msdUploadActions = null;
    var msdResetEnabled = false;
    var msdAvailable = false;
    var msdActions = null;

    (function wireMsdDialog() {
        var sel = document.getElementById("msd-image");
        if (sel) {
            sel.addEventListener("change", function () {
                msd.setParam("image", sel.value).then(paintMsd);
            });
        }
        var mode = document.getElementById("msd-mode");
        if (mode) {
            mode.addEventListener("change", function () {
                msd.setParam("cdrom", mode.value === "1" ? 1 : 0).then(paintMsd);
            });
        }
        var rw = document.getElementById("msd-rw");
        if (rw) {
            rw.addEventListener("change", function () {
                msd.setParam("rw", rw.checked ? 1 : 0).then(paintMsd);
            });
        }
        msdDriveActions = mountDialogActions("msd-drive-actions", msdDriveSpecs);
        msdUploadActions = mountDialogActions("msd-upload-actions", msdUploadSpecs);
        var file = document.getElementById("msd-file");
        if (file) file.addEventListener("change", paintMsd);
        var url = document.getElementById("msd-url");
        if (url) url.addEventListener("input", paintMsd);
        msdActions = mountDialogActions("msd-dlg-actions", msdActionSpecs);
        if (msdDlg) {
            msdDlg.addEventListener("mousedown", function (e) {
                if (e.target === msdDlg) closeMsdDialog();
            });
            msdDlg.addEventListener("keydown", function (e) {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    closeMsdDialog();
                }
            });
        }
    })();

    function openMsdDialog() {
        if (!msdDlg) return;
        closeOtherDialogs(msdDlg);
        msdDlg.hidden = false;
        paintMsd();
    }
    function msdDriveSpecs() {
        return [
            {
                id: "msd-connect",
                label: "Mount on the target",
                hidden: msdBody.connected,
                disabled: !msdBody.canConnect || msdConnectPending,
                onSelect: function () { setMsdConnected(true); },
            },
            {
                id: "msd-disconnect",
                label: "Unmount",
                hidden: !msdBody.connected,
                disabled: !msdBody.canDisconnect || msdConnectPending,
                onSelect: function () { setMsdConnected(false); },
            },
            {
                id: "msd-remove",
                label: "Delete image",
                disabled: !msdBody.canRemove,
                onSelect: removeMsdImage,
            },
        ];
    }
    function msdUploadSpecs() {
        return [
            {
                id: "msd-upload",
                label: "Start upload",
                hidden: msdBody.uploading,
                disabled: !msdBody.canUpload,
                onSelect: startMsdUpload,
            },
            {
                id: "msd-abort",
                label: "Abort",
                hidden: !msdBody.uploading,
                onSelect: function () { if (msdUpload) msdUpload.abort(); },
            },
        ];
    }
    /* Our own request in flight, on top of the Pi's busy flag.
     *
     * canConnect and canDisconnect are derived entirely from the Pi's state,
     * and that state does not arrive until the Pi has answered — so between the
     * click and the msd event every further click went straight out. Measured:
     * three rapid presses of Mount sent three set_connected requests, against a
     * GPIO pulse button next door that sent one. kvmd serialises these, so the
     * redundant ones come back as failures and the user gets error toasts for a
     * mount that is in fact working.
     *
     * Exactly the guard gpioPending already is, for the two actions here that
     * are a single unconfirmed click. Reset drive and Delete image each ask
     * first, so a stray double press cannot reach them. */
    var msdConnectPending = false;
    function setMsdConnected(on) {
        if (msdConnectPending) return;
        msdConnectPending = true;
        repaintMsdBody();
        msd.setConnected(on).then(function () {
            msdConnectPending = false;
            repaintMsdBody();
        });
    }
    /* Keep focus usable when a button replaces itself.
     *
     * These actions withdraw or disable the very control that was pressed, and
     * the browser drops focus from a control the moment it becomes disabled —
     * so focus ended on the body with the dialog still open. Measured, each
     * with the button focused first so the loss is real rather than an artefact
     * of a synthetic click:
     *
     *     Mount         -> BODY   (msd-connect disabled by the pending guard)
     *     Unmount       -> BODY   (once the Pi answered)
     *     Delete image  -> BODY   (once the Pi reported it gone)
     *
     * Mount/Unmount and Start upload/Abort are a pair of buttons occupying one
     * slot — the comment on msdBody says so, and it is why they are hidden
     * rather than disabled — so when one goes its partner is exactly where the
     * user was aiming. Anything else falls back to Done rather than to the next
     * button along: that row also holds Delete image, and landing a keyboard
     * user on a destructive action they did not choose is worse than the lost
     * focus this is fixing. */
    var MSD_PAIRS = {
        "msd-connect": "msd-disconnect",
        "msd-disconnect": "msd-connect",
        "msd-upload": "msd-abort",
        "msd-abort": "msd-upload",
    };
    function repaintMsdBody() {
        var was = document.activeElement;
        var hosts = [document.getElementById("msd-drive-actions"), document.getElementById("msd-upload-actions")];
        var owner = hosts.filter(function (h) {
            return h && h.contains(was);
        })[0];
        var key = owner && was.getAttribute ? was.getAttribute("data-tb") || was.getAttribute("data-fk") : null;
        if (msdDriveActions) msdDriveActions.update();
        if (msdUploadActions) msdUploadActions.update();
        if (!owner) return;
        var now = document.activeElement;
        // Still there and still usable: leave it alone.
        if (owner.contains(now) && !now.disabled) return;
        var partner = key && MSD_PAIRS[key] ? dialogControl(MSD_PAIRS[key]) : null;
        var next = partner && !partner.disabled && partner.getClientRects().length ? partner : dialogControl("msd-close");
        if (next && next.focus) next.focus();
    }
    function removeMsdImage() {
        var d = msd.drive();
        if (!d || !d.image) return;
        if (!window.confirm('Delete "' + d.image.name + '" from the PiKVM?\n\nThis cannot be undone.')) return;
        fetch("/api/msd/remove?image=" + encodeURIComponent(d.image.name), { method: "POST", cache: "no-store" })
            .then(function (r) {
                toast(r.ok ? "Image deleted" : "Could not delete the image (" + r.status + ")", !r.ok);
            })
            .catch(function (e) {
                toast("Could not delete the image: " + (e && e.message ? e.message : "network error"), true);
            });
    }
    function msdActionSpecs() {
        return [
            {
                id: "msd-reset",
                label: "Reset drive",
                // Resetting a drive that is not fitted is not a disabled
                // action, it is not an action. Done is left on its own.
                hidden: !msdAvailable,
                disabled: !msdResetEnabled,
                onSelect: function () {
                    if (!window.confirm("Reset the mass storage drive?\n\nAnything mounted is unmounted.")) return;
                    fetch("/api/msd/reset", { method: "POST", cache: "no-store" })
                        .then(function (r) {
                            toast(r.ok ? "Drive reset" : "Could not reset the drive (" + r.status + ")", !r.ok);
                        })
                        .catch(function (e) {
                            toast("Could not reset the drive: " + (e && e.message ? e.message : "network error"), true);
                        });
                },
            },
            { id: "msd-close", label: "Done", variant: "default", onSelect: closeMsdDialog },
        ];
    }
    function repaintMsdActions() {
        if (msdActions) msdActions.update(msdActionSpecs());
    }

    function closeMsdDialog() {
        // An upload in flight keeps running; closing the dialog is not an abort.
        if (msdDlg) msdDlg.hidden = true;
        refocusKbd();
    }

    var healthDlg = document.getElementById("health-dlg");

    function paintHealth() {
        var problems = health.problems();
        /* Input not reaching the Pi is a problem the desktop never showed.
         *
         * paintConnStatus puts " · input offline" on the connection chip, and
         * that chip lives in #bar-main — the web/mobile bar, which the desktop
         * console does not paint. Measured at 1200x760 with the HID socket
         * killed: 45 painted text nodes, not one of them mentioning it, and no
         * visible title or aria-label carrying it either. So on the desktop
         * every keystroke and click went nowhere while the window looked
         * perfectly healthy — the exact failure paintConnStatus's own comment
         * describes, still live on the surface that has no chip.
         *
         * It belongs here rather than in health.problems(): that module reports
         * what the PI says, and a socket that is not up is a fact about this
         * client. First in the list because it is the most actionable thing on
         * it, and because the titlebar's label joins them in order. */
        if (hid.everSettled() && !hid.isOpen()) {
            problems = [{ level: "error", text: "Keyboard and mouse input is not reaching the PiKVM" }].concat(problems);
        }
        var worst = problems.some(function (p) {
            return p.level === "error";
        });
        var problemTexts = problems.map(function (p) {
            return p.text;
        });
        /* One label, not a title and an aria-label that could disagree. The
         * button only appears when something is wrong and its whole job is to
         * say what, so "Health" alone was a generic word for the one control
         * that had something specific to report. Joined with a full stop rather
         * than newlines, which screen readers run together inconsistently. */
        tbState.health = {
            visible: problems.length > 0,
            error: worst,
            label: problems.length === 0 ? "Health" : "Health: " + problemTexts.join(". "),
        };
        repaintTbState();
        var list = document.getElementById("health-list");
        if (list) {
            /* Rebuilt only when the problems actually change.
             *
             * paintHealth runs on every info, hid and streamer event, and a real
             * Pi sends those constantly — so this tore down and rebuilt the list
             * several times a second whatever it contained. Same idiom the GPIO
             * rows and the image picker already use, and for the same reason:
             * a rebuild throws away anything the user was doing inside it. */
            var listKey = problems
                .map(function (p) {
                    return p.level + ":" + p.text;
                })
                .join("|");
            if (list.getAttribute("data-set") !== listKey) {
                list.setAttribute("data-set", listKey);
                list.innerHTML = "";
                for (var i = 0; i < problems.length; i++) {
                    var li = document.createElement("li");
                    li.textContent = problems[i].text;
                    if (problems[i].level === "error") li.className = "is-error";
                    list.appendChild(li);
                }
            }
        }
        var ok = document.getElementById("health-ok");
        if (ok) {
            /* An empty problem list is not the same as a clean bill of health.
             *
             * This line showed whenever nothing was wrong, and nothing is
             * "wrong" before the Pi has said a word — so the dialog opened
             * claiming "Everything looks fine." on top of a row that read
             * "state unknown", and went on claiming it right through an outage
             * with the socket dead:
             *
             *     connected, nothing reported : claimsFine=true, problems=[]
             *     socket killed               : claimsFine=true, problems=[]
             *     8s after the outage         : claimsFine=true, problems=[]
             *
             * Two different states were being reported as the good one. Say
             * which it is instead of asserting a result we do not have. */
            ok.hidden = problems.length > 0;
            setText(ok, health.reported() ? "Everything looks fine." : "Nothing reported from the PiKVM yet.");
        }

        paintGpio();
        paintAbout();

        /* This board reports connected:null and online:true — it simply does not
         * publish an attach flag. Keying the control off `connected` alone left
         * Detach permanently disabled and the row reading "state unknown", so the
         * feature was dead on the hardware it ships against. A gadget that is
         * online IS attached as far as the target is concerned, so treat it that
         * way and reserve "unknown" for boards that say nothing at all. */
        var connected = health.hidConnected();
        var online = health.hidOnline();
        var attached = connected === true || (connected === null && online === true);
        var known = connected !== null || online !== null;
        var busy = health.hidBusy();
        var stateEl = document.getElementById("health-hid-state");
        /* "busy" alongside the state rather than instead of it: which way round
         * the gadget is remains the useful half, and the word matches the one
         * each GPIO row and the mass storage note already use. */
        var word = !known ? "state unknown" : attached ? "attached" : "detached";
        setText(stateEl, busy ? word + "  ·  busy" : word);
        /* The label is the ACTION, so it says what pressing it will do rather
         * than what is currently true — and it is disabled while that is not
         * known, because a button offering to detach something that may already
         * be detached is worse than one that waits. */
        hidToggleState = { attached: !!attached, known: !!known, busy: !!busy };
        repaintHealthActions();
    }
    /* Live channel state, read by the specs at repaint. Keyed by channel so a
     * spec built once when the row was created still sees the current values. */
    var gpioLive = {};
    var gpioRows = {};
    /* The per-row status word. A channel the Pi reports as offline and one that
     * is momentarily busy both disable the row's controls, and with nothing but
     * a greyed switch on screen the two were indistinguishable — one is a fault
     * that stays, the other clears on its own. Same shape the keyboard/mouse row
     * above already uses for "state unknown". */
    var gpioNotes = {};
    /* Channels with one of OUR requests in flight.
     *
     * A row's controls are disabled by the Pi's own `busy`, which does not
     * arrive until the Pi has answered — so between the click and that event
     * every further click went straight out. Three rapid clicks on a channel
     * sent three requests:
     *
     *     gpio:pulse:channel=rack_pdu_1
     *     gpio:pulse:channel=rack_pdu_1
     *     gpio:pulse:channel=rack_pdu_1
     *
     * A pulse is a momentary contact closure, so on a relay wired to a power
     * button that is three presses of it. The switch survives on its own — all
     * three read the same stale `on` and asked for the same state — but a pulse
     * has no such luck and neither has any confirmation to slow it down.
     *
     * Per channel rather than global: two different relays are independent, and
     * blocking one because another is mid-request would be its own surprise. */
    var gpioPending = {};
    function gpioBusy(name, busy) {
        if (busy) gpioPending[name] = true;
        else delete gpioPending[name];
        var mounted = gpioRows[name];
        if (mounted) mounted.update();
    }

    /* GPIO rows are rebuilt only when the channel set changes; their live state is
     * written on every event, so a toggle reflects the Pi rather than the click. */
    function paintGpio() {
        var section = document.getElementById("gpio-section");
        var rows = document.getElementById("gpio-rows");
        if (!section || !rows) return;
        var outs = gpio.outputs();
        section.hidden = outs.length === 0;
        if (!outs.length) return;
        var key = outs
            .map(function (o) {
                return o.name;
            })
            .join(",");
        if (rows.getAttribute("data-set") !== key) {
            rows.setAttribute("data-set", key);
            rows.innerHTML = "";
            gpioRows = {};
            gpioNotes = {};
            outs.forEach(function (o) {
                var row = document.createElement("div");
                row.className = "dlg-row";
                var label = document.createElement("span");
                label.className = "dlg-label dlg-grow";
                label.textContent = o.label;
                label.id = "gpio-label-" + o.name.replace(/[^A-Za-z0-9_-]/g, "-");
                row.appendChild(label);
                var note = document.createElement("span");
                note.className = "dlg-hint";
                note.hidden = true;
                row.appendChild(note);
                gpioNotes[o.name] = note;
                var host = document.createElement("span");
                host.className = "dlg-inline-actions";
                row.appendChild(host);
                rows.appendChild(row);
                /* One mount per row, kept so the live state below repaints
                 * through it. Rebuilt only when the channel SET changes, which
                 * is why the handle is stored rather than remounted. */
                gpioRows[o.name] = mountRowButtons(host, gpioSpecsFor(o.name, label.id));
            });
        }
        gpioLive = {};
        outs.forEach(function (o) {
            gpioLive[o.name] = o;
        });
        outs.forEach(function (o) {
            var note = gpioNotes[o.name];
            if (note) {
                setText(note, !o.online ? "offline" : o.busy ? "busy" : "");
                setProp(note, "hidden", !note.textContent);
            }
            var mounted = gpioRows[o.name];
            if (mounted) mounted.update();
        });
    }
    function gpioSpecsFor(name, labelId) {
        return function () {
            var o = gpioLive[name];
            if (!o) return [];
            var specs = [];
            /* Pulse first, switch last.
             *
             * The switch is the row's STATE, and a column of states can only be
             * read down if they share an edge. With the switch first, a row that
             * also pulses pushed its On/Off inboard of every other row's, so the
             * states no longer lined up with each other. Actions then state
             * keeps the right edge straight, and tab order still matches what
             * is on screen. */
            if (o.canPulse) {
                specs.push({
                    id: "gpio-pulse-" + name,
                    label: "Pulse",
                    // Every pulse button says "Pulse", so on their own a list of
                    // them names nothing you could tell apart.
                    ariaLabel: "Pulse " + o.label,
                    disabled: o.busy || !o.online || !!gpioPending[name],
                    onSelect: function () {
                        var warn = GPIO_CONFIRM[name];
                        if (warn && !window.confirm(warn)) return;
                        gpioBusy(name, true);
                        gpio.pulse(name).then(function () {
                            gpioBusy(name, false);
                        });
                    },
                });
            }
            if (o.canSwitch) {
                specs.push({
                    id: "gpio-switch-" + name,
                    label: o.on ? "On" : "Off",
                    // A switch, not a button: the word on it is the STATE, not
                    // what it does. Named by the row's own label so the two
                    // cannot drift, and checked so the state is not carried by
                    // the fill colour alone.
                    role: "switch",
                    checked: o.on,
                    ariaLabelledBy: labelId,
                    variant: o.on ? "default" : "outline",
                    disabled: o.busy || !o.online || !!gpioPending[name],
                    onSelect: function () {
                        var cur = gpioLive[name];
                        if (!cur) return;
                        var warn = GPIO_CONFIRM[name];
                        if (warn && !window.confirm(warn)) return;
                        gpioBusy(name, true);
                        gpio.switchTo(name, !cur.on).then(function () {
                            gpioBusy(name, false);
                        });
                    },
                });
            }
            return specs;
        };
    }
    /* The same poll-and-mount as mountDialogActions, but the host is created
     * here rather than looked up by id: a GPIO row exists only once the Pi has
     * said which channels it has. */
    function mountRowButtons(host, specs) {
        var mounted = null;
        function tryMount() {
            var shared = window.pikvmShared;
            if (!shared || !shared.mountButtons || mounted) return !!mounted;
            mounted = shared.mountButtons(host, specs());
            return true;
        }
        if (!tryMount()) {
            var tries = 0;
            var timer = setInterval(function () {
                if (tryMount()) return clearInterval(timer);
                if (++tries <= 100) return;
                clearInterval(timer);
                mounted = renderPlainButtons(host, specs());
            }, 50);
        }
        return { update: function () { if (mounted) mounted.update(specs()); } };
    }

    gpio.onChange(function () {
        if (healthDlg && !healthDlg.hidden) paintGpio();
    });

    /** One line of "what is this Pi", from the info event's system/health blocks. */
    function paintAbout() {
        var el = document.getElementById("health-about");
        if (!el) return;
        var i = health.info();
        if (!i) {
            setText(el, "");
            return;
        }
        var bits = [];
        /* Written only when it changes.
         *
         * This is the line with the hostname and the kvmd and streamer versions
         * on it — the one thing in this dialog anyone selects, because it is
         * what you paste into a bug report. It was reassigned on every health
         * repaint, and paintHealth runs on every info, hid and streamer event.
         * Measured with the line selected and four unrelated hid events pushed:
         *
         *     about rewrites: 4      selection: "" (gone)
         *
         * Rewriting a text node destroys any selection inside it, so the string
         * you were half way through copying vanished the moment the Pi reported
         * anything at all. */
        if (i.node && i.node.host) bits.push(i.node.host);
        if (i.system && i.system.platform && i.system.platform.model) bits.push("PiKVM " + i.system.platform.model);
        if (i.system && i.system.kvmd && i.system.kvmd.version) bits.push("kvmd " + i.system.kvmd.version);
        if (i.system && i.system.streamer && i.system.streamer.version) bits.push((i.system.streamer.app || "streamer") + " " + i.system.streamer.version);
        if (i.health && i.health.temp && typeof i.health.temp.cpu === "number") bits.push(i.health.temp.cpu.toFixed(0) + "°C");
        if (i.fan && i.fan.monitored && i.fan.state && i.fan.state.hall && i.fan.state.hall.available) bits.push(i.fan.state.hall.rpm + " rpm");
        setText(el, bits.join("  ·  "));
    }

    health.onChange(paintHealth);

    function openHealthDialog() {
        if (!healthDlg) return;
        paintHealth();
        closeOtherDialogs(healthDlg);
        healthDlg.hidden = false;
        /* Focus Done, not whatever happens to be first.
         *
         * This looked the button up by id, and the id went away when the
         * actions moved to the shared component library — they carry data-tb,
         * and the no-bundle fallback carries data-fk. The lookup quietly
         * returned null, so the deliberate choice fell through to
         * initialFocusIn, which takes the FIRST focusable in the dialog. In
         * this one that is a GPIO switch: on a V4 the dialog opened with focus
         * on the USB power breaker, the single channel here that carries a
         * confirmation warning. Enter to dismiss a dialog is muscle memory. */
        var close = dialogControl("health-close");
        if (close) close.focus();
    }
    var hidToggleState = { attached: false, known: false };
    var hidTogglePending = false;
    var healthActions = null;
    function healthActionSpecs() {
        return [
            {
                id: "hid-toggle",
                label: hidToggleState.attached ? "Detach" : "Attach",
                /* Also while the Pi is working on it: kvmd rejects the change
                 * then anyway, and a button naming what it will do is lying
                 * while the thing it describes is already moving.
                 *
                 * And while OUR request is in flight, for the same reason the
                 * mass storage mount button and every GPIO row carry it: busy
                 * comes from the Pi and does not arrive until it has answered,
                 * so three rapid presses sent three set_connected requests. */
                disabled: !hidToggleState.known || hidToggleState.busy || hidTogglePending,
                onSelect: function () {
                    if (hidTogglePending) return;
                    // Mirror the label: whatever it says it will do, do that.
                    var isAttached =
                        health.hidConnected() === true ||
                        (health.hidConnected() === null && health.hidOnline() === true);
                    hidTogglePending = true;
                    repaintHealthActions();
                    setHidConnected(!isAttached).then(function () {
                        hidTogglePending = false;
                        repaintHealthActions();
                    });
                },
            },
            /* Reset deliberately stays live while busy, unlike its mass
             * storage counterpart. This is the recovery lever for a keyboard
             * the target has stopped answering, and gating it on a flag the Pi
             * could be stuck reporting would take away the escape hatch exactly
             * when it is wanted. Repeating a reset costs nothing, and it asks
             * for confirmation first, so a stray double press is not a hazard. */
            { id: "hid-reset", label: "Reset", onSelect: resetHid },
            { id: "health-close", label: "Done", variant: "default", onSelect: closeHealthDialog },
        ];
    }
    function repaintHealthActions() {
        if (healthActions) healthActions.update(healthActionSpecs());
    }

    function closeHealthDialog() {
        if (healthDlg) healthDlg.hidden = true;
        refocusKbd();
    }
    (function wireHealthDialog() {
        healthActions = mountDialogActions("health-dlg-actions", healthActionSpecs);
        if (healthDlg) {
            healthDlg.addEventListener("mousedown", function (e) {
                if (e.target === healthDlg) closeHealthDialog();
            });
            healthDlg.addEventListener("keydown", function (e) {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    closeHealthDialog();
                }
            });
        }
    })();

    /* ----------------------------------------------------------------- *
     * Stream settings (kvmd api/streamer/set_params)
     * ----------------------------------------------------------------- */

    /* The `streamer` event carries {features, limits, applied}. `features` says which
     * knobs this Pi actually has, `limits` gives their ranges and the resolutions it
     * can capture, `applied` is what is currently in force. We drive the controls from
     * all three rather than hardcoding ranges, so an unusual capture board still gets
     * the right sliders. */
    var streamerState = { features: null, limits: null, applied: null };

    function setStreamerState(s) {
        if (!s) return;
        if (s.features !== undefined) {
            streamerState.features = s.features;
            streamerState.limits = s.limits; // kvmd sends limits with features
        }
        if (s.applied !== undefined) streamerState.applied = s.applied;
        paintStreamDialog();
    }

    function sendStreamParam(name, value) {
        return fetch("/api/streamer/set_params?" + encodeURIComponent(name) + "=" + encodeURIComponent(value), {
            method: "POST",
            cache: "no-store",
        })
            .then(function (r) {
                if (r.ok) return;
                toast("Could not change the stream " + name.replace(/_/g, " ") + " (" + r.status + ")", true);
                revertStreamControls();
            })
            .catch(function (e) {
                toast("Could not change the stream: " + (e && e.message ? e.message : "network error"), true);
                revertStreamControls();
            });
    }
    /* Put the controls back to what the Pi actually has.
     *
     * A rejected change left the slider sitting at the value that was refused:
     * ask for 60% quality, get a 409, and the dialog went on reading 60% while
     * the Pi stayed at 80. The toast said it failed and the control said it had
     * not, and nothing corrected it — kvmd only emits a streamer event when
     * something really changes, so there was no later update to put it right.
     *
     * paintStreamDialog writes every control from streamerState.applied, and
     * skips any the user is currently holding, so this is safe to call the
     * moment the answer comes back. */
    function revertStreamControls() {
        paintStreamDialog();
    }

    var streamDlg = document.getElementById("stream-dlg");
    /* name -> [param, row id, value formatter]. One table so adding the next knob is
     * one line rather than another copy of the same wiring. */
    var STREAM_SLIDERS = [
        { el: "sp-quality", row: "sp-quality-row", param: "quality", feature: "quality", fmt: function (v) { return v + "%"; } },
        { el: "sp-fps", row: "sp-fps-row", param: "desired_fps", limit: "desired_fps", fmt: function (v) { return v === 0 ? "unlimited" : v + " fps"; } },
        { el: "sp-bitrate", row: "sp-bitrate-row", param: "h264_bitrate", feature: "h264", limit: "h264_bitrate", fmt: function (v) { return v + " kbps"; } },
        { el: "sp-gop", row: "sp-gop-row", param: "h264_gop", feature: "h264", limit: "h264_gop", fmt: String },
    ];

    /* The formatted value goes on the SLIDER as well as the label beside it.
     *
     * A range input is announced by its raw number, so "Target FPS" at 0 was
     * read out as zero — the one value where the number and the meaning
     * disagree, since 0 there means unlimited. The label beside it already said
     * so and nothing carried that across.
     *
     * One helper rather than setting it at each call site: the text is painted
     * both on open and on every drag, and a second place to remember is how the
     * slider and its label drift apart. */
    function paintSliderValue(cfg, el, val) {
        var text = cfg.fmt(Number(el.value));
        setText(val, text);
        setAttr(el, "aria-valuetext", text);
    }

    function paintStreamDialog() {
        var f = streamerState.features || {};
        var l = streamerState.limits || {};
        var a = streamerState.applied || {};
        var anything = false;

        var resRow = document.getElementById("sp-resolution-row");
        var resSel = document.getElementById("sp-resolution");
        if (resRow && resSel) {
            var hasRes = !!f.resolution && !!(l.available_resolutions && l.available_resolutions.length);
            setProp(resRow, "hidden", !hasRes);
            /* This is the one that bit: the sliders below already refuse to write
             * to the control the user is holding, but the resolution list did not,
             * so every unrelated streamer event slammed its dropdown shut. */
            if (hasRes) {
                anything = true;
                if (!controlBusy(resSel, paintStreamDialog)) {
                    var key = l.available_resolutions.join(",");
                    if (resSel.getAttribute("data-set") !== key) {
                        resSel.setAttribute("data-set", key);
                        resSel.innerHTML = "";
                        for (var i = 0; i < l.available_resolutions.length; i++) {
                            var o = document.createElement("option");
                            o.value = o.textContent = l.available_resolutions[i];
                            resSel.appendChild(o);
                        }
                    }
                    if (a.resolution) resSel.value = a.resolution;
                }
            }
        }

        for (var s = 0; s < STREAM_SLIDERS.length; s++) {
            var cfg = STREAM_SLIDERS[s];
            var row = document.getElementById(cfg.row);
            var el = document.getElementById(cfg.el);
            var val = document.getElementById(cfg.el + "-value");
            if (!row || !el) continue;
            var have = cfg.feature ? !!f[cfg.feature] : a[cfg.param] !== undefined;
            setProp(row, "hidden", !have);
            if (!have) continue;
            anything = true;
            /* Don't fight the user mid-drag. The value was already guarded, but the
             * bounds were not, and rewriting min or max moves the thumb just as
             * surely. The input handler keeps the label live while they hold it. */
            if (controlBusy(el, paintStreamDialog)) continue;
            var range = cfg.limit ? l[cfg.limit] : null;
            // String, because el.min reads back as one and a number never matches.
            if (range && typeof range.min === "number") setProp(el, "min", String(range.min));
            if (range && typeof range.max === "number") setProp(el, "max", String(range.max));
            if (a[cfg.param] !== undefined) el.value = a[cfg.param];
            paintSliderValue(cfg, el, val);
        }

        var empty = document.getElementById("sp-empty");
        setProp(empty, "hidden", anything);
    }

    /* Declared ahead of the IIFE that assigns it, not after.
     *
     * var hoists but its initialiser does not: with `var streamActions = null`
     * sitting below wireStreamDialog, the mount ran first and the assignment
     * then wiped it, so repaintStreamActions saw null forever and silently did
     * nothing. Save screenshot stayed clickable while its own request was in
     * flight — the guard still refused the extra clicks, which is the worst
     * shape of all: a live button that ignores you. */
    var streamActions = null;
    function repaintStreamActions() {
        if (streamActions) streamActions.update();
    }

    (function wireStreamDialog() {
        var resSel = document.getElementById("sp-resolution");
        if (resSel) {
            resSel.addEventListener("change", function () {
                sendStreamParam("resolution", resSel.value);
            });
        }
        STREAM_SLIDERS.forEach(function (cfg) {
            var el = document.getElementById(cfg.el);
            var val = document.getElementById(cfg.el + "-value");
            if (!el) return;
            // Live label while dragging, but only POST on release — kvmd re-encodes on
            // every change and a slider dragged across its range would hammer it.
            el.addEventListener("input", function () {
                paintSliderValue(cfg, el, val);
            });
            el.addEventListener("change", function () {
                sendStreamParam(cfg.param, Number(el.value));
            });
        });
        streamActions = mountDialogActions("stream-dlg-actions", function () {
            return [
                { id: "sp-screenshot", label: "Save screenshot", disabled: screenshotBusy, onSelect: saveScreenshot },
                {
                    id: "sp-reset",
                    label: "Reset stream",
                    onSelect: function () {
                        if (!window.confirm("Reset the stream?\n\nThe picture drops for a moment while the streamer restarts.")) return;
                        fetch("/api/streamer/reset", { method: "POST", cache: "no-store" })
                            .then(function (r) {
                                toast(r.ok ? "Stream reset" : "Could not reset the stream (" + r.status + ")", !r.ok);
                            })
                            .catch(function (e) {
                                toast("Could not reset the stream: " + (e && e.message ? e.message : "network error"), true);
                            });
                    },
                },
                { id: "sp-close", label: "Done", variant: "default", onSelect: closeStreamDialog },
            ];
        });
        if (streamDlg) {
            streamDlg.addEventListener("mousedown", function (e) {
                if (e.target === streamDlg) closeStreamDialog();
            });
            streamDlg.addEventListener("keydown", function (e) {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    closeStreamDialog();
                }
            });
        }
    })();

    function openStreamDialog() {
        if (!streamDlg) return;
        paintStreamDialog();
        closeOtherDialogs(streamDlg);
        streamDlg.hidden = false;
        var first = streamDlg.querySelector("select:not([disabled]), input, button");
        if (first) first.focus();
    }
    function closeStreamDialog() {
        if (streamDlg) streamDlg.hidden = true;
        refocusKbd();
    }


    /* One at a time.
     *
     * This is a full-resolution JPEG pulled from the streamer and handed to the
     * browser's download machinery, and nothing here was gated on the fetch in
     * flight. Three rapid clicks measured three snapshot requests, three
     * downloads and three "Screenshot saved" toasts — three files in the user's
     * downloads folder, each with its own timestamp, from one slip of the
     * finger. It is also the last single unconfirmed click in the console
     * without a guard; mount, detach and every GPIO row already have one.
     *
     * The flag lives on the function rather than only on the button because
     * there are two ways in — the stream dialog and the ⋯ menu — and only one
     * of them has a control that can be disabled. */
    var screenshotBusy = false;
    /** Pull a full-resolution JPEG straight from the streamer and save it. */
    function saveScreenshot() {
        if (screenshotBusy) return;
        screenshotBusy = true;
        repaintStreamActions();
        fetch("/api/streamer/snapshot?allow_offline=1", { cache: "no-store" })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.blob();
            })
            .then(function (blob) {
                var url = URL.createObjectURL(blob);
                var a = document.createElement("a");
                a.href = url;
                a.download = "pikvm-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jpg";
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(function () {
                    URL.revokeObjectURL(url);
                }, 10_000);
                toast("Screenshot saved");
            })
            .catch(function (e) {
                toast("Screenshot failed: " + (e && e.message ? e.message : "network error"), true);
            })
            .then(function () {
                screenshotBusy = false;
                repaintStreamActions();
            });
    }

    /* ----------------------------------------------------------------- *
     * Paste as keys (kvmd api/hid/print)
     * ----------------------------------------------------------------- */

    /* kvmd types the whole string itself using its configured keymap. That is both
     * far faster than sending it key by key over the HID socket and layout-correct,
     * because kvmd owns the Shift/AltGr decisions rather than our US/UK map. */
    var pasteDlg = document.getElementById("paste-dlg");
    var pasteText = document.getElementById("paste-text");
    var pasteKeymap = document.getElementById("paste-keymap");
    var pasteCount = document.getElementById("paste-count");
    /* Whether Paste can act, kept here rather than written onto a node: it is
     * disabled with nothing to send AND while a send is in flight, and those two
     * were previously set from three different places. */
    var pasteHasText = false;
    var pasteBusy = false;
    var pasteActions = null;
    function pasteActionSpecs() {
        return [
            { id: "paste-cancel", label: "Cancel", onSelect: closePaste },
            {
                id: "paste-send",
                label: "Paste",
                variant: "default",
                /* Also while a macro is playing. A paste and a macro are both
                 * bulk input to the same target, and overlapping them garbles
                 * both — which is the judgement ce3cd25 already made about two
                 * macros. Started a macro of "Ctrl+Alt+Delete, pause, type
                 * hello, Enter" and pasted during its pause; the target got:
                 *
                 *     CAD  INTERLEAVED  hello  Enter
                 *
                 * so on a log-in macro the pasted text lands in the field
                 * before the password does. The macro strip greys out while one
                 * runs and this did not, which made the two say different things
                 * about the same busy target. */
                disabled: !pasteHasText || pasteBusy || !!macroRunning,
                onSelect: sendPaste,
            },
        ];
    }
    function repaintPasteActions() {
        if (pasteActions) pasteActions.update(pasteActionSpecs());
    }

    function paintPasteCount() {
        if (!pasteCount || !pasteText) return;
        var n = pasteText.value.length;
        pasteCount.textContent = n ? n + (n === 1 ? " character" : " characters") : "";
        pasteBusy = false;
        pasteHasText = n > 0;
        repaintPasteActions();
    }
    function fillKeymaps() {
        if (!pasteKeymap) return;
        /* Not while the user has the list open. Now that a kvmd event can call
         * this and not just the dialog opening, it is subject to the same rule
         * as every other native select here: rebuilding one shuts its dropdown
         * under the pointer. controlBusy repaints it again on blur. */
        if (controlBusy(pasteKeymap, fillKeymaps)) return;
        var km = kvmdKeymaps || {};
        /* kvmd's `available` is a MAP of name -> details, not a list of names.
         *
         * This read it as an array, so `.length` was undefined, the guard fell
         * through to the default-only branch every time, and the select was
         * then disabled by `avail.length < 2`. Pushed a hid_keymaps event
         * carrying four keymaps and the control offered exactly one:
         *
         *     available {en-us, en-gb, de, fr} -> options ["en-us"], disabled
         *
         * So choosing the layout your target actually uses was impossible, and
         * it failed as a control that simply looked like it had nothing to
         * offer rather than as an error.
         *
         * Both shapes are accepted rather than swapping one assumption for
         * another — I could not put this against a real Pi from here, and a
         * list of names is the other reasonable thing to send. Sorted so the
         * order does not depend on how the keys happened to serialise. */
        var supplied = km.available;
        var avail = Array.isArray(supplied)
            ? supplied.slice()
            : supplied && typeof supplied === "object"
              ? Object.keys(supplied)
              : [];
        avail.sort();
        // The default is what the Pi will use, so it belongs in the list even
        // if it somehow is not among the ones it offered.
        if (km["default"] && avail.indexOf(km["default"]) < 0) avail.unshift(km["default"]);
        // Only rebuild when the set actually changed, so the user's pick survives.
        var key = avail.join(",");
        if (pasteKeymap.getAttribute("data-set") === key) return;
        pasteKeymap.setAttribute("data-set", key);
        pasteKeymap.innerHTML = "";
        for (var i = 0; i < avail.length; i++) {
            var o = document.createElement("option");
            o.value = avail[i];
            o.textContent = avail[i];
            if (avail[i] === km["default"]) o.selected = true;
            pasteKeymap.appendChild(o);
        }
        pasteKeymap.disabled = avail.length < 2;
        /* With nothing to choose, the control goes away rather than sitting
           there empty.
           A labelled select showing no value and no options reads as a broken
           control, not as "the Pi has not said yet" — and the row it lives in
           also carries the character count, so the label and the select are
           hidden rather than the row. Same call the resolution row already
           makes on boards that cannot change resolution. One option is still
           worth showing: it says which keymap the text will be typed with,
           which is information even when it is not a choice. */
        var keymapLabel = document.querySelector('label[for="paste-keymap"]');
        pasteKeymap.hidden = !avail.length;
        if (keymapLabel) keymapLabel.hidden = !avail.length;
    }
    function closePaste() {
        if (pasteDlg) pasteDlg.hidden = true;
        refocusKbd();
    }
    function openPasteDialog() {
        if (!pasteDlg || !pasteText) return;
        fillKeymaps();
        pasteText.value = "";
        paintPasteCount();
        closeOtherDialogs(pasteDlg);
        pasteDlg.hidden = false;
        pasteText.focus();
        // Prefill from the host clipboard — pasting what you just copied is the whole
        // point. Needs a secure context and permission, so a refusal is not an error:
        // the box is still there to type or Ctrl+V into.
        if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard
                .readText()
                .then(function (t) {
                    if (t && !pasteText.value) {
                        pasteText.value = t;
                        pasteText.select();
                        paintPasteCount();
                    }
                })
                .catch(function () {});
        }
    }
    function sendPaste() {
        if (!pasteText) return;
        var text = pasteText.value;
        if (!text) return;
        if (macroRunning) {
            /* Ctrl/Cmd+Enter reaches here without touching the disabled button,
             * so the guard cannot live in the spec alone. Same shape as the
             * send-keys menu route into runMacro. */
            toast(macroRunning.label + " is still running", true);
            return;
        }
        var keymap = pasteKeymap && pasteKeymap.value ? pasteKeymap.value : null;
        var q = ["limit=0"];
        if (keymap) q.push("keymap=" + encodeURIComponent(keymap));
        // 20ms between keys — kvmd's own default, and slow enough that a target under
        // load does not drop characters.
        q.push("delay=0.02");
        pasteBusy = true;
        repaintPasteActions();
        fetch("/api/hid/print?" + q.join("&"), {
            method: "POST",
            cache: "no-store",
            headers: { "Content-Type": "text/plain" },
            body: text,
        })
            .then(function (r) {
                if (r.status === 413) {
                    toast("That is too much text for one paste.", true);
                    return;
                }
                if (!r.ok) {
                    toast("Paste failed (" + r.status + ")", true);
                    return;
                }
                closePaste();
                toast("Typed " + text.length + (text.length === 1 ? " character" : " characters") + " on the target");
            })
            .catch(function (e) {
                toast("Paste failed: " + (e && e.message ? e.message : "network error"), true);
            })
            .then(function () {
                pasteBusy = false;
                repaintPasteActions();
            });
    }
    var pasteBtn = document.getElementById("paste-btn");
    if (pasteBtn) pasteBtn.addEventListener("click", openPasteDialog);
    var streamBtn = document.getElementById("stream-btn");
    if (streamBtn) streamBtn.addEventListener("click", openStreamDialog);
    var screenshotBtn = document.getElementById("screenshot-btn");
    if (screenshotBtn) screenshotBtn.addEventListener("click", saveScreenshot);
    var healthBtn = document.getElementById("health-btn");
    if (healthBtn) healthBtn.addEventListener("click", openHealthDialog);
    var msdBtn = document.getElementById("msd-btn");
    if (msdBtn) msdBtn.addEventListener("click", openMsdDialog);
    var ocrBtn = document.getElementById("ocr-btn");
    if (ocrBtn) ocrBtn.addEventListener("click", startOcrPick);
    var logBtn = document.getElementById("log-btn");
    if (logBtn) logBtn.addEventListener("click", openLogDialog);
    var macroBtn = document.getElementById("macro-btn");
    if (macroBtn) macroBtn.addEventListener("click", openMacroEditor);
    if (pasteText) pasteText.addEventListener("input", paintPasteCount);
    pasteActions = mountDialogActions("paste-dlg-actions", pasteActionSpecs);
    if (pasteDlg) {
        // Click the scrim (not the panel) to dismiss.
        pasteDlg.addEventListener("mousedown", function (e) {
            if (e.target === pasteDlg) closePaste();
        });
        // The dialog's own keys are LOCAL: Esc closes, Ctrl/Cmd+Enter sends. They must
        // not reach the KVM forwarder, which would type them on the target.
        pasteDlg.addEventListener("keydown", function (e) {
            if (e.key === "Escape") {
                e.stopPropagation();
                closePaste();
            } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.stopPropagation();
                e.preventDefault();
                sendPaste();
            }
        });
    }
    /* The real OS cursor is hidden over the live screen in favour of the
     * simulated PiKVM one. While a dialog is up the pointer is pointing at
     * buttons rather than driving the target, so hand the host cursor back and
     * drop the blob. Driven by observing the scrims' `hidden` attribute rather
     * than by wiring every open/close pair, so a dialog added later is covered
     * without anyone remembering to. */
    function syncModalCursor() {
        var open = modalOpen();
        document.documentElement.classList.toggle("modal-open", open);
        if (open && kvmCursor) kvmCursor.style.display = "none";
    }
    /* Dialogs are AUTHORED inside the screen pane (they belong to it in the
     * markup's reading order) but must not be CLIPPED to it: with the
     * conversation panel taking most of the window, that pane is a narrow strip,
     * which left dialogs cramped and put the click-to-dismiss scrim right beside
     * their content. Reparenting at runtime gets window-level modals without
     * cutting up nested markup — element references and listeners survive a
     * move, so everything wired below still works. */
    (function liftDialogsToWindowLevel() {
        document.querySelectorAll(".dlg-scrim").forEach(function (el) {
            document.body.appendChild(el);
        });
        // The general toast goes with them: most of what it reports is fired FROM
        // a dialog, so leaving it in the pane hid it behind them. The RESOLUTION
        // toast stays put — it is about the stream, and no dialog raises it.
        var toastNode = document.getElementById("toast");
        if (toastNode) document.body.appendChild(toastNode);
    })();

    /* Close any dialog that is not this one, before showing it.
     *
     * openScrim below is written as "THE dialog currently up" and returns the
     * FIRST non-hidden scrim in DOM order, and the focus trap, Escape and
     * modalOpen are all built on that being the only one. Nothing enforced it,
     * and the ⋯ menu opens a dialog without closing what is already there.
     *
     * With two up, every scrim carries the same z-index, so the one painted on
     * top is simply the later one in the DOM — while openScrim hands the focus
     * trap the EARLIER one. Opening Stream settings and then System put the
     * System dialog behind the Stream scrim, dimmed and unreachable by mouse,
     * with the keyboard trapped inside it:
     *
     *     open: ["health-dlg","stream-dlg"]  topmost: stream-dlg
     *     focus: health-dlg "Done"           after 6 tabs: still health-dlg
     *     Escape closed health-dlg and left stream-dlg up
     *
     * So you tab around a dialog you cannot see and Escape shuts the one you
     * were not looking at. There is no stacking design to preserve here — the
     * equal z-index is the proof — so the fix is to make the singular
     * assumption true rather than teach four consumers to cope with it. */
    /* Where focus should come BACK to, which is not always where it is now.
     *
     * A ⋯ menu item is display:none'd by the very click that opens the dialog,
     * and focusing a hidden element does nothing — so remembering the item and
     * restoring to it later lands on the body. Measured on the web layout,
     * opening each dialog from the menu and pressing Escape:
     *
     *     msd -> BODY    stream -> BODY    log -> BODY
     *
     * The button that owns the menu is still there when the dialog closes, and
     * it is where the user was a moment before, so that is the anchor. The
     * desktop pops a native menu instead and never reaches this branch. */
    function focusAnchor() {
        var a = document.activeElement;
        if (!a || a === document.body) return null;
        if (a.closest && a.closest(".more-menu")) return document.getElementById("more-btn") || a;
        return a;
    }

    function closeOtherDialogs(keep) {
        /* Remember where focus was BEFORE the dialog can take it.
         *
         * The scrim observer below already tries to, but it only saves when the
         * scrim does not yet contain the active element — and its callback is a
         * microtask, so it runs AFTER the synchronous open. Dialogs that set
         * their own initial focus (health focuses Done, paste focuses the
         * textarea) had already moved it by then, the save was skipped, and
         * closing them restored nothing. Measured from a titlebar button:
         *
         *     focus before : "Fit to native resolution (1280 x 720)"
         *     Escape out   : "Fit to native resolution (1280 x 720)"   restored
         *     Done out     : "BODY"                                    lost
         *
         * Same action, two answers, depending only on whether that dialog
         * happened to focus something on open. Landing on BODY is worse than
         * losing your place, too: BODY is the state where keystrokes go to the
         * target, so the next thing typed after Done went to the remote machine.
         *
         * Here because every open path already calls this, before hidden is
         * cleared and before any focus() of its own. Only when nothing is open
         * yet — opening a second dialog must keep the focus from before the
         * FIRST, not park it on a control that is about to be hidden. */
        if (!openScrim()) focusBeforeModal = focusAnchor();
        document.querySelectorAll(".dlg-scrim").forEach(function (el) {
            if (el !== keep && !el.hidden) el.hidden = true;
        });
        /* The region pick is a modal MODE, and it was not covered by any of
         * this. Armed, it survived a dialog opening over it — its "Drag over
         * the text to read · Esc to cancel" hint left drawn behind the scrim,
         * on a screen the scrim had just put out of reach — and it owned
         * Escape, so the first press cancelled the pick nobody could see and
         * the visible dialog stayed up:
         *
         *     pick started  : picking=true,  dialogs=[]
         *     dialog on top : picking=true,  dialogs=["stream-dlg"]
         *     Escape        : picking=false, dialogs=["stream-dlg"]
         *     Escape again  : dialogs=[]
         *
         * Opening a dialog is abandoning the aim, so end it here with the rest.
         * Safe from the OCR dialog's own open: ocrPointerUp calls endOcrPick
         * before runOcr, so picking is already false by then and this is a
         * no-op. */
        endOcrPick();
    }

    /** The dialog currently up, or null. */
    function openScrim() {
        var scrims = document.querySelectorAll(".dlg-scrim");
        for (var i = 0; i < scrims.length; i++) if (!scrims[i].hidden) return scrims[i];
        return null;
    }
    var FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    /* Focusable AND on screen. Dialogs hide rows the board cannot do — the stream
     * dialog's resolution select, the mass-storage progress bar — and those still
     * match the selector. Focusing one silently does nothing, so anything that
     * picks "the first thing to focus" has to filter first. */
    function focusablesIn(scrim) {
        return Array.prototype.filter.call(scrim.querySelectorAll(FOCUSABLE), function (el) {
            return el.offsetParent !== null;
        });
    }

    /* Focus was free to leave a dialog: one Tab and you were back on the live
     * surface, typing at the remote machine while a dialog was still up. Keep it
     * inside, and hand it back where it came from on close. */
    var focusBeforeModal = null;
    document.addEventListener(
        "keydown",
        function (e) {
            if (e.key !== "Tab") return;
            var scrim = openScrim();
            if (!scrim) return;
            var items = focusablesIn(scrim);
            if (!items.length) return;
            var first = items[0];
            var last = items[items.length - 1];
            var active = document.activeElement;
            // Wrap at both ends, and pull focus back in if it has already escaped.
            if (!scrim.contains(active)) {
                e.preventDefault();
                (e.shiftKey ? last : first).focus();
            } else if (e.shiftKey && active === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
            }
        },
        true,
    );

    (function watchModalCursor() {
        if (typeof MutationObserver !== "function") return;
        var observer = new MutationObserver(function () {
            syncModalCursor();
            var scrim = openScrim();
            if (scrim && !scrim.contains(document.activeElement)) {
                // Remember where focus was so closing returns it, not the body.
                if (!focusBeforeModal) focusBeforeModal = focusAnchor();
                var first = initialFocusIn(scrim);
                if (first) first.focus();
            } else if (!scrim && focusBeforeModal) {
                var restore = focusBeforeModal;
                focusBeforeModal = null;
                if (restore && restore.focus && document.contains(restore)) restore.focus();
            }
        });
        document.querySelectorAll(".dlg-scrim").forEach(function (el) {
            observer.observe(el, { attributes: true, attributeFilter: ["hidden"] });
        });
        syncModalCursor();
    })();

    /** True while any modal owns the keyboard. The KVM forwarder holds off then —
     *  otherwise the dialog's own keystrokes get typed on the target as well.
     *
     *  Derived from the scrims rather than listed. The list named all seven and
     *  was correct, but it had to be remembered: an eighth dialog that nobody
     *  added here would have let every keystroke typed into it go to the remote
     *  machine as well, and nothing would have said so. openScrim already asks
     *  the DOM the same question for the focus trap, so ask it once. */
    /** Where a dialog should put focus when it opens.
     *
     *  The first focusable, EXCEPT a range input. The stream dialog's sliders
     *  post to the target on `change`, and a range fires change on the first
     *  arrow press — so opening with one focused meant a single keystroke
     *  retuned the live picture before anyone had decided to. Nothing else in
     *  these dialogs acts on a keystroke that way: a text field waits to be
     *  typed into, a select waits to be opened, a button waits to be pressed.
     *
     *  With nothing safe to take it, focus goes to the dialog itself so it is
     *  still announced and the trap still has somewhere to hold. */
    function initialFocusIn(scrim) {
        var items = focusablesIn(scrim);
        for (var i = 0; i < items.length; i++) {
            if (items[i].type !== "range") return items[i];
        }
        var dlg = scrim.querySelector(".dlg");
        if (dlg) {
            if (!dlg.hasAttribute("tabindex")) dlg.setAttribute("tabindex", "-1");
            return dlg;
        }
        return items[0] || null;
    }

    function modalOpen() {
        return !!openScrim();
    }

    function runAtxAction(id) {
        for (var i = 0; i < ATX_ACTIONS.length; i++) {
            var a = ATX_ACTIONS[i];
            if (a.id !== id) continue;
            if (!window.confirm(a.warn)) return;
            atx.click(a.id).then(function (ok) {
                if (ok) toast(a.label + " sent");
            });
            return;
        }
    }

    /* ----------------------------------------------------------------- *
     * Keyboard: armed modifiers + chord sender
     * ----------------------------------------------------------------- */

    var layout = "us";
    var armed = {}; // code -> true while a sticky modifier is armed
    var modLock = {}; // code -> true if double-tapped (stays armed)

    function clearArmed() {
        Object.keys(armed).forEach(function (m) {
            if (!modLock[m]) {
                delete armed[m];
                paintMod(m, false);
            }
        });
    }
    function armedList() {
        return Object.keys(armed);
    }
    /* ---- serialized key sender ----
     * Each chord is queued and sent to COMPLETION (modifiers + key down, a brief hold,
     * then up) before the next begins — so fast typing never interleaves modifiers
     * (which would flip a letter's case or drop it). ~13ms/key ⇒ ~75 keys/s, well above
     * any human burst, so it stays crystal-smooth AND correct. */
    /* Modifiers the user is physically holding, mirrored onto the target for as
     * long as they are down. Previously a bare modifier was never forwarded at
     * all — it was only synthesised for the few milliseconds a chord took — so
     * holding Ctrl and clicking, or Ctrl-dragging, did nothing on the target
     * because Ctrl was never actually down when the button arrived. */
    var modMirror = KeyChord.createModifierMirror(function (code, down) {
        hid.key(code, down);
    });
    function pressMod(code) {
        modMirror.press(code);
    }
    function releaseMod(code) {
        modMirror.release(code);
    }
    /** Let go of everything: focus loss, or a modal taking the keyboard. */
    function releaseAllMods() {
        modMirror.releaseAll();
    }

    var keyQ = [];
    var keyBusy = false;
    /* Callbacks waiting for the key queue to empty.
     *
     * sendChord is fire-and-forget: it queues, and drainKeys plays the chord out
     * over several timeouts. Anything that has to happen AFTER a chord — the
     * next step of a macro, say — has to wait for this rather than for
     * sendChord to return, which it does immediately. */
    var keyDrained = [];
    /* The target reads the USB HID gadget on a polling interval (5-10ms is typical).
     * A press whose down AND up both land between two polls is never seen at all — the
     * host just reads "nothing pressed" and the keystroke vanishes. The old 11ms hold
     * sat right on that boundary, which is a good part of why keys felt like they
     * landed "sometimes". 22ms spans several polls with room to spare and still allows
     * ~36 keys/s, far beyond any human burst. */
    var KEY_HOLD = 22;
    var KEY_GAP = 4;
    /* Modifiers get their own report, settled, BEFORE the key goes down. Sending both
     * in the same instant lets them coalesce into one report, and some targets (BIOS,
     * UEFI, KVM switches) then apply the key without the modifier. */
    var KEY_MOD_SETTLE = 6;
    /** Run `cb` once every queued key has been pressed AND released. */
    function afterKeys(cb) {
        if (!keyBusy && !keyQ.length) {
            setTimeout(cb, 0);
            return;
        }
        keyDrained.push(cb);
    }
    function sendChord(mods, codeName, shift) {
        if (agentActing) return;
        var m = (mods || []).slice();
        // Shift can arrive twice — once from the caller's flag, once from an armed
        // on-screen Shift. Pressing the same physical key twice leaves it stuck down
        // on the target, so fold them into one.
        if (shift && m.indexOf("ShiftLeft") < 0 && m.indexOf("ShiftRight") < 0) m.push("ShiftLeft");
        keyQ.push({ mods: m, code: codeName });
        if (keyQ.length > 600) keyQ.shift(); // never let a runaway queue grow unbounded
        if (!keyBusy) drainKeys();
    }
    function drainKeys() {
        if (!keyQ.length) {
            keyBusy = false;
            var waiting = keyDrained.splice(0, keyDrained.length);
            for (var w = 0; w < waiting.length; w++) {
                try {
                    waiting[w]();
                } catch (e) {}
            }
            return;
        }
        keyBusy = true;
        var op = keyQ.shift();
        // A modifier the user is holding is already down on the target; pressing
        // it again is harmless but RELEASING it at the end of the chord would
        // drop it while their finger is still on the key. Leave those alone.
        var owned = modMirror.owned(op.mods);
        for (var i = 0; i < owned.length; i++) hid.key(owned[i], true);
        setTimeout(
            function () {
                hid.key(op.code, true);
                setTimeout(function () {
                    hid.key(op.code, false);
                    for (var j = owned.length - 1; j >= 0; j--) hid.key(owned[j], false);
                    setTimeout(drainKeys, KEY_GAP);
                }, KEY_HOLD);
            },
            op.mods.length ? KEY_MOD_SETTLE : 0,
        );
    }
    /** A bare key (with any armed sticky modifiers). */
    function sendCode(codeName) {
        sendChord(armedList(), codeName, false);
        clearArmed();
    }
    /** A printable character (resolves to physical key + shift). */
    function sendChar(ch) {
        var k = charToKey(ch, layout);
        if (!k) return;
        sendChord(armedList(), k.code, k.shift);
        clearArmed();
    }
    function modsFromEvent(e) {
        var m = [];
        if (e.ctrlKey) m.push("ControlLeft");
        if (e.altKey) m.push("AltLeft");
        if (e.metaKey) m.push("MetaLeft");
        return m;
    }

    /* ----------------------------------------------------------------- *
     * DOM wiring
     * ----------------------------------------------------------------- */

    var app = document.getElementById("app");
    var img = document.getElementById("screen");
    var vid = document.getElementById("screen-video");
    var pane = document.getElementById("screen-pane");

    /* ---- active stream element + geometry source ----
     * The picture is either the MJPEG <img> (#screen) or the WebRTC <video>
     * (#screen-video). Both occupy the SAME box (CSS) and carry the SAME zoom/pan
     * transform, so all the input/overlay maths can read whichever is active.
     * For an <img> the intrinsic size is natural{Width,Height}; for a <video> it's
     * video{Width,Height}. `streamEl()` returns the visible one; `geomW/H()` return
     * its intrinsic content size (falling back to a 16:9 guess before first frame). */
    var webrtcActive = false; // true once a remote video track is playing
    function streamEl() {
        return webrtcActive ? vid : img;
    }
    function geomW() {
        var el = streamEl();
        return (webrtcActive ? el.videoWidth : el.naturalWidth) || 16;
    }
    function geomH() {
        var el = streamEl();
        return (webrtcActive ? el.videoHeight : el.naturalHeight) || 9;
    }
    var overlayLabel = document.getElementById("overlay-label");
    var overlaySpinner = document.getElementById("overlay-spinner");
    var conn = document.getElementById("conn");
    var connText = document.getElementById("conn-text");
    var titleText = document.getElementById("tb-title");
    var kbd = document.getElementById("kbd");
    var chatFrame = document.getElementById("chat-frame");
    var TERM_W_KEY = "pikvm-chat-workspace-width-v2";
    /* Shared with the divider's ARIA range: a keyboard user is told the same
     * bounds the drag is clamped to, and the two cannot drift apart. */
    /* Read from the stylesheet rather than repeated here: the grid enforces the
     * floor, so if these disagreed the drag would announce a width the layout
     * refused to render. The fallbacks only matter if the stylesheet has not
     * applied yet. */
    function panelBound(name, fallback) {
        var raw = "";
        try {
            raw = getComputedStyle(document.documentElement).getPropertyValue(name);
        } catch (e) {}
        var value = parseInt(raw, 10);
        return isFinite(value) && value > 0 ? value : fallback;
    }
    var PANEL_MIN_W = panelBound("--chat-min", 320);
    var PANEL_MAX_W = panelBound("--chat-max", 1100);
    var PANEL_DEFAULT_W = panelBound("--chat-default", 400);
    var PANEL_SCREEN_MIN = panelBound("--screen-min", 300);
    function panelMaxNow() {
        return panelCeiling(window.innerWidth, PANEL_SCREEN_MIN, PANEL_MIN_W, PANEL_MAX_W);
    }
    /* Storage keeps the static clamp on purpose: a width chosen on a big monitor
     * should still be there after a spell in a small window, and the grid renders
     * it correctly meanwhile. Only the live interaction clamps to the window. */
    function clampPanelWidth(w) {
        return Math.round(Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, Number(w) || PANEL_DEFAULT_W)));
    }
    function clampPanelWidthNow(w) {
        return Math.round(Math.max(PANEL_MIN_W, Math.min(panelMaxNow(), Number(w) || PANEL_DEFAULT_W)));
    }
    /* Assigned once the divider is wired. Collapsing the preview stretches the
     * conversation across the whole window, so the announced value has to be
     * refreshed on the way back out — otherwise the divider keeps reporting the
     * collapsed width, which is larger than the maximum it also reports. */
    var repaintPanelDivider = function () {};
    /* Fit-to-native needs the picture's real dimensions, which only exist once a
     * frame has arrived. Assigned by the desktop titlebar wiring; the stream state
     * machine calls it because that is what knows when a picture appears or goes. */
    var repaintFitButton = function () {};


    function readPanelWidth() {
        try {
            var raw = localStorage.getItem(TERM_W_KEY);
            return raw ? clampPanelWidth(parseInt(raw, 10)) : 0;
        } catch (e) {
            return 0;
        }
    }
    function savePanelWidth(w) {
        try {
            localStorage.setItem(TERM_W_KEY, String(clampPanelWidth(w)));
        } catch (e) {}
    }
    function applyPanelWidth(w) {
        var next = clampPanelWidth(w);
        app.style.setProperty("--chat-w", next + "px");
        return next;
    }

    /* ---- connection / stream resilience ----
     * A small state machine drives the status chip + overlay and an exponential
     * reconnect. Sources: native stream load/error + health, VNC snapshot fetches,
     * the HID socket, and page-visibility / network events. */
    var streamKey = Math.random().toString(16).slice(2) + Date.now().toString(16);
    var streamUp = false;
    var serverDown = false;
    var streamState = ""; // connecting | live | nosignal | offline | reconnecting | disconnected
    var retryMs = 800;
    var streamWatchdog = null;
    var reconnectTimer = null;
    var streamMode = "detecting"; // detecting | native | snapshot
    // When WebRTC is the live source we suspend the MJPEG pipeline entirely: blank
    // the <img> src (so the Pi's MJPEG connection is released) and stop the watchdog
    // / health-driven state changes from fighting the WebRTC status. Resumed on
    // fallback. The HID health poll keeps running regardless (input is independent).
    var mjpegPaused = false;

    var STATUS = {
        connecting: {
            tone: "",
            label: "Connecting",
        },
        live: {
            tone: "ok",
            label: "Live",
        },
        nosignal: {
            tone: "warn",
            label: "No signal",
        },
        offline: {
            tone: "bad",
            label: "Reconnecting",
        },
        reconnecting: {
            tone: "",
            label: "Reconnecting",
        },
        disconnected: {
            tone: "bad",
            label: "Screen unavailable",
        },
    };
    /* The connection chip: stream state, plus whether input can reach the target.
     *
     * "input offline" used to go only into the title attribute, so a console
     * whose HID socket had dropped showed a plain "Live" and looked perfectly
     * healthy while every keystroke and click went nowhere. A tooltip is the
     * wrong place for that: there is no hover on a phone at all, and on the
     * desktop it means resting on an 8px dot to find out why nothing works.
     *
     * The overlay pill deliberately keeps d.label on its own — that one is
     * about the picture, and the input socket is a different thing. */
    function paintConnStatus() {
        var d = STATUS[streamState] || STATUS.connecting;
        var inputNote = hid.isOpen() ? "" : " · input offline";
        conn.className = "dot " + d.tone;
        setText(connText, d.label + inputNote);
        conn.title = d.label + inputNote;
    }

    function setState(s) {
        /* Leaving "live" is the moment to hold the picture, whatever is about to
         * stop updating it — an MJPEG source restart, a stall, a WebRTC drop. Doing
         * it here rather than only in loadStream matters: loadStream returns early
         * while WebRTC owns the picture, so on a WebRTC target the freeze would
         * never have fired at all. */
        if (s !== "live" && streamState === "live") freezeFrame();
        streamState = s;
        paintConnStatus();
        var d = STATUS[s] || STATUS.connecting;
        pane.setAttribute("data-stream-state", s);
        repaintFitButton(); // a picture arriving or going changes whether it can fit
        if (s === "live") {
            pane.classList.remove("offline");
            thawFrame(); // the live source is painting again
        } else {
            pane.classList.add("offline");
            /* One line, reusing the chip's own label so a state cannot be
             * described two different ways. The spinner means "a picture is
             * still coming"; no signal is a settled answer, not a wait. */
            setText(overlayLabel, d.label);
            if (overlaySpinner) overlaySpinner.hidden = s === "nosignal";
        }
    }
    /* setStatus existed and nothing had ever subscribed to it, so the socket
     * coming or going changed nothing on screen until some unrelated stream
     * transition repainted. */
    hid.setStatus(paintConnStatus);

    /* Hold the last good frame on a canvas so re-establishing the stream does not
     * blank the picture.
     *
     * Reloading an MJPEG <img> clears it the instant src is set and the first new
     * frame is not instant, so the screen dropped to black on every reconnect —
     * jarring, and indistinguishable from the target actually going away. The
     * overlay already keeps the last frame visible for a stalled stream; this is
     * the same idea for the moment the source is deliberately restarted. */
    function freezeFrame() {
        if (!freezeCanvas || !pane.classList.contains("has-frame")) return;
        var live = webrtcActive ? vid : img;
        var w = webrtcActive ? vid.videoWidth : img.naturalWidth;
        var h = webrtcActive ? vid.videoHeight : img.naturalHeight;
        if (!w || !h) return;
        try {
            freezeCanvas.width = w;
            freezeCanvas.height = h;
            freezeCanvas.getContext("2d").drawImage(live, 0, 0, w, h);
            pane.classList.add("frozen");
        } catch (e) {
            // A source that cannot be drawn yet is not worth losing the reconnect over.
        }
    }
    function thawFrame() {
        if (freezeCanvas) pane.classList.remove("frozen");
    }

    function loadStream() {
        if (streamMode !== "native" || mjpegPaused) return; // WebRTC owns the picture; don't open an MJPEG conn
        /* While the server is known down, its verdict is the only one shown.
         *
         * Three writers describe the same "no picture, retrying" situation with
         * three different names — pollHealth sets "disconnected", this sets
         * "reconnecting", scheduleReconnect sets "offline" — and two of those
         * render the same word in different colours. None knew about the
         * others, so one unchanging outage made the overlay thrash. Recorded
         * over 24s with the streamer refusing every request:
         *
         *     1039ms disconnected  "Screen unavailable" red
         *     1273ms offline       "Reconnecting"       red
         *     3539ms disconnected  "Screen unavailable" red
         *     5756ms reconnecting  "Reconnecting"       white
         *     5772ms offline       "Reconnecting"       red     <- 16ms later
         *     6039ms disconnected  "Screen unavailable" red
         *     ...
         *
         * Nineteen changes in twenty-four seconds, alternating both the wording
         * and the colour, including one-frame white flashes — on the one
         * surface whose whole job is to explain why there is no picture. */
        if (streamState !== "live" && !serverDown) setState(streamState === "disconnected" ? "reconnecting" : streamState || "connecting");
        // Before the src is replaced, not after: setting it is what blanks the <img>.
        freezeFrame();
        img.src = streamPath(streamKey, navigator.userAgent) + "&t=" + Date.now();
        if (streamWatchdog) clearTimeout(streamWatchdog);
        streamWatchdog = setTimeout(function () {
            if (!streamUp) scheduleReconnect(); // first frame never arrived
        }, 7000);
    }
    function scheduleReconnect() {
        if (streamMode !== "native" || mjpegPaused || reconnectTimer) return;
        // Same reason as loadStream: do not talk over the health poll.
        if (streamState !== "disconnected" && !serverDown) setState("offline");
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            loadStream();
        }, retryMs);
        retryMs = Math.min(Math.round(retryMs * 1.7), 8000);
    }
    img.addEventListener("load", function () {
        if (streamMode !== "native" || mjpegPaused) return;
        streamUp = true;
        pane.classList.add("has-frame");
        thawFrame(); // a real frame is on screen again
        retryMs = 800;
        if (streamWatchdog) clearTimeout(streamWatchdog);
        if (!serverDown && !blankFrame) setState("live");
    });
    img.addEventListener("error", function () {
        if (streamMode !== "native" || mjpegPaused) return;
        streamUp = false;
        scheduleReconnect();
    });

    // Health poll: tells server-unreachable / no-signal apart from a stream hiccup,
    // and recovers the stream after the link comes back (phone reconnects, etc.).
    function pollHealth() {
        if (streamMode !== "native") return;
        var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        var to = setTimeout(function () {
            if (ctrl) ctrl.abort();
        }, 4000);
        fetch("/streamer/state", ctrl ? { signal: ctrl.signal, cache: "no-store" } : { cache: "no-store" })
            .then(function (r) {
                if (!r.ok) throw new Error("bad");
                return r.json();
            })
            .then(function (j) {
                clearTimeout(to);
                var wasDown = serverDown;
                serverDown = false;
                if (mjpegPaused) return; // WebRTC owns the status while it's live
                var online = !!(j && j.result && j.result.source && j.result.source.online);
                if (wasDown) {
                    streamKey = Math.random().toString(16).slice(2) + Date.now().toString(16);
                    loadStream();
                } else if ((!online || blankFrame) && streamUp) {
                    if (streamState !== "nosignal") setState("nosignal");
                } else if (online && streamUp && streamState !== "live") {
                    setState("live");
                }
            })
            .catch(function () {
                clearTimeout(to);
                serverDown = true;
                streamUp = false;
                if (!mjpegPaused) setState("disconnected");
            });
    }

    var snapshotTimer = null;
    var snapshotInFlight = false;
    var snapshotFailures = 0;
    var snapshotObjectUrl = null;

    function scheduleSnapshot(delay) {
        if (streamMode !== "snapshot") return;
        if (snapshotTimer) clearTimeout(snapshotTimer);
        snapshotTimer = setTimeout(function () {
            snapshotTimer = null;
            loadSnapshotFrame();
        }, Math.max(0, delay || 0));
    }

    function snapshotFailed() {
        if (streamMode !== "snapshot") return;
        snapshotFailures += 1;
        serverDown = true;
        setState(snapshotFailures >= 3 ? "disconnected" : "reconnecting");
        scheduleSnapshot(Math.min(400 * Math.pow(1.8, snapshotFailures - 1), 5000));
    }

    function presentSnapshot(blob) {
        var nextUrl = URL.createObjectURL(blob);
        var candidate = new Image();
        candidate.onload = function () {
            if (streamMode !== "snapshot") {
                snapshotInFlight = false;
                URL.revokeObjectURL(nextUrl);
                return;
            }
            var previousUrl = snapshotObjectUrl;
            snapshotObjectUrl = nextUrl;
            img.src = nextUrl;
            img.classList.remove("hidden");
            pane.classList.add("has-frame");
            streamUp = true;
            serverDown = false;
            snapshotFailures = 0;
            snapshotInFlight = false;
            setState(blankFrame ? "nosignal" : "live");
            if (previousUrl) {
                requestAnimationFrame(function () {
                    URL.revokeObjectURL(previousUrl);
                });
            }
            scheduleSnapshot(200);
        };
        candidate.onerror = function () {
            snapshotInFlight = false;
            URL.revokeObjectURL(nextUrl);
            snapshotFailed();
        };
        candidate.src = nextUrl;
    }

    function loadSnapshotFrame() {
        if (streamMode !== "snapshot" || snapshotInFlight) return;
        if (document.hidden) {
            scheduleSnapshot(500);
            return;
        }
        snapshotInFlight = true;
        var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        var timeout = setTimeout(function () {
            if (controller) controller.abort();
        }, 5000);
        fetch(
            "/api/streamer/snapshot?t=" + Date.now(),
            controller ? { signal: controller.signal, cache: "no-store" } : { cache: "no-store" },
        )
            .then(function (response) {
                if (!response.ok) throw new Error("snapshot " + response.status);
                var type = response.headers.get("content-type") || "";
                if (type.indexOf("image/") !== 0) throw new Error("snapshot was not an image");
                return response.blob();
            })
            .then(function (blob) {
                clearTimeout(timeout);
                presentSnapshot(blob);
            })
            .catch(function () {
                clearTimeout(timeout);
                snapshotInFlight = false;
                snapshotFailed();
            });
    }

    function startSnapshotScreen() {
        streamMode = "snapshot";
        mjpegPaused = true;
        vid.classList.add("hidden");
        img.classList.remove("hidden");
        if (titleText) titleText.textContent = "VNC lab";
        var fullUi = document.getElementById("full-ui");
        if (fullUi) fullUi.hidden = true;
        setState("connecting");
        loadSnapshotFrame();
    }

    function startNativeScreen() {
        streamMode = "native";
        mjpegPaused = false;
        if (titleText) titleText.textContent = "PiKVM";
        var fullUi = document.getElementById("full-ui");
        if (fullUi) fullUi.hidden = false;
        setState("connecting");
        loadStream();
        startNativeWebrtc();
    }

    function detectScreenMode() {
        var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        var timeout = setTimeout(function () {
            if (ctrl) ctrl.abort();
        }, 2500);
        fetch("/api/info", ctrl ? { signal: ctrl.signal, cache: "no-store" } : { cache: "no-store" })
            .then(function (response) {
                if (!response.ok) throw new Error("info " + response.status);
                return response.json();
            })
            .then(function (info) {
                clearTimeout(timeout);
                if (streamModeForInfo(info) === "snapshot") startSnapshotScreen();
                else startNativeScreen();
            })
            .catch(function () {
                clearTimeout(timeout);
                startNativeScreen();
            });
    }


    hid.setStatus(function () {
        // Refresh the input note without changing the stream state.
        setState(streamState || "connecting");
        // And the titlebar/health view of it, which is the desktop's only one.
        paintHealth();
    });
    hid.connect();
    setState("connecting");
    detectScreenMode();
    setInterval(pollHealth, 2500);

    /* ---- visual "no signal" detection ----
     * The streamer can report a source as online while the target is putting out a
     * completely blank picture (a solid colour / black). Sample a tiny canvas off the
     * live frame; if it stays uniform for a moment, show "No signal" anyway. */
    var blankCtx = null;
    try {
        var blankCanvas = document.createElement("canvas");
        blankCanvas.width = 40;
        blankCanvas.height = 24;
        blankCtx = blankCanvas.getContext("2d", { willReadFrequently: true });
    } catch (e) {}
    var blankSince = 0;
    var blankFrame = false;

    /* ---- background screen-change alerts (desktop only) ----
     * While the desktop window sits behind something else we keep watching the
     * remote picture: when a big enough part of it changes (a dialog opens, the
     * target reboots, a long install finishes) we ask the OS to pulse the
     * taskbar/dock icon, so you can leave the window in the background and still
     * notice. The detector reuses the same 40x24 luminance grid the blank
     * sampler already reads back, so it costs one diff over 960 cells and no
     * extra frame grab.
     *
     * That coarse grid is the whole trick for "meaningful": a moving mouse
     * pointer, a blinking caret or a clock ticking over averages away to almost
     * nothing across a cell (~48x45 source px at 1080p), while anything
     * dialog-sized moves a couple of percent of the cells at once. Measured on
     * simulated 1080p frames, share of cells over ALERT_CELL_DELTA:
     *
     *   mouse cursor moving        0.10%   caret blink        0.21%
     *   clock digits               0.21%   all of the above
     *                                      plus tray widgets  1.04%
     *   notification toast         1.67%   modal dialog       9.06%
     *   wake from a black screen   100%
     *
     * So 2% sits at about twice the worst compound idle noise. A small toast
     * lands just under it, which is the trade we want: a cue you never learn to
     * ignore beats one that catches everything. */
    var ALERTS_KEY = "pikvm-console-screen-alerts";
    var ALERT_CELL_DELTA = 10; // per-cell luminance change (0-255) that counts as movement
    var ALERT_CHANGED_FRACTION = 0.02; // share of cells that must move to be "meaningful"
    var ALERT_QUIET_MS = 20000; // the screen must settle this long before we alert again
    var screenAlertsOn = true;
    try {
        screenAlertsOn = localStorage.getItem(ALERTS_KEY) !== "off";
    } catch (e) {}
    var prevLum = null; // previous luminance grid, or null while we are not watching
    var lastMeaningfulAt = 0; // nowMs() of the last change over the threshold

    function screenAlertsAvailable() {
        return !!(window.desktopConsole && window.desktopConsole.signalScreenChange);
    }
    function screenAlertsEnabled() {
        return screenAlertsOn;
    }
    function setScreenAlerts(on) {
        screenAlertsOn = !!on;
        try {
            localStorage.setItem(ALERTS_KEY, screenAlertsOn ? "on" : "off");
        } catch (e) {}
    }
    /** Watch only when the desktop window is in the BACKGROUND — a focused window
     *  is already being looked at, and web/mobile has no taskbar to pulse. */
    function watchingForChange() {
        return screenAlertsAvailable() && screenAlertsOn && !windowFocused;
    }

    // Two grids, ping-ponged, so a sample never allocates and the previous sample
    // stays intact for the diff.
    var lumGrids = [null, null];
    var lumSlot = 0;
    function nextLumGrid(n) {
        lumSlot ^= 1;
        var g = lumGrids[lumSlot];
        if (!g || g.length !== n) g = lumGrids[lumSlot] = new Float32Array(n);
        return g;
    }

    function noteScreenSample(lum, n) {
        if (!watchingForChange()) {
            // Re-baseline (and start a fresh episode) on the first sample after we
            // start watching again, so nothing that happened while the window was
            // focused fires an alert the moment it loses focus.
            prevLum = null;
            lastMeaningfulAt = 0;
            return;
        }
        var prev = prevLum;
        prevLum = lum;
        if (!prev || prev.length !== n) return; // first sample, or the grid was resized
        var changed = 0;
        for (var i = 0; i < n; i++) {
            if (Math.abs(lum[i] - prev[i]) > ALERT_CELL_DELTA) changed++;
        }
        if (changed / n < ALERT_CHANGED_FRACTION) return;
        // One alert per episode of activity: an install churns the screen for
        // minutes and should pulse the icon once, not on every 1.5s tick.
        var now = nowMs();
        var newEpisode = !lastMeaningfulAt || now - lastMeaningfulAt >= ALERT_QUIET_MS;
        lastMeaningfulAt = now;
        if (newEpisode) window.desktopConsole.signalScreenChange();
    }

    function reevalStreamState() {
        if (mjpegPaused && !webrtcActive) return; // WebRTC owns status while live-MJPEG is suspended
        if (blankFrame && streamUp) setState("nosignal");
        else if (streamUp && !serverDown) setState("live");
    }
    function sampleBlank() {
        if (!blankCtx) return;
        // The getImageData readback is expensive — skip it entirely while the window
        // is hidden (the user isn't looking at "no signal" anyway). A minimised
        // window still gets sampled when screen-change alerts are armed: that is
        // exactly the case the alert exists for.
        if (typeof document !== "undefined" && document.hidden && !watchingForChange()) return;
        var useVid = webrtcActive && webrtcSwapped;
        if (!streamUp && !useVid) return;
        var srcEl = useVid ? vid : img;
        var w = useVid ? vid.videoWidth : img.naturalWidth;
        var h = useVid ? vid.videoHeight : img.naturalHeight;
        if (!w || !h) return;
        var uniform;
        var n = 40 * 24;
        var lum = nextLumGrid(n);
        try {
            blankCtx.drawImage(srcEl, 0, 0, 40, 24);
            var px = blankCtx.getImageData(0, 0, 40, 24).data;
            var sum = 0,
                sumsq = 0;
            for (var i = 0; i < n; i++) {
                var o = i * 4;
                var l = (px[o] + px[o + 1] + px[o + 2]) / 3;
                lum[i] = l;
                sum += l;
                sumsq += l * l;
            }
            var mean = sum / n;
            var variance = sumsq / n - mean * mean;
            uniform = variance < 6; // near-uniform: a solid colour (incl. black) = no real picture
        } catch (e) {
            return; // draw/read failed — don't guess
        }
        // Same grid, second job: has enough of the picture moved to be worth a
        // taskbar pulse while the window is in the background?
        noteScreenSample(lum, n);
        var now = nowMs();
        if (uniform) {
            if (!blankSince) blankSince = now;
            if (now - blankSince > 2500 && !blankFrame) {
                blankFrame = true;
                reevalStreamState();
            }
        } else {
            blankSince = 0;
            if (blankFrame) {
                blankFrame = false;
                reevalStreamState();
            }
        }
    }
    setInterval(sampleBlank, 1500);

    // Recover promptly when the phone wakes / regains network.
    document.addEventListener("visibilitychange", function () {
        if (!document.hidden) {
            hid.connect();
            if (streamMode === "snapshot") scheduleSnapshot(0);
            else {
                pollHealth();
                if (streamState !== "live") loadStream();
            }
        }
    });
    window.addEventListener("online", function () {
        serverDown = false;
        hid.connect();
        if (streamMode === "snapshot") scheduleSnapshot(0);
        else loadStream();
    });
    window.addEventListener("offline", function () {
        serverDown = true;
        setState("disconnected");
    });

    /* ----------------------------------------------------------------- *
     * WebRTC (Janus) video + audio + mic, with MJPEG fallback
     * ----------------------------------------------------------------- *
     * On load we try the Pi's Janus ustreamer (smooth ~60fps H.264). When a remote
     * video track starts playing we swap the visible source from the MJPEG <img> to
     * the <video> and suspend the MJPEG pipeline; if Janus is missing/unsupported or
     * the connection errors before we ever saw video, we stay on (or fall back to)
     * MJPEG. The whole block degrades to a no-op when window.JanusStream is absent. */
    var audioBtn = document.getElementById("audio-btn");
    var micBtn = document.getElementById("mic-btn");
    var audioPip = document.getElementById("audio-pip");
    var micPip = document.getElementById("mic-pip");
    var avSep = document.getElementById("av-sep");
    var resToast = document.getElementById("res-toast");
    var resToastMain = document.getElementById("res-toast-main");
    var resToastAv = document.getElementById("res-toast-av");

    function janusWsUrl() {
        return (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/janus/ws";
    }

    var isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent || "");
    var webrtcSwapped = false; // have we actually hidden the MJPEG <img> for the video?
    var gestureUnmuteArmed = false;
    var playWatchdog = null; // reverts to MJPEG if the <video> never starts playing

    // A WebRTC track arrived. Show the <video> and start it MUTED — Safari/iOS refuse
    // to autoplay an unmuted MediaStream without a user gesture (and would pause the
    // moment it gained an unmuted audio track), so the picture must never wait on
    // audio permission. We do NOT hide the MJPEG <img> here: that swap waits for the
    // <video>'s "playing" event (onVidPlaying), so the fallback stays up until frames
    // are genuinely decoding and a silent WebRTC failure never leaves a blank screen.
    function activateWebrtc() {
        if (webrtcActive) return;
        webrtcActive = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        vid.classList.remove("hidden");
        vid.classList.add("warming"); // decoding but transparent until "playing" — MJPEG shows through
        applyXform(); // make sure the video carries the current zoom/pan
        vid.muted = true; // ALWAYS muted to start (Safari autoplay); audio re-applied on play
        var p = vid.play();
        if (p && p.catch) p.catch(function () {}); // muted play() is allowed everywhere
        revealAvToggles(true);
        startMeters();
        // The visible <video> must stay rendered to actually decode (Safari won't
        // play a display:none video), so a stream that connects but never produces
        // frames would otherwise sit black over the MJPEG. Bail back to MJPEG if no
        // "playing" lands shortly.
        if (playWatchdog) clearTimeout(playWatchdog);
        playWatchdog = setTimeout(function () {
            playWatchdog = null;
            if (webrtcActive && !webrtcSwapped) fallbackToMjpeg();
        }, 6000);
    }

    // The video is really playing frames now — safe to retire the MJPEG fallback.
    function onVidPlaying() {
        if (!webrtcActive) return;
        if (!webrtcSwapped) {
            webrtcSwapped = true;
            mjpegPaused = true;
            if (playWatchdog) {
                clearTimeout(playWatchdog);
                playWatchdog = null;
            }
            if (streamWatchdog) {
                clearTimeout(streamWatchdog);
                streamWatchdog = null;
            }
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            vid.classList.remove("warming"); // confirmed playing — reveal the video
            img.classList.add("hidden");
            img.removeAttribute("src"); // release the Pi's MJPEG connection only now
            applyXform();
            setState("live");
            if (connText) connText.textContent = "Live · HD";
            fitAspect();
            showResToast();
        }
        // Honour the audio preference now it's playing. Chrome unmutes immediately;
        // Safari would pause an un-gestured unmute, so there we wait for the user's
        // next tap (they're driving a KVM — a click/keypress comes fast).
        if (audioOn && vid.muted) {
            if (isSafari) armGestureUnmute();
            else tryUnmuteVid();
        }
    }
    vid.addEventListener("playing", onVidPlaying);

    // Unmute without losing the picture: if the browser blocks it (no gesture), keep
    // the muted picture playing and unmute on the next user interaction instead.
    function tryUnmuteVid() {
        vid.muted = false;
        var p = vid.play();
        if (p && p.catch)
            p.catch(function () {
                vid.muted = true;
                var q = vid.play();
                if (q && q.catch) q.catch(function () {});
                armGestureUnmute();
            });
    }
    function armGestureUnmute() {
        if (gestureUnmuteArmed) return;
        gestureUnmuteArmed = true;
        var h = function () {
            document.removeEventListener("pointerdown", h, true);
            gestureUnmuteArmed = false;
            if (audioOn && webrtcActive && vid.muted) tryUnmuteVid();
        };
        document.addEventListener("pointerdown", h, true);
    }

    // Fall back to MJPEG: show <img>, hide <video>, resume the MJPEG pipeline.
    function fallbackToMjpeg() {
        var was = webrtcActive;
        /* Nothing to fall back FROM, so nothing to do.
         *
         * onStatus calls this on every WebRTC "error" while no video has been
         * seen, and the wrapper keeps retrying — so on any Pi without a working
         * Janus this ran every few seconds forever. Everything below is teardown
         * of a session that is not there, except the last two lines, which throw
         * away a perfectly good MJPEG connection and reopen it. Measured while
         * plainly live, with the picture never having left "live":
         *
         *     +2.4s  /streamer/stream?key=…
         *     +7.5s  /streamer/stream?key=…
         *     +12.7s /streamer/stream?key=…
         *     +17.7s /streamer/stream?key=…
         *     +22.7s /streamer/stream?key=…
         *
         * Five reopens in 25 seconds, each freezing the last frame while the
         * <img> reloads — a visible stutter every five seconds during ordinary
         * viewing, on the machines least able to spare it.
         *
         * mjpegPaused is what tells the two cases apart: WebRTC suspends the
         * MJPEG pipeline when it takes over, so a fallback that has to resume it
         * still has work even though webrtcActive never became true. Only when
         * the pipeline is already running AND there was no session is this a
         * no-op. */
        if (!was && !mjpegPaused) return;
        webrtcActive = false;
        webrtcSwapped = false;
        if (playWatchdog) {
            clearTimeout(playWatchdog);
            playWatchdog = null;
        }
        mjpegPaused = false;
        revealAvToggles(false); // the meter loop sees !webrtcActive next tick and clears
        vid.classList.add("hidden");
        vid.classList.remove("warming");
        img.classList.remove("hidden");
        try {
            if (vid.srcObject) {
                vid.srcObject.getTracks().forEach(function (t) {
                    try {
                        t.stop();
                    } catch (e) {}
                });
            }
        } catch (e) {}
        vid.srcObject = null;
        applyXform();
        if (was) setState("offline"); // brief "reconnecting" while the img reloads
        streamUp = false;
        loadStream();
    }

    function revealAvToggles(on) {
        // Audio/mic only make sense with a WebRTC session (MJPEG has no audio).
        // Reveal both the menu items (web/mobile) AND the desktop titlebar buttons.
        // We do NOT reset audioOn/micOn here: toggling audio triggers a brief Janus
        // re-watch (a transient MJPEG flash), and resetting would wipe the user's
        // choice + the indicators every time. The desired state persists and is
        // re-applied/repainted when WebRTC re-activates (see activateWebrtc).
        [audioBtn, micBtn, avSep, document.querySelector(".tb-av-sep")].forEach(function (el) {
            if (!el) return;
            if (on) el.removeAttribute("hidden");
            else el.setAttribute("hidden", "");
        });
        // Their titlebar twins are rendered, so visibility is a prop, not an attribute.
        avState.visible = !!on;
        repaintAv();
        if (on) {
            // Re-paint the indicators to the persisted desired state.
            paintToggle(audioBtn, audioPip, audioOn, false);
            paintToggle(micBtn, micPip, micOn, false);
        }
    }

    // A small toast over the top of the stream when the resolution/source changes.
    var lastResKey = "";
    var resToastTimer = null;
    var onStreamResolutionChange = function () {};
    function avSummary() {
        /* Only a WebRTC session carries audio at all.
         *
         * audioOn defaults to true and is a DESIRED state that deliberately
         * survives a WebRTC drop, so the user's choice is not wiped by every
         * re-watch. Reading it directly meant the resolution toast showed 🔊 on
         * an MJPEG stream, which has no audio to be on — and on a Pi with no
         * Janus at all that is every toast it ever shows.
         *
         * The console already draws this line: revealAvToggles hides the audio
         * and mic buttons unless WebRTC is live, so the toast was the one place
         * still claiming otherwise. Empty is a designed state here —
         * .res-toast-av:empty is display:none — so the badge simply goes away. */
        if (!webrtcActive) return "";
        var bits = [];
        if (audioOn) bits.push("🔊");
        if (micOn) bits.push("🎙");
        return bits.join(" ");
    }
    function refreshResToastAv() {
        if (resToastAv) resToastAv.textContent = avSummary();
    }
    function showResToast(force) {
        var w = geomW();
        var h = geomH();
        if (w <= 16 || h <= 9) return; // no real frame yet
        var src = webrtcActive ? "HD · WebRTC" : streamMode === "snapshot" ? "VNC" : "MJPEG";
        var key = w + "x" + h + "/" + src;
        var changed = key !== lastResKey;
        if (!force && !changed) return; // only on a real change
        lastResKey = key;
        if (changed) onStreamResolutionChange(key);
        if (!resToast) return;
        if (resToastMain) resToastMain.textContent = w + " × " + h + "  ·  " + src;
        refreshResToastAv();
        resToast.classList.add("show");
        if (resToastTimer) clearTimeout(resToastTimer);
        resToastTimer = setTimeout(function () {
            resToast.classList.remove("show");
            /* And empty it once the fade is done.
             *
             * This toast hides with opacity:0, and opacity does not take an
             * element out of the accessibility tree — so the last thing it said
             * stayed readable to a screen reader browsing the page forever
             * after, describing a toast that is not on screen. Before the first
             * frame it read out the em dash placeholder the markup used to
             * carry, which is not even a sentence.
             *
             * #toast, six lines below it in the markup, turned out to have the
             * same bug rather than being the example to copy — it is emptied
             * through the same helper now. */
            emptyWhenFaded(resToast, [resToastMain, resToastAv]);
        }, 2600);
    }

    var stream = null;
    function startNativeWebrtc() {
        if (streamMode !== "native" || stream || !window.JanusStream || !window.JanusStream.available()) return;
        var sawVideo = false;
        var startGuard = null;
        stream = window.JanusStream({
            wsUrl: janusWsUrl(),
            video: vid,
            wantAudio: true, // audio output ON by default (mic stays off for privacy)
            wantMic: false,
            onStatus: function (st) {
                // "connecting" / "live" / "error". We only surface this quietly; the
                // visible status is driven by activate/fallback below.
                if (st === "error") {
                    // If we never managed to show video, drop to MJPEG. (Once live,
                    // the wrapper auto-retries; we keep showing the video element.)
                    if (!sawVideo) fallbackToMjpeg();
                }
            },
            onActive: function (active) {
                if (active && stream && stream.hasVideo()) {
                    sawVideo = true;
                    if (startGuard) {
                        clearTimeout(startGuard);
                        startGuard = null;
                    }
                    activateWebrtc();
                } else if (!active && webrtcActive) {
                    // The session stopped while live — go back to MJPEG so the user
                    // isn't left on a frozen frame.
                    fallbackToMjpeg();
                }
            },
        });
        try {
            stream.start();
        } catch (e) {
            stream = null;
        }
        // If WebRTC hasn't produced video within a few seconds (Janus down, no
        // ICE, SDP issue), don't keep the user staring at MJPEG-less black — MJPEG
        // is already running underneath, so just make sure the toggles stay hidden.
        if (stream) {
            startGuard = setTimeout(function () {
                startGuard = null;
                if (!sawVideo) fallbackToMjpeg(); // harmless: MJPEG is already live
            }, 8000);
        }
    }

    /* ---- Audio / Mic toggles (WebRTC only) ----
     * Audio = unmute the remote audio track (and ask Janus to send it). Mic =
     * capture the local microphone and push it to the target; needs getUserMedia
     * permission, handled gracefully. Both off by default. */
    var audioOn = true; // audio output on by default
    var micOn = false;
    // If the user turns audio OFF, re-enable it after an hour.
    var audioReenableTimer = null;
    function scheduleAudioReenable() {
        if (audioReenableTimer) clearTimeout(audioReenableTimer);
        audioReenableTimer = setTimeout(function () {
            audioReenableTimer = null;
            if (!audioOn && audioBtn) audioBtn.click(); // turn it back on
        }, 3600000); // 1 hour
    }

    // ---- audio activity meters --------------------------------------------------
    // Read the live audio level straight from WebRTC stats (getAudioLevels) — NO
    // AudioContext / output device, so it works with no user gesture and can't touch
    // the OS default device. A rAF loop polls ~every 90ms and drives `--vol` (0..1)
    // on the speaker + mic buttons with a VU-style decay (rise fast, fall slow).
    var meterRaf = 0;
    var spkTarget = 0;
    var micTarget = 0;
    var spkShown = 0;
    var micShown = 0;
    var lastPollTs = 0;
    function setVol(els, v) {
        els.forEach(function (el) {
            if (el) el.style.setProperty("--vol", v.toFixed(3));
        });
    }
    function nowMs() {
        return typeof performance !== "undefined" && performance.now ? performance.now() : 0;
    }
    function meterTick() {
        meterRaf = 0;
        if (!webrtcActive || !stream || !stream.getAudioLevels) {
            setVol([document.querySelector('[data-tb="audio"]'), audioBtn, document.querySelector('[data-tb="mic"]'), micBtn], 0);
            spkShown = micShown = spkTarget = micTarget = 0;
            return; // loop stops; activateWebrtc restarts it
        }
        // Nothing to meter (both off) or the window's hidden — drop to a cheap 2fps
        // heartbeat instead of burning 60fps + getStats; it resumes full rate the
        // moment audio/mic is on and the window is visible again.
        if ((!audioOn && !micOn) || (typeof document !== "undefined" && document.hidden)) {
            setVol([document.querySelector('[data-tb="audio"]'), audioBtn, document.querySelector('[data-tb="mic"]'), micBtn], 0);
            meterRaf = setTimeout(meterTick, 500);
            return;
        }
        var t = nowMs();
        if (!lastPollTs || t - lastPollTs > 90) {
            lastPollTs = t;
            stream.getAudioLevels().then(function (lv) {
                if (lv && lv.speaker != null) spkTarget = Math.min(1, lv.speaker * 2.4);
                if (lv && lv.mic != null) micTarget = Math.min(1, lv.mic * 2.4);
            });
        }
        // Rise instantly, fall slowly (~0.4s) — a real VU meter.
        spkShown = spkTarget > spkShown ? spkTarget : Math.max(spkTarget, spkShown - 0.03);
        micShown = micTarget > micShown ? micTarget : Math.max(micTarget, micShown - 0.03);
        setVol([document.querySelector('[data-tb="audio"]'), audioBtn], audioOn ? spkShown : 0);
        setVol([document.querySelector('[data-tb="mic"]'), micBtn], micOn ? micShown : 0);
        meterRaf = raf(meterTick);
    }
    function startMeters() {
        if (!meterRaf) meterRaf = raf(meterTick);
    }

    function paintToggle(btn, pip, on, warn, label) {
        if (!btn || !pip) return;
        btn.classList.toggle("on", on);
        btn.classList.toggle("warn", !!warn);
        pip.textContent = label || (on ? "On" : "Off");
        /* The titlebar twin is drawn by the shared component library now, so
         * this records what was said and lets the spec express it. The in-page
         * control spells the state out in the pip beside it — "On", "Off",
         * "Denied", "No mic" — and its twin has room for none of that, so the
         * label carries it rather than it living only in a colour. */
        var which = btn === audioBtn ? "audio" : btn === micBtn ? "mic" : null;
        if (which) {
            avState[which] = { on: !!on, warn: !!warn, label: label || "" };
            repaintAv();
        }
    }
    if (audioBtn) {
        audioBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            if (!stream) return;
            audioOn = !audioOn;
            vid.muted = !audioOn; // browsers gate autoplay on muted; unmute on opt-in
            if (audioOn) {
                vid.play().catch(function () {}); // some browsers need a fresh play()
            }
            stream.setAudio(audioOn);
            paintToggle(audioBtn, audioPip, audioOn, false);
            showResToast(true); // flash confirmation with the new A/M state
            startMeters();
            // Turned off → re-enable in an hour; turned back on → cancel that.
            if (!audioOn) scheduleAudioReenable();
            else if (audioReenableTimer) {
                clearTimeout(audioReenableTimer);
                audioReenableTimer = null;
            }
        });
    }
    if (micBtn) {
        micBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            if (!stream) return;
            if (micOn) {
                micOn = false;
                stream.setMic(false);
                paintToggle(micBtn, micPip, false, false);
                showResToast(true);
                return;
            }
            // Mic needs a permission grant; the wrapper's createAnswer will call
            // getUserMedia. Pre-flight the prompt so we can show a clear hint on
            // denial instead of silently failing. (The level meter reads the mic
            // energy from WebRTC stats, so we don't keep this stream.)
            paintToggle(micBtn, micPip, false, false, "…");
            var gum = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
            if (!gum) {
                paintToggle(micBtn, micPip, false, true, "No mic");
                return;
            }
            navigator.mediaDevices
                .getUserMedia({ audio: true })
                .then(function (s) {
                    s.getTracks().forEach(function (t) {
                        try {
                            t.stop();
                        } catch (e) {}
                    });
                    micOn = true;
                    // Mic implies an audio session; make sure audio is requested too.
                    stream.setMic(true);
                    paintToggle(micBtn, micPip, true, false);
                    showResToast(true);
                    startMeters();
                })
                .catch(function () {
                    paintToggle(micBtn, micPip, false, true, "Denied");
                });
        });
    }

    /* ---- coordinate mapping ----
     * The <img> fills the pane (object-fit:contain) and may be transformed by the
     * zoom/pan. Map a screen point to a 0..1 fraction of the actual video content,
     * accounting for the letterbox bars and the current transform. */
    var lastMoveTs = 0;
    /* The picture's box in client pixels — the transformed element minus the
     * letterbox bars the aspect ratio leaves. Shared, because the cursor blob has
     * to be pinned to exactly the box the coordinates are pinned to; computing it
     * twice is how the two would drift. */
    function pictureBox() {
        var r = streamEl().getBoundingClientRect(); // transformed element box
        if (r.width <= 0 || r.height <= 0) return null;
        var natAR = geomW() / geomH();
        var cw, ch, ox, oy;
        if (r.width / r.height > natAR) {
            ch = r.height;
            cw = ch * natAR;
            ox = (r.width - cw) / 2;
            oy = 0;
        } else {
            cw = r.width;
            ch = cw / natAR;
            ox = 0;
            oy = (r.height - ch) / 2;
        }
        return { left: r.left + ox, top: r.top + oy, w: cw, h: ch };
    }

    function fracAt(clientX, clientY, clamp) {
        /* With a button held, a pointer that has left the picture is still part of
         * the same drag, so it pins to the nearest edge rather than being dropped.
         *
         * Dropping it is what made dragging a window on the target fall apart the
         * moment the host pointer crossed into the letterbox or off the window
         * entirely: the browser keeps delivering the moves (a button-down takes an
         * implicit grab), the remote cursor just stopped following them and the
         * window stuck where the pointer left it. Pinning to the edge is also
         * exactly what edge-snapping needs — you throw the window at the side of
         * the screen and the target sees the cursor arrive there and hold. */
        return fracInBox(pictureBox(), clientX, clientY, clamp);
    }

    // Absolute move (desktop mouse): set the virtual cursor to the exact point and
    // send coalesced via rAF (one per frame) — same smooth path as the trackpad.
    function moveTo(clientX, clientY, force, clamp) {
        var f = fracAt(clientX, clientY, clamp);
        if (!f) return;
        vcur.x = fracToNorm(f.fx);
        vcur.y = fracToNorm(f.fy);
        moveDirty = true;
        if (force) flushMove();
        else queueMove();
    }
    function clickAt(clientX, clientY, button) {
        moveTo(clientX, clientY, true);
        setTimeout(function () {
            hid.button(button || "left", true);
            setTimeout(function () {
                hid.button(button || "left", false);
            }, 45);
        }, 12);
    }

    /* ---- zoom/pan view transform ----
     * The <img> fills the pane (position:absolute inset:0). transform-origin is the
     * pane's top-left, so the maths below is in pane-relative pixels and stays
     * consistent across pinch, two-finger pan and wheel zoom. */
    var ZMAX = 6;
    var scale = 1;
    var tx = 0;
    var ty = 0;
    // Set by the overlay layer so persistent boxes (the region map) re-scale with
    // the stream on every zoom/pan/resize, not just when a fresh map arrives.
    var onXform = null;
    function applyXform() {
        // Drive BOTH the <img> and the <video> with the same transform so zoom/pan
        // is identical whichever source is currently visible.
        var t = "translate(" + tx.toFixed(1) + "px," + ty.toFixed(1) + "px) scale(" + scale.toFixed(4) + ")";
        var wc = scale > 1 ? "transform" : "auto";
        img.style.transform = t;
        img.style.willChange = wc;
        vid.style.transform = t;
        vid.style.willChange = wc;
        // The held frame has to zoom and pan with the live picture, or thawing
        // after a reconnect would snap the view back.
        if (freezeCanvas) freezeCanvas.style.transform = t;
        if (onXform) onXform(); // let the region overlay re-scale with the stream
    }
    function clampPan() {
        if (scale <= 1) {
            tx = 0;
            ty = 0;
            return;
        }
        var pr = pane.getBoundingClientRect();
        tx = Math.min(0, Math.max(-pr.width * (scale - 1), tx));
        ty = Math.min(0, Math.max(-pr.height * (scale - 1), ty));
    }
    // Zoom to `ns`, keeping the screen point (px,py) pinned to the same content.
    function zoomAround(px, py, ns) {
        ns = Math.max(1, Math.min(ZMAX, ns));
        if (ns === scale) return;
        var pr = pane.getBoundingClientRect();
        var k = ns / scale;
        tx = px - pr.left - (px - pr.left - tx) * k;
        ty = py - pr.top - (py - pr.top - ty) * k;
        scale = ns;
        clampPan();
        applyXform();
    }

    /* ---- pointer input on the screen ----
     * Touch = a relative TRACKPAD (drag moves the cursor by a delta, like a laptop
     *   trackpad): tap = left click, two-finger tap = right click, two-finger drag
     *   = scroll, pinch = zoom the view, tap-and-a-half / Drag-lock = hold to drag.
     * Mouse (desktop) = ABSOLUTE: the cursor goes exactly where you point/click.
     */
    var pts = new Map(); // pointerId -> {x,y}
    var startPt = null; // {x,y,t,id}
    var moved = false;
    var pinchDist = 0;
    var pinchCx = 0;
    var pinchCy = 0;
    var dragLock = false;
    var pressing = false; // left button held (drag-lock or tap-and-a-half)
    var longPress = null;
    var lastTapUp = 0;
    var twoStart = null; // {t, moved} for two-finger tap = right click
    var scrollAcc = 0;
    var heldMouseButtons = {};
    /* Let go of everything the target is still holding.
     *
     * A release we never saw is the worst kind of stuck: the button stays down on
     * the TARGET, so the remote window keeps following the cursor with nothing
     * held on this side, and no amount of moving fixes it. It happens whenever the
     * physical release lands where we do not get the event — over another
     * application during a drag outside the window, or when the window loses the
     * pointer outright. Clamping the drag to the edge made that reachable in
     * normal use, because now the drag survives leaving the window at all. */
    function releaseHeldMouseButtons() {
        var held = Object.keys(heldMouseButtons);
        if (!held.length) return;
        held.forEach(function (b) {
            hid.button(b, false);
            delete heldMouseButtons[b];
        });
        releaseClickMods();
    }
    /* Losing the window mid-drag releases whatever is still down on the target.
     *
     * These used to sit inside the desktop block, which returns early when there
     * is no desktopConsole — so on web and mobile they were never registered at
     * all. Switching tab or app while dragging left the left button AND any
     * click modifiers held down on the target, with no pointerup ever coming to
     * clear them: measured on the web path as mouse_button down, ControlLeft
     * down, then nothing on blur.
     *
     * The reasoning was never desktop-specific. A button left down on the target
     * is worse than a dropped one — the remote window carries on following a
     * cursor with nothing held over here — and switching away mid-gesture is
     * MORE likely on a phone, not less. The desktop path also drives these from
     * the main process's window focus; releasing twice is harmless, since both
     * of these check what is actually held before sending anything. */
    window.addEventListener("blur", releaseAllMods);
    window.addEventListener("blur", releaseHeldMouseButtons);
    window.addEventListener("blur", releaseClickMods);

    // Modifiers held on the HOST across a click. The chord queue only ever synthesises
    // modifiers around KEYS, and a bare modifier keydown is never forwarded, so without
    // this the target sees a plain click: Shift+click range-select and Ctrl+click
    // multi-select silently did the wrong thing.
    var clickMods = [];
    function pressClickMods(e) {
        releaseClickMods();
        var m = modsFromEvent(e);
        if (e.shiftKey) m.push("ShiftLeft");
        /* An on-screen sticky modifier counts as much as a physical one.
         *
         * This read only the event, so arming Ctrl in the drawer and clicking
         * the picture sent a bare click and left the Ctrl armed for whatever
         * came next — and on a touch device, arming it is the ONLY way to hold
         * Ctrl, so Ctrl+click had no route at all. Deduped because a user can
         * hold Ctrl physically AND have it armed, and pressing the same key
         * twice leaves it stuck down on the target. */
        armedList().forEach(function (a) {
            if (m.indexOf(a) < 0) m.push(a);
        });
        clearArmed();
        // Anything the user is physically holding is already down and stays down
        // until they let go; synthesising it again would mean releasing it on
        // pointerup while it is still held.
        m = modMirror.owned(m);
        for (var i = 0; i < m.length; i++) hid.key(m[i], true);
        clickMods = m;
    }
    function releaseClickMods() {
        for (var i = clickMods.length - 1; i >= 0; i--) hid.key(clickMods[i], false);
        clickMods = [];
    }
    var MOVE_SLOP = 8;
    var SENS = 0.9; // trackpad sensitivity (finger px -> cursor travel)

    // Virtual cursor in PiKVM absolute units; relative drags accumulate into it and
    // we send absolute moves, so trackpad mode works with the default (absolute)
    // PiKVM mouse — no Pi-side relative-mouse configuration required.
    var vcur = { x: 0, y: 0 };
    var lastMoveX = 0,
        lastMoveY = 0; // last mouse client pos, for the no-signal relative wake nudge
    // Coalesce moves to ONE HID send per animation frame. Sending on every
    // pointermove (up to ~120/s) floods the WebSocket and makes the cursor stutter;
    // batching to ~60fps with the latest position is smooth (what PiKVM does too).
    var raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : function (cb) { return setTimeout(cb, 16); };
    var moveDirty = false;
    var moveRaf = 0;
    // In the desktop window, a passing cursor must not drive the remote pointer while
    // the window is in the background. Updated by focus/blur listeners (desktop only);
    // stays true on web/mobile where there is no real window-focus concept.
    var windowFocused = true;
    // Tell the agent daemon where the USER just moved the cursor (norm ±32767), so its
    // tracked position follows manual live-view moves — kvmd doesn't broadcast position, so
    // this is the only way it can observe them. Debounced + best-effort; desktop-only (where
    // the daemon proxy exists) and never while the agent itself is driving.
    var reportCursor = (function () {
        var pending = null, timer = null;
        return function (nx, ny) {
            if (agentActing || !window.desktopConsole) return;
            pending = { x: Math.round(nx), y: Math.round(ny) };
            if (timer) return;
            timer = setTimeout(function () {
                timer = null;
                var p = pending; pending = null;
                if (!p) return;
                fetch("/_agent/daemon/cursor", {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify(p), keepalive: true,
                }).catch(function () {});
            }, 180);
        };
    })();
    function flushMove() {
        moveRaf = 0;
        if (!moveDirty) return;
        moveDirty = false;
        if (window.desktopConsole && !windowFocused) return; // background window: don't move the KVM cursor
        hid.move(Math.round(vcur.x), Math.round(vcur.y));
        reportCursor(vcur.x, vcur.y);
    }
    function queueMove() {
        moveDirty = true;
        if (!moveRaf) moveRaf = raf(flushMove);
    }
    function relMove(dx, dy) {
        var el = streamEl();
        var w = el.offsetWidth || pane.clientWidth || 1;
        var h = el.offsetHeight || pane.clientHeight || 1;
        vcur.x = Math.max(-32768, Math.min(32767, vcur.x + (dx / w) * SENS * 65534));
        vcur.y = Math.max(-32768, Math.min(32767, vcur.y + (dy / h) * SENS * 65534));
        queueMove();
    }
    function tapClick(button) {
        flushMove(); // make sure the cursor is at its latest position first
        // The touch path never went near pressClickMods, so an armed modifier
        // was dropped here too — and this is the tap a phone actually makes.
        withArmedMods(function (release) {
            hid.button(button || "left", true);
            setTimeout(function () {
                hid.button(button || "left", false);
                release();
            }, 45);
        });
    }

    function centroid() {
        var sx = 0,
            sy = 0;
        pts.forEach(function (p) {
            sx += p.x;
            sy += p.y;
        });
        return { x: sx / pts.size, y: sy / pts.size };
    }
    function twoDist() {
        var a = Array.from(pts.values());
        return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
    }

    // Our own cursor (the OS one is hidden over the screen). Follows the mouse.
    var kvmCursor = document.getElementById("kvm-cursor");
    var freezeCanvas = document.getElementById("screen-freeze");
    function paintCursor(clientX, clientY, dragging) {
        if (!kvmCursor) return;
        // A dialog owns the pointer; the blob would sit under it as a ghost.
        if (modalOpen()) {
            kvmCursor.style.display = "none";
            pane.style.cursor = "";
            return;
        }
        // Background desktop window: the cursor isn't driving the target, so don't
        // paint the blob (a passing pointer must not leave a ghost cursor).
        if (window.desktopConsole && !windowFocused) {
            kvmCursor.style.display = "none";
            pane.style.cursor = "";
            return;
        }
        /* Off the picture and not dragging: the blob is not the pointer here.
         *
         * The drag path below already refuses to follow the host pointer into
         * the letterbox, because the blob is meant to show where the TARGET's
         * cursor is. Hovering had no such rule, so the blob tracked out over the
         * bars while nothing at all was being sent. Measured with a 1280x720
         * picture letterboxed into a 759x775 box:
         *
         *     inside the picture  : blob shown, 1 move sent
         *     letterbox bar above : blob shown at y=53,  0 moves sent
         *     letterbox bar below : blob shown at y=788, 0 moves sent
         *
         * And .screen is cursor:none, so that blob is the only pointer on
         * screen there — the one thing telling the user where their input goes,
         * saying it in a place no input goes.
         *
         * Hiding it alone would leave the bars with no pointer at all, so the
         * real one comes back: outside the picture you get your own cursor,
         * which is the honest signal that you are off the target. Clamping to
         * the edge instead would be its own lie, since no move was sent and the
         * target's pointer is still wherever it was. */
        var offPicture = pictureBox();
        if (!dragging && offPicture) {
            var outside =
                clientX < offPicture.left ||
                clientX > offPicture.left + offPicture.w ||
                clientY < offPicture.top ||
                clientY > offPicture.top + offPicture.h;
            if (outside) {
                kvmCursor.style.display = "none";
                pane.style.cursor = "default";
                return;
            }
        }
        pane.style.cursor = "";
        // Pinned to the picture while dragging, so the blob sits where the
        // target's cursor actually is rather than following the host pointer out
        // into the letterbox.
        if (dragging) {
            var b = pictureBox();
            if (b) {
                clientX = Math.max(b.left, Math.min(b.left + b.w, clientX));
                clientY = Math.max(b.top, Math.min(b.top + b.h, clientY));
            }
        }
        var pr = pane.getBoundingClientRect();
        kvmCursor.style.left = clientX - pr.left + "px";
        kvmCursor.style.top = clientY - pr.top + "px";
        kvmCursor.style.display = "block";
    }
    pane.addEventListener("pointerleave", function (e) {
        // Not while a button is held: the drag is still running and the blob is
        // pinned to the edge, which is the only feedback that it still is.
        if (e.buttons !== 0) return;
        if (e.pointerType === "mouse" && kvmCursor) kvmCursor.style.display = "none";
    });
    // When the user's mouse enters the live surface, make sure the target is in ABSOLUTE
    // pointer mode — this client drives the cursor with absolute moves, so a Pi stuck in
    // relative can't track it. ensureAbsolute is a throttled no-op once it's absolute.
    pane.addEventListener("pointerenter", function (e) {
        if (modalOpen()) return;
        if (e.pointerType === "mouse") hid.ensureAbsolute();
    });

    pane.addEventListener(
        "pointerdown",
        function (e) {
            // Taps on the overlaid UI (keys row, acting bar, copilot, suggestion card)
            // are NOT KVM input — let those handle their own clicks.
            if (e.target && e.target.closest && e.target.closest(".bar-keys, .acting-bar, .copilot, .suggest-card")) return;
            if (blockKvmInput(e)) return;
            if (modalOpen()) return;
            // Picking an OCR region: the drag is a selection, not remote input.
            if (ocrPickingNow()) {
                e.preventDefault();
                e.stopPropagation();
                pane.setPointerCapture(e.pointerId);
                ocrPointerDown(e);
                return;
            }
            pane.setPointerCapture(e.pointerId);
            pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (e.pointerType === "mouse") {
                // Only act on clicks INSIDE the actual picture — a click in the
                // letterbox/empty space around the stream is not a KVM click.
                if (!fracAt(e.clientX, e.clientY)) {
                    try {
                        pane.releasePointerCapture(e.pointerId);
                    } catch (err) {}
                    pts.delete(e.pointerId);
                    return;
                }
                noteManualKvmInput();
                // Real buttons, absolute move. In the native desktop window the global
                // keydown handler captures keys; elsewhere focus the hidden input so
                // typing (and the soft keyboard) goes to the target. Either way, blur
                // the agent iframe so keystrokes route to the KVM, not the chat.
                if (window.desktopConsole) {
                    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
                } else {
                    kbd.focus({ preventScroll: true });
                }
                var b = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
                moveTo(e.clientX, e.clientY, true);
                paintCursor(e.clientX, e.clientY);
                heldMouseButtons[b] = true;
                pressClickMods(e);
                hid.button(b, true);
                return;
            }
            noteManualKvmInput();

            if (pts.size === 2) {
                cancelLongPress();
                pinchDist = twoDist();
                var c = centroid();
                pinchCx = c.x;
                pinchCy = c.y;
                scrollAcc = 0;
                twoStart = { t: Date.now(), moved: false };
                return;
            }
            // First touch.
            startPt = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
            moved = false;
            var now = Date.now();
            if (dragLock || now - lastTapUp < 300) {
                // Drag-lock, or the down-stroke of a "tap-and-a-half": hold left so
                // the next move drags (and a quick non-move still reads as a click).
                pressing = true;
                hid.button("left", true);
            } else {
                // Long-press = right click.
                longPress = setTimeout(function () {
                    if (!moved) {
                        tapClick("right");
                        startPt = null;
                    }
                }, 500);
            }
        },
        true,
    );

    pane.addEventListener(
        "pointermove",
        function (e) {
            if (blockKvmInput(e)) return;
            if (modalOpen()) return;
            if (ocrPickingNow()) {
                e.preventDefault();
                ocrPointerMove(e);
                return;
            }
            // Desktop mouse: the remote cursor follows the pointer ABSOLUTELY — on
            // plain hover too, not only while a button is held (gating on "is the
            // pointer down" made it behave like a relative trackpad).
            if (e.pointerType === "mouse") {
                // A move that reports no buttons down is proof the release
                // happened, whether or not its pointerup ever reached us.
                if (e.buttons === 0) releaseHeldMouseButtons();
                hid.ensureAbsolute(); // recover absolute mode if the Pi reports relative (throttled no-op otherwise)
                /* A held button means this move belongs to a drag that started on
                 * the picture, so it keeps steering the target even once the host
                 * pointer has left — pinned to the edge rather than thrown away.
                 * That is what lets a window be dragged to the side of the remote
                 * screen and snapped, and it is why the button state has to be read
                 * from the event rather than assumed from where the pointer is. */
                var dragging = e.buttons !== 0;
                moveTo(e.clientX, e.clientY, false, dragging);
                paintCursor(e.clientX, e.clientY, dragging);
                // When the target isn't showing a live picture (asleep / no signal), an
                // absolute position report alone often won't wake it — mirror the actual
                // movement as a clamped RELATIVE nudge, which reliably does. Gated to
                // non-live so it never doubles the cursor when there's a real signal.
                if (streamState !== "live" && (!window.desktopConsole || windowFocused)) {
                    var dx = e.clientX - lastMoveX;
                    var dy = e.clientY - lastMoveY;
                    if (dx || dy) hid.relative(Math.max(-30, Math.min(30, dx)), Math.max(-30, Math.min(30, dy)));
                }
                lastMoveX = e.clientX;
                lastMoveY = e.clientY;
                return;
            }

            if (!pts.has(e.pointerId)) return;
            var prev = pts.get(e.pointerId);
            pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (pts.size >= 2) {
                e.preventDefault();
                cancelLongPress();
                var d = twoDist();
                var c = centroid();
                if (twoStart && Math.hypot(c.x - pinchCx, c.y - pinchCy) > MOVE_SLOP) twoStart.moved = true;
                // Pinch -> zoom around the pinch centre.
                if (pinchDist > 0 && Math.abs(d / pinchDist - 1) > 0.004) zoomAround(c.x, c.y, scale * (d / pinchDist));
                // Two-finger drag: pan the view when zoomed, else scroll the target.
                if (scale > 1) {
                    tx += c.x - pinchCx;
                    ty += c.y - pinchCy;
                    clampPan();
                    applyXform();
                } else {
                    scrollAcc += c.y - pinchCy;
                    while (Math.abs(scrollAcc) >= 22) {
                        hid.wheel(0, scrollAcc > 0 ? 1 : -1);
                        scrollAcc += scrollAcc > 0 ? -22 : 22;
                    }
                }
                pinchDist = d;
                pinchCx = c.x;
                pinchCy = c.y;
                return;
            }

            // Single finger: always the trackpad cursor (pan is two-finger when zoomed).
            if (!startPt) return;
            var movedDist = Math.hypot(e.clientX - startPt.x, e.clientY - startPt.y);
            if (!moved && movedDist > MOVE_SLOP) {
                moved = true;
                cancelLongPress();
            }
            if (!moved) return;
            e.preventDefault();
            relMove(e.clientX - prev.x, e.clientY - prev.y);
        },
        true,
    );

    function endTouch(e) {
        if (modalOpen()) {
            // A modal swallows the release, so let go of anything the target is still
            // holding rather than leaving a button or modifier stuck down on it.
            releaseHeldMouseButtons();
            pts.delete(e.pointerId);
            return;
        }
        if (ocrPickingNow()) {
            e.preventDefault();
            ocrPointerUp(e);
            return;
        }
        if (!pts.has(e.pointerId)) return;
        pts.delete(e.pointerId);
        if (e.pointerType === "mouse") {
            var b = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
            hid.button(b, false);
            delete heldMouseButtons[b];
            releaseClickMods();
            return;
        }
        cancelLongPress();
        // Two-finger tap (both up quickly, no drag) = right click.
        if (twoStart && pts.size === 1) {
            if (!twoStart.moved && Date.now() - twoStart.t < 300) tapClick("right");
            twoStart = null;
        }
        var wasPressing = pressing;
        if (pressing && pts.size === 0) {
            hid.button("left", false);
            pressing = false;
        }
        if (startPt && startPt.id === e.pointerId) {
            // Pure tap (no drag, no held button) = left click at the cursor. Two
            // quick taps send two clicks -> the target OS forms the double-click.
            if (!moved && !wasPressing) tapClick("left");
            lastTapUp = Date.now();
            startPt = null;
            moved = false;
        }
    }
    function cancelLongPress() {
        if (longPress) {
            clearTimeout(longPress);
            longPress = null;
        }
    }
    pane.addEventListener("pointerup", endTouch, true);
    pane.addEventListener("pointercancel", endTouch, true);
    pane.addEventListener("contextmenu", function (e) {
        e.preventDefault();
    });
    // Desktop wheel -> remote scroll (ctrl+wheel = zoom).
    pane.addEventListener(
        "wheel",
        function (e) {
            if (blockKvmInput(e)) return;
            if (modalOpen()) return;
            noteManualKvmInput();
            e.preventDefault();
            var dy = e.deltaY < 0 ? 1 : -1;
            /* Ctrl+wheel zooms the LOCAL view on a phone, where there is no other
             * way to get a closer look and no target application expecting it.
             * On the desktop it belongs to the target: Ctrl+scroll is how you zoom
             * an editor, a browser or a document over there, and swallowing it to
             * scale our own picture meant the one gesture everybody already knows
             * did the wrong thing on a window that looks like a computer.
             *
             * Bare modifiers are deliberately never forwarded (see key-chord.js),
             * so holding Ctrl on the host does NOT leave the target holding it.
             * The modifier has to be wrapped around the wheel explicitly, or the
             * target would just receive a plain scroll. */
            if (e.ctrlKey || e.metaKey) {
                if (!window.desktopConsole) {
                    zoomAround(e.clientX, e.clientY, scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
                    return;
                }
                /* owned(), for the reason the chord queue uses it.
                 *
                 * This pressed the modifier and then RELEASED it — while the
                 * user's finger was still on the key. The mirror went on
                 * believing Ctrl was held, so owned() excluded it from every
                 * chord after, and the target had it up: hold Ctrl, scroll
                 * once, then press A, and the target received a plain A. Zoom a
                 * document and then select all is an ordinary thing to do.
                 *
                 * A trackpad pinch still works. It arrives as ctrlKey with no
                 * physical Ctrl behind it, so the mirror does not have it, and
                 * owned() hands it back to be pressed and released here. */
                var mod = e.metaKey ? "MetaLeft" : "ControlLeft";
                var mine = modMirror.owned([mod]);
                for (var mi = 0; mi < mine.length; mi++) hid.key(mine[mi], true);
                hid.wheel(0, dy);
                for (var mj = mine.length - 1; mj >= 0; mj--) hid.key(mine[mj], false);
                return;
            }
            hid.wheel(0, dy);
        },
        { passive: false },
    );

    /* ---- keyboard input via the hidden field ---- */
    /* One physical press can reach us twice (keydown AND the beforeinput fallback that
     * soft keyboards need), so a same-key guard is needed. It has to be exact, though:
     * keyed on the code alone it also swallowed Shift+Enter typed straight after Enter,
     * and every OS auto-repeat faster than 60ms while a key was held — which is most of
     * them. So the identity includes the modifiers, and a repeat event always passes. */
    var lastKey = { code: "", id: "", ts: 0 };
    var DEDUPE_MS = 60;
    /** Auto-repeat throttle. A held key repeats at the HOST's rate, which can be as low
     *  as 15ms and outrun the send queue — the target would then carry on receiving the
     *  key well after it was released. Admitting a repeat only once the queue is nearly
     *  drained makes a held key track the drain rate instead of building a backlog. */
    function admitRepeat() {
        return keyQ.length < 2;
    }
    function dedupe(codeName, mods, repeat) {
        if (repeat) return admitRepeat(); // genuine OS auto-repeat, not a double-fire
        var id = codeName + "|" + (mods || []).slice().sort().join("+");
        var now = Date.now();
        if (lastKey.id === id && now - lastKey.ts < DEDUPE_MS) return false;
        lastKey = { code: codeName, id: id, ts: now };
        return true;
    }
    /** True if ANY chord on this physical key just went out. The beforeinput fallback
     *  uses this so it never re-sends what keydown already handled with a modifier. */
    function recentlySent(codeName) {
        return lastKey.code === codeName && Date.now() - lastKey.ts < DEDUPE_MS;
    }
    /** Record a send that didn't go through dedupe (the beforeinput fallback), so a
     *  repeat of the same event is still caught. */
    function noteSent(codeName) {
        lastKey = { code: codeName, id: codeName + "|", ts: Date.now() };
    }
    /**
     * Act on a decided keydown. Shared by both keyboard paths so the gating, the
     * dedupe and the queue behave identically whichever one is live.
     * `printable` is false for the hidden field, where beforeinput produces characters.
     */
    function handleKeydown(e, printable) {
        var d = KeyChord.decide(e, { armed: armedList(), printable: printable });
        if (d.kind === "ignore") {
            // A bare modifier rides the chord for typing, but it also has to be
            // HELD on the target so Ctrl+click and Ctrl+drag behave.
            if (d.why === "bare-modifier" && e.code) pressMod(e.code);
            return;
        }
        e.preventDefault();
        if (d.kind === "swallow") return;
        if (d.kind === "char") {
            // Printable keys carry no dedupe (a fast "aaa" must all land), so only the
            // repeat throttle applies.
            if (!e.repeat || admitRepeat()) sendChar(d.char);
            return;
        }
        if (dedupe(d.code, d.mods, e.repeat)) sendChord(d.mods, d.code, false);
        clearArmed();
    }
    kbd.addEventListener("keydown", function (e) {
        if (blockKvmInput(e)) return;
        noteManualKvmInput();
        handleKeydown(e, false);
    });
    kbd.addEventListener("keyup", function (e) {
        if (e.code) releaseMod(e.code);
    });
    kbd.addEventListener("beforeinput", function (e) {
        if (blockKvmInput(e)) return;
        noteManualKvmInput();
        if (e.inputType === "insertText" && e.data) {
            for (var i = 0; i < e.data.length; i++) sendChar(e.data[i]);
            e.preventDefault();
        } else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
            // Soft-keyboard fallback only. Match on the CODE, not the full chord, so a
            // Shift+Enter that keydown already sent isn't followed by a bare Enter.
            if (!recentlySent("Enter")) {
                noteSent("Enter");
                sendCode("Enter");
            }
            e.preventDefault();
        } else if (e.inputType === "deleteContentBackward") {
            if (!recentlySent("Backspace")) {
                noteSent("Backspace");
                sendCode("Backspace");
            }
            e.preventDefault();
        }
        kbd.value = "";
    });
    kbd.addEventListener("input", function () {
        kbd.value = "";
    });

    /* ---- on-screen controls ---- */
    function paintMod(codeName, on) {
        var btn = document.querySelector('[data-mod="' + codeName + '"]');
        if (!btn) return;
        btn.classList.toggle("on", on);
        /* Armed is a STATE, and it was carried by the class alone.
         *
         * These are the sticky modifiers in the touch drawer: tap Ctrl, then tap
         * a key, and the chord goes out. Whether Ctrl is currently armed decides
         * what the next tap does, and the accessibility tree said nothing about
         * it — measured on an armed button:
         *
         *     class "ibtn on"
         *     role=button  properties=["invalid=false","focusable=true"]
         *     aria-pressed / aria-checked / aria-label: all null
         *
         * So the one thing that changes the meaning of the next tap was visible
         * only as a colour. On a phone this drawer is the ONLY way to send a
         * modifier at all, so there is no other route to check.
         *
         * aria-pressed rather than a switch role, matching the audio and mic
         * toggles in the titlebar, which are the same kind of control. The GPIO
         * rows use role=switch because they report a remote thing's state;
         * these arm a local intent. */
        btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    document.querySelectorAll("[data-key]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            if (agentActing) return;
            noteManualKvmInput();
            sendCode(btn.getAttribute("data-key"));
            refocusKbd();
        });
    });
    document.querySelectorAll("[data-mod]").forEach(function (btn) {
        var codeName = btn.getAttribute("data-mod");
        /* A toggle says so before it is ever pressed, or the first press is the
         * first time anything announces it has two states. paintMod keeps it in
         * step from here on. */
        btn.setAttribute("aria-pressed", armed[codeName] ? "true" : "false");
        var lastTap = 0;
        btn.addEventListener("click", function () {
            if (agentActing) return;
            noteManualKvmInput();
            var now = Date.now();
            if (armed[codeName]) {
                if (now - lastTap < 350 && !modLock[codeName]) {
                    modLock[codeName] = true; // double-tap locks it down
                } else {
                    delete armed[codeName];
                    delete modLock[codeName];
                    paintMod(codeName, false);
                }
            } else {
                armed[codeName] = true;
                paintMod(codeName, true);
            }
            lastTap = now;
            refocusKbd();
        });
    });
    /* Hold the armed sticky modifiers around a mouse action, the way sendCode
     * does around a key.
     *
     * An armed modifier applied to keys and was dropped by every button in this
     * drawer, so Ctrl+click — how you multi-select almost anywhere — sent a bare
     * click and left the Ctrl still armed for whatever came next. On a touch
     * device this drawer is the only way to click at all, so there was no other
     * route to the gesture.
     *
     * owned() so a modifier the user is also physically holding is left alone:
     * pressing it again is harmless, releasing it at the end would drop it while
     * their finger is still down. clearArmed() honours a double-tap lock, so a
     * locked modifier stays on for the next click, same as for the next key. */
    function withArmedMods(act) {
        var mods = modMirror.owned(armedList());
        for (var i = 0; i < mods.length; i++) hid.key(mods[i], true);
        clearArmed();
        act(function () {
            for (var j = mods.length - 1; j >= 0; j--) hid.key(mods[j], false);
        });
    }
    document.querySelectorAll("[data-click]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            if (agentActing) return;
            noteManualKvmInput();
            var b = btn.getAttribute("data-click");
            withArmedMods(function (release) {
                hid.button(b, true);
                setTimeout(function () {
                    hid.button(b, false);
                    release();
                }, 45);
            });
        });
    });
    document.querySelectorAll("[data-scroll]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            if (agentActing) return;
            noteManualKvmInput();
            var up = btn.getAttribute("data-scroll") === "up";
            withArmedMods(function (release) {
                hid.wheel(0, up ? 2 : -2);
                release();
            });
        });
    });
    document.getElementById("cad").addEventListener("click", function () {
        if (agentActing) return;
        noteManualKvmInput();
        sendChord(["ControlLeft", "AltLeft"], "Delete", false);
    });
    var dragBtn = document.getElementById("drag-lock");
    /* Latched or not is a STATE, and it was only a class — the same gap the
     * sticky modifiers had. This one latches the target's LEFT BUTTON DOWN, so
     * "is it on" decides whether the next tap drags or clicks, and the target is
     * holding a button either way. Measured before: class "ibtn on", and the
     * accessibility node carried no pressed state at all. */
    dragBtn.setAttribute("aria-pressed", dragLock ? "true" : "false");
    dragBtn.addEventListener("click", function () {
        if (agentActing) return;
        noteManualKvmInput();
        dragLock = !dragLock;
        dragBtn.classList.toggle("on", dragLock);
        dragBtn.setAttribute("aria-pressed", dragLock ? "true" : "false");
    });

    function refocusKbd() {
        if (app.classList.contains("keys-open")) kbd.focus({ preventScroll: true });
    }

    /* ---- keyboard toggle ---- */
    var kbdBtn = document.getElementById("kbd-btn");
    /* This one DISCLOSES a region rather than flipping a setting, so it is
     * aria-expanded rather than aria-pressed, and it names the region it
     * controls. Before, opening the drawer changed a class and nothing else:
     * the button read "Controls" whether the keys were on screen or not. */
    kbdBtn.setAttribute("aria-controls", "drawer");
    kbdBtn.setAttribute("aria-expanded", app.classList.contains("keys-open") ? "true" : "false");
    kbdBtn.addEventListener("click", function () {
        var openK = app.classList.toggle("keys-open");
        kbdBtn.classList.toggle("on", openK);
        kbdBtn.setAttribute("aria-expanded", openK ? "true" : "false");
        if (openK) kbd.focus({ preventScroll: true });
        else kbd.blur();
    });

    /* ---- size the split: auto-fit the screen to the stream aspect (no black
     * bars), until the user drags the bar. Drag is delta-based off a fixed start
     * point (NOT recomputed from the live layout), so it's smooth and never
     * jitters. Tapping a button doesn't start a drag. */
    var userResized = false;
    // Intro: start showing just the stream; slide the chat in once it signals ready.
    var booting = true;
    app.classList.add("booting");
    app.style.setProperty("--sh", "88vh");
    function reveal() {
        if (!booting) return;
        booting = false;
        app.classList.remove("booting"); // chat slides up (transform)
        raf(fitAspect); // --sh animates to the aspect fit
    }
    setTimeout(reveal, 3500); // fallback if the chat never signals
    function clampH(h) {
        return Math.max(110, Math.min(Math.max(140, window.innerHeight - 160), h));
    }
    // Desktop = wide + landscape: the chat sits to the RIGHT and the screen sizes to
    // the stream's aspect by WIDTH (so there are no black bars); mobile stacks and
    // sizes by HEIGHT.
    function isDesktop() {
        return window.matchMedia("(min-width: 900px) and (orientation: landscape)").matches;
    }
    function fitAspect() {
        if (userResized || booting) return;
        // Use the active source's intrinsic size: <img> natural*, <video> video*.
        var nw = webrtcActive ? vid.videoWidth : img.naturalWidth;
        var nh = webrtcActive ? vid.videoHeight : img.naturalHeight;
        if (!nw || !nh) return;
        if (isDesktop()) {
            // The screen is the flexible remainder beside the (user-resizable) agent
            // panel; the stream is object-fit:contain within it. "Fit to native
            // resolution" snaps the window so it's 1:1. Nothing to compute here.
            app.style.removeProperty("--sh");
        } else {
            var w = pane.clientWidth || window.innerWidth;
            app.style.setProperty("--sh", clampH(Math.round((w * nh) / nw)) + "px");
            app.style.removeProperty("--sw");
        }
    }
    img.addEventListener("load", function () {
        fitAspect();
        showResToast();
    });
    // The video reports its size asynchronously once the first frame decodes.
    vid.addEventListener("loadedmetadata", function () {
        fitAspect();
        showResToast();
    });
    vid.addEventListener("resize", function () {
        fitAspect();
        showResToast();
    });
    window.addEventListener("resize", fitAspect);
    window.addEventListener("orientationchange", function () {
        setTimeout(fitAspect, 250);
    });

    /* ---- haptic feedback (web-haptics: haptics.lochie.me) ----
     * Android = navigator.vibrate; iOS = the lib's hidden <input switch> Taptic
     * trick. Lazily loaded as a served module so the un-bundled console can use it.
     * Every call is a no-op until it loads (and on devices without a vibrator). */
    var haptics = null;
    if (typeof navigator !== "undefined") {
        import("/_agent/haptics.js")
            .then(function (m) {
                try {
                    haptics = new m.WebHaptics();
                } catch (e) {}
            })
            .catch(function () {});
    }
    function buzz(kind) {
        if (haptics) {
            try {
                haptics.trigger(kind || "light");
            } catch (e) {}
        }
    }

    // Snap targets for the vertical drag: the height at which the live screen sits
    // flush against the bottom of the picture (no black bars) — "the edge of the
    // PiKVM" — plus the fully-collapsed and fully-expanded extents.
    function snapTargets() {
        var nw = webrtcActive ? vid.videoWidth : img.naturalWidth;
        var nh = webrtcActive ? vid.videoHeight : img.naturalHeight;
        var w = pane.clientWidth || window.innerWidth;
        var list = [];
        if (nw && nh) list.push(clampH(Math.round((w * nh) / nw)));
        list.push(clampH(110));
        list.push(clampH(window.innerHeight));
        return list;
    }

    var resizing = false;
    var startY = 0;
    var startH = 0;
    var dragTouch = false; // pointer is a finger (haptics only make sense then)
    var lastSnap = null; // the snap target we're currently parked on (for edge-trigger)
    function resizeStart(e) {
        if (e.target.closest && e.target.closest(".ibtn")) return; // let buttons click
        if (isDesktop()) return; // desktop auto-fits the screen width; no vertical drag
        resizing = true;
        userResized = true; // a manual drag stops auto-fit for this session
        dragTouch = e.pointerType !== "mouse";
        lastSnap = null;
        app.classList.add("resizing"); // kill the --sh transition so the drag is 1:1, never eased
        startY = e.clientY;
        startH = pane.offsetHeight;
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch (err) {}
        if (dragTouch) buzz("light"); // grab
        e.preventDefault();
    }
    function resizeMove(e) {
        if (!resizing) return;
        e.preventDefault();
        var raw = clampH(startH + (e.clientY - startY));
        // Magnetically snap when the drag passes within ~20px of a target.
        var SNAP = 20;
        var snapped = null;
        var best = SNAP + 1;
        snapTargets().forEach(function (t) {
            var d = Math.abs(raw - t);
            if (d <= SNAP && d < best) {
                best = d;
                snapped = t;
            }
        });
        var h = snapped == null ? raw : snapped;
        // Tick once each time the drag enters (or moves between) a snap zone.
        if (snapped != null && snapped !== lastSnap && dragTouch) buzz("medium");
        lastSnap = snapped;
        app.style.setProperty("--sh", h.toFixed(0) + "px");
    }
    function resizeEnd() {
        resizing = false;
        app.classList.remove("resizing");
    }
    // Only the grip + the status area of the bar resize; the keys row scrolls
    // independently and the action buttons keep clicking.
    [document.getElementById("grip"), document.getElementById("bar-main")].forEach(function (el) {
        if (!el) return;
        el.addEventListener("pointerdown", resizeStart);
        el.addEventListener("pointermove", resizeMove);
        el.addEventListener("pointerup", resizeEnd);
        el.addEventListener("pointercancel", resizeEnd);
    });

    /* The same split, from the keyboard.
     *
     * The grip was drag-only — a bare div with a title — so on the stacked
     * layout the balance between the live screen and the panel under it could
     * not be changed without a pointer, and a screen reader was told nothing
     * about it at all. That is not only a phone problem: a browser window
     * narrower than 900px gets this layout too. The desktop divider beside it
     * has been a role=separator with an announced range since it had the same
     * fault; this is that control for the other axis.
     *
     * The range comes out of clampH rather than repeating its numbers, so the
     * ends the arrows reach are by construction the ends the drag is held to.
     *
     * stopPropagation matters for the reason it does on the divider: the
     * console forwards stray keystrokes straight to the TARGET and only skips
     * its own editable fields — a focusable div is not one, so without this
     * every arrow press would also arrive on the remote machine. */
    var gripEl = document.getElementById("grip");
    /* `known` is the height just asked for, when there is one.
     *
     * --sh is transitioned outside a drag — which is why resizeStart adds
     * .resizing to kill it — so reading pane.offsetHeight straight after
     * writing the property returns the value it is animating AWAY from.
     * Announcing that reported the previous step every time: measured
     * ArrowDown taking the pane to 405px while aria-valuenow still said 394.
     * The handler already knows what it asked for, so it says that; the
     * caller with nothing to pass reads the DOM, which is right for a window
     * resize or the end of a drag. */
    function paintGripValue(known) {
        if (!gripEl) return;
        setAttr(gripEl, "aria-valuemin", String(clampH(0)));
        setAttr(gripEl, "aria-valuemax", String(clampH(Number.MAX_SAFE_INTEGER)));
        setAttr(gripEl, "aria-valuenow", String(clampH(known == null ? pane.offsetHeight : known)));
    }
    if (gripEl) {
        gripEl.addEventListener("keydown", function (e) {
            // Hidden on the desktop layout, where there is no vertical split at
            // all — but the guard is cheap and matches what resizeStart does.
            if (isDesktop()) return;
            var step = e.shiftKey ? 48 : 12;
            var current = pane.offsetHeight;
            var next = null;
            if (e.key === "ArrowUp") next = current - step;
            else if (e.key === "ArrowDown") next = current + step;
            else if (e.key === "Home") next = clampH(0);
            else if (e.key === "End") next = clampH(Number.MAX_SAFE_INTEGER);
            if (next === null) return;
            e.preventDefault();
            e.stopPropagation();
            userResized = true; // same as a drag: stop auto-fit for this session
            var h = clampH(next);
            app.style.setProperty("--sh", h.toFixed(0) + "px");
            paintGripValue(h);
        });
        /* Wrapped, not passed directly: these hand their Event to the first
         * argument, which is the "height just asked for" — clamping an Event
         * yields NaN and the control would announce nothing at all. */
        gripEl.addEventListener("pointerup", function () {
            paintGripValue();
        });
        window.addEventListener("resize", function () {
            paintGripValue();
        });
        paintGripValue();
    }

    /* ---- desktop: drag the chat workspace's right edge to balance it against
     * the supporting computer preview. */
    var chatResize = document.getElementById("chat-resize");
    if (chatResize) {
        var cresizing = false;
        var cStartX = 0;
        var cStartW = 0;
        var cLastW = 0;
        chatResize.addEventListener("pointerdown", function (e) {
            cresizing = true;
            cStartX = e.clientX;
            var chatEl = document.querySelector(".chat");
            cStartW = chatEl ? chatEl.offsetWidth : 760;
            cLastW = cStartW;
            app.classList.add("col-resizing");
            try {
                chatResize.setPointerCapture(e.pointerId);
            } catch (err) {}
            e.preventDefault();
        });
        chatResize.addEventListener("pointermove", function (e) {
            if (!cresizing) return;
            // The divider is the chat workspace's RIGHT edge — unless the conversation
            // has been swapped to the right side, where the handle is its LEFT edge and
            // the same pointer travel means the opposite width change.
            var sign = document.documentElement.classList.contains("agent-right") ? -1 : 1;
            var want = cStartW + sign * (e.clientX - cStartX);
            want = clampPanelWidthNow(want);
            if (want !== cLastW) {
                applyPanelWidth(want);
                cLastW = want;
            }
        });
        function paintResizeValue() {
            var chatEl = document.querySelector(".chat");
            chatResize.setAttribute("aria-valuemin", String(PANEL_MIN_W));
            chatResize.setAttribute("aria-valuemax", String(panelMaxNow()));
            /* Clamped to the same range that was just announced, so min <= now <=
             * max holds by construction. In a normal layout this is a no-op: the
             * grid and panelMaxNow() compute the ceiling from the same token. It
             * earns its keep with the preview collapsed, where the conversation
             * spans the whole window and the raw width would exceed the maximum. */
            chatResize.setAttribute(
                "aria-valuenow",
                String(clampPanelWidthNow(chatEl ? chatEl.offsetWidth : PANEL_MIN_W)),
            );
        }
        function cresizeEnd() {
            cresizing = false;
            app.classList.remove("col-resizing");
            savePanelWidth(cLastW);
            paintResizeValue();
        }
        chatResize.addEventListener("pointerup", cresizeEnd);
        chatResize.addEventListener("pointercancel", cresizeEnd);

        /* The divider was drag-only, so the panel width could not be changed
         * from the keyboard at all. Arrows move it, Shift takes bigger steps,
         * Home and End go to the ends of the same range the drag is clamped to.
         *
         * stopPropagation matters here: the console forwards stray keystrokes
         * straight to the TARGET, and it only skips its own editable fields — a
         * focusable div is not one, so without this every arrow press would
         * also arrive on the remote machine. */
        chatResize.addEventListener("keydown", function (e) {
            var chatEl = document.querySelector(".chat");
            var current = chatEl ? chatEl.offsetWidth : 760;
            // On the right-hand side the same arrow means the opposite width
            // change, exactly as the drag already accounts for.
            var sign = document.documentElement.classList.contains("agent-right") ? -1 : 1;
            var step = e.shiftKey ? 64 : 16;
            var next = null;
            if (e.key === "ArrowLeft") next = current - sign * step;
            else if (e.key === "ArrowRight") next = current + sign * step;
            else if (e.key === "Home") next = PANEL_MIN_W;
            else if (e.key === "End") next = panelMaxNow();
            if (next === null) return;
            e.preventDefault();
            e.stopPropagation();
            next = clampPanelWidthNow(next);
            applyPanelWidth(next);
            savePanelWidth(next);
            paintResizeValue();
        });
        repaintPanelDivider = paintResizeValue;
        paintResizeValue();
        /* The first paint runs before the panel has been laid out, so it reports
         * whatever width the element happens to have at parse time — measured as
         * 460 against an actual 760. Correct it once layout has settled, and
         * again whenever the window changes, which is also how a side swap
         * announces itself. A timeout rather than a frame callback on purpose:
         * an occluded window stops producing frames, and the value would then
         * stay wrong for as long as it stayed hidden. */
        setTimeout(paintResizeValue, 0);
        window.addEventListener("resize", paintResizeValue);
    }

    window.addEventListener("message", function (e) {
        var d = e.data;
        if (!d) return;
        if (d.type === "chat-ready") {
            reveal(); // terminal loaded — slide the panel in
        }
    });

    /* ---- overflow (⋯) menu: positioned to the best-fitting spot, closes on
     * pick/outside. Flips above/below by available room and clamps on-screen. */
    var moreBtn = document.getElementById("more-btn");
    var moreMenu = document.getElementById("more-menu");
    function placeMenu() {
        var GAP = 6;
        var M = 8; // viewport margin
        var r = moreBtn.getBoundingClientRect();
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        // Measure with left/top anchoring (it's position:fixed, so size is stable).
        moreMenu.style.right = "auto";
        moreMenu.style.bottom = "auto";
        var mw = moreMenu.offsetWidth;
        var mh = moreMenu.offsetHeight;
        // Horizontal: align the menu's right edge to the button, clamp on-screen.
        var left = Math.max(M, Math.min(r.right - mw, vw - mw - M));
        // Vertical: prefer above the button; flip below if there's more room there.
        var above = r.top - GAP - mh;
        var below = r.bottom + GAP;
        var top = r.top - GAP >= mh || r.top > vh - r.bottom ? above : below;
        top = Math.max(M, Math.min(top, vh - mh - M));
        moreMenu.style.left = left + "px";
        moreMenu.style.top = top + "px";
    }
    if (moreBtn && moreMenu) {
        /* Open-ness through ONE helper, because four separate places close this
         * menu — the button, picking an item, a tap outside, and Escape — and an
         * aria-expanded added to only some of them goes stale on the others.
         *
         * It needed one: measured against the keys drawer, which does announce,
         * the button said nothing in either state —
         *
         *     more     name="More"      state=NONE       (closed AND open)
         *     drawer   name="Controls"  state=expanded=false / expanded=true
         *
         * and the menu itself is a bare div with no role and no name, so a
         * screen reader met thirty-five buttons with nothing to say what they
         * belonged to or that anything had opened.
         *
         * aria-expanded and a label, NOT role="menu": the menu is walked with
         * Tab, not arrow keys (checked — ArrowDown does not move between items),
         * so claiming menu semantics would promise a keyboard model that is not
         * there. A labelled group of real buttons is what it actually is. */
        moreMenu.setAttribute("aria-label", "More actions");
        moreBtn.setAttribute("aria-controls", moreMenu.id || "more-menu");
        function setMenuOpen(open) {
            /* Closing with focus still inside it drops that focus on the floor.
             *
             * The items are display:none'd along with the class, so the browser
             * resets activeElement to the body — open the menu, Tab to an item,
             * change your mind and press Escape, and you are dumped to the top
             * of the document with a full Tab walk back. Every dialog here
             * already returns focus to the control that opened it; this is the
             * one dismissable thing that did not.
             *
             * Only when focus is actually inside: picking an ITEM also closes
             * the menu, and by the time this runs that item's own handler has
             * opened a dialog and focused it. Restoring unconditionally would
             * snatch focus straight back out of the dialog the user just asked
             * for. Moved before the class toggle so there is no moment where
             * focus sits on a hidden button. */
            if (!open && moreMenu.contains(document.activeElement)) moreBtn.focus();
            moreMenu.classList.toggle("open", open);
            moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
            return open;
        }
        setMenuOpen(moreMenu.classList.contains("open"));
        moreBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            if (setMenuOpen(!moreMenu.classList.contains("open"))) placeMenu();
        });
        // Picking an item closes it — EXCEPT the audio/mic toggles, which stay open
        // so you can flip both without the menu vanishing (the original bug).
        moreMenu.addEventListener("click", function (e) {
            if (e.target.closest && e.target.closest(".more-item.toggle")) return;
            setMenuOpen(false);
        });
        // Click/tap-outside detection: anything that isn't the menu or the button
        // dismisses it (pointerdown so it's snappy + reliable on touch).
        document.addEventListener("pointerdown", function (e) {
            if (!moreMenu.classList.contains("open")) return;
            if (moreMenu.contains(e.target) || moreBtn.contains(e.target)) return;
            setMenuOpen(false);
        });
        // Escape closes it too.
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") setMenuOpen(false);
        });
        window.addEventListener("resize", function () {
            if (moreMenu.classList.contains("open")) placeMenu();
        });
    }

    /* ---- theme ---- */
    var themeBtn = document.getElementById("theme-btn");
    function currentTheme() {
        return document.documentElement.getAttribute("data-theme") || "dark";
    }
    /* A saved theme is the user's CHOICE; the OS is only the default when they
     * have not made one. It used to be the other way round — boot re-applied the
     * OS theme, and applyTheme persists, so every launch quietly overwrote the
     * choice with the system one. The button worked and the value saved, and it
     * was gone by the next start, with nothing to say why. */
    function storedTheme() {
        try {
            return localStorage.getItem("pikvm-console-theme") || "";
        } catch (e) {
            return "";
        }
    }
    function applyTheme(t, remember) {
        document.documentElement.setAttribute("data-theme", t);
        /* The shared component library keys its palette off a `dark` CLASS, and
         * its token block is NOT inside a Tailwind layer — so it sits unlayered
         * at the same specificity as this file's :root and simply comes later in
         * the document, which meant it won every colour the two of them name.
         *
         * The effect was that the theme toggle did nothing at all: light and
         * dark resolved to identical values and the whole window was stuck in
         * the library's light palette, buttons and dialogs alike.
         *
         * Setting the class is the fix rather than reordering the two sheets,
         * because .dark carries forty tokens and this file only names nine of
         * them. Reordering would have flipped those nine and left --input,
         * --muted, --ring and the rest light, which is a half-dark window. The
         * values in the two dark palettes already agree. */
        document.documentElement.classList.toggle("dark", t === "dark");
        // Only a deliberate choice is written down. Following the OS must not
        // record anything, or the next OS change has a "choice" to fight.
        if (remember) {
            try {
                localStorage.setItem("pikvm-console-theme", t);
            } catch (e) {}
        }
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute("content", t === "light" ? "#f5f5f7" : "#0a0a0c");
        /* The desktop conversation is a native child view, not that iframe, so
         * the postMessage above never reaches it. Without this the console went
         * light and the panel beside it stayed dark, in the same window. */
        /* window.desktopConsole rather than the `dc` alias: that is declared
         * inside the desktop-only block further down, so naming it here threw a
         * ReferenceError after the theme had already been applied — silently,
         * because it is the last statement in the handler. */
        var desk = window.desktopConsole;
        if (desk && desk.reportAgentTheme) desk.reportAgentTheme(t);
        /* And the embedded conversation, which is a same-origin frame rather
         * than a native view now. Its markup hardcodes class="dark", so without
         * this the console going light left half of one window in the wrong
         * theme — the exact fault the native path already had a channel for. */
        try {
            if (chatFrame && chatFrame.contentWindow) {
                chatFrame.contentWindow.postMessage(
                    { channel: "pikvm-panel", type: "theme", value: t },
                    location.origin,
                );
            }
        } catch (e) {}
    }
    /* Answer a frame asking for the theme, on EVERY platform.
     *
     * applyTheme posts to the frame whenever the theme changes, which is enough
     * once the frame is up — but a frame that mounts afterwards has missed it,
     * and both of ours do: the conversation loads when the harness answers, and
     * the terminal loads with the page. They ask on mount.
     *
     * The desktop block already answers subscribe with placement AND theme, but
     * that whole block is skipped in a browser — which is exactly where the
     * terminal panel is used. Answering here as well costs a duplicate message
     * on the desktop and is the only answer on web and mobile. */
    window.addEventListener("message", function (e) {
        if (!chatFrame || e.source !== chatFrame.contentWindow) return;
        if (e.origin !== location.origin) return;
        var d = e.data;
        if (!d || d.channel !== "pikvm-panel" || d.type !== "subscribe") return;
        try {
            e.source.postMessage(
                { channel: "pikvm-panel", type: "theme", value: currentTheme() },
                location.origin,
            );
        } catch (err) {}
    });

    themeBtn.addEventListener("click", function () {
        applyTheme(currentTheme() === "light" ? "dark" : "light", true);
    });
    // Follow the OS appearance: switch the whole console (light/dark) live whenever
    // the OS theme changes. In the desktop window this tracks the OS via Electron's
    // system nativeTheme; in a browser it tracks prefers-color-scheme directly.
    try {
        var osThemeMq = window.matchMedia("(prefers-color-scheme: dark)");
        var onOsTheme = function (e) {
            // Live OS changes still follow, but only while the user has not
            // chosen for themselves — otherwise the choice is overridden the
            // first time the system flips.
            if (!storedTheme()) applyTheme(e.matches ? "dark" : "light", false);
        };
        if (osThemeMq.addEventListener) osThemeMq.addEventListener("change", onOsTheme);
        else if (osThemeMq.addListener) osThemeMq.addListener(onOsTheme);
        /* Boot: honour a saved choice, else follow the OS. Applied either way and
         * not just when it differs, because this is also what tells the native
         * conversation view beside us which theme to draw. */
        applyTheme(storedTheme() || (osThemeMq.matches ? "dark" : "light"), false);
    } catch (e) {}
    // First paint of the embedded chat should match; pass the theme on its URL and
    // re-assert on load (in case it booted before the message handler attached).
    // Inside the native desktop console the chat workspace is a native child view;
    // on web/mobile the legacy embedded workspace remains available.
    var EMBED_PARAM = window.desktopConsole ? "desktop" : "1";
    if (window.desktopConsole && window.desktopConsole.reportWorkspaceRect) {
        // DESKTOP: the first-party harness is a native WebContentsView floated over
        // this panel. Report only the content bounds; there is no secondary terminal
        // workspace or mode switch.
        /* The conversation is served from OUR origin at /_agent/workspace/, so it
         * renders here, in the page, laid out by the same grid as everything else.
         *
         * It used to be a native WebContentsView floated over this frame, which
         * meant the frame existed only to be measured: its rect was reported to
         * main on a resize listener, a ResizeObserver AND a one-second interval,
         * because a native view pinned over a page has no way to follow the
         * layout on its own. None of that is needed once the thing is IN the
         * layout — it moves because the grid moved.
         *
         * Same origin, so no CORS and no separate session: the API comes back
         * through /_agent/harness/*, where the proxy attaches the operator
         * credential server-side and it never reaches any renderer. */
        chatFrame.title = "Conversation";
        chatFrame.removeAttribute("aria-hidden");
        /* And hidden until it has something to show.
         *
         * A frame with no src is not an empty frame — it is about:blank, and
         * that document paints its own opaque WHITE base over whatever the
         * element's background says. #chat-frame is already set to
         * var(--background) for exactly this reason and it never had a chance:
         * measured with the daemon stopped, the conversation pane was a 600px
         * white slab down the right of a black window, and it stayed that way
         * until the daemon came back.
         *
         * The frame starts srcless and is emptied again every time the harness
         * goes away, so the white showed on a cold start as well as on a drop.
         * Hiding it lets .chat's own --background through, which is the colour
         * the pane is supposed to be; the titlebar pill already says why there
         * is nothing in it. [hidden] is !important in this sheet, so this holds
         * against #chat-frame's own display:block. */
        chatFrame.hidden = true;

        /* The harness is a separate process this app spawns, and it is not
         * listening the instant the window opens — the proxy answers 502 until
         * it is. Pointing the frame at the workspace straight away therefore put
         * a token prompt over a Bad Gateway, and nothing retried, so it sat
         * there long after the harness came up.
         *
         * The native view this replaces had exactly this machinery
         * (HarnessViewLifecycle: beginLoad / failed / scheduleRetry / loaded).
         * Moving the conversation into the page does not make the race go away,
         * so the retry has to move with it. Ask first, load once the answer is
         * real, and never let the frame see the error page at all. */
        var WORKSPACE_URL = "/_agent/workspace/";
        var workspaceShown = false;
        var workspaceRetryMs = 400;
        function harnessAnswering() {
            return fetch("/_agent/harness/api/runs?limit=1", {
                headers: { "X-PiKVM-Workspace": "1" },
                cache: "no-store",
            })
                .then(function (r) {
                    return r.ok;
                })
                .catch(function () {
                    return false;
                });
        }
        function pollWorkspace() {
            harnessAnswering().then(function (up) {
                if (up && !workspaceShown) {
                    workspaceShown = true;
                    chatFrame.src = WORKSPACE_URL;
                    chatFrame.hidden = false;
                    workspaceRetryMs = 400;
                } else if (!up && workspaceShown) {
                    /* It went away — a harness restart, or the app respawning it.
                     * Drop the frame so the conversation is not left showing a
                     * dead session, and let the poll bring it back. */
                    workspaceShown = false;
                    chatFrame.removeAttribute("src");
                    chatFrame.hidden = true;
                }
                var next = workspaceShown ? 5000 : (workspaceRetryMs = Math.min(Math.round(workspaceRetryMs * 1.6), 5000));
                setTimeout(pollWorkspace, next);
            });
        }
        pollWorkspace();

        /* Dev convenience: main watches the workspace build directory and tells
         * us when a rebuild lands, so the frame picks it up without restarting
         * the app. It used to reload the native view directly, which after the
         * move would have refreshed the copy nobody looks at. */
        if (window.desktopConsole.onWorkspaceReload) {
            window.desktopConsole.onWorkspaceReload(function () {
                if (workspaceShown && chatFrame.contentWindow) {
                    try {
                        chatFrame.contentWindow.location.reload();
                    } catch (e) {
                        chatFrame.src = WORKSPACE_URL;
                    }
                }
            });
        }

        // Agent-backend readiness pill: poll the daemon's /status (via the proxy) and
        // colour the titlebar dot. Tooltip enumerates each dependency the daemon needs.
        var bsEl = document.getElementById("backend-status");
        var bsText = document.getElementById("bs-text");
        if (bsEl) {
            /* Only write when something actually changed.
             *
             * This pill is role="status" aria-live="polite" and it is VISIBLE on
             * the desktop, so every write to its text is an announcement.
             * pollBackend runs every five seconds and called this unconditionally
             * with whatever it found, so reassigning the same string re-created
             * the text node and announced it again. Counted with a
             * MutationObserver over 22 seconds against a steady Pi:
             *
             *     backend-status  5 mutations   text "Agent ready" throughout
             *     overlay         0
             *     toast           0
             *
             * A screen reader therefore said "Agent ready" every five seconds
             * for as long as the window was open, and the two live regions that
             * behave were the ones that only write on a real change.
             *
             * dataset.state is still set every time: it drives the CSS and an
             * attribute write does not announce, so there is no reason to let it
             * drift out of step with the poll. */
            var lastBackend = null;
            var setBackend = function (state, label, tip) {
                bsEl.dataset.state = state;
                var key = state + "\n" + label + "\n" + tip;
                if (key === lastBackend) return;
                lastBackend = key;
                if (bsText) bsText.textContent = label;
                bsEl.title = tip;
            };
            var pollBackend = function () {
                fetch("/_agent/daemon/status", { cache: "no-store" })
                    .then(function (r) { if (!r.ok) throw r.status; return r.json(); })
                    .then(function (s) {
                        var d = s.dependencies || {};
                        var parts = ["Daemon: ready"];
                        parts.push("PiKVM: " + (d.pikvm && d.pikvm.reachable ? "reachable" : "unreachable"));
                        /* "loading…" was the client's own guess. The daemon
                         * reports reachable true or false and never says it is
                         * on its way, so an unreachable vision service was
                         * described as making progress it may not be making —
                         * this one has read "loading…" for hours. Report the
                         * fact, and say what it costs, since the daemon is
                         * explicit that it only gates autonomous perception. */
                        if (d.omniparser && d.omniparser.enabled)
                            parts.push(
                                "Vision: " +
                                    (d.omniparser.reachable
                                        ? "ready"
                                        : "unavailable (autonomous mode only)"),
                            );
                        if (d.operator)
                            parts.push("LLM: " + (d.operator.configured ? d.operator.provider : "no API key"));
                        if (d.ocr)
                            parts.push("OCR: " + d.ocr.provider + (d.ocr.available ? "" : " (missing)"));
                        var ready = !!s.ok;
                        /* The pill names its subject.
                         *
                         * It used to read a bare "Ready" / "Starting" /
                         * "Unavailable", and it sits in the titlebar a few
                         * hundred pixels from a stream overlay that says
                         * "Screen unavailable" about something else entirely.
                         * Two red states both saying "unavailable" about
                         * different subsystems, with only a tooltip to tell
                         * them apart, is a question the window should not be
                         * asking anyone. */
                        setBackend(ready ? "ready" : "starting",
                                   ready ? "Agent ready" : "Agent starting",
                                   "Agent daemon — " + parts.join("  ·  "));
                    })
                    .catch(function () {
                        setBackend("down", "Agent unavailable", "Agent daemon unreachable (starting, or not running)");
                    });
            };
            pollBackend();
            setInterval(pollBackend, 5000);
        }
    } else {
        // WEB / MOBILE: load the SAME shared terminal as desktop. The PTYs are hosted on the
        // server; this page connects to the /_agent/terminal WebSocket and sees the same tabs
        // + live output as every other device (full control). No native view needed here.
        chatFrame.src = "/_agent/terminal.html";
        chatFrame.title = "Terminal";
    }

    /* ---- pick up the server's keyboard layout (so symbols map right) ---- */
    fetch("/_agent/api/state")
        .then(function (r) {
            return r.json();
        })
        .then(function (s) {
            if (s && s.settings && (s.settings.keyboardLayout === "uk" || s.settings.keyboardLayout === "us"))
                layout = s.settings.keyboardLayout;
        })
        .catch(function () {});

    // The agent X-ray overlay, meeting copilot, suggestion cards and the overlay/
    // ambient SSE streams were removed with the in-app agent. `clearRegionMapForManualInput`
    // and `onXform` keep their safe no-op/null defaults declared above.

    // Keep the picture from being zoomed by the browser's own pinch.
    document.addEventListener("gesturestart", function (e) {
        e.preventDefault();
    });

    /* ===================================================================== *
     * NATIVE DESKTOP CONSOLE wiring — runs ONLY inside the Electron desktop
     * window, where the preload exposes `window.desktopConsole`. On any phone
     * or browser this whole block is skipped, so the web/mobile console is
     * completely unchanged. It: reveals the custom titlebar, wires the window
     * controls + panel toggle + fit-native, and swaps the HTML `.more-menu`
     * for a NATIVE Electron context menu (incl. live Audio/Mic toggles).
     * ===================================================================== */
    (function desktopConsole() {
        var dc = window.desktopConsole;
        /* The guard the comment above promises, at the top where it belongs.
         *
         * It used to sit ninety-eight lines further down, after three
         * `if (dc.onAgentAttached)`-style subscriptions that dereference dc at
         * load time. On web and mobile dc is undefined, so the block did not
         * skip — it threw:
         *
         *     TypeError: Cannot read properties of undefined
         *       (reading 'onAgentAttached')
         *
         * on every page load, and the guard itself was then unreachable. The
         * effect was benign only by luck: this IIFE is the last thing in the
         * file, so the abort took nothing else with it, and everything above
         * the throw is either a function declaration or desktop-only. Anything
         * appended to this file later would have silently not run on web.
         *
         * Safe to move because the two statements it now skips do not matter
         * off the desktop: the panel-message listener below is answered for
         * EVERY platform by the copy near applyTheme (its own comment says
         * why), and every html.agent-right rule in console.css is scoped to
         * html.desktop-console, so setting that class on a phone styled
         * nothing. */
        if (!dc) return; // web/mobile: nothing below runs

        /* ---- conversation placement: which side, or its own window ----
         * Side is a lasting preference (localStorage, like the theme and panel
         * width); detached is session state and intentionally not persisted. */
        var AGENT_SIDE_KEY = "pikvm-console-agent-side";
        function agentOnRight() {
            return document.documentElement.classList.contains("agent-right");
        }
        function agentDetached() {
            return document.documentElement.classList.contains("agent-detached");
        }
        /* The conversation's own header carries these controls, so it has to be
         * told where things stand — on its first paint and after every change,
         * whoever made it. The console stays the single owner of the state. */
        function currentPlacement() {
            return { side: agentOnRight() ? "right" : "left", detached: agentDetached() };
        }
        /* The conversation is a same-origin frame now, not a native view with a
         * preload, so its placement bridge is a postMessage rather than IPC. Both
         * are told: the detached WINDOW is still a native view and still needs the
         * IPC, and the two must never disagree about which side we are on. */
        function postToWorkspace(type, value) {
            var w = chatFrame && chatFrame.contentWindow;
            if (!w) return;
            try {
                w.postMessage({ channel: "pikvm-panel", type: type, value: value }, location.origin);
            } catch (e) {}
        }
        function publishAgentPlacement() {
            postToWorkspace("placement", currentPlacement());
            if (!dc.reportAgentPlacement) return;
            dc.reportAgentPlacement(currentPlacement());
        }
        /* Requests coming back the other way. Only from our own frame and our own
         * origin: this moves the panel and can open a window, so a message from
         * anywhere else is not a control input. */
        window.addEventListener("message", function (e) {
            if (!chatFrame || e.source !== chatFrame.contentWindow) return;
            if (e.origin !== location.origin) return;
            var d = e.data;
            if (!d || d.channel !== "pikvm-panel") return;
            if (d.type === "set-side") setAgentSide(d.value === "left" ? "left" : "right");
            else if (d.type === "toggle-detached") toggleAgentDetached();
            else if (d.type === "subscribe") {
                // It has just mounted and wants the current state, not the next change.
                postToWorkspace("placement", currentPlacement());
                postToWorkspace("theme", currentTheme());
            }
        });
        function setAgentSide(side) {
            document.documentElement.classList.toggle("agent-right", side === "right");
            try { localStorage.setItem(AGENT_SIDE_KEY, side); } catch (e) {}
            // Re-report the workspace rect NOW rather than at the next poll tick, so
            // the native harness view lands on the new side in the same frame.
            window.dispatchEvent(new Event("resize"));
            publishAgentPlacement();
        }
        // Right by default. The screen is what you look at, so it keeps the left
        // of the window; the conversation reads as a panel alongside it. Only an
        // explicit choice of "left" moves it back, so a storage failure lands on
        // the default rather than silently on the old side.
        var storedAgentSide = null;
        try {
            storedAgentSide = localStorage.getItem(AGENT_SIDE_KEY);
        } catch (e) {}
        if (storedAgentSide !== "left") document.documentElement.classList.add("agent-right");
        function toggleAgentDetached() {
            if (!dc.detachAgent) return;
            // Optimistically collapse the embedded panel; main opens the window. When
            // already detached the same message closes that window instead, and the
            // attach signal below restores the panel.
            if (!agentDetached()) {
                document.documentElement.classList.add("agent-detached");
                window.dispatchEvent(new Event("resize"));
            }
            dc.detachAgent();
            publishAgentPlacement();
        }
        if (dc.onAgentAttached) {
            dc.onAgentAttached(function () {
                document.documentElement.classList.remove("agent-detached");
                window.dispatchEvent(new Event("resize"));
                publishAgentPlacement();
            });
        }
        if (dc.onAgentThemeRequest) {
            dc.onAgentThemeRequest(function () {
                if (dc.reportAgentTheme) dc.reportAgentTheme(currentTheme());
            });
        }
        if (dc.onAgentPlacementCommand) {
            dc.onAgentPlacementCommand(function (command) {
                if (command.type === "side") setAgentSide(command.side);
                else if (command.type === "toggle-detached") toggleAgentDetached();
                else publishAgentPlacement();
            });
        }

        /* How much vertical space fit-native has to reserve above the picture.
         *
         * Measured rather than repeated: the height is set in console.css, and a
         * copy here would silently start reserving the wrong amount the moment
         * that changed. The fallback only covers the native shell, where the bar
         * belongs to ui.html and is not in this document to measure. */
        var NATIVE_SHELL_TITLEBAR_H = 38; // ui.html's strip; = TITLEBAR_HEIGHT in main.ts
        var nativeShellTitlebar = false;
        function titlebarHeight() {
            if (nativeShellTitlebar) return NATIVE_SHELL_TITLEBAR_H;
            var el = document.getElementById("titlebar");
            var measured = el ? Math.round(el.getBoundingClientRect().height) : 0;
            return measured || NATIVE_SHELL_TITLEBAR_H;
        }
        var savedPanelW = readPanelWidth();
        if (savedPanelW) applyPanelWidth(savedPanelW);
        document.documentElement.classList.add("desktop-console");
        // Platform → window-control style (GNOME/Adwaita on Linux, native traffic
        // lights on macOS so we hide our own, Windows keeps the default custom set).
        if (dc.platform) document.documentElement.classList.add("platform-" + dc.platform);
        if (dc.nativeControls) document.documentElement.classList.add("native-window-controls");

        // Block KVM mouse movement while the window is NOT focused — a background
        // window must not let a passing cursor drive the remote pointer.
        function applyWinFocus(focused) {
            windowFocused = focused;
            document.documentElement.classList.toggle("win-blur", !focused);
            // Drop the simulated cursor blob and restore the real OS cursor over the
            // screen, so an unfocused window shows a normal pointer instead of nothing.
            if (!focused && kvmCursor) kvmCursor.style.display = "none";
            // Alt+Tabbing away must not leave a modifier stuck down on the target —
            // the host stops sending us the keyup that would have released it.
            if (!focused) {
                releaseClickMods();
                releaseAllMods();
            }
        }
        if (window.desktopConsole && window.desktopConsole.onWindowFocus) {
            // Desktop: focus comes from the MAIN process (true window focus). A focused
            // terminal child view steals the console renderer's focus but NOT the window's,
            // so the KVM mouse keeps working as long as the whole window is focused.
            window.desktopConsole.onWindowFocus(applyWinFocus);
        } else {
            // Web/mobile: the document's own focus/blur is the window focus.
            window.addEventListener("focus", function () { applyWinFocus(true); });
            window.addEventListener("blur", function () { applyWinFocus(false); });
        }

        // Desktop keyboard: forward PHYSICAL keystrokes straight to the KVM. The agent
        // chat is an iframe, so when it has focus the parent document never sees the
        // key — this only fires for KVM-destined input. We skip our own editable fields.
        document.addEventListener("keydown", function (e) {
            if (!windowFocused) return;
            // A modal owns the keyboard while it is up — forwarding here would type
            // the dialog's own keystrokes onto the target as well.
            if (modalOpen()) {
                releaseAllMods();
                return;
            }
            /* The preview is hidden, so there is nothing to type AT.
             *
             * Same category as the two guards above: both mean the user is not
             * looking at the target, and this is the one case of that which was
             * missing. It also closes a split — with the preview collapsed the
             * screen is zero pixels wide, so no pointer event can reach it and
             * the mouse is already off; only the keyboard was still going, and
             * it is the half with no feedback at all. There is no picture, no
             * simulated cursor and no letterbox, so a keystroke that lands on
             * the target leaves nothing on screen to say it did.
             *
             * Paste text to the target… is the supported way to send input
             * without watching it arrive. */
            if (!panelShown()) {
                releaseAllMods();
                return;
            }
            /* Focus on one of OUR controls means the keystroke is ours.
             *
             * This listed INPUT, TEXTAREA and SELECT only, so a focused BUTTON
             * was captured and forwarded like any other key — and handleKeydown
             * calls preventDefault, which stops the browser doing what it would
             * have done. Enter on a titlebar button did not press it, it typed
             * Enter on the remote machine. Tab did not move to the next
             * control, it typed Tab. Focusing any console control from the
             * keyboard was a one-way trip: nothing could activate it and
             * nothing could leave it.
             *
             * FOCUSABLE is the same set the dialog focus traps use, so a
             * control that can hold focus is a control whose keys are its own.
             * Clicking the picture still blurs to BODY, which matches nothing
             * here, so typing at the target is unchanged. */
            var t = e.target;
            if (t && (t.isContentEditable || (t.closest && t.closest(FOCUSABLE)))) return;
            if (blockKvmInput(e)) return;
            noteManualKvmInput();
            // Printable keys are ours here (there is no hidden field in play), so the
            // produced character goes through — e.key already reflects the host's Shift
            // and Caps Lock, which is why the case is right on the caps-off target.
            handleKeydown(e, true);
        });
        /* Releasing the modifier is what ends the hold on the target, so this
         * listener is the other half of the feature — without it a modifier
         * would stay down forever. It is deliberately ungated: if the key went
         * down we must let it up, whatever the window state has become since. */
        document.addEventListener("keyup", function (e) {
            if (e.code) releaseMod(e.code);
        });

        // The MAIN desktop window keeps the original ui.html titlebar ABOVE the
        // console (?shell=native) — hide the console's own titlebar then, but keep all
        // the other desktop chrome (agent header, native menus, fit-native).
        var nativeShell = false;
        try {
            nativeShell = new URLSearchParams(location.search).get("shell") === "native";
        } catch (e) {}
        if (nativeShell) {
            document.documentElement.classList.add("native-titlebar");
            /* The console draws no titlebar in this mode, but ui.html's strip sits
             * above this view, so fit-native still has to reserve it — and it
             * cannot be measured from in here. */
            nativeShellTitlebar = true;
        }

        var titlebar = document.getElementById("titlebar");
        if (titlebar) titlebar.setAttribute("aria-hidden", "false");

        /* ---- window controls ---- */
        /* The window's own controls, drawn by the shared component library but
         * keeping .tb-btn and .tb-win from console.css. Both classes are load
         * bearing and neither shows up in a screenshot: .tb-btn carries
         * -webkit-app-region:no-drag, without which these become part of the
         * window drag region and stop responding to clicks at all, and .tb-win
         * carries the platform treatment. Their container keeps the z-index that
         * holds them above a modal scrim. */
        var windowMaximised = false;
        function windowButtonSpecs() {
            return [
                { id: "win-min", label: "Minimise", icon: TB_ICONS.winmin, className: "tb-btn tb-win", onSelect: function () { dc.minimise(); } },
                {
                    id: "win-max",
                    // The glyph used to be two SVGs swapped by a class on the
                    // titlebar. One state, one icon, chosen here.
                    label: windowMaximised ? "Restore" : "Maximise",
                    icon: windowMaximised ? TB_ICONS.winrestore : TB_ICONS.winmax,
                    className: "tb-btn tb-win",
                    onSelect: function () { dc.toggleMaximise(); },
                },
                { id: "win-close", label: "Close", icon: TB_ICONS.winclose, className: "tb-btn tb-win tb-close", onSelect: function () { dc.close(); } },
            ];
        }
        function paintMax(maxed) {
            windowMaximised = !!maxed;
            if (titlebar) titlebar.classList.toggle("is-maximised", !!maxed);
            if (windowButtons) windowButtons.update(withTbClass(windowButtonSpecs()));
        }
        Promise.resolve(dc.isMaximised && dc.isMaximised()).then(paintMax).catch(function () {});
        if (dc.onMaximiseChange) dc.onMaximiseChange(paintMax);
        // Double-clicking the drag area toggles maximise, like a native titlebar.
        if (titlebar) {
            titlebar.addEventListener("dblclick", function (e) {
                if (e.target.closest && e.target.closest(".tb-btn")) return;
                dc.toggleMaximise();
            });
        }

        /* The title is centred on the WINDOW, not on the space left between the
         * two clusters, because a title that shifts as buttons come and go reads
         * as a wobble. The cost is that it can run underneath them: the right
         * cluster grows with every pinned macro, and at the 900px minimum window
         * "PiKVM" was drawn straight over two macro icons.
         *
         * So it yields. Nothing else can give way — the buttons are all doing a
         * job and the title is the one thing here that is only decoration. */
        var tbTitle = document.getElementById("tb-title");
        var tbLeft = document.querySelector(".tb-left");
        var tbRight = document.querySelector(".tb-right");
        function fitTitle() {
            if (!tbTitle || !tbLeft || !tbRight) return;
            // Measured unhidden, or it would never come back once it went away.
            tbTitle.style.visibility = "";
            var t = tbTitle.getBoundingClientRect();
            if (!t.width) return;
            var GAP = 8; // a hair of air, so it does not sit flush against an icon
            var clear = t.left >= tbLeft.getBoundingClientRect().right + GAP && t.right <= tbRight.getBoundingClientRect().left - GAP;
            tbTitle.style.visibility = clear ? "" : "hidden";
        }
        fitTitle();
        window.addEventListener("resize", fitTitle);
        /* Watching the clusters, not just the window: they change width on their
         * own when a macro is pinned, when the health warning appears, or when the
         * audio pair is revealed by a WebRTC session — none of which resize
         * anything. Observing the boxes catches every one of those without each
         * having to remember to call this. */
        if (window.ResizeObserver) {
            var titleFit = new ResizeObserver(fitTitle);
            titleFit.observe(tbLeft);
            titleFit.observe(tbRight);
        }

        /* ---- supporting computer preview collapse (titlebar-left toggle) ---- */
        function panelShown() {
            return !app.classList.contains("computer-collapsed");
        }
        /* Drawn by the shared component library, so this hands it new props
         * rather than writing four attributes onto a node. The label is the
         * ACTION, not the state — "Hide target preview" while it is showing —
         * which is why aria-pressed carries the state separately. */
        /* Every titlebar button carries .tb-btn, drawn by the shared component
         * or not.
         *
         * Two things live on that class and neither is decoration. It sets
         * -webkit-app-region:no-drag: the titlebar IS the window drag region,
         * and a button inside one without this is a surface the window manager
         * takes the click from — which CDP cannot catch, because dispatched
         * input goes straight to the renderer and never meets the compositor.
         * And it carries the focus ring; the component's own ring resolves
         * against a --ring this document does not define, so it came out fully
         * transparent. Measured: the window controls showed a solid 2px ring
         * because they kept .tb-btn, and the twelve that had lost it showed
         * rgba(0,0,0,0).
         *
         * Applied in one place so a new button cannot quietly miss it. */
        function withTbClass(specs) {
            return specs.map(function (spec) {
                var extra = spec.className ? " " + spec.className : "";
                var out = {};
                for (var k in spec) if (Object.prototype.hasOwnProperty.call(spec, k)) out[k] = spec[k];
                out.className = "tb-btn" + extra;
                return out;
            });
        }
        function statusButtonSpecs() {
            var h = tbState.health;
            var p = tbState.power;
            return [
                {
                    id: "health",
                    label: h.label,
                    icon: TB_ICONS.health,
                    hidden: !h.visible,
                    className: "tb-health" + (h.error ? " is-error" : ""),
                    onSelect: openHealthDialog,
                },
                {
                    id: "power",
                    label: p.label,
                    icon: TB_ICONS.power,
                    hidden: !p.visible,
                    className: (p.on ? "atx-on" : "") + (p.busy ? " atx-busy" : ""),
                    onSelect: function () {
                        var r = tbRect("power");
                        dc.popupMenu(
                            ATX_ACTIONS.map(function (a) {
                                return { id: "atx:" + a.id, label: a.label, enabled: !atx.busy() };
                            }),
                            { x: r.left, y: r.bottom },
                        );
                    },
                },
            ];
        }
        function avButtonSpecs() {
            return ["audio", "mic"].map(function (which) {
                var st = avState[which];
                var base = which === "mic" ? "Microphone" : "Audio output";
                return {
                    id: which,
                    /* The in-page twin spells the state out beside it — "On",
                     * "Denied", "No mic". This has room for none of that, so it
                     * goes in the label rather than living only in a colour. */
                    label: st.warn && st.label ? base + " — " + st.label : base,
                    icon: TB_ICONS[which],
                    pressed: !!st.on,
                    hidden: !avState.visible,
                    className: "tb-av" + (st.on ? " on" : "") + (st.warn ? " warn" : ""),
                    onSelect: function () {
                        var b = document.getElementById(which === "mic" ? "mic-btn" : "audio-btn");
                        if (b) b.click();
                    },
                };
            });
        }
        function panelButtonSpecs() {
            var shown = panelShown();
            return [
                {
                    id: "panel",
                    label: shown ? "Hide target preview" : "Show target preview",
                    icon: TB_ICONS.panel,
                    pressed: shown,
                    onSelect: function () { setPanel(!panelShown()); },
                },
            ];
        }
        function paintPanelToggle() {
            if (panelButtons) panelButtons.update(withTbClass(panelButtonSpecs()));
        }
        function setPanel(show) {
            if (show === panelShown()) return;
            app.classList.toggle("computer-collapsed", !show);
            paintPanelToggle();
            /* The conversation's width changes with the collapse, and the divider
             * announces that width. Repaint after the class change so it never
             * reports the stretched size once the preview is back. */
            repaintPanelDivider();
        }
        paintPanelToggle();

        /* ---- fit to native resolution ---- */
        function nativeDims() {
            var nw = webrtcActive ? vid.videoWidth : img.naturalWidth;
            var nh = webrtcActive ? vid.videoHeight : img.naturalHeight;
            return nw && nh ? { w: nw, h: nh } : null;
        }
        function fitNativeNow() {
            var d = nativeDims();
            if (!d) return false;
            if (!panelShown()) setPanel(true);
            var pane = document.getElementById("screen-pane");
            if (!pane) return false;
            /* Everything in the window that is NOT the screen's content box.
             *
             * This used to be sent as a list of the parts main should add back —
             * the chat column and the titlebar — and the list was one short. The
             * screen pane carries a 1px right border as the divider against the
             * panel, so the pane was handed the native width as its BORDER box
             * and its content box came out a pixel narrower. object-fit then
             * scaled 1920x1080 down to 1919x1079.44: a resample and a sliver of
             * letterbox, from the one button whose entire job is neither.
             *
             * Measured as a single leftover instead, so the divider is included
             * because it is there rather than because someone remembered it, and
             * a future column or status bar needs nothing added here. */
            dc.fitNative({
                width: d.w,
                height: d.h,
                chromeWidth: Math.round(document.documentElement.clientWidth - pane.clientWidth),
                chromeHeight: Math.round(document.documentElement.clientHeight - pane.clientHeight),
            });
            return true;
        }
        var nativeFitTimer = null;
        var lastNativeFitKey = "";
        onStreamResolutionChange = function (key) {
            if (!key || key === lastNativeFitKey) return;
            lastNativeFitKey = key;
            if (nativeFitTimer) clearTimeout(nativeFitTimer);
            nativeFitTimer = setTimeout(function () {
                nativeFitTimer = null;
                fitNativeNow();
            }, 0);
        };
        /* ---- titlebar buttons drawn by the conversation's component library ----
         *
         * The console keeps owning what these do and when; React is only told
         * what to draw. That split matters: nothing about how this page talks to
         * the target moves into a framework, and the buttons stop being a second
         * design system with the operating system's tooltip on them.
         *
         * The menus need the button's own rectangle to open beneath it, so they
         * find it by data-tb rather than being handed a node — React owns that
         * element and may replace it on any update. */
        var TB_ICONS = {
            more: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"5\" cy=\"12\" r=\"1\"/><circle cx=\"12\" cy=\"12\" r=\"1\"/><circle cx=\"19\" cy=\"12\" r=\"1\"/></svg>",
            keys: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"2\" y=\"6\" width=\"20\" height=\"12\" rx=\"2\"/><path d=\"M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12\"/></svg>",
            fit: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M9 9 4 4M4 9V4h5\"/><path d=\"m15 9 5-5M15 4h5v5\"/><path d=\"M9 15l-5 5M4 15v5h5\"/><path d=\"m15 15 5 5M20 15v5h-5\"/></svg>",
            audio: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M11 5 6 9H2v6h4l5 4V5z\"/><path class=\"wave\" d=\"M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14\"/></svg>",
            mic: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"9\" y=\"2\" width=\"6\" height=\"11\" rx=\"3\"/><path d=\"M5 10a7 7 0 0 0 14 0M12 17v4\"/></svg>",
            health: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 3 2 20h20L12 3z\"/><path d=\"M12 10v4M12 17h.01\"/></svg>",
            power: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 3v9\"/><path d=\"M18.4 6.6a9 9 0 1 1-12.8 0\"/></svg>",
            winmin: "<svg viewBox=\"0 0 16 16\" fill=\"currentColor\"><path d=\"m 4 10.007812 h 8 v 1.988282 h -8 z m 0 0\"/></svg>",
            winmax: "<svg viewBox=\"0 0 16 16\" fill=\"currentColor\"><path d=\"m 3.988281 3.992188 v 8.011718 h 8.011719 v -8.011718 z m 2 2 h 4.011719 v 4.011718 h -4.011719 z m 0 0\"/></svg>",
            winrestore: "<svg viewBox=\"0 0 16 16\" fill=\"currentColor\"><path d=\"m 4.988281 4.992188 v 6.011718 h 6.011719 v -6.011718 z m 2 2 h 2.011719 v 2.011718 h -2.011719 z m 0 0\"/></svg>",
            winclose: "<svg viewBox=\"0 0 16 16\" fill=\"currentColor\"><path d=\"m 4 4 h 1 h 0.03125 c 0.253906 0.011719 0.511719 0.128906 0.6875 0.3125 l 2.28125 2.28125 l 2.3125 -2.28125 c 0.265625 -0.230469 0.445312 -0.304688 0.6875 -0.3125 h 1 v 1 c 0 0.285156 -0.035156 0.550781 -0.25 0.75 l -2.28125 2.28125 l 2.25 2.25 c 0.1875 0.1875 0.28125 0.453125 0.28125 0.71875 v 1 h -1 c -0.265625 0 -0.53125 -0.09375 -0.71875 -0.28125 l -2.28125 -2.28125 l -2.28125 2.28125 c -0.1875 0.1875 -0.453125 0.28125 -0.71875 0.28125 h -1 v -1 c 0 -0.265625 0.09375 -0.53125 0.28125 -0.71875 l 2.28125 -2.25 l -2.28125 -2.28125 c -0.210938 -0.195312 -0.304688 -0.46875 -0.28125 -0.75 z m 0 0\"/></svg>",
            panel: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"14\" rx=\"2\"/><path d=\"M8 21h8M12 18v3\"/></svg>",
            settings: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z\"/></svg>",
        };
        function tbRect(id) {
            var el = document.querySelector('[data-tb="' + id + '"]');
            return el ? el.getBoundingClientRect() : { left: 0, bottom: 38 };
        }
        var menuButtons = null;
        var viewButtons = null;
        var panelButtons = null;
        var avButtons = null;
        var statusButtons = null;
        var macroButtonsRoot = null;
        var windowButtons = null;
        function viewButtonSpecs() {
            var dims = nativeDims();
            /* "Waiting for a picture" is false while one is on screen.
             *
             * nativeDims reads the <img>, and the whole point of the freeze is
             * that the img has gone empty while the last frame stays visible on
             * the canvas. So during a reconnect this button sat there telling
             * the user there was no picture, directly underneath one.
             *
             * It stays disabled: the held frame's size is the resolution from
             * BEFORE the drop, and sizing the window to it is a guess that the
             * target did not change mode while the link was down. But the
             * reason it gives is now the true one. */
            var held = !dims && pane.classList.contains("frozen");
            return [
                {
                    id: "fit",
                    label: dims
                        ? "Fit to native resolution (" + dims.w + " x " + dims.h + ")"
                        : held
                          ? "Fit to native resolution — waiting for the stream to come back"
                          : "Fit to native resolution — waiting for a picture",
                    icon: TB_ICONS.fit,
                    disabled: !dims,
                    onSelect: fitNativeNow,
                },
                { id: "settings", label: "Settings", icon: TB_ICONS.settings, onSelect: openSettingsWindow },
            ];
        }
        function mountTitlebarButtons() {
            var shared = window.pikvmShared;
            if (!shared) return false;
            var menusHost = document.getElementById("tb-actions-menus");
            var viewHost = document.getElementById("tb-actions-view");
            if (menusHost && !menuButtons) {
                menuButtons = shared.mountIconButtons(menusHost, withTbClass([
                    {
                        id: "more",
                        label: "More actions",
                        icon: TB_ICONS.more,
                        onSelect: function () {
                            var r = tbRect("more");
                            popNative({ x: r.left, y: r.bottom });
                        },
                    },
                    {
                        id: "keys",
                        label: "Send a keyboard shortcut to the target",
                        icon: TB_ICONS.keys,
                        onSelect: function () {
                            var r = tbRect("keys");
                            popSendKeys({ x: r.left, y: r.bottom });
                        },
                    },
                ]));
            }
            if (viewHost && !viewButtons) viewButtons = shared.mountIconButtons(viewHost, withTbClass(viewButtonSpecs()));
            var panelHost = document.getElementById("tb-actions-panel");
            if (panelHost && !panelButtons) panelButtons = shared.mountIconButtons(panelHost, withTbClass(panelButtonSpecs()));
            var windowHost = document.getElementById("tb-window");
            if (windowHost && !windowButtons) windowButtons = shared.mountIconButtons(windowHost, withTbClass(windowButtonSpecs()));
            var macroHost = document.getElementById("tb-macros");
            if (macroHost && !macroButtonsRoot) {
                macroButtonsRoot = shared.mountIconButtons(macroHost, withTbClass(pinnedMacroSpecs()));
                repaintMacroButtons = function () {
                    if (macroButtonsRoot) macroButtonsRoot.update(withTbClass(pinnedMacroSpecs()));
                };
                repaintMacroButtons();
                /* Bring a tabbed-to macro fully into view.
                 *
                 * This strip clips (overflow:hidden) so it can give way instead
                 * of pushing the window controls off the bar, and the browser
                 * scrolls a focused child back into view on its own — but only
                 * when that child is ENTIRELY outside the scrollport. The one
                 * straddling the clip edge counts as visible, so it is left
                 * exactly where it is. Measured at 900px with sixty macros,
                 * tabbing along the strip:
                 *
                 *     macro 16 : 100% visible, scrollLeft=0
                 *     macro 17 :  53% visible, scrollLeft=0
                 *     macro 18 : 100% visible, scrollLeft=321
                 *
                 * So every macro is reachable except the one you always land on
                 * crossing from the visible set into the clipped set, which sits
                 * half cut with half its focus ring gone. "nearest" scrolls the
                 * minimum needed and does nothing at all when the button is
                 * already whole, so this costs nothing in the common case. */
                macroHost.addEventListener("focusin", function (e) {
                    var btn = e.target && e.target.closest && e.target.closest("button");
                    if (btn && macroHost.contains(btn)) btn.scrollIntoView({ block: "nearest", inline: "nearest" });
                });
            }
            var statusHost = document.getElementById("tb-actions-status");
            if (statusHost && !statusButtons) {
                statusButtons = shared.mountIconButtons(statusHost, withTbClass(statusButtonSpecs()));
                /* Re-render only when the state behind these buttons moved.
                 *
                 * paintHealth and the ATX painter both end in this, and both run
                 * on every event of their kind — so an unchanged Pi still
                 * re-rendered the health and power buttons continuously. Counted
                 * titlebar mutations for six IDENTICAL events of each type:
                 *
                 *     msd 0   streamer 0   gpio 0
                 *     info 6   atx 6   hid 6
                 *
                 * The three that churned are exactly the three that reach here.
                 * The specs are built from tbState alone, so comparing that is
                 * the same question as "would the render differ", without having
                 * to compare specs that carry functions. */
                var lastTbKey = null;
                repaintTbState = function () {
                    if (!statusButtons) return;
                    var key = JSON.stringify([tbState.health, tbState.power]);
                    if (key === lastTbKey) return;
                    lastTbKey = key;
                    statusButtons.update(withTbClass(statusButtonSpecs()));
                };
                repaintTbState();
            }
            var avHost = document.getElementById("tb-actions-av");
            if (avHost && !avButtons) {
                avButtons = shared.mountIconButtons(avHost, withTbClass(avButtonSpecs()));
                repaintAv = function () {
                    if (avButtons) avButtons.update(withTbClass(avButtonSpecs()));
                };
                repaintAv();
            }
            return !!(menuButtons && viewButtons && panelButtons && avButtons && statusButtons && macroButtonsRoot && windowButtons);
        }
        /* The bundle is a module, so it has not run when this line does. Poll
         * briefly rather than racing it; if it never arrives the console is
         * simply missing two buttons rather than broken. */
        if (!mountTitlebarButtons()) {
            var mountTries = 0;
            var mountTimer = setInterval(function () {
                if (mountTitlebarButtons() || ++mountTries > 100) clearInterval(mountTimer);
            }, 50);
        }
        /* Without a frame there are no native dimensions, so fitNativeNow returns
         * false and nothing happens at all — a button that looks available and
         * silently does not work. Say which it is, and name the size it would fit
         * to when it can, since that is the one thing the label cannot tell you. */
        repaintFitButton = function () {
            // The button is drawn by the shared component library now, so this
            // hands it new props rather than reaching for a DOM node.
            if (viewButtons) viewButtons.update(withTbClass(viewButtonSpecs()));
        };
        repaintFitButton();
        // The dimensions can change without the stream state changing at all.
        img.addEventListener("load", repaintFitButton);
        vid.addEventListener("resize", repaintFitButton);

        /* The titlebar audio/mic pair still drive the canonical toggles — the
         * hidden menu buttons that run setAudio/setMic and getUserMedia — but
         * that click now lives in their spec, beside the state it reflects. */

        // Titlebar Settings opens in its own window. Visible button so it's
        // discoverable (not just in the ⋯ menu).
        function openSettingsWindow() {
            var desk = window.desktopConsole;
            if (desk && desk.openSettingsWindow) desk.openSettingsWindow();
        }

        /* ---- NATIVE context menu (replaces the HTML .more-menu) ----
         * The same actions the web ⋯ menu offers, plus the WebRTC Audio/Mic
         * checkbox toggles reflecting the live state. We DELEGATE the actual work
         * to the existing buttons/handlers (click them) so there is one source of
         * truth — desktop just renders the menu natively and routes the pick. */
        var audioBtnEl = document.getElementById("audio-btn");
        var micBtnEl = document.getElementById("mic-btn");
        function avAvailable() {
            // The toggles are unhidden by revealAvToggles() once WebRTC is live.
            return !!(audioBtnEl && !audioBtnEl.hidden);
        }
        /* The conversation owns its own history and copy controls, so this outer
         * shell menu carries neither. The branch that offered them was picked by
         * isDesktopWorkspace, which is invariably true here: everything in this
         * block runs only when window.desktopConsole exists, and the preload
         * always defines reportWorkspaceRect on it. So the alternative was
         * unreachable, and its two commands posted messages into a frame that is
         * blank on the desktop and, on web, runs a terminal that ignores them. */
        function buildMenu() {
            var items = [{ id: "settings", label: "Settings" }];
            if (avAvailable()) {
                items.push({ type: "separator" });
                items.push({ id: "audio", label: "Audio output", type: "checkbox", checked: audioOn });
                items.push({ id: "mic", label: "Microphone", type: "checkbox", checked: micOn });
            }
            /* Detaching the conversation and swapping its side used to sit here,
             * in the menu belonging to the OTHER half of the window. They live in
             * the conversation's own header now, next to everything else about
             * it; runCommand still answers both ids for the non-desktop path. */
            items.push({ type: "separator" });
            items.push({ id: "paste", label: "Paste text to the target…" });
            if (atx.available()) {
                items.push({ type: "separator" });
                for (var a = 0; a < ATX_ACTIONS.length; a++) {
                    items.push({ id: "atx:" + ATX_ACTIONS[a].id, label: ATX_ACTIONS[a].label, enabled: !atx.busy() });
                }
            }
            items.push({ type: "separator" });
            items.push({ id: "panel", label: panelShown() ? "Hide target preview" : "Show target preview" });
            if (screenAlertsAvailable()) {
                items.push({ id: "alerts", label: "Pulse the taskbar when the screen changes", type: "checkbox", checked: screenAlertsEnabled() });
            }
            items.push({ id: "fit", label: "Fit to native resolution", enabled: !!nativeDims() });
            items.push({ id: "stream", label: "Stream settings…" });
            items.push({ id: "screenshot", label: "Save screenshot", enabled: !screenshotBusy });
            items.push({ id: "health", label: "System, GPIO & health…" });
            if (msd.available()) items.push({ id: "msd", label: "Mass storage…" });
            // enabled, not omitted: the entry is a property of this Pi, and
            // dropping it entirely would make it look unsupported. Same shape
            // as "Fit to native resolution" above, for the same reason.
            if (ocrAvailable())
                items.push({ id: "ocr", label: "Read text from the screen…", enabled: screenHasPicture() });
            items.push({ id: "log", label: "PiKVM log…" });
            items.push({ id: "macros", label: "Macros…" });
            items.push({ id: "theme", label: "Toggle theme" });
            if (streamMode === "native") {
                items.push({ type: "separator" });
                items.push({ id: "full-ui", label: "Full PiKVM UI" });
            }
            return items;
        }
        function runCommand(id) {
            if (id.indexOf("kb:") === 0) {
                runShortcut(id.slice(3));
                return;
            }
            if (id.indexOf("atx:") === 0) {
                runAtxAction(id.slice(4));
                return;
            }
            if (id === "paste") {
                openPasteDialog();
                return;
            }
            if (id === "stream") {
                openStreamDialog();
                return;
            }
            if (id === "screenshot") {
                saveScreenshot();
                return;
            }
            if (id === "health") {
                openHealthDialog();
                return;
            }
            if (id === "msd") {
                openMsdDialog();
                return;
            }
            if (id === "ocr") {
                startOcrPick();
                return;
            }
            if (id === "log") {
                openLogDialog();
                return;
            }
            if (id === "macros") {
                openMacroEditor();
                return;
            }
            if (id.indexOf("macro:") === 0) {
                runMacro(macroById(id.slice(6)));
                return;
            }
            switch (id) {
                case "settings":
                    if (window.desktopConsole.openSettingsWindow) {
                        window.desktopConsole.openSettingsWindow();
                    }
                    break;
                case "audio":
                    if (audioBtnEl) audioBtnEl.click();
                    break;
                case "mic":
                    if (micBtnEl) micBtnEl.click();
                    break;
                case "panel":
                    setPanel(!panelShown());
                    break;
                case "alerts":
                    setScreenAlerts(!screenAlertsEnabled());
                    break;
                case "fit":
                    /* This read a variable named tbFit, and tbFit is declared
                     * nowhere — one occurrence in the file, the read. So this
                     * threw ReferenceError every time and the ⋯ menu's "Fit to
                     * native resolution" did nothing, while sitting there
                     * enabled whenever the stream reported dimensions. The
                     * sibling cases delegate to real elements (audioBtnEl,
                     * micBtnEl, themeBtn all exist); this one delegated to a
                     * name that never did. Calls what the titlebar button
                     * calls, rather than a button standing in for it. */
                    fitNativeNow();
                    break;
                case "theme":
                    if (themeBtn) themeBtn.click();
                    break;
                case "full-ui":
                    location.href = "/?native=1";
                    break;
            }
        }
        if (dc.onMenuCommand) dc.onMenuCommand(runCommand);

        // The ⋯ button + a right-click anywhere (outside the chat iframe — that owns
        // its own menus) pop the native menu instead of the HTML one.
        function popNative(anchor) {
            dc.popupMenu(buildMenu(), anchor || undefined);
        }
        var moreBtnEl = document.getElementById("more-btn");
        if (moreBtnEl) {
            // Stop the HTML .more-menu from opening; pop the native one at the button.
            moreBtnEl.addEventListener(
                "click",
                function (e) {
                    e.stopPropagation();
                    e.preventDefault();
                    var r = moreBtnEl.getBoundingClientRect();
                    popNative({ x: r.left, y: r.bottom });
                },
                true // capture: beat the existing HTML-menu handler
            );
        }
        // Right-click on the desktop chrome (not the live screen — that forwards a
        // remote right-click — and not the chat iframe) opens the native menu.
        document.addEventListener("contextmenu", function (e) {
            if (e.target.closest && (e.target.closest(".screen") || e.target.closest(".chat"))) return;
            e.preventDefault();
            popNative({ x: e.clientX, y: e.clientY });
        });

        /* ---- send a keyboard shortcut/chord to the KVM target ---- */
        var KVM_SHORTCUTS = [
            { id: "cad", label: "Ctrl + Alt + Delete", mods: ["ControlLeft", "AltLeft"], code: "Delete" },
            { id: "taskmgr", label: "Ctrl + Shift + Esc  (Task Manager)", mods: ["ControlLeft", "ShiftLeft"], code: "Escape" },
            { id: "alttab", label: "Alt + Tab", mods: ["AltLeft"], code: "Tab" },
            { id: "altf4", label: "Alt + F4  (Close window)", mods: ["AltLeft"], code: "F4" },
            { id: "win", label: "Windows / Super key", mods: [], code: "MetaLeft" },
            { id: "wind", label: "Win + D  (Show desktop)", mods: ["MetaLeft"], code: "KeyD" },
            { id: "winl", label: "Win + L  (Lock)", mods: ["MetaLeft"], code: "KeyL" },
            { id: "winr", label: "Win + R  (Run)", mods: ["MetaLeft"], code: "KeyR" },
            { id: "prtsc", label: "Print Screen", mods: [], code: "PrintScreen" },
            { id: "esc", label: "Escape", mods: [], code: "Escape" },
        ];
        function runShortcut(sid) {
            for (var i = 0; i < KVM_SHORTCUTS.length; i++) {
                if (KVM_SHORTCUTS[i].id === sid) {
                    sendChord(KVM_SHORTCUTS[i].mods, KVM_SHORTCUTS[i].code, false);
                    return;
                }
            }
        }
        /* The desktop titlebar had no ⋯ button — the native menu was reachable
         * only by right-clicking the chrome, which meant everything in it
         * (models, stream, macros, health, log, detach) was effectively hidden.
         * These two buttons make the common ones findable. */
        /* Detach used to be a button here. It acts on the conversation, so it
         * sits in the conversation's own header now, beside the rest of its
         * controls, and this bar is left to the target and the window. */

        // Titlebar power button: the same three actions, one click away rather than
        // buried in the ⋯ menu. Powering a hung machine is why a KVM exists.
        /* Named, not inline on a listener, because the button that opens it is
         * rendered by the shared component library now and hands us only its
         * position. The menu itself is unchanged. */
        function popSendKeys(anchor) {
            // Paste sits at the top of the "send to target" menu: it is the same
            // idea as a shortcut (keystrokes the target receives) and it is the
            // one people hunt for.
            var items = [{ id: "paste", label: "Paste text…" }];
            if (macros.length) {
                items.push({ type: "separator" });
                macros.forEach(function (m) {
                    items.push({ id: "macro:" + m.id, label: m.label });
                });
            }
            items.push({ type: "separator" });
            dc.popupMenu(
                items.concat(
                    KVM_SHORTCUTS.map(function (s) {
                        return { id: "kb:" + s.id, label: s.label };
                    }),
                ),
                anchor,
            );
        }

        // The window starts wide enough for the desktop layout immediately, so fit
        // the screen once the first frame is known.
        setTimeout(function () { try { fitAspect(); } catch (e) {} }, 0);
    })();
})();
