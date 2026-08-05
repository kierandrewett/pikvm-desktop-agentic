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
     *  longer, because a failed power action is worth actually reading.
     *  `sticky` keeps it up until something replaces or clears it — for work
     *  that outlasts the normal dwell and would otherwise look abandoned. */
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
            },
            error ? 6000 : 2600,
        );
    }
    function hideToast() {
        if (!toastEl) return;
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = null;
        toastEl.classList.remove("show");
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
     * Macros: user-defined input the target receives
     * ----------------------------------------------------------------- */

    /* Stored server-side as macros.json beside the app's other settings, so the
     * same list reaches desktop and phone and can be hand-edited on disk. A
     * macro is a list of steps because the useful ones rarely are one chord:
     * "open the run box, type a path, press enter" is three. */
    var macros = [];
    var macroDlg = document.getElementById("macro-dlg");
    var macroSelected = null; // id being edited

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
                // The server normalises (drops empty steps, dedupes ids), so
                // adopt what it stored rather than what we sent.
                macros = (d && d.macros) || [];
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
        noteManualKvmInput();
        var i = 0;
        var next = function () {
            if (i >= macro.steps.length) {
                // A macro's whole effect happens on the OTHER machine, so without
                // this the click has no visible consequence here at all — and a
                // chord the target ignored looks identical to one never sent.
                toast(macro.label + " sent");
                return;
            }
            var step = macro.steps[i++];
            if (step.type === "chord") {
                sendChord(step.mods || [], step.code, false);
                setTimeout(next, 0);
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
                    .catch(function () {
                        toast("Macro text failed to send", true);
                    })
                    .then(next);
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

    function paintMacroButtons() {
        var host = document.getElementById("tb-macros");
        if (!host) return;
        host.innerHTML = "";
        macros
            .filter(function (m) {
                return m.pinned !== false;
            })
            .forEach(function (m) {
                var btn = document.createElement("button");
                btn.type = "button";
                btn.className = "tb-btn";
                btn.title = m.label;
                btn.setAttribute("aria-label", m.label);
                var svg = macroIconSvg(m.icon);
                if (svg) btn.appendChild(svg);
                else btn.textContent = m.icon || m.label.slice(0, 2).toUpperCase();
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
        }
        var macro = macroById(macroSelected);
        var form = document.getElementById("macro-form");
        var empty = document.getElementById("macro-empty");
        if (form) form.hidden = !macro;
        if (empty) empty.hidden = !!macro;
        if (!macro) return;

        var labelEl = document.getElementById("macro-label");
        var pinnedEl = document.getElementById("macro-pinned");
        if (labelEl && document.activeElement !== labelEl) labelEl.value = macro.label;
        if (pinnedEl) pinnedEl.checked = macro.pinned !== false;

        var icons = document.getElementById("macro-icons");
        if (icons) {
            icons.innerHTML = "";
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
        steps.innerHTML = "";
        macro.steps.forEach(function (step, index) {
            var row = document.createElement("div");
            row.className = "macro-step";
            var kind = document.createElement("span");
            kind.className = "macro-kind";
            kind.textContent = step.type === "chord" ? "Keys" : step.type === "text" ? "Text" : "Pause";
            row.appendChild(kind);

            if (step.type === "chord") {
                // Capture the chord by pressing it, rather than asking the user
                // to know that "S" is "KeyS".
                var capture = document.createElement("button");
                capture.type = "button";
                capture.className = "macro-capture";
                capture.textContent = step.code ? chordLabel(step) : "Click, then press the keys";
                capture.addEventListener("click", function () {
                    capture.classList.add("capturing");
                    capture.textContent = "Press the keys…";
                    var onKey = function (e) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (/^(Control|Alt|Meta|Shift)(Left|Right)?$/.test(e.code)) return;
                        step.mods = [];
                        if (e.ctrlKey) step.mods.push("ControlLeft");
                        if (e.altKey) step.mods.push("AltLeft");
                        if (e.metaKey) step.mods.push("MetaLeft");
                        if (e.shiftKey) step.mods.push("ShiftLeft");
                        step.code = e.code;
                        window.removeEventListener("keydown", onKey, true);
                        capture.classList.remove("capturing");
                        void saveMacros();
                    };
                    window.addEventListener("keydown", onKey, true);
                });
                row.appendChild(capture);
            } else if (step.type === "text") {
                var text = document.createElement("input");
                text.type = "text";
                text.className = "dlg-text dlg-grow";
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
            var move = function (delta, label) {
                var btn = document.createElement("button");
                btn.type = "button";
                btn.className = "dlg-btn macro-move";
                btn.textContent = label;
                btn.setAttribute("aria-label", delta < 0 ? "Move step up" : "Move step down");
                btn.disabled = delta < 0 ? index === 0 : index === macro.steps.length - 1;
                btn.addEventListener("click", function () {
                    var to = index + delta;
                    var moved = macro.steps.splice(index, 1)[0];
                    macro.steps.splice(to, 0, moved);
                    void saveMacros();
                });
                return btn;
            };
            // Nothing to reorder in a one-step macro — and a permanently disabled
            // pair of arrows reads as a rendering fault rather than as a control.
            if (macro.steps.length > 1) {
                row.appendChild(move(-1, "↑"));
                row.appendChild(move(1, "↓"));
            }

            var remove = document.createElement("button");
            remove.type = "button";
            remove.className = "dlg-btn";
            remove.textContent = "Remove";
            remove.addEventListener("click", function () {
                macro.steps.splice(index, 1);
                if (!macro.steps.length) macro.steps.push({ type: "chord", mods: [], code: "" });
                void saveMacros();
            });
            row.appendChild(remove);
            steps.appendChild(row);
        });

        /* A step with no key (or no text) is dropped by the server's validation,
         * and a macro left with none is dropped whole — so a new macro closed
         * before its key is captured just vanishes. Say that, rather than
         * letting the work disappear silently. */
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
                      ? "Not saved yet — set the key or text below and it will be kept."
                      : "One step is still empty; it will be dropped when saved.";
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
    (function wireMacroEditor() {
        var close = document.getElementById("macro-close");
        if (close) close.addEventListener("click", closeMacroEditor);
        var add = document.getElementById("macro-new");
        if (add) {
            add.addEventListener("click", function () {
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
            });
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
        document.querySelectorAll("[data-add-step]").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var macro = macroById(macroSelected);
                if (!macro) return;
                var kind = btn.getAttribute("data-add-step");
                if (kind === "chord") macro.steps.push({ type: "chord", mods: [], code: "" });
                else if (kind === "text") macro.steps.push({ type: "text", text: "" });
                else macro.steps.push({ type: "delay", ms: 200 });
                paintMacroEditor();
            });
        });
        var del = document.getElementById("macro-delete");
        if (del) {
            del.addEventListener("click", function () {
                var macro = macroById(macroSelected);
                if (!macro) return;
                if (!window.confirm('Delete the macro "' + macro.label + '"?')) return;
                macros = macros.filter(function (m) {
                    return m.id !== macro.id;
                });
                macroSelected = macros.length ? macros[0].id : null;
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
    function loadLog() {
        var body = document.getElementById("log-body");
        var seekEl = document.getElementById("log-seek");
        if (!body) return;
        if (logAbort) logAbort.abort();
        var controller = new AbortController();
        logAbort = controller;
        var seek = seekEl ? seekEl.value : "3600";
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
                body.textContent = capLog(t) || "(nothing in this window)";
                body.scrollTop = body.scrollHeight; // newest last
            })
            .catch(function (e) {
                if (e && e.name === "AbortError") return;
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
        var refresh = document.getElementById("log-refresh");
        if (refresh) refresh.addEventListener("click", loadLog);
        var seek = document.getElementById("log-seek");
        if (seek) seek.addEventListener("change", loadLog);
        var copy = document.getElementById("log-copy");
        if (copy) {
            copy.addEventListener("click", function () {
                var body = document.getElementById("log-body");
                if (body) copyText(body.textContent, "Log copied");
            });
        }
        var close = document.getElementById("log-close");
        if (close) close.addEventListener("click", closeLogDialog);
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

    function startOcrPick() {
        if (!ocrAvailable() || ocrPicking) return;
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
                if (out) out.value = text.replace(/\s+$/, "") || "(no text found in that region)";
                if (dlg) dlg.hidden = false;
                if (out) out.focus();
            })
            .catch(function (e) {
                toast("Could not read the screen: " + (e && e.message ? e.message : "network error"), true);
            });
    }
    (function wireOcrDialog() {
        var dlg = document.getElementById("ocr-dlg");
        var close = document.getElementById("ocr-close");
        var copy = document.getElementById("ocr-copy");
        var closeIt = function () {
            if (dlg) dlg.hidden = true;
            refocusKbd();
        };
        if (close) close.addEventListener("click", closeIt);
        if (copy) {
            copy.addEventListener("click", function () {
                var out = document.getElementById("ocr-text");
                if (out) copyText(out.value, "Text copied");
            });
        }
        if (dlg) {
            dlg.addEventListener("mousedown", function (e) {
                if (e.target === dlg) closeIt();
            });
            dlg.addEventListener("keydown", function (e) {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    closeIt();
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
                if (!state || !state.enabled) return "This PiKVM has no mass storage.";
                if (!state.online) return "The drive is offline.";
                var d = state.drive;
                if (!d) return "The drive is idle.";
                if (d.connected) {
                    return "Mounted on the target: " + (d.image ? d.image.name : "(no image)") + " as " + (d.cdrom ? "a CD/DVD" : "a flash drive") + (d.rw ? ", writable" : ", read-only") + ".";
                }
                if (d.image) return "Ready to mount " + d.image.name + " (" + humanBytes(d.image.size) + ").";
                return "No image selected.";
            },
            setParam: function (name, value) {
                return fetch("/api/msd/set_params?" + encodeURIComponent(name) + "=" + encodeURIComponent(value), { method: "POST", cache: "no-store" }).then(function (r) {
                    if (!r.ok) toast("Could not set the drive " + name + " (" + r.status + ")", true);
                    return r.ok;
                });
            },
            setConnected: function (on) {
                return fetch("/api/msd/set_connected?connected=" + (on ? 1 : 0), { method: "POST", cache: "no-store" })
                    .then(function (r) {
                        toast(r.ok ? (on ? "Mounted on the target" : "Unmounted") : "Could not " + (on ? "mount" : "unmount") + " (" + r.status + ")", !r.ok);
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
                toast(r.ok ? (on ? "Keyboard and mouse attached" : "Keyboard and mouse detached") : "Could not " + (on ? "attach" : "detach") + " the HID (" + r.status + ")", !r.ok);
            })
            .catch(function (e) {
                toast("Could not change the HID: " + (e && e.message ? e.message : "network error"), true);
            });
    }

    /** Reset the Pi's HID stack — the fix for a keyboard the target has stopped
     *  responding to, without reaching for SSH. */
    function resetHid() {
        if (!window.confirm("Reset the keyboard and mouse?\n\nThe target briefly sees the USB device disappear and come back.")) return;
        fetch("/api/hid/reset", { method: "POST", cache: "no-store" })
            .then(function (r) {
                toast(r.ok ? "Keyboard and mouse reset" : "Could not reset the HID (" + r.status + ")", !r.ok);
            })
            .catch(function (e) {
                toast("Could not reset the HID: " + (e && e.message ? e.message : "network error"), true);
            });
    }

    var msdDlg = document.getElementById("msd-dlg");
    var msdUpload = null; // the in-flight XMLHttpRequest, or null

    function paintMsd() {
        if (!msdDlg || msdDlg.hidden) return;
        var online = msd.online();
        var busy = msd.busy();
        var d = msd.drive() || {};
        var connected = !!d.connected;
        // While the drive is connected the target owns it — kvmd rejects any change,
        // so the controls that would make one are disabled rather than left to fail.
        var settable = online && !connected && !busy && !msdUpload;

        var status = document.getElementById("msd-status");
        if (status) status.textContent = msd.summary();

        var sel = document.getElementById("msd-image");
        if (sel) {
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
            if (document.activeElement !== sel) sel.value = d.image && d.image.in_storage ? d.image.name : "";
            sel.disabled = !settable;
        }

        var mode = document.getElementById("msd-mode");
        if (mode) {
            if (document.activeElement !== mode) mode.value = d.cdrom ? "1" : "0";
            mode.disabled = !settable;
        }
        var rw = document.getElementById("msd-rw");
        if (rw) {
            rw.checked = !!d.rw;
            // A CD/DVD is read-only by definition, so the toggle only applies to flash.
            rw.disabled = !settable || !!d.cdrom;
        }

        var conn = document.getElementById("msd-connect");
        var disc = document.getElementById("msd-disconnect");
        if (conn) {
            conn.hidden = connected;
            conn.disabled = !(online && d.image && !connected && !busy);
        }
        if (disc) {
            disc.hidden = !connected;
            disc.disabled = !(online && connected && !busy);
        }
        var rm = document.getElementById("msd-remove");
        if (rm) rm.disabled = !(settable && d.image && d.image.removable);

        var file = document.getElementById("msd-file");
        var url = document.getElementById("msd-url");
        var up = document.getElementById("msd-upload");
        var abort = document.getElementById("msd-abort");
        if (file) file.disabled = !settable;
        if (url) url.disabled = !settable;
        if (up) {
            up.hidden = !!msdUpload;
            up.disabled = !settable || !((file && file.files && file.files.length) || (url && url.value.trim()));
        }
        if (abort) abort.hidden = !msdUpload;
        var reset = document.getElementById("msd-reset");
        if (reset) reset.disabled = !online || busy || !!msdUpload;

        var free = document.getElementById("msd-free");
        if (free) {
            var f = msd.free();
            free.textContent = f === null ? "" : humanBytes(f) + " free";
        }
    }
    msd.onChange(paintMsd);
    // The menu entry has to track availability even while the dialog is closed, so it
    // is painted separately from the dialog body (which short-circuits when hidden).
    msd.onChange(function () {
        var btn = document.getElementById("msd-btn");
        if (btn) btn.hidden = !msd.available();
    });

    function setMsdProgress(pct, label) {
        var row = document.getElementById("msd-progress-row");
        var bar = document.getElementById("msd-progress");
        var val = document.getElementById("msd-progress-value");
        if (row) row.hidden = pct === null;
        if (bar && pct !== null) bar.value = pct;
        if (val) val.textContent = label || "";
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
        setMsdProgress(0, remote ? "starting…" : "0%");
        paintMsd();

        var done = function (okMsg, errMsg) {
            msdUpload = null;
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
            setMsdProgress(0, "the Pi is downloading it…");
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
            done(null, "Upload aborted");
        };
        xhr.send(remote ? null : picked);
    }

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
        var conn = document.getElementById("msd-connect");
        if (conn) conn.addEventListener("click", function () { msd.setConnected(true); });
        var disc = document.getElementById("msd-disconnect");
        if (disc) disc.addEventListener("click", function () { msd.setConnected(false); });
        var rm = document.getElementById("msd-remove");
        if (rm) {
            rm.addEventListener("click", function () {
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
            });
        }
        var up = document.getElementById("msd-upload");
        if (up) up.addEventListener("click", startMsdUpload);
        var abort = document.getElementById("msd-abort");
        if (abort) {
            abort.addEventListener("click", function () {
                if (msdUpload) msdUpload.abort();
            });
        }
        var file = document.getElementById("msd-file");
        if (file) file.addEventListener("change", paintMsd);
        var url = document.getElementById("msd-url");
        if (url) url.addEventListener("input", paintMsd);
        var reset = document.getElementById("msd-reset");
        if (reset) {
            reset.addEventListener("click", function () {
                if (!window.confirm("Reset the mass storage drive?\n\nAnything mounted is unmounted.")) return;
                fetch("/api/msd/reset", { method: "POST", cache: "no-store" })
                    .then(function (r) {
                        toast(r.ok ? "Drive reset" : "Could not reset the drive (" + r.status + ")", !r.ok);
                    })
                    .catch(function (e) {
                        toast("Could not reset the drive: " + (e && e.message ? e.message : "network error"), true);
                    });
            });
        }
        var close = document.getElementById("msd-close");
        if (close) close.addEventListener("click", closeMsdDialog);
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
        msdDlg.hidden = false;
        paintMsd();
    }
    function closeMsdDialog() {
        // An upload in flight keeps running; closing the dialog is not an abort.
        if (msdDlg) msdDlg.hidden = true;
        refocusKbd();
    }

    var healthDlg = document.getElementById("health-dlg");

    function paintHealth() {
        var problems = health.problems();
        var worst = problems.some(function (p) {
            return p.level === "error";
        });
        var tb = document.getElementById("tb-health");
        if (tb) {
            var problemTexts = problems.map(function (p) {
                return p.text;
            });
            tb.hidden = problems.length === 0;
            tb.classList.toggle("is-error", worst);
            tb.title = problems.length === 0 ? "Health" : problemTexts.join("\n");
            /* aria-label WINS over title, so leaving it at the static "Health"
             * announced a generic word for a button that only appears when
             * something is wrong and whose whole job is to say what. Joined with
             * a full stop rather than the tooltip's newlines, which screen
             * readers run together inconsistently. */
            tb.setAttribute(
                "aria-label",
                problems.length === 0 ? "Health" : "Health: " + problemTexts.join(". "),
            );
        }
        var list = document.getElementById("health-list");
        if (list) {
            list.innerHTML = "";
            for (var i = 0; i < problems.length; i++) {
                var li = document.createElement("li");
                li.textContent = problems[i].text;
                if (problems[i].level === "error") li.className = "is-error";
                list.appendChild(li);
            }
        }
        var ok = document.getElementById("health-ok");
        if (ok) ok.hidden = problems.length > 0;

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
        var stateEl = document.getElementById("health-hid-state");
        if (stateEl) stateEl.textContent = !known ? "state unknown" : attached ? "attached" : "detached";
        var toggle = document.getElementById("hid-toggle");
        if (toggle) {
            toggle.textContent = attached ? "Detach" : "Attach";
            toggle.disabled = !known;
        }
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
            outs.forEach(function (o) {
                var row = document.createElement("div");
                row.className = "dlg-row";
                var label = document.createElement("span");
                label.className = "dlg-label dlg-grow";
                label.textContent = o.label;
                label.id = "gpio-label-" + o.name.replace(/[^A-Za-z0-9_-]/g, "-");
                row.appendChild(label);
                if (o.canSwitch) {
                    var btn = document.createElement("button");
                    btn.type = "button";
                    btn.className = "dlg-btn";
                    // A switch, not a button: the word on it is the STATE, not
                    // what it does. Without these it announced a bare "On" with
                    // nothing saying what was on, and the state was carried to
                    // sighted users by the blue fill alone.
                    btn.setAttribute("role", "switch");
                    btn.setAttribute("aria-labelledby", label.id);
                    btn.setAttribute("data-gpio-switch", o.name);
                    btn.addEventListener("click", function () {
                        var cur = gpio.outputs().filter(function (x) {
                            return x.name === o.name;
                        })[0];
                        if (!cur) return;
                        var warn = GPIO_CONFIRM[o.name];
                        if (warn && !window.confirm(warn)) return;
                        gpio.switchTo(o.name, !cur.on);
                    });
                    row.appendChild(btn);
                }
                if (o.canPulse) {
                    var pulse = document.createElement("button");
                    pulse.type = "button";
                    pulse.className = "dlg-btn";
                    pulse.textContent = "Pulse";
                    // Every pulse button says "Pulse", so on their own a list of
                    // them names nothing you could tell apart.
                    pulse.setAttribute("aria-label", "Pulse " + o.label);
                    pulse.setAttribute("data-gpio-pulse", o.name);
                    pulse.addEventListener("click", function () {
                        var warn = GPIO_CONFIRM[o.name];
                        if (warn && !window.confirm(warn)) return;
                        gpio.pulse(o.name);
                    });
                    row.appendChild(pulse);
                }
                rows.appendChild(row);
            });
        }
        outs.forEach(function (o) {
            var btn = rows.querySelector('[data-gpio-switch="' + o.name + '"]');
            if (btn) {
                btn.textContent = o.on ? "On" : "Off";
                btn.setAttribute("aria-checked", o.on ? "true" : "false");
                btn.classList.toggle("primary", o.on);
                btn.disabled = o.busy || !o.online;
            }
            var pulse = rows.querySelector('[data-gpio-pulse="' + o.name + '"]');
            if (pulse) pulse.disabled = o.busy || !o.online;
        });
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
            el.textContent = "";
            return;
        }
        var bits = [];
        if (i.node && i.node.host) bits.push(i.node.host);
        if (i.system && i.system.platform && i.system.platform.model) bits.push("PiKVM " + i.system.platform.model);
        if (i.system && i.system.kvmd && i.system.kvmd.version) bits.push("kvmd " + i.system.kvmd.version);
        if (i.system && i.system.streamer && i.system.streamer.version) bits.push((i.system.streamer.app || "streamer") + " " + i.system.streamer.version);
        if (i.health && i.health.temp && typeof i.health.temp.cpu === "number") bits.push(i.health.temp.cpu.toFixed(0) + "°C");
        if (i.fan && i.fan.monitored && i.fan.state && i.fan.state.hall && i.fan.state.hall.available) bits.push(i.fan.state.hall.rpm + " rpm");
        el.textContent = bits.join("  ·  ");
    }

    health.onChange(paintHealth);

    function openHealthDialog() {
        if (!healthDlg) return;
        paintHealth();
        healthDlg.hidden = false;
        var close = document.getElementById("health-close");
        if (close) close.focus();
    }
    function closeHealthDialog() {
        if (healthDlg) healthDlg.hidden = true;
        refocusKbd();
    }
    (function wireHealthDialog() {
        var tb = document.getElementById("tb-health");
        if (tb) tb.addEventListener("click", openHealthDialog);
        var close = document.getElementById("health-close");
        if (close) close.addEventListener("click", closeHealthDialog);
        var toggle = document.getElementById("hid-toggle");
        if (toggle) {
            toggle.addEventListener("click", function () {
                // Mirror the label: whatever it says it will do, do that.
                var isAttached =
                    health.hidConnected() === true ||
                    (health.hidConnected() === null && health.hidOnline() === true);
                setHidConnected(!isAttached);
            });
        }
        var reset = document.getElementById("hid-reset");
        if (reset) reset.addEventListener("click", resetHid);
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
                if (!r.ok) toast("Could not change the stream " + name.replace(/_/g, " ") + " (" + r.status + ")", true);
            })
            .catch(function (e) {
                toast("Could not change the stream: " + (e && e.message ? e.message : "network error"), true);
            });
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

    function paintStreamDialog() {
        var f = streamerState.features || {};
        var l = streamerState.limits || {};
        var a = streamerState.applied || {};
        var anything = false;

        var resRow = document.getElementById("sp-resolution-row");
        var resSel = document.getElementById("sp-resolution");
        if (resRow && resSel) {
            var hasRes = !!f.resolution && !!(l.available_resolutions && l.available_resolutions.length);
            resRow.hidden = !hasRes;
            if (hasRes) {
                anything = true;
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

        for (var s = 0; s < STREAM_SLIDERS.length; s++) {
            var cfg = STREAM_SLIDERS[s];
            var row = document.getElementById(cfg.row);
            var el = document.getElementById(cfg.el);
            var val = document.getElementById(cfg.el + "-value");
            if (!row || !el) continue;
            var have = cfg.feature ? !!f[cfg.feature] : a[cfg.param] !== undefined;
            row.hidden = !have;
            if (!have) continue;
            anything = true;
            var range = cfg.limit ? l[cfg.limit] : null;
            if (range && typeof range.min === "number") el.min = range.min;
            if (range && typeof range.max === "number") el.max = range.max;
            // Don't fight the user mid-drag: only adopt the applied value when the
            // slider isn't the thing that just changed it.
            if (a[cfg.param] !== undefined && document.activeElement !== el) el.value = a[cfg.param];
            if (val) val.textContent = cfg.fmt(Number(el.value));
        }

        var empty = document.getElementById("sp-empty");
        if (empty) empty.hidden = anything;
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
                if (val) val.textContent = cfg.fmt(Number(el.value));
            });
            el.addEventListener("change", function () {
                sendStreamParam(cfg.param, Number(el.value));
            });
        });
        var close = document.getElementById("sp-close");
        if (close) close.addEventListener("click", closeStreamDialog);
        var reset = document.getElementById("sp-reset");
        if (reset) {
            reset.addEventListener("click", function () {
                if (!window.confirm("Reset the stream?\n\nThe picture drops for a moment while the streamer restarts.")) return;
                fetch("/api/streamer/reset", { method: "POST", cache: "no-store" })
                    .then(function (r) {
                        toast(r.ok ? "Stream reset" : "Could not reset the stream (" + r.status + ")", !r.ok);
                    })
                    .catch(function (e) {
                        toast("Could not reset the stream: " + (e && e.message ? e.message : "network error"), true);
                    });
            });
        }
        var shot = document.getElementById("sp-screenshot");
        if (shot) shot.addEventListener("click", saveScreenshot);
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
        streamDlg.hidden = false;
        var first = streamDlg.querySelector("select:not([disabled]), input, button");
        if (first) first.focus();
    }
    function closeStreamDialog() {
        if (streamDlg) streamDlg.hidden = true;
        refocusKbd();
    }

    /** Pull a full-resolution JPEG straight from the streamer and save it. */
    function saveScreenshot() {
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
                if (!focusBeforeModal) focusBeforeModal = document.activeElement;
                var first = focusablesIn(scrim)[0];
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
    var overlayTitle = document.getElementById("overlay-title");
    var overlayDetail = document.getElementById("overlay-detail");
    var overlayRetry = document.getElementById("overlay-retry");
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
    function clampPanelWidth(w) {
        return Math.round(Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, Number(w) || PANEL_DEFAULT_W)));
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
        // A dialog owns the pointer; the blob would sit under it as a ghost.
        if (modalOpen()) {
            kvmCursor.style.display = "none";
            return;
        }
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
        if (modalOpen()) {
            // A modal swallows the release, so let go of anything the target is still
            // holding rather than leaving a button or modifier stuck down on it.
            Object.keys(heldMouseButtons).forEach(function (b) {
                hid.button(b, false);
                delete heldMouseButtons[b];
            });
            releaseClickMods();
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
            // The divider is the chat workspace's RIGHT edge — unless the conversation
            // has been swapped to the right side, where the handle is its LEFT edge and
            // the same pointer travel means the opposite width change.
            var sign = document.documentElement.classList.contains("agent-right") ? -1 : 1;
            var want = cStartW + sign * (e.clientX - cStartX);
            want = clampPanelWidth(want);
            if (want !== cLastW) {
                applyPanelWidth(want);
                cLastW = want;
            }
        });
        function paintResizeValue() {
            var chatEl = document.querySelector(".chat");
            chatResize.setAttribute("aria-valuemin", String(PANEL_MIN_W));
            chatResize.setAttribute("aria-valuemax", String(PANEL_MAX_W));
            chatResize.setAttribute(
                "aria-valuenow",
                String(chatEl ? Math.round(chatEl.offsetWidth) : PANEL_MIN_W),
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
            else if (e.key === "End") next = PANEL_MAX_W;
            if (next === null) return;
            e.preventDefault();
            e.stopPropagation();
            next = clampPanelWidth(next);
            applyPanelWidth(next);
            savePanelWidth(next);
            paintResizeValue();
        });
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
        /* The desktop conversation is a native child view, not that iframe, so
         * the postMessage above never reaches it. Without this the console went
         * light and the panel beside it stayed dark, in the same window. */
        /* window.desktopConsole rather than the `dc` alias: that is declared
         * inside the desktop-only block further down, so naming it here threw a
         * ReferenceError after the theme had already been applied — silently,
         * because it is the last statement in the handler. */
        var desk = window.desktopConsole;
        if (desk && desk.reportAgentTheme) desk.reportAgentTheme(t);
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
        /* Nothing is ever rendered in here on the desktop: the frame is a spacer
         * whose rect tells main where to float the native conversation view. An
         * empty frame that announces itself as a workspace is worse than one
         * that says nothing, so take it out of the accessibility tree. */
        chatFrame.setAttribute("aria-hidden", "true");
        chatFrame.removeAttribute("title");
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
        function publishAgentPlacement() {
            if (!dc.reportAgentPlacement) return;
            dc.reportAgentPlacement({
                side: agentOnRight() ? "right" : "left",
                detached: agentDetached(),
            });
        }
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
        if (!dc) return; // web/mobile: nothing below runs

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
            var t = e.target;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
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
        window.addEventListener("blur", releaseAllMods);

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
                titlebarHeight: titlebarHeight(),
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
        function openSettingsWindow() {
            var desk = window.desktopConsole;
            if (desk && desk.openSettingsWindow) desk.openSettingsWindow();
        }
        var tbSettings = document.getElementById("tb-settings");
        if (tbSettings) tbSettings.addEventListener("click", openSettingsWindow);

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
            items.push({ id: "panel", label: panelShown() ? "Hide computer preview" : "Show computer preview" });
            if (screenAlertsAvailable()) {
                items.push({ id: "alerts", label: "Pulse the taskbar when the screen changes", type: "checkbox", checked: screenAlertsEnabled() });
            }
            items.push({ id: "fit", label: "Fit to native resolution", enabled: !!nativeDims() });
            items.push({ id: "stream", label: "Stream settings…" });
            items.push({ id: "screenshot", label: "Save screenshot" });
            items.push({ id: "health", label: "System, GPIO & health…" });
            if (msd.available()) items.push({ id: "msd", label: "Mass storage…" });
            if (ocrAvailable()) items.push({ id: "ocr", label: "Read text from the screen…" });
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
            if (id === "detach") {
                toggleAgentDetached();
                return;
            }
            if (id === "swap-side") {
                setAgentSide(agentOnRight() ? "left" : "right");
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
        /* The desktop titlebar had no ⋯ button — the native menu was reachable
         * only by right-clicking the chrome, which meant everything in it
         * (models, stream, macros, health, log, detach) was effectively hidden.
         * These two buttons make the common ones findable. */
        var tbMore = document.getElementById("tb-more");
        if (tbMore) {
            tbMore.addEventListener("click", function (e) {
                e.stopPropagation();
                var r = tbMore.getBoundingClientRect();
                popNative({ x: r.left, y: r.bottom });
            });
        }
        /* Detach used to be a button here. It acts on the conversation, so it
         * sits in the conversation's own header now, beside the rest of its
         * controls, and this bar is left to the target and the window. */

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
                    { x: r.left, y: r.bottom },
                );
            });
        }

        // The window starts wide enough for the desktop layout immediately, so fit
        // the screen once the first frame is known.
        setTimeout(function () { try { fitAspect(); } catch (e) {} }, 0);
    })();
})();
