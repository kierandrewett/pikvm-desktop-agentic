/*
 * WebRTC (Janus) streamer for the console — smooth H.264 video + AUDIO + MIC,
 * the same path PiKVM's own UI uses. Ported from PiKVM's stream_janus.js, stripped
 * of its DOM/tools coupling. Talks to the Pi's `janus.plugin.ustreamer` over the
 * proxied `wss://<origin>/janus/ws`.
 *
 * Flow: Janus.init → new Janus(ws) → attach ustreamer → {request:"features"} →
 * {request:"watch", params:{audio,mic,cam}} → createAnswer(tracks) → {request:"start"}
 * → onremotetrack → <video>. Mic = capture:true on the audio track.
 *
 * Usage: const s = JanusStream({ wsUrl, video, wantAudio, wantMic, onStatus, onActive });
 *        s.start(); s.setMic(true); s.setAudio(true); s.stop();
 * Falls back to MJPEG (in console.js) when WebRTC/Janus is unavailable.
 */
(function () {
    "use strict";

    var Janus = null;
    function ensureJanus(cb) {
        if (Janus) return cb(true);
        import("/_agent/janus.js")
            .then(function (m) {
                m.Janus.init({
                    debug: false,
                    callback: function () {
                        Janus = m.Janus;
                        cb(true);
                    },
                });
            })
            .catch(function (e) {
                console.error("Janus import failed", e);
                cb(false);
            });
    }

    window.JanusStream = function (opts) {
        var janus = null;
        var handle = null;
        var ice = null;
        var stopped = false;
        var allowAudio = !!opts.wantAudio;
        var allowMic = !!opts.wantMic;
        var allowCam = false;
        var retry = null;
        var video = opts.video;
        var status = opts.onStatus || function () {};
        var onActive = opts.onActive || function () {};

        function addTrack(track) {
            if (video.srcObject) {
                video.srcObject.getTracks().forEach(function (tr) {
                    if (tr.kind === track.kind && tr.id !== track.id) removeTrack(tr);
                });
            }
            if (!video.srcObject) video.srcObject = new MediaStream();
            video.srcObject.addTrack(track);
        }
        function removeTrack(track) {
            if (!video.srcObject) return;
            try {
                track.stop();
            } catch (e) {}
            try {
                video.srcObject.removeTrack(track);
            } catch (e) {}
            if (video.srcObject.getTracks().length === 0) video.srcObject = null;
        }

        function sendWatch() {
            if (handle) handle.send({ message: { request: "watch", params: { orientation: 0, audio: allowAudio, mic: allowMic, cam: allowCam } } });
        }
        function sendStart(jsep) {
            if (handle) handle.send({ message: { request: "start" }, jsep: jsep });
        }
        function sendStop() {
            if (handle) {
                try {
                    handle.send({ message: { request: "stop" } });
                    handle.hangup();
                } catch (e) {}
            }
        }

        function attach() {
            if (!janus) return;
            janus.attach({
                plugin: "janus.plugin.ustreamer",
                opaqueId: "oid-" + Janus.randomString(12),
                success: function (h) {
                    handle = h;
                    h.send({ message: { request: "features" } });
                },
                error: function (e) {
                    status("error", e);
                    destroy();
                },
                connectionState: function (st) {
                    if (st === "failed") destroy();
                },
                webrtcState: function () {},
                onmessage: function (msg, jsep) {
                    if (msg.result) {
                        if (msg.result.status === "started") {
                            onActive(true);
                            status("live");
                        } else if (msg.result.status === "stopped") {
                            onActive(false);
                        } else if (msg.result.status === "features") {
                            ice = msg.result.features.ice;
                            // honour what the Pi actually supports
                            if (!msg.result.features.audio) allowAudio = false;
                            if (!msg.result.features.mic) allowMic = false;
                            sendWatch();
                        }
                    } else if (msg.error_code || msg.error) {
                        status("error", msg.error);
                        setTimeout(function () {
                            if (!stopped) {
                                sendStop();
                                sendWatch();
                            }
                        }, 2000);
                        return;
                    }
                    if (jsep) {
                        var tracks = [{ type: "video", capture: allowAudio && allowCam, recv: true, add: true }];
                        if (allowAudio) tracks.push({ type: "audio", capture: allowMic, recv: true, add: true });
                        handle.createAnswer({
                            jsep: jsep,
                            tracks: tracks,
                            // Chrome plays OPUS as mono without this (PiKVM's hack).
                            customizeSdp: function (j) {
                                j.sdp = j.sdp.replace("useinbandfec=1", "useinbandfec=1;stereo=1");
                            },
                            success: function (j) {
                                sendStart(j);
                            },
                            error: function (e) {
                                status("error", e);
                            },
                        });
                    }
                },
                onremotetrack: function (track, id, added, meta) {
                    var reason = (meta || {}).reason;
                    if (added && reason === "created") addTrack(track);
                    else if (!added && reason === "ended") removeTrack(track);
                },
                oncleanup: function () {},
            });
        }

        function ensure() {
            if (janus || stopped) return;
            status("connecting");
            janus = new Janus({
                server: opts.wsUrl,
                ipv6: true,
                destroyOnUnload: false,
                iceServers: function () {
                    return ice && ice.url ? [{ urls: ice.url }] : [];
                },
                success: attach,
                error: function (e) {
                    status("error", e);
                    finish();
                },
            });
        }
        function finish() {
            if (handle) {
                try {
                    handle.detach();
                } catch (e) {}
                handle = null;
            }
            janus = null;
            if (!stopped && !retry)
                retry = setTimeout(function () {
                    retry = null;
                    ensure();
                }, 5000);
        }
        function destroy() {
            if (janus) {
                try {
                    janus.destroy();
                } catch (e) {}
            }
            finish();
            if (video.srcObject) {
                video.srcObject.getTracks().forEach(function (t) {
                    try {
                        t.stop();
                    } catch (e) {}
                });
                video.srcObject = null;
            }
        }
        function rewatch() {
            if (handle) {
                sendStop();
                sendWatch();
            }
        }

        return {
            start: function () {
                stopped = false;
                ensureJanus(function (ok) {
                    if (ok) ensure();
                    else status("error", "no-janus");
                });
            },
            stop: function () {
                stopped = true;
                sendStop();
                destroy();
            },
            setAudio: function (on) {
                allowAudio = !!on;
                rewatch();
            },
            setMic: function (on) {
                allowMic = !!on;
                rewatch();
            },
            hasVideo: function () {
                return !!(video.srcObject && video.srcObject.getVideoTracks().length);
            },
            // Read the live audio energy (0..1) for the received (speaker) and sent
            // (mic) tracks straight from WebRTC stats — no AudioContext / output
            // device needed. Resolves { speaker, mic } (null when unavailable).
            getAudioLevels: function () {
                var pc = handle && handle.webrtcStuff && handle.webrtcStuff.pc;
                if (!pc || !pc.getStats) return Promise.resolve({ speaker: null, mic: null });
                return pc.getStats().then(function (report) {
                    var speaker = null;
                    var mic = null;
                    report.forEach(function (s) {
                        if (s.kind !== "audio" && s.mediaType !== "audio") return;
                        if (s.type === "inbound-rtp" && typeof s.audioLevel === "number") speaker = s.audioLevel;
                        else if ((s.type === "media-source" || s.type === "outbound-rtp") && typeof s.audioLevel === "number") mic = s.audioLevel;
                    });
                    return { speaker: speaker, mic: mic };
                }).catch(function () {
                    return { speaker: null, mic: null };
                });
            },
        };
    };

    window.JanusStream.available = function () {
        return !!window.RTCPeerConnection;
    };
})();
