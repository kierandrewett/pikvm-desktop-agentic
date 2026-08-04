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

    var pure = {
        charToKey: charToKey,
        fracToNorm: fracToNorm,
        streamPath: streamPath,
        streamModeForInfo: streamModeForInfo,
    };
    if (typeof module !== "undefined" && module.exports) module.exports = pure;
    if (typeof window === "undefined") return; // node test: stop before DOM wiring

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
        var connecting = false;
        var queue = [];
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
                connecting = false;
                if (onStatus) onStatus(true);
                var q = queue;
                queue = [];
                q.forEach(raw);
            };
            ws.onclose = function () {
                open = false;
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
                    if (d && d.event_type === "hid_keymaps" && ed && ed.keymaps) kvmdKeymaps = ed.keymaps;
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
                var ev = obj && obj.event;
                var release = ev && ev.state === false && (obj.event_type === "key" || obj.event_type === "mouse_button");
                if (!release) return;
            }
            if (open && ws && ws.readyState === 1) raw(obj);
            else {
                if (queue.length < 256) queue.push(obj);
                connect();
            }
        }
        return {
            connect: connect,
            isOpen: function () {
                return open;
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
     *  longer, because a failed power action is worth actually reading. */
    function toast(msg, error) {
        if (!toastEl) return;
        toastEl.textContent = msg;
        toastEl.classList.toggle("is-error", !!error);
        toastEl.classList.add("show");
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(
            function () {
                toastEl.classList.remove("show");
            },
            error ? 6000 : 2600,
        );
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
        var tb = document.getElementById("tb-power");
        if (tb) {
            tb.hidden = !show;
            var powered = atx.powered();
            tb.classList.toggle("atx-on", powered === true && !busy);
            tb.classList.toggle("atx-busy", busy);
            tb.title = !show ? "Power" : busy ? "Power — busy" : powered ? "Power — target is on" : "Power — target is off";
        }
    });

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
    var pasteSend = document.getElementById("paste-send");

    function paintPasteCount() {
        if (!pasteCount || !pasteText) return;
        var n = pasteText.value.length;
        pasteCount.textContent = n ? n + (n === 1 ? " character" : " characters") : "";
        if (pasteSend) pasteSend.disabled = !n;
    }
    function fillKeymaps() {
        if (!pasteKeymap) return;
        var km = kvmdKeymaps || {};
        var avail = km.available && km.available.length ? km.available : km["default"] ? [km["default"]] : [];
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
        var keymap = pasteKeymap && pasteKeymap.value ? pasteKeymap.value : null;
        var q = ["limit=0"];
        if (keymap) q.push("keymap=" + encodeURIComponent(keymap));
        // 20ms between keys — kvmd's own default, and slow enough that a target under
        // load does not drop characters.
        q.push("delay=0.02");
        if (pasteSend) pasteSend.disabled = true;
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
                if (pasteSend) pasteSend.disabled = false;
            });
    }
    var pasteBtn = document.getElementById("paste-btn");
    if (pasteBtn) pasteBtn.addEventListener("click", openPasteDialog);
    if (pasteText) pasteText.addEventListener("input", paintPasteCount);
    if (pasteSend) pasteSend.addEventListener("click", sendPaste);
    var pasteCancel = document.getElementById("paste-cancel");
    if (pasteCancel) pasteCancel.addEventListener("click", closePaste);
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
    /** True while the paste dialog owns the keyboard. */
    function pasteDialogOpen() {
        return !!(pasteDlg && !pasteDlg.hidden);
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
    var keyQ = [];
    var keyBusy = false;
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
            return;
        }
        keyBusy = true;
        var op = keyQ.shift();
        for (var i = 0; i < op.mods.length; i++) hid.key(op.mods[i], true);
        setTimeout(
            function () {
                hid.key(op.code, true);
                setTimeout(function () {
                    hid.key(op.code, false);
                    for (var j = op.mods.length - 1; j >= 0; j--) hid.key(op.mods[j], false);
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
    var overlayTitle = document.getElementById("overlay-title");
    var overlayDetail = document.getElementById("overlay-detail");
    var overlayRetry = document.getElementById("overlay-retry");
    var conn = document.getElementById("conn");
    var connText = document.getElementById("conn-text");
    var titleText = document.getElementById("tb-title");
    var kbd = document.getElementById("kbd");
    var chatFrame = document.getElementById("chat-frame");
    var TERM_W_KEY = "pikvm-chat-workspace-width-v2";
    function clampPanelWidth(w) {
        return Math.round(Math.max(560, Math.min(1100, Number(w) || 760)));
    }
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
            title: "Connecting to computer",
            detail: "Waiting for the first screen frame.",
        },
        live: {
            tone: "ok",
            label: "Live",
            title: "Screen connected",
            detail: "",
        },
        nosignal: {
            tone: "warn",
            label: "No signal",
            title: "No display signal",
            detail: "The computer is connected, but it is not producing a picture.",
            retry: true,
        },
        offline: {
            tone: "bad",
            label: "Reconnecting",
            title: "Screen paused",
            detail: "Keeping the last frame visible while the screen reconnects.",
            retry: true,
        },
        reconnecting: {
            tone: "",
            label: "Reconnecting",
            title: "Reconnecting to computer",
            detail: "The next screen frame will appear automatically.",
            retry: true,
        },
        disconnected: {
            tone: "bad",
            label: "Screen unavailable",
            title: "Screen preview unavailable",
            detail: "The computer did not return a frame. Retrying automatically.",
            retry: true,
        },
    };
    function setState(s) {
        streamState = s;
        var d = STATUS[s] || STATUS.connecting;
        conn.className = "dot " + d.tone;
        var inputNote = hid.isOpen() ? "" : " · input offline";
        if (connText) connText.textContent = d.label;
        conn.title = d.label + inputNote;
        pane.setAttribute("data-stream-state", s);
        if (s === "live") {
            pane.classList.remove("offline");
        } else {
            pane.classList.add("offline");
            if (overlayTitle) overlayTitle.textContent = d.title;
            if (overlayDetail) overlayDetail.textContent = d.detail;
            if (overlayRetry) overlayRetry.hidden = !d.retry;
        }
    }
    function loadStream() {
        if (streamMode !== "native" || mjpegPaused) return; // WebRTC owns the picture; don't open an MJPEG conn
        if (streamState !== "live") setState(streamState === "disconnected" ? "reconnecting" : streamState || "connecting");
        img.src = streamPath(streamKey, navigator.userAgent) + "&t=" + Date.now();
        if (streamWatchdog) clearTimeout(streamWatchdog);
        streamWatchdog = setTimeout(function () {
            if (!streamUp) scheduleReconnect(); // first frame never arrived
        }, 7000);
    }
    function scheduleReconnect() {
        if (streamMode !== "native" || mjpegPaused || reconnectTimer) return;
        if (streamState !== "disconnected") setState("offline");
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

    if (overlayRetry) {
        overlayRetry.addEventListener("click", function (event) {
            event.stopPropagation();
            serverDown = false;
            retryMs = 800;
            if (streamMode === "snapshot") {
                snapshotFailures = 0;
                setState("reconnecting");
                scheduleSnapshot(0);
                return;
            }
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            setState("reconnecting");
            loadStream();
            pollHealth();
        });
    }

    hid.setStatus(function () {
        // Refresh the input note without changing the stream state.
        setState(streamState || "connecting");
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
    function reevalStreamState() {
        if (mjpegPaused && !webrtcActive) return; // WebRTC owns status while live-MJPEG is suspended
        if (blankFrame && streamUp) setState("nosignal");
        else if (streamUp && !serverDown) setState("live");
    }
    function sampleBlank() {
        if (!blankCtx) return;
        // The getImageData readback is expensive — skip it entirely while the window
        // is hidden (the user isn't looking at "no signal" anyway).
        if (typeof document !== "undefined" && document.hidden) return;
        var useVid = webrtcActive && webrtcSwapped;
        if (!streamUp && !useVid) return;
        var srcEl = useVid ? vid : img;
        var w = useVid ? vid.videoWidth : img.naturalWidth;
        var h = useVid ? vid.videoHeight : img.naturalHeight;
        if (!w || !h) return;
        var uniform;
        try {
            blankCtx.drawImage(srcEl, 0, 0, 40, 24);
            var px = blankCtx.getImageData(0, 0, 40, 24).data;
            var n = 40 * 24,
                sum = 0,
                sumsq = 0;
            for (var i = 0; i < n; i++) {
                var o = i * 4;
                var l = (px[o] + px[o + 1] + px[o + 2]) / 3;
                sum += l;
                sumsq += l * l;
            }
            var mean = sum / n;
            var variance = sumsq / n - mean * mean;
            uniform = variance < 6; // near-uniform: a solid colour (incl. black) = no real picture
        } catch (e) {
            return; // draw/read failed — don't guess
        }
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
        [audioBtn, micBtn, avSep, document.getElementById("tb-audio"), document.getElementById("tb-mic"), document.querySelector(".tb-av-sep")].forEach(function (el) {
            if (!el) return;
            if (on) el.removeAttribute("hidden");
            else el.setAttribute("hidden", "");
        });
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
            setVol([document.getElementById("tb-audio"), audioBtn, document.getElementById("tb-mic"), micBtn], 0);
            spkShown = micShown = spkTarget = micTarget = 0;
            return; // loop stops; activateWebrtc restarts it
        }
        // Nothing to meter (both off) or the window's hidden — drop to a cheap 2fps
        // heartbeat instead of burning 60fps + getStats; it resumes full rate the
        // moment audio/mic is on and the window is visible again.
        if ((!audioOn && !micOn) || (typeof document !== "undefined" && document.hidden)) {
            setVol([document.getElementById("tb-audio"), audioBtn, document.getElementById("tb-mic"), micBtn], 0);
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
        setVol([document.getElementById("tb-audio"), audioBtn], audioOn ? spkShown : 0);
        setVol([document.getElementById("tb-mic"), micBtn], micOn ? micShown : 0);
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
        // Mirror state onto the matching desktop-titlebar button.
        var tb = btn === audioBtn ? document.getElementById("tb-audio") : btn === micBtn ? document.getElementById("tb-mic") : null;
        if (tb) {
            tb.classList.toggle("on", on);
            tb.classList.toggle("warn", !!warn);
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
    function fracAt(clientX, clientY) {
        var r = streamEl().getBoundingClientRect(); // transformed element box
        if (r.width <= 0 || r.height <= 0) return null;
        var nw = geomW();
        var nh = geomH();
        var elemAR = r.width / r.height;
        var natAR = nw / nh;
        var cw, ch, ox, oy;
        if (elemAR > natAR) {
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
        var fx = (clientX - r.left - ox) / cw;
        var fy = (clientY - r.top - oy) / ch;
        // Outside the actual picture (in the letterbox/empty space) → not a KVM point.
        if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
        return { fx: fx, fy: fy };
    }
    // Absolute move (desktop mouse): set the virtual cursor to the exact point and
    // send coalesced via rAF (one per frame) — same smooth path as the trackpad.
    function moveTo(clientX, clientY, force) {
        var f = fracAt(clientX, clientY);
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
    // Modifiers held on the HOST across a click. The chord queue only ever synthesises
    // modifiers around KEYS, and a bare modifier keydown is never forwarded, so without
    // this the target sees a plain click: Shift+click range-select and Ctrl+click
    // multi-select silently did the wrong thing.
    var clickMods = [];
    function pressClickMods(e) {
        releaseClickMods();
        var m = modsFromEvent(e);
        if (e.shiftKey) m.push("ShiftLeft");
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
        hid.button(button || "left", true);
        setTimeout(function () {
            hid.button(button || "left", false);
        }, 45);
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
    function paintCursor(clientX, clientY) {
        if (!kvmCursor) return;
        // Background desktop window: the cursor isn't driving the target, so don't
        // paint the blob (a passing pointer must not leave a ghost cursor).
        if (window.desktopConsole && !windowFocused) {
            kvmCursor.style.display = "none";
            return;
        }
        var pr = pane.getBoundingClientRect();
        kvmCursor.style.left = clientX - pr.left + "px";
        kvmCursor.style.top = clientY - pr.top + "px";
        kvmCursor.style.display = "block";
    }
    pane.addEventListener("pointerleave", function (e) {
        if (e.pointerType === "mouse" && kvmCursor) kvmCursor.style.display = "none";
    });
    // When the user's mouse enters the live surface, make sure the target is in ABSOLUTE
    // pointer mode — this client drives the cursor with absolute moves, so a Pi stuck in
    // relative can't track it. ensureAbsolute is a throttled no-op once it's absolute.
    pane.addEventListener("pointerenter", function (e) {
        if (e.pointerType === "mouse") hid.ensureAbsolute();
    });

    pane.addEventListener(
        "pointerdown",
        function (e) {
            // Taps on the overlaid UI (keys row, acting bar, copilot, suggestion card)
            // are NOT KVM input — let those handle their own clicks.
            if (e.target && e.target.closest && e.target.closest(".bar-keys, .acting-bar, .copilot, .suggest-card")) return;
            if (blockKvmInput(e)) return;
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
            // Desktop mouse: the remote cursor follows the pointer ABSOLUTELY — on
            // plain hover too, not only while a button is held (gating on "is the
            // pointer down" made it behave like a relative trackpad).
            if (e.pointerType === "mouse") {
                hid.ensureAbsolute(); // recover absolute mode if the Pi reports relative (throttled no-op otherwise)
                moveTo(e.clientX, e.clientY);
                paintCursor(e.clientX, e.clientY);
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
            noteManualKvmInput();
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                zoomAround(e.clientX, e.clientY, scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
                return;
            }
            e.preventDefault();
            hid.wheel(0, e.deltaY < 0 ? 1 : -1);
        },
        { passive: false },
    );

    /* ---- keyboard input via the hidden field ---- */
    /* What a keydown means (chord / character / swallow) is decided by key-chord.js —
     * pure, shared by both keyboard paths, and covered by tests. This file keeps the
     * parts that need the DOM and the socket: gating, dedupe, and the send queue. */
    var KeyChord = window.KeyChord;
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
        if (d.kind === "ignore") return;
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
        if (btn) btn.classList.toggle("on", on);
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
    document.querySelectorAll("[data-click]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            if (agentActing) return;
            noteManualKvmInput();
            var b = btn.getAttribute("data-click");
            hid.button(b, true);
            setTimeout(function () {
                hid.button(b, false);
            }, 45);
        });
    });
    document.querySelectorAll("[data-scroll]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            if (agentActing) return;
            noteManualKvmInput();
            hid.wheel(0, btn.getAttribute("data-scroll") === "up" ? 2 : -2);
        });
    });
    document.getElementById("cad").addEventListener("click", function () {
        if (agentActing) return;
        noteManualKvmInput();
        sendChord(["ControlLeft", "AltLeft"], "Delete", false);
    });
    var dragBtn = document.getElementById("drag-lock");
    dragBtn.addEventListener("click", function () {
        if (agentActing) return;
        noteManualKvmInput();
        dragLock = !dragLock;
        dragBtn.classList.toggle("on", dragLock);
    });

    function refocusKbd() {
        if (app.classList.contains("keys-open")) kbd.focus({ preventScroll: true });
    }

    /* ---- keyboard toggle ---- */
    var kbdBtn = document.getElementById("kbd-btn");
    kbdBtn.addEventListener("click", function () {
        var openK = app.classList.toggle("keys-open");
        kbdBtn.classList.toggle("on", openK);
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
            // The divider is the chat workspace's RIGHT edge.
            var want = cStartW + (e.clientX - cStartX);
            want = clampPanelWidth(want);
            if (want !== cLastW) {
                applyPanelWidth(want);
                cLastW = want;
            }
        });
        function cresizeEnd() {
            cresizing = false;
            app.classList.remove("col-resizing");
            savePanelWidth(cLastW);
        }
        chatResize.addEventListener("pointerup", cresizeEnd);
        chatResize.addEventListener("pointercancel", cresizeEnd);
    }

    /* ---- merged bar: drive the embedded terminal (e.g. "new tab") ---- */
    document.querySelectorAll("[data-agent]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            try {
                chatFrame.contentWindow.postMessage({ type: "agent-action", action: btn.getAttribute("data-agent") }, "*");
            } catch (e) {}
        });
    });
    window.addEventListener("message", function (e) {
        var d = e.data;
        if (!d) return;
        if (d.type === "chat-ready") {
            reveal(); // terminal loaded — slide the panel in
            sendDesktopOrigin();
        } else if (d.type === "desktop-origin-request") {
            // The embedded settings (re)opened and wants the current origin config.
            sendDesktopOrigin();
        } else if (d.type === "desktop-set-console-origin") {
            // The embedded settings asked to change the desktop's console origin.
            if (window.desktopConsole && window.desktopConsole.setConsoleOrigin) window.desktopConsole.setConsoleOrigin(String(d.origin || ""));
        } else if (d.type === "desktop-set-pikvm-origin") {
            if (window.desktopConsole && window.desktopConsole.setPikvmOrigin) window.desktopConsole.setPikvmOrigin(String(d.url || ""));
        }
    });
    // Tell the embedded settings where this desktop loads the console from.
    function sendDesktopOrigin() {
        if (!window.desktopConsole || !window.desktopConsole.originConfig) return;
        try {
            chatFrame.contentWindow.postMessage({ type: "desktop-origin", config: window.desktopConsole.originConfig }, "*");
        } catch (e2) {}
    }

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
        moreBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            if (moreMenu.classList.toggle("open")) placeMenu();
        });
        // Picking an item closes it — EXCEPT the audio/mic toggles, which stay open
        // so you can flip both without the menu vanishing (the original bug).
        moreMenu.addEventListener("click", function (e) {
            if (e.target.closest && e.target.closest(".more-item.toggle")) return;
            moreMenu.classList.remove("open");
        });
        // Click/tap-outside detection: anything that isn't the menu or the button
        // dismisses it (pointerdown so it's snappy + reliable on touch).
        document.addEventListener("pointerdown", function (e) {
            if (!moreMenu.classList.contains("open")) return;
            if (moreMenu.contains(e.target) || moreBtn.contains(e.target)) return;
            moreMenu.classList.remove("open");
        });
        // Escape closes it too.
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") moreMenu.classList.remove("open");
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
    function applyTheme(t) {
        document.documentElement.setAttribute("data-theme", t);
        try {
            localStorage.setItem("pikvm-console-theme", t);
        } catch (e) {}
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute("content", t === "light" ? "#f5f5f7" : "#0a0a0c");
        try {
            chatFrame.contentWindow.postMessage({ type: "pikvm-theme", theme: t }, "*");
        } catch (e) {}
    }
    themeBtn.addEventListener("click", function () {
        applyTheme(currentTheme() === "light" ? "dark" : "light");
    });
    // Follow the OS appearance: switch the whole console (light/dark) live whenever
    // the OS theme changes. In the desktop window this tracks the OS via Electron's
    // system nativeTheme; in a browser it tracks prefers-color-scheme directly.
    try {
        var osThemeMq = window.matchMedia("(prefers-color-scheme: dark)");
        var onOsTheme = function (e) {
            applyTheme(e.matches ? "dark" : "light");
        };
        if (osThemeMq.addEventListener) osThemeMq.addEventListener("change", onOsTheme);
        else if (osThemeMq.addListener) osThemeMq.addListener(onOsTheme);
        // Sync to the OS now so we start matching it (overrides any stale saved value).
        applyTheme(osThemeMq.matches ? "dark" : "light");
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
        chatFrame.src = "about:blank";
        var reportTermRect = function () {
            try {
                var r = chatFrame.getBoundingClientRect();
                window.desktopConsole.reportWorkspaceRect({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
            } catch (e) {}
        };
        window.addEventListener("resize", reportTermRect);
        try {
            new ResizeObserver(reportTermRect).observe(chatFrame);
        } catch (e) {}
        setInterval(reportTermRect, 1000); // fallback for layout changes we don't observe
        setTimeout(reportTermRect, 150);

        // Agent-backend readiness pill: poll the daemon's /status (via the proxy) and
        // colour the titlebar dot. Tooltip enumerates each dependency the daemon needs.
        var bsEl = document.getElementById("backend-status");
        var bsText = document.getElementById("bs-text");
        if (bsEl) {
            var setBackend = function (state, label, tip) {
                bsEl.dataset.state = state;
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
                        if (d.omniparser && d.omniparser.enabled)
                            parts.push("Vision: " + (d.omniparser.reachable ? "ready" : "loading…"));
                        if (d.operator)
                            parts.push("LLM: " + (d.operator.configured ? d.operator.provider : "no API key"));
                        if (d.ocr)
                            parts.push("OCR: " + d.ocr.provider + (d.ocr.available ? "" : " (missing)"));
                        var ready = !!s.ok;
                        setBackend(ready ? "ready" : "starting",
                                   ready ? "Ready" : "Starting",
                                   "Computer backend — " + parts.join("  ·  "));
                    })
                    .catch(function () {
                        setBackend("down", "Unavailable", "Computer daemon unreachable (starting or not running)");
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

    // Surface the active input model: trackpad (relative) on touch, pointer
    // (absolute) on desktop — matching how the screen responds to taps/clicks.
    var hint = document.getElementById("mode-hint");
    if (hint) {
        var isTouch = "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
        hint.textContent = isTouch ? "Trackpad" : "Pointer";
    }

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
        if (!dc) return; // web/mobile: nothing below runs

        var TITLEBAR_H = 38; // keep in sync with .titlebar height in console.css
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
            // Alt+Tabbing away mid-click must not leave a modifier stuck down on the
            // target — the host stops sending us the keyup that would have released it.
            if (!focused) releaseClickMods();
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
            if (pasteDialogOpen()) return;
            var t = e.target;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
            if (blockKvmInput(e)) return;
            noteManualKvmInput();
            // Printable keys are ours here (there is no hidden field in play), so the
            // produced character goes through — e.key already reflects the host's Shift
            // and Caps Lock, which is why the case is right on the caps-off target.
            handleKeydown(e, true);
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
            // The console has no titlebar of its own, but the window has the ui.html
            // titlebar strip (38px, = main.ts TITLEBAR_HEIGHT) above this view — so
            // fit-native must reserve that, not the console's own 34px.
            TITLEBAR_H = 38;
        }

        var titlebar = document.getElementById("titlebar");
        if (titlebar) titlebar.setAttribute("aria-hidden", "false");

        /* ---- window controls ---- */
        var tbMin = document.getElementById("tb-min");
        var tbMax = document.getElementById("tb-max");
        var tbClose = document.getElementById("tb-close");
        if (tbMin) tbMin.addEventListener("click", function () { dc.minimise(); });
        if (tbMax) tbMax.addEventListener("click", function () { dc.toggleMaximise(); });
        if (tbClose) tbClose.addEventListener("click", function () { dc.close(); });
        // Reflect the maximised state on the glyph (max ⇄ restore).
        function paintMax(maxed) {
            if (titlebar) titlebar.classList.toggle("is-maximised", !!maxed);
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

        /* ---- supporting computer preview collapse (titlebar-left toggle) ---- */
        var tbPanel = document.getElementById("tb-panel");
        function panelShown() {
            return !app.classList.contains("computer-collapsed");
        }
        function paintPanelToggle() {
            if (!tbPanel) return;
            var shown = panelShown();
            tbPanel.classList.toggle("active", shown);
            tbPanel.setAttribute("aria-pressed", String(shown));
            tbPanel.setAttribute("aria-label", shown ? "Hide computer preview" : "Show computer preview");
            tbPanel.title = shown ? "Hide computer preview" : "Show computer preview";
        }
        function setPanel(show) {
            if (show === panelShown()) return;
            app.classList.toggle("computer-collapsed", !show);
            paintPanelToggle();
        }
        paintPanelToggle();
        if (tbPanel) tbPanel.addEventListener("click", function () { setPanel(!panelShown()); });

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
            dc.fitNative({
                width: d.w,
                height: d.h,
                // The chat column's measured width (0 when collapsed) so the
                // screen lands exactly on its native size.
                agentPanelWidth: Math.round(document.querySelector(".chat").getBoundingClientRect().width),
                titlebarHeight: TITLEBAR_H,
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
        var tbFit = document.getElementById("tb-fit");
        if (tbFit) tbFit.addEventListener("click", fitNativeNow);

        // Titlebar audio/mic: drive the canonical toggles (the hidden menu buttons run
        // setAudio/setMic + getUserMedia; paintToggle mirrors state back to these).
        var tbAudio = document.getElementById("tb-audio");
        var tbMic = document.getElementById("tb-mic");
        if (tbAudio) tbAudio.addEventListener("click", function () { var b = document.getElementById("audio-btn"); if (b) b.click(); });
        if (tbMic) tbMic.addEventListener("click", function () { var b = document.getElementById("mic-btn"); if (b) b.click(); });

        // Titlebar Settings opens in its own window. Visible button so it's
        // discoverable (not just in the ⋯ menu).
        function openPanelWin(id) {
            if (window.desktopConsole && window.desktopConsole.openAgentPanel) window.desktopConsole.openAgentPanel(id);
        }
        var tbSettings = document.getElementById("tb-settings");
        if (tbSettings) tbSettings.addEventListener("click", function () { openPanelWin("settings"); });

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
        // The native harness owns its own history and copy controls. Keep this outer
        // shell menu to desktop settings instead of duplicating chat actions.
        var isDesktopWorkspace = !!(window.desktopConsole && window.desktopConsole.reportWorkspaceRect);
        function buildMenu() {
            var items = isDesktopWorkspace
                ? [
                      { id: "settings", label: "Settings" },
                  ]
                : [
                      { id: "history", label: "History" },
                      { id: "settings", label: "Settings" },
                      { id: "copy", label: "Copy conversation" },
                  ];
            if (avAvailable()) {
                items.push({ type: "separator" });
                items.push({ id: "audio", label: "Audio output", type: "checkbox", checked: audioOn });
                items.push({ id: "mic", label: "Microphone", type: "checkbox", checked: micOn });
            }
            items.push({ type: "separator" });
            items.push({ id: "paste", label: "Paste text to the target…" });
            if (atx.available()) {
                items.push({ type: "separator" });
                for (var a = 0; a < ATX_ACTIONS.length; a++) {
                    items.push({ id: "atx:" + ATX_ACTIONS[a].id, label: ATX_ACTIONS[a].label, enabled: !atx.busy() });
                }
            }
            items.push({ type: "separator" });
            items.push({ id: "panel", label: panelShown() ? "Hide computer preview" : "Show computer preview" });
            items.push({ id: "fit", label: "Fit to native resolution", enabled: !!nativeDims() });
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
            switch (id) {
                case "history":
                case "settings":
                    if (isDesktopWorkspace && window.desktopConsole.openAgentPanel) {
                        window.desktopConsole.openAgentPanel(id);
                    } else {
                        try { chatFrame.contentWindow.postMessage({ type: "agent-action", action: id }, "*"); } catch (e) {}
                    }
                    break;
                case "copy":
                    try { chatFrame.contentWindow.postMessage({ type: "agent-action", action: "copy" }, "*"); } catch (e) {}
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
                case "fit":
                    if (tbFit) tbFit.click();
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
        // Titlebar power button: the same three actions, one click away rather than
        // buried in the ⋯ menu. Powering a hung machine is why a KVM exists.
        var tbPower = document.getElementById("tb-power");
        if (tbPower) {
            tbPower.addEventListener("click", function (e) {
                e.stopPropagation();
                var r = tbPower.getBoundingClientRect();
                dc.popupMenu(
                    ATX_ACTIONS.map(function (a) {
                        return { id: "atx:" + a.id, label: a.label, enabled: !atx.busy() };
                    }),
                    { x: r.left, y: r.bottom },
                );
            });
        }

        var tbKeys = document.getElementById("tb-keys");
        if (tbKeys) {
            tbKeys.addEventListener("click", function (e) {
                e.stopPropagation();
                var r = tbKeys.getBoundingClientRect();
                // Paste sits at the top of the "send to target" menu: it is the same
                // idea as a shortcut (keystrokes the target receives) and it is the
                // one people hunt for.
                var items = [{ id: "paste", label: "Paste text…" }, { type: "separator" }];
                dc.popupMenu(
                    items.concat(
                        KVM_SHORTCUTS.map(function (s) {
                            return { id: "kb:" + s.id, label: s.label };
                        }),
                    ),
                    { x: r.left, y: r.bottom },
                );
            });
        }

        // The window starts wide enough for the desktop layout immediately, so fit
        // the screen once the first frame is known.
        setTimeout(function () { try { fitAspect(); } catch (e) {} }, 0);
    })();
})();
