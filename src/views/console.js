/*
 * PiKVM web console — manual keyboard/mouse + live screen, with the agent chat
 * below. It reuses the existing reverse proxy: the live picture is the Pi's own
 * MJPEG stream (/streamer/stream) and input goes over the Pi's own HID WebSocket
 * (/api/ws) with the exact JSON the desktop control core sends — so we add no new
 * server surface and reinvent nothing.
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

    var pure = { charToKey: charToKey, fracToNorm: fracToNorm, streamPath: streamPath };
    if (typeof module !== "undefined" && module.exports) module.exports = pure;
    if (typeof window === "undefined") return; // node test: stop before DOM wiring

    /* ----------------------------------------------------------------- *
     * HID WebSocket client — same protocol as src/pikvm-control.ts
     * ----------------------------------------------------------------- */

    var hid = (function () {
        var ws = null;
        var open = false;
        var connecting = false;
        var queue = [];
        var onStatus = null;
        var retry = null;

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
            ws.onmessage = function () {}; // drain state pings; we don't need them
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
        };
    })();

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
    function sendChord(mods, codeName, shift) {
        mods = (mods || []).slice();
        if (shift) mods.push("ShiftLeft");
        mods.forEach(function (m) {
            hid.key(m, true);
        });
        hid.key(codeName, true);
        setTimeout(function () {
            hid.key(codeName, false);
            mods.reverse().forEach(function (m) {
                hid.key(m, false);
            });
        }, 25);
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
    var overlayMsg = document.getElementById("overlay-msg");
    var conn = document.getElementById("conn");
    var connText = document.getElementById("conn-text");
    var kbd = document.getElementById("kbd");
    var chatFrame = document.getElementById("chat-frame");

    /* ---- connection / stream resilience ----
     * A small state machine drives the status chip + overlay and an exponential
     * reconnect. Sources: the MJPEG <img> load/error, a periodic /api/streamer
     * health poll (distinguishes "no signal" / "server unreachable" from a stream
     * hiccup), the HID socket, and page-visibility / network events. */
    var streamKey = Math.random().toString(16).slice(2) + Date.now().toString(16);
    var streamUp = false;
    var serverDown = false;
    var streamState = ""; // connecting | live | nosignal | offline | reconnecting | disconnected
    var retryMs = 800;
    var streamWatchdog = null;
    var reconnectTimer = null;
    // When WebRTC is the live source we suspend the MJPEG pipeline entirely: blank
    // the <img> src (so the Pi's MJPEG connection is released) and stop the watchdog
    // / health-driven state changes from fighting the WebRTC status. Resumed on
    // fallback. The HID health poll keeps running regardless (input is independent).
    var mjpegPaused = false;

    var STATUS = {
        connecting: ["", "Connecting…", true],
        live: ["ok", "Live", false],
        nosignal: ["warn", "No signal from target", true],
        offline: ["bad", "Stream lost — reconnecting…", true],
        reconnecting: ["", "Reconnecting…", true],
        disconnected: ["bad", "Disconnected — check connection", true],
    };
    function setState(s) {
        streamState = s;
        var d = STATUS[s] || STATUS.connecting;
        conn.className = "dot " + d[0];
        var inputNote = hid.isOpen() ? "" : " · input offline";
        if (connText) connText.textContent = d[1];
        conn.title = d[1] + inputNote;
        if (s === "live") {
            pane.classList.remove("offline");
        } else {
            pane.classList.add("offline");
            overlayMsg.textContent = d[1];
            // No spinner for a steady "no signal" (target is just off).
            pane.classList.toggle("no-spin", s === "nosignal");
        }
    }
    function loadStream() {
        if (mjpegPaused) return; // WebRTC owns the picture; don't open an MJPEG conn
        if (streamState !== "live") setState(streamState === "disconnected" ? "reconnecting" : streamState || "connecting");
        img.src = streamPath(streamKey, navigator.userAgent) + "&t=" + Date.now();
        if (streamWatchdog) clearTimeout(streamWatchdog);
        streamWatchdog = setTimeout(function () {
            if (!streamUp) scheduleReconnect(); // first frame never arrived
        }, 7000);
    }
    function scheduleReconnect() {
        if (mjpegPaused || reconnectTimer) return;
        if (streamState !== "disconnected") setState("offline");
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            loadStream();
        }, retryMs);
        retryMs = Math.min(Math.round(retryMs * 1.7), 8000);
    }
    img.addEventListener("load", function () {
        if (mjpegPaused) return;
        streamUp = true;
        retryMs = 800;
        if (streamWatchdog) clearTimeout(streamWatchdog);
        if (!serverDown) setState("live");
    });
    img.addEventListener("error", function () {
        if (mjpegPaused) return;
        streamUp = false;
        scheduleReconnect();
    });

    // Health poll: tells server-unreachable / no-signal apart from a stream hiccup,
    // and recovers the stream after the link comes back (phone reconnects, etc.).
    function pollHealth() {
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
                } else if (!online && streamUp) {
                    setState("nosignal");
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

    hid.setStatus(function () {
        // Refresh the input note without changing the stream state.
        setState(streamState || "connecting");
    });
    hid.connect();
    setState("connecting");
    loadStream();
    setInterval(pollHealth, 2500);

    // Recover promptly when the phone wakes / regains network.
    document.addEventListener("visibilitychange", function () {
        if (!document.hidden) {
            hid.connect();
            pollHealth();
            if (streamState !== "live") loadStream();
        }
    });
    window.addEventListener("online", function () {
        serverDown = false;
        hid.connect();
        loadStream();
    });
    window.addEventListener("offline", function () {
        serverDown = true;
        if (!mjpegPaused) setState("disconnected");
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

    // Switch the visible picture to WebRTC: show <video>, hide <img>, suspend MJPEG.
    function activateWebrtc() {
        if (webrtcActive) return;
        webrtcActive = true;
        mjpegPaused = true;
        if (streamWatchdog) {
            clearTimeout(streamWatchdog);
            streamWatchdog = null;
        }
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        vid.classList.remove("hidden");
        img.classList.add("hidden");
        img.removeAttribute("src"); // release the Pi's MJPEG connection
        applyXform(); // make sure the video carries the current zoom/pan
        setState("live");
        if (connText) connText.textContent = "Live · HD";
        // Audio/mic become available now there's a WebRTC session. Re-apply the
        // user's desired audio mute state (it survives the re-watch) and play.
        vid.muted = !audioOn;
        if (audioOn) vid.play().catch(function () {});
        revealAvToggles(true);
        // Light up the speaker meter once the audio track lands (retry a couple of times).
        startMeters();
        fitAspect();
    }

    // Fall back to MJPEG: show <img>, hide <video>, resume the MJPEG pipeline.
    function fallbackToMjpeg() {
        var was = webrtcActive;
        webrtcActive = false;
        mjpegPaused = false;
        revealAvToggles(false); // the meter loop sees !webrtcActive next tick and clears
        vid.classList.add("hidden");
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
        if (!resToast) return;
        var w = geomW();
        var h = geomH();
        if (w <= 16 || h <= 9) return; // no real frame yet
        var src = webrtcActive ? "HD · WebRTC" : "MJPEG";
        var key = w + "x" + h + "/" + src;
        if (!force && key === lastResKey) return; // only on a real change
        lastResKey = key;
        if (resToastMain) resToastMain.textContent = w + " × " + h + "  ·  " + src;
        refreshResToastAv();
        resToast.classList.add("show");
        if (resToastTimer) clearTimeout(resToastTimer);
        resToastTimer = setTimeout(function () {
            resToast.classList.remove("show");
        }, 2600);
    }

    var stream = null;
    if (window.JanusStream && window.JanusStream.available()) {
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
    var MOVE_SLOP = 8;
    var SENS = 0.9; // trackpad sensitivity (finger px -> cursor travel)

    // Virtual cursor in PiKVM absolute units; relative drags accumulate into it and
    // we send absolute moves, so trackpad mode works with the default (absolute)
    // PiKVM mouse — no Pi-side relative-mouse configuration required.
    var vcur = { x: 0, y: 0 };
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
    function flushMove() {
        moveRaf = 0;
        if (!moveDirty) return;
        moveDirty = false;
        if (window.desktopConsole && !windowFocused) return; // background window: don't move the KVM cursor
        hid.move(Math.round(vcur.x), Math.round(vcur.y));
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
        var pr = pane.getBoundingClientRect();
        kvmCursor.style.left = clientX - pr.left + "px";
        kvmCursor.style.top = clientY - pr.top + "px";
        kvmCursor.style.display = "block";
    }
    pane.addEventListener("pointerleave", function (e) {
        if (e.pointerType === "mouse" && kvmCursor) kvmCursor.style.display = "none";
    });

    pane.addEventListener(
        "pointerdown",
        function (e) {
            // Taps on the overlaid UI (keys row, acting bar, copilot) are NOT KVM
            // input — let those handle their own clicks.
            if (e.target && e.target.closest && e.target.closest(".bar-keys, .acting-bar, .copilot")) return;
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
                hid.button(b, true);
                return;
            }

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
            // Desktop mouse: the remote cursor follows the pointer ABSOLUTELY — on
            // plain hover too, not only while a button is held (gating on "is the
            // pointer down" made it behave like a relative trackpad).
            if (e.pointerType === "mouse") {
                moveTo(e.clientX, e.clientY);
                paintCursor(e.clientX, e.clientY);
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
    var CONTROL_KEYS = {
        Enter: "Enter",
        Backspace: "Backspace",
        Tab: "Tab",
        Escape: "Escape",
        Delete: "Delete",
        Home: "Home",
        End: "End",
        PageUp: "PageUp",
        PageDown: "PageDown",
        ArrowUp: "ArrowUp",
        ArrowDown: "ArrowDown",
        ArrowLeft: "ArrowLeft",
        ArrowRight: "ArrowRight",
    };
    var lastKey = { code: "", ts: 0 };
    function dedupe(codeName) {
        var now = Date.now();
        if (lastKey.code === codeName && now - lastKey.ts < 60) return false;
        lastKey = { code: codeName, ts: now };
        return true;
    }
    kbd.addEventListener("keydown", function (e) {
        var ctrlAltMeta = e.ctrlKey || e.altKey || e.metaKey;
        var ctl = CONTROL_KEYS[e.code] || CONTROL_KEYS[e.key];
        if (/^F\d{1,2}$/.test(e.code)) ctl = e.code;
        if (ctl) {
            e.preventDefault();
            if (dedupe(ctl)) sendChord(modsFromEvent(e).concat(armedList()), ctl, false);
            clearArmed();
            return;
        }
        if (ctrlAltMeta && e.code && !/^(Control|Alt|Meta|Shift)/.test(e.code)) {
            // Hardware chord (Ctrl+C etc.) — the printable path is suppressed.
            e.preventDefault();
            if (dedupe(e.code)) sendChord(modsFromEvent(e).concat(armedList()), e.code, e.shiftKey);
            clearArmed();
        }
    });
    kbd.addEventListener("beforeinput", function (e) {
        if (e.inputType === "insertText" && e.data) {
            for (var i = 0; i < e.data.length; i++) sendChar(e.data[i]);
            e.preventDefault();
        } else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
            if (dedupe("Enter")) sendCode("Enter");
            e.preventDefault();
        } else if (e.inputType === "deleteContentBackward") {
            if (dedupe("Backspace")) sendCode("Backspace");
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
            sendCode(btn.getAttribute("data-key"));
            refocusKbd();
        });
    });
    document.querySelectorAll("[data-mod]").forEach(function (btn) {
        var codeName = btn.getAttribute("data-mod");
        var lastTap = 0;
        btn.addEventListener("click", function () {
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
            var b = btn.getAttribute("data-click");
            hid.button(b, true);
            setTimeout(function () {
                hid.button(b, false);
            }, 45);
        });
    });
    document.querySelectorAll("[data-scroll]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            hid.wheel(0, btn.getAttribute("data-scroll") === "up" ? 2 : -2);
        });
    });
    document.getElementById("cad").addEventListener("click", function () {
        sendChord(["ControlLeft", "AltLeft"], "Delete", false);
    });
    var dragBtn = document.getElementById("drag-lock");
    dragBtn.addEventListener("click", function () {
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

    var resizing = false;
    var startY = 0;
    var startH = 0;
    function resizeStart(e) {
        if (e.target.closest && e.target.closest(".ibtn")) return; // let buttons click
        if (isDesktop()) return; // desktop auto-fits the screen width; no vertical drag
        resizing = true;
        userResized = true; // a manual drag stops auto-fit for this session
        app.classList.add("resizing"); // kill the --sh transition so the drag is 1:1, never eased
        startY = e.clientY;
        startH = pane.offsetHeight;
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch (err) {}
        e.preventDefault();
    }
    function resizeMove(e) {
        if (!resizing) return;
        e.preventDefault();
        app.style.setProperty("--sh", clampH(startH + (e.clientY - startY)).toFixed(0) + "px");
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

    /* ---- desktop: drag the agent panel's left edge to resize its WIDTH (--chat-w).
     * Works regardless of the screen size (incl. after "fit to native resolution"). */
    var chatResize = document.getElementById("chat-resize");
    if (chatResize) {
        var cresizing = false;
        var cStartX = 0;
        var cStartW = 0;
        chatResize.addEventListener("pointerdown", function (e) {
            cresizing = true;
            cStartX = e.clientX;
            var chatEl = document.querySelector(".chat");
            cStartW = chatEl ? chatEl.offsetWidth : 380;
            app.classList.add("col-resizing");
            try {
                chatResize.setPointerCapture(e.pointerId);
            } catch (err) {}
            e.preventDefault();
        });
        chatResize.addEventListener("pointermove", function (e) {
            if (!cresizing) return;
            // Dragging the LEFT edge left widens the panel.
            var want = cStartW + (cStartX - e.clientX);
            var max = Math.max(280, window.innerWidth - 360);
            want = Math.max(280, Math.min(max, want));
            app.style.setProperty("--chat-w", Math.round(want) + "px");
        });
        function cresizeEnd() {
            cresizing = false;
            app.classList.remove("col-resizing");
        }
        chatResize.addEventListener("pointerup", cresizeEnd);
        chatResize.addEventListener("pointercancel", cresizeEnd);
    }

    /* ---- merged bar: drive the embedded agent + show its status ---- */
    document.querySelectorAll("[data-agent]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            try {
                chatFrame.contentWindow.postMessage({ type: "agent-action", action: btn.getAttribute("data-agent") }, "*");
            } catch (e) {}
        });
    });
    var agentStatusEl = document.getElementById("agent-status");
    window.addEventListener("message", function (e) {
        var d = e.data;
        if (!d) return;
        if (d.type === "agent-status" && agentStatusEl) {
            agentStatusEl.textContent = "· " + (d.text || "Idle");
            agentStatusEl.classList.toggle("busy", !!d.busy);
        } else if (d.type === "chat-fullscreen") {
            // The embedded agent opened a panel — expand the chat to cover the phone.
            app.classList.toggle("chat-full", !!d.on);
        } else if (d.type === "chat-ready") {
            reveal(); // conversation loaded — slide the chat in
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
    // Inside the native desktop console the agent panel keeps its own header
    // (?embed=desktop); on web/mobile it is the headerless merged-bar embed (?embed=1).
    var EMBED_PARAM = window.desktopConsole ? "desktop" : "1";
    chatFrame.src = "/_agent/sidebar.html?embed=" + EMBED_PARAM + "&theme=" + encodeURIComponent(currentTheme());
    chatFrame.addEventListener("load", function () {
        applyTheme(currentTheme());
    });

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

    /* ---- agent X-ray overlay + meeting copilot (fed by SSE) ----
     * Renders the same cursor / look / typing / acting / context the desktop's
     * native overlay shows, mapped onto the live screen (incl. zoom/pan), plus the
     * floating copilot. Guarded so the node test (no EventSource) skips it. */
    if (typeof EventSource !== "undefined") {
        setupOverlays();
    }
    function setupOverlays() {
        var xray = document.getElementById("xray");
        var aiCursor = document.getElementById("ai-cursor");
        var actingAction = document.getElementById("acting-action");
        var actingCtx = document.getElementById("acting-ctx");
        if (!xray || !aiCursor) return;

        // Frame fraction (0..1) -> pane-relative px on the screen content (tracks
        // the object-fit letterbox AND the current zoom/pan transform).
        function contentBox() {
            var r = streamEl().getBoundingClientRect();
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
            var pr = pane.getBoundingClientRect();
            return { left: r.left + ox - pr.left, top: r.top + oy - pr.top, width: cw, height: ch };
        }
        function pt(fx, fy) {
            var b = contentBox();
            return { x: b.left + fx * b.width, y: b.top + fy * b.height };
        }

        var cur = { x: 0, y: 0 };
        var tgt = { x: 0, y: 0 };
        var raf = null;
        function lerp() {
            cur.x += (tgt.x - cur.x) * 0.18;
            cur.y += (tgt.y - cur.y) * 0.18;
            aiCursor.style.left = cur.x + "px";
            aiCursor.style.top = cur.y + "px";
            raf = Math.abs(tgt.x - cur.x) > 0.4 || Math.abs(tgt.y - cur.y) > 0.4 ? requestAnimationFrame(lerp) : null;
        }
        function onCursor(d) {
            if (!d.w || !d.h) return;
            var p = pt(d.x / d.w, d.y / d.h);
            tgt = p;
            aiCursor.classList.add("show");
            if (!raf) raf = requestAnimationFrame(lerp);
            if (d.kind === "click" || d.kind === "double_click") {
                var b = document.createElement("div");
                b.className = "click-burst";
                b.style.left = p.x + "px";
                b.style.top = p.y + "px";
                xray.appendChild(b);
                setTimeout(function () {
                    b.remove();
                }, 600);
            }
        }
        function onRegion(d) {
            if (!d.w || !d.h) return;
            var b = contentBox();
            var p = pt(d.x / d.w, d.y / d.h);
            var box = document.createElement("div");
            box.className = "look-box";
            box.style.left = p.x + "px";
            box.style.top = p.y + "px";
            box.style.width = Math.max(10, (d.width / d.w) * b.width) + "px";
            box.style.height = Math.max(10, (d.height / d.h) * b.height) + "px";
            var tag = document.createElement("div");
            tag.className = "look-tag";
            tag.textContent = d.label || "Looking";
            box.appendChild(tag);
            var scan = document.createElement("div");
            scan.className = "scan";
            box.appendChild(scan);
            xray.appendChild(box);
            requestAnimationFrame(function () {
                box.classList.add("show");
            });
            setTimeout(function () {
                box.classList.remove("show");
                setTimeout(function () {
                    box.remove();
                }, 240);
            }, d.hold || 1500);
        }
        // LLM-segmented region map: persistent, thin labelled rectangles for the
        // salient regions (windows, taskbar, AVD, terminal…), redrawn whenever a
        // fresh map arrives. Held in their own layer so they can be re-scaled with
        // the stream (letterbox + zoom/pan) on every reflow, like the other boxes.
        var regionsLayer = null;
        var lastRegions = null;
        function renderRegions() {
            if (!lastRegions || !lastRegions.w || !lastRegions.h) return;
            if (!regionsLayer) {
                regionsLayer = document.createElement("div");
                regionsLayer.className = "region-layer";
                xray.appendChild(regionsLayer);
            }
            var b = contentBox();
            regionsLayer.textContent = "";
            var rs = lastRegions.regions || [];
            for (var i = 0; i < rs.length; i++) {
                var r = rs[i];
                var p = pt(r.x / lastRegions.w, r.y / lastRegions.h);
                var box = document.createElement("div");
                box.className = "region-box";
                box.style.left = p.x + "px";
                box.style.top = p.y + "px";
                box.style.width = Math.max(8, (r.width / lastRegions.w) * b.width) + "px";
                box.style.height = Math.max(8, (r.height / lastRegions.h) * b.height) + "px";
                var tag = document.createElement("div");
                tag.className = "region-tag";
                tag.textContent = (r.label || "Region") + (r.kind ? " · " + r.kind : "");
                box.appendChild(tag);
                regionsLayer.appendChild(box);
            }
        }
        function onRegions(d) {
            if (!d || !d.w || !d.h) return;
            lastRegions = d;
            renderRegions();
        }
        // Keep the persistent region boxes glued to the stream as it zooms/pans/resizes.
        onXform = renderRegions;
        window.addEventListener("resize", renderRegions);

        var typeBox = null;
        var typeHide = null;
        function onTyping(d) {
            if (!d.w || !d.h) return;
            if (!typeBox) {
                typeBox = document.createElement("div");
                typeBox.className = "type-box";
                typeBox.innerHTML = '<div class="type-tag"></div><div class="pbar"></div>';
                xray.appendChild(typeBox);
            }
            if (typeHide) {
                clearTimeout(typeHide);
                typeHide = null;
            }
            var tag = typeBox.querySelector(".type-tag");
            var bar = typeBox.querySelector(".pbar");
            if (d.region) {
                var b = contentBox();
                var p = pt(d.region.x / d.w, d.region.y / d.h);
                typeBox.style.left = p.x + "px";
                typeBox.style.top = p.y + "px";
                typeBox.style.width = Math.max(12, (d.region.width / d.w) * b.width) + "px";
                typeBox.style.height = Math.max(10, (d.region.height / d.h) * b.height) + "px";
            }
            typeBox.classList.remove("verifying", "verified", "correcting");
            typeBox.classList.add("show");
            switch (d.phase) {
                case "start":
                    tag.textContent = "Typing…";
                    bar.style.width = "0%";
                    break;
                case "located":
                case "progress":
                    tag.textContent = "Typing…";
                    if (typeof d.done === "number" && d.total) bar.style.width = Math.min(100, Math.round((100 * d.done) / d.total)) + "%";
                    break;
                case "verifying":
                    tag.textContent = "Verifying…";
                    typeBox.classList.add("verifying");
                    break;
                case "verified":
                    tag.textContent = "Verified ✓";
                    typeBox.classList.add("verified");
                    break;
                case "correcting":
                    tag.textContent = d.reason === "no-focus" ? "Not focused ✗" : d.reason === "layout" ? "Layout slip — fixing ✗" : "Fixing ✗";
                    typeBox.classList.add("correcting");
                    break;
                case "done":
                    tag.textContent = d.ok ? (d.corrected ? "Fixed ✓" : "Verified ✓") : "Check failed";
                    typeBox.classList.add(d.ok ? "verified" : "correcting");
                    bar.style.width = "100%";
                    typeHide = setTimeout(function () {
                        if (typeBox) typeBox.classList.remove("show");
                    }, 1500);
                    break;
            }
        }
        function onActing(d) {
            pane.classList.toggle("acting", !!d.active);
            if (d.active && actingAction && d.action) actingAction.textContent = d.action;
            if (!d.active) aiCursor.classList.remove("show");
        }
        function onContext(c) {
            if (!actingCtx) return;
            if (!c || !c.app) {
                actingCtx.classList.remove("show");
                return;
            }
            actingCtx.classList.add("show");
            actingCtx.classList.toggle("sensitive", !!c.sensitive);
            actingCtx.textContent = "· " + (c.sensitive ? c.app + " — sensitive, needs approval" : c.app);
        }

        var es = new EventSource("/_agent/api/overlay/stream");
        es.onmessage = function (ev) {
            var d;
            try {
                d = JSON.parse(ev.data);
            } catch (e) {
                return;
            }
            if (d.type === "cursor") onCursor(d);
            else if (d.type === "region") onRegion(d);
            else if (d.type === "regions") onRegions(d);
            else if (d.type === "typing") onTyping(d);
            else if (d.type === "acting") onActing(d);
            else if (d.type === "context") onContext(d);
        };

        var stopBtn = document.getElementById("act-stop");
        var pauseBtn = document.getElementById("act-pause");
        if (stopBtn) stopBtn.addEventListener("click", function () {
            fetch("/_agent/api/stop", { method: "POST" }).catch(function () {});
        });
        if (pauseBtn) pauseBtn.addEventListener("click", function () {
            fetch("/_agent/api/pause", { method: "POST" }).catch(function () {});
        });

        // Floating meeting copilot, fed by the existing ambient SSE.
        var copilot = document.getElementById("copilot");
        var copilotBody = document.getElementById("copilot-body");
        var copilotX = document.getElementById("copilot-x");
        if (copilot && copilotBody) {
            if (copilotX) copilotX.addEventListener("click", function () {
                copilot.classList.remove("show");
            });
            var aes = new EventSource("/_agent/api/ambient/stream");
            aes.onmessage = function (ev) {
                var d;
                try {
                    d = JSON.parse(ev.data);
                } catch (e) {
                    return;
                }
                if (d.level === "suggestion" && d.text) {
                    copilot.classList.add("show");
                    var s = document.createElement("div");
                    s.className = "sug";
                    s.textContent = d.text;
                    copilotBody.insertBefore(s, copilotBody.firstChild);
                    while (copilotBody.children.length > 8) copilotBody.removeChild(copilotBody.lastChild);
                }
            };
        }
    }

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
        document.documentElement.classList.add("desktop-console");
        // Platform → window-control style (GNOME/Adwaita on Linux, native traffic
        // lights on macOS so we hide our own, Windows keeps the default custom set).
        if (dc.platform) document.documentElement.classList.add("platform-" + dc.platform);
        if (dc.nativeControls) document.documentElement.classList.add("native-window-controls");

        // Block KVM mouse movement while the window is NOT focused — a background
        // window must not let a passing cursor drive the remote pointer.
        window.addEventListener("focus", function () {
            windowFocused = true;
        });
        window.addEventListener("blur", function () {
            windowFocused = false;
        });

        // Desktop keyboard: forward PHYSICAL keystrokes straight to the KVM. The agent
        // chat is an iframe, so when it has focus the parent document never sees the
        // key — this only fires for KVM-destined input. We skip our own editable fields.
        document.addEventListener("keydown", function (e) {
            if (!windowFocused) return;
            var t = e.target;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
            if (e.isComposing) return;
            var code = e.code;
            if (!code) return;
            if (/^(Control|Alt|Meta|Shift)(Left|Right)?$/.test(code)) return; // bare modifier rides the chord
            var mods = modsFromEvent(e).concat(armedList());
            var ctl = CONTROL_KEYS[code] || CONTROL_KEYS[e.key] || (/^F\d{1,2}$/.test(code) ? code : null);
            if (ctl) {
                e.preventDefault();
                if (dedupe(ctl)) sendChord(mods, ctl, false);
                clearArmed();
                return;
            }
            if (e.ctrlKey || e.altKey || e.metaKey) {
                e.preventDefault();
                if (dedupe(code)) sendChord(mods, code, e.shiftKey);
                clearArmed();
                return;
            }
            // Printable: send the produced character (respects the host keyboard layout).
            if (e.key && e.key.length === 1) {
                e.preventDefault();
                sendChar(e.key);
                clearArmed();
            } else if (dedupe(code)) {
                e.preventDefault();
                sendChord(mods, code, e.shiftKey);
                clearArmed();
            }
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

        /* ---- agent panel collapse (titlebar-left toggle) ---- */
        var tbPanel = document.getElementById("tb-panel");
        function panelShown() {
            return !app.classList.contains("panel-collapsed");
        }
        function paintPanelToggle() {
            if (tbPanel) tbPanel.classList.toggle("active", panelShown());
        }
        var lastPanelW = 380;
        function setPanel(show) {
            if (show === panelShown()) return;
            if (!show) {
                // Collapsing: remember the panel's width, then SHRINK the window by it
                // so the KVM screen keeps its exact size (window loses the panel column).
                var chat = document.querySelector(".chat");
                lastPanelW = chat ? Math.round(chat.getBoundingClientRect().width) : lastPanelW;
                app.classList.add("panel-collapsed");
                if (dc.resizeBy) dc.resizeBy(-lastPanelW, 0);
            } else {
                // Expanding: GROW the window by the panel width first, then show it.
                app.classList.remove("panel-collapsed");
                if (dc.resizeBy) dc.resizeBy(lastPanelW, 0);
            }
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
        var tbFit = document.getElementById("tb-fit");
        if (tbFit) {
            tbFit.addEventListener("click", function () {
                var d = nativeDims();
                if (!d) return;
                dc.fitNative({
                    width: d.w,
                    height: d.h,
                    // The chat column's measured width (0 when collapsed) so the
                    // screen lands exactly on its native size.
                    agentPanelWidth: panelShown() ? Math.round(document.querySelector(".chat").getBoundingClientRect().width) : 0,
                    titlebarHeight: TITLEBAR_H,
                });
            });
        }

        // Titlebar audio/mic: drive the canonical toggles (the hidden menu buttons run
        // setAudio/setMic + getUserMedia; paintToggle mirrors state back to these).
        var tbAudio = document.getElementById("tb-audio");
        var tbMic = document.getElementById("tb-mic");
        if (tbAudio) tbAudio.addEventListener("click", function () { var b = document.getElementById("audio-btn"); if (b) b.click(); });
        if (tbMic) tbMic.addEventListener("click", function () { var b = document.getElementById("mic-btn"); if (b) b.click(); });

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
        function buildMenu() {
            var items = [
                { id: "history", label: "History" },
                { id: "ambient", label: "Monitor" },
                { id: "settings", label: "Settings" },
                { id: "copy", label: "Copy conversation" },
            ];
            if (avAvailable()) {
                items.push({ type: "separator" });
                items.push({ id: "audio", label: "Audio output", type: "checkbox", checked: audioOn });
                items.push({ id: "mic", label: "Microphone", type: "checkbox", checked: micOn });
            }
            items.push({ type: "separator" });
            items.push({ id: "panel", label: panelShown() ? "Hide agent panel" : "Show agent panel" });
            items.push({ id: "fit", label: "Fit to native resolution", enabled: !!nativeDims() });
            items.push({ id: "theme", label: "Toggle theme" });
            items.push({ type: "separator" });
            items.push({ id: "full-ui", label: "Full PiKVM UI" });
            return items;
        }
        function runCommand(id) {
            switch (id) {
                case "history":
                case "ambient":
                case "settings":
                    try { chatFrame.contentWindow.postMessage({ type: "agent-action", action: id }, "*"); } catch (e) {}
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

        // The window starts wide enough for the desktop layout immediately, so fit
        // the screen once the first frame is known.
        setTimeout(function () { try { fitAspect(); } catch (e) {} }, 0);
    })();
})();
