// Failure modes V1-V10, S1-S4, W1-W5, L1-L3, U1: see FAILURE_MODES.md.
//
// Everything runs through the driver on a manual clock, so an outage of minutes
// takes microseconds and every timeout is exact.

import { describe, expect, it } from "vitest";
import { createVideoState, reduceVideo } from "./machine";
import type { VideoState } from "./machine";
import { sourceOnline, streamModeForInfo, streamPath } from "./stream-path";
import { createVideoRig } from "./test-rig";
import type { VideoRig } from "./test-rig";
import { statusLabel } from "./types";
import type { VideoEffect, VideoEvent } from "./types";

/** Boot a native screen and bring it live on MJPEG. */
function liveNative(init?: Parameters<typeof createVideoRig>[0]): VideoRig {
    const r = createVideoRig(init);
    r.bootNative();
    r.goLive();
    r.clear();
    return r;
}

describe("choosing the source", () => {
    it("V1: only vnc_lab.enabled === true selects snapshot mode", () => {
        const table: [string, unknown, "native" | "snapshot"][] = [
            ["enabled", { result: { extras: { vnc_lab: { enabled: true } } } }, "snapshot"],
            ["disabled", { result: { extras: { vnc_lab: { enabled: false } } } }, "native"],
            ["truthy but not true", { result: { extras: { vnc_lab: { enabled: 1 } } } }, "native"],
            ["string true", { result: { extras: { vnc_lab: { enabled: "true" } } } }, "native"],
            ["no extras", { result: {} }, "native"],
            ["null", null, "native"],
            ["garbage", "hello", "native"],
        ];
        for (const [name, info, mode] of table) expect(streamModeForInfo(info), name).toBe(mode);
    });

    it("V1: boot asks /api/info, and a failed answer starts the native screen", () => {
        const r = createVideoRig();
        r.driver.start();
        expect(r.of("fetchInfo")).toEqual([{ type: "fetchInfo", timeoutMs: 2500 }]);
        r.send({ type: "infoFailed" });
        expect(r.driver.state.mode).toBe("native");
        expect(r.of("loadMjpeg")).toHaveLength(1);
    });

    it("V2: the MJPEG URL carries the browser quirk and an encoded key", () => {
        const table: [string, string, string][] = [
            ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Safari/604.1", "&dual_final_frames=1"],
            ["iPad Chrome", "Mozilla/5.0 (iPad) CriOS/120 Safari/604.1", "&dual_final_frames=1"],
            ["Safari", "Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/17 Safari/605", "&dual_final_frames=1"],
            ["Chrome", "Mozilla/5.0 (X11; Linux) AppleWebKit Chrome/120 Safari/537", "&advance_headers=1"],
            ["Android Chrome", "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537", "&advance_headers=1"],
            ["Firefox", "Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/120", ""],
            ["empty", "", ""],
        ];
        for (const [name, ua, quirk] of table) expect(streamPath("a b&c", ua), name).toBe(`/streamer/stream?key=a%20b%26c${quirk}`);
    });

    it("V3: MJPEG starts at once alongside WebRTC, which is started only when it can be", () => {
        const ok = createVideoRig({ janus: "ok" });
        ok.bootNative();
        expect(ok.of("loadMjpeg")).toHaveLength(1);
        expect(ok.janus.started).toBe(1);
        expect(ok.driver.state.janusStarted).toBe(true);

        const none = createVideoRig({ janus: "unavailable" });
        none.bootNative();
        expect(none.of("loadMjpeg")).toHaveLength(1);
        expect(none.janus.started).toBe(0);
        expect(none.driver.state.janusStarted).toBe(false);

        const boom = createVideoRig({ janus: "throws" });
        boom.bootNative();
        expect(boom.of("loadMjpeg")).toHaveLength(1);
        expect(boom.janus.started).toBe(1);
        expect(boom.driver.state.janusStarted).toBe(false);
        // no start guard is armed for a session that does not exist: health + blank + stream watchdog only
        expect(boom.clock.pending()).toBe(3);
        expect(ok.clock.pending()).toBe(4);
    });
});

describe("MJPEG resilience", () => {
    it("V4: a first frame that never arrives restarts the stream after 7 s", () => {
        const r = createVideoRig();
        r.bootNative();
        r.clear();
        r.advance(6999);
        expect(r.count("loadMjpeg")).toBe(0);
        r.advance(1);
        expect(r.signals()).toEqual(["offline"]);
        r.advance(799);
        expect(r.count("loadMjpeg")).toBe(0);
        r.advance(1);
        expect(r.count("loadMjpeg")).toBe(1);
    });

    it("V4: restarts back off 800 ms x1.7 to 8 s, with one restart ever pending", () => {
        const r = createVideoRig();
        r.bootNative();
        for (const delay of [800, 1360, 2312, 3930, 6681, 8000, 8000]) {
            r.clear();
            r.send({ type: "mjpegError" });
            r.send({ type: "mjpegError" }); // a second error while one is pending must not queue another
            r.advance(delay - 1);
            expect(r.count("loadMjpeg"), `before ${delay}`).toBe(0);
            r.advance(1);
            expect(r.count("loadMjpeg"), `at ${delay}`).toBe(1);
        }
    });

    it("V4: a real frame resets the backoff to 800", () => {
        const r = createVideoRig();
        r.bootNative();
        for (let i = 0; i < 4; i++) {
            r.send({ type: "mjpegError" });
            r.advance(8000);
        }
        r.send({ type: "mjpegLoaded" });
        r.clear();
        r.send({ type: "mjpegError" });
        r.advance(799);
        expect(r.count("loadMjpeg")).toBe(0);
        r.advance(1);
        expect(r.count("loadMjpeg")).toBe(1);
    });

    it("V5: an unchanging outage produces ONE signal change, not nineteen", () => {
        const r = createVideoRig();
        r.bootNative();
        r.clear();
        r.send({ type: "healthFailed" });
        const seen: string[] = r.signals();
        r.clear();
        // 30 s of the streamer refusing every request: each reconnect fails, each health poll fails
        for (let i = 0; i < 30; i++) {
            r.advance(1000);
            if (r.count("loadMjpeg") > 0) r.send({ type: "mjpegError" });
            if (r.count("pollHealth") > 0) r.send({ type: "healthFailed" });
            seen.push(...r.signals());
            r.clear();
        }
        expect(seen).toEqual(["disconnected"]);
        expect(r.driver.state.signal).toBe("disconnected");
    });

    it("V6: recovery reloads under a NEW key, via reconnecting, and is live only on a real frame", () => {
        const r = liveNative();
        r.send({ type: "healthFailed" });
        expect(r.signals()).toEqual(["disconnected"]);
        r.clear();
        r.send({ type: "healthResult", online: true });
        expect(r.of("loadMjpeg")).toEqual([{ type: "loadMjpeg", key: "k-1" }]);
        expect(r.signals()).toEqual(["reconnecting"]);
        r.clear();
        r.send({ type: "mjpegLoaded" });
        expect(r.signals()).toEqual(["live"]);
        // a second outage gets a second, different key
        r.send({ type: "healthFailed" });
        r.clear();
        r.send({ type: "healthResult", online: true });
        expect(r.of("loadMjpeg")).toEqual([{ type: "loadMjpeg", key: "k-2" }]);
    });

    it("V7: the last good frame is held across restarts, never before one exists", () => {
        const early = createVideoRig();
        early.bootNative();
        early.send({ type: "mjpegError" });
        early.advance(20000);
        expect(early.count("freeze")).toBe(0); // nothing to hold yet

        const r = liveNative();
        r.send({ type: "healthFailed" }); // live -> disconnected
        expect(r.count("freeze")).toBeGreaterThan(0);
        r.send({ type: "healthResult", online: true }); // reload: freeze before the src is replaced
        const kinds = r.fx.map((e) => e.type);
        expect(kinds.lastIndexOf("freeze")).toBeLessThan(kinds.lastIndexOf("loadMjpeg"));
        r.clear();
        r.send({ type: "mjpegLoaded" });
        expect(r.count("thaw")).toBeGreaterThan(0);
    });

    it("V8: the health poll tells no signal from server down from a hiccup", () => {
        const r = liveNative();
        r.send({ type: "healthResult", online: false });
        expect(r.signals()).toEqual(["nosignal"]);
        r.send({ type: "healthResult", online: false });
        expect(r.signals()).toEqual(["nosignal"]); // not repainted
        r.send({ type: "healthResult", online: true });
        expect(r.signals()).toEqual(["nosignal", "live"]);

        const idle = createVideoRig();
        idle.bootNative(); // no frame has arrived: streamUp is false
        idle.clear();
        idle.send({ type: "healthResult", online: false });
        idle.send({ type: "healthResult", online: true });
        expect(idle.signals()).toEqual([]);
    });

    it("V8: a blank picture reads as no signal even when the source says online", () => {
        const r = liveNative();
        r.send({ type: "blankSample", uniform: true });
        r.advance(2501);
        r.send({ type: "blankSample", uniform: true });
        expect(r.driver.state.signal).toBe("nosignal");
        r.clear();
        r.send({ type: "healthResult", online: true });
        expect(r.signals()).toEqual([]);
        expect(r.driver.state.signal).toBe("nosignal");
    });

    it("V9: the health poll leaves the status alone while WebRTC owns the picture", () => {
        const r = liveNative({ janus: "ok" });
        r.webrtcUp();
        r.clear();
        r.send({ type: "healthResult", online: false });
        r.send({ type: "healthFailed" });
        expect(r.signals()).toEqual([]);
        expect(r.driver.state.signal).toBe("live");
    });

    it("V10: a collapsed preview closes the stream, cannot be reopened behind it, and expanding resumes it", () => {
        const r = liveNative();
        r.send({ type: "need", collapsed: true, watching: false });
        expect(r.count("dropMjpeg")).toBe(1);
        r.clear();
        r.send({ type: "mjpegError" });
        r.advance(60000);
        expect(r.count("loadMjpeg")).toBe(0);
        r.send({ type: "need", collapsed: false, watching: false });
        expect(r.count("loadMjpeg")).toBe(1);
    });

    it("V10: background alerts keep a collapsed stream open", () => {
        const r = liveNative();
        r.send({ type: "need", collapsed: true, watching: true });
        expect(r.count("dropMjpeg")).toBe(0);
        expect(r.driver.state.mjpegOpen).toBe(true);
    });

    it("V10: the framed Pi UI closes our stream and nothing reopens it until it is gone", () => {
        const r = liveNative();
        r.send({ type: "fullUi", on: true });
        expect(r.count("dropMjpeg")).toBe(1);
        r.clear();
        r.send({ type: "online" });
        r.send({ type: "mjpegError" });
        r.advance(60000);
        expect(r.count("loadMjpeg")).toBe(0);
        r.send({ type: "fullUi", on: false });
        expect(r.count("loadMjpeg")).toBe(1);
    });

    it("is pure: an event never mutates the state it was given", () => {
        const before = createVideoState();
        const snapshot = JSON.stringify(before);
        const a = reduceVideo(before, { type: "start", t: 0, janusAvailable: true, streamKey: "k" });
        const b = reduceVideo(before, { type: "start", t: 0, janusAvailable: true, streamKey: "k" });
        expect(JSON.stringify(before)).toBe(snapshot);
        expect(a).toEqual(b);
    });
});

describe("snapshot mode", () => {
    it("S1: polls 200 ms after a good frame, one fetch at a time", () => {
        const r = createVideoRig();
        r.bootSnapshot();
        expect(r.count("fetchSnapshot")).toBe(1);
        expect(r.count("loadMjpeg")).toBe(0);
        r.send({ type: "snapshotDecoded" });
        expect(r.signals()).toContain("live");
        expect(r.count("presentSnapshot")).toBe(1);
        r.clear();
        r.advance(199);
        expect(r.count("fetchSnapshot")).toBe(0);
        r.advance(1);
        expect(r.count("fetchSnapshot")).toBe(1);
        // a nudge while one is in flight must not start a second
        r.send({ type: "online" });
        r.advance(10);
        expect(r.count("fetchSnapshot")).toBe(1);
    });

    it("S1: a hidden document does not fetch and waits 500 ms", () => {
        const r = createVideoRig({ documentHidden: true });
        r.bootSnapshot();
        expect(r.count("fetchSnapshot")).toBe(0);
        r.advance(499);
        r.advance(1);
        expect(r.count("fetchSnapshot")).toBe(0);
        r.send({ type: "visibility", hidden: false });
        r.advance(0);
        expect(r.count("fetchSnapshot")).toBe(1);
    });

    it("S2: failures back off 400 ms x1.8, 'reconnecting' twice then 'disconnected', and a frame resets", () => {
        const r = createVideoRig();
        r.bootSnapshot();
        r.clear();
        const delays = [400, 400 * 1.8, 400 * 1.8 ** 2, 400 * 1.8 ** 3, 400 * 1.8 ** 4, 5000, 5000];
        const seen: string[] = [];
        for (const d of delays) {
            r.send({ type: "snapshotFailed" });
            seen.push(...r.signals());
            r.clear();
            r.advance(Math.ceil(d) - 1);
            expect(r.count("fetchSnapshot"), `before ${d}`).toBe(0);
            r.advance(1);
            expect(r.count("fetchSnapshot"), `at ${d}`).toBe(1);
            r.clear();
        }
        expect(seen).toEqual(["reconnecting", "disconnected"]);
        r.send({ type: "snapshotDecoded" });
        expect(r.driver.state.snapshotFailures).toBe(0);
        expect(r.driver.state.signal).toBe("live");
        r.clear();
        r.advance(200);
        r.send({ type: "snapshotFailed" });
        expect(r.signals()).toEqual(["reconnecting"]);
        r.clear();
        r.advance(399);
        expect(r.count("fetchSnapshot")).toBe(0);
        r.advance(1);
        expect(r.count("fetchSnapshot")).toBe(1);
    });

    it("S3: a frame decoded after the mode changed is thrown away", () => {
        const native = reduceVideo({ ...createVideoState(), mode: "native", snapshotInFlight: true }, { type: "snapshotDecoded", t: 0 });
        expect(native.effects.map((e) => e.type)).toEqual(["discardSnapshot"]);
        expect(native.state.snapshotInFlight).toBe(false);
    });

    it("S4: MJPEG is never opened and the framed Pi UI is refused", () => {
        const r = createVideoRig();
        r.bootSnapshot();
        r.clear();
        r.send({ type: "mjpegLoaded" });
        r.send({ type: "mjpegError" });
        r.send({ type: "fullUi", on: true });
        r.send({ type: "need", collapsed: true, watching: false });
        r.send({ type: "need", collapsed: false, watching: false });
        r.advance(20000);
        expect(r.count("loadMjpeg")).toBe(0);
        expect(r.count("dropMjpeg")).toBe(0);
        expect(r.driver.state.fullUiOn).toBe(false);
    });
});

describe("WebRTC", () => {
    it("W1: a track arriving does not swap the picture; playing does", () => {
        const r = createVideoRig({ janus: "ok" });
        r.bootNative();
        r.clear();
        r.janus.hasVideo = true;
        r.janus.handlers?.onActive(true);
        expect(r.count("webrtcActivated")).toBe(1);
        expect(r.count("dropMjpeg")).toBe(0);
        expect(r.count("videoSwapped")).toBe(0);
        expect(r.driver.state.mjpegPaused).toBe(false);
        expect(r.driver.state.mjpegOpen).toBe(true);

        r.send({ type: "videoPlaying" });
        expect(r.of("videoSwapped")).toEqual([{ type: "videoSwapped", first: true }]);
        expect(r.driver.state.mjpegPaused).toBe(true);
        expect(r.driver.state.mjpegOpen).toBe(false);
        expect(r.driver.state.signal).toBe("live");
        // every MJPEG timer died with the swap: nothing comes back to talk over the video
        r.clear();
        r.advance(60000);
        expect(r.fx.filter((e) => e.type === "loadMjpeg" || e.type === "webrtcFallback" || e.type === "signal")).toEqual([]);
        // later `playing` events only re-apply the audio preference
        r.send({ type: "videoPlaying" });
        expect(r.of("videoSwapped")).toEqual([{ type: "videoSwapped", first: false }]);
    });

    it("W1: active without a video track does not activate; a stray playing does nothing", () => {
        const r = createVideoRig({ janus: "ok" });
        r.bootNative();
        r.clear();
        r.janus.handlers?.onActive(true); // hasVideo false
        r.send({ type: "videoPlaying" });
        expect(r.fx).toEqual([]);
    });

    it("W2: a track that never plays falls back to MJPEG after 6 s", () => {
        const r = liveNative({ janus: "ok" });
        r.janus.hasVideo = true;
        r.janus.handlers?.onActive(true);
        r.clear();
        r.advance(5999);
        expect(r.count("webrtcFallback")).toBe(0);
        r.advance(1);
        expect(r.of("webrtcFallback")).toEqual([{ type: "webrtcFallback", wasActive: true }]);
        expect(r.signals()).toEqual(["offline"]);
        expect(r.count("loadMjpeg")).toBe(1);
        // the video is still showing when the frame is held, then it goes
        const kinds = r.fx.map((e) => e.type);
        expect(kinds.indexOf("freeze")).toBeGreaterThanOrEqual(0);
        expect(kinds.indexOf("freeze")).toBeLessThan(kinds.indexOf("webrtcFallback"));
    });

    it("W3: fallback with nothing to fall back from does not reload a good MJPEG stream", () => {
        const r = liveNative({ janus: "ok" });
        for (let i = 0; i < 5; i++) {
            r.advance(5000);
            r.janus.handlers?.onStatus("error");
        }
        expect(r.count("loadMjpeg")).toBe(0);
        expect(r.count("freeze")).toBe(0);
        expect(r.count("webrtcFallback")).toBe(0);
        expect(r.signals()).toEqual([]);
    });

    it("W3: when MJPEG was suspended there is work to do even if the session never became active", () => {
        const r = createVideoRig({ janus: "ok" });
        r.bootNative();
        r.driver.send({ type: "need", collapsed: false, watching: false });
        // WebRTC took over the pipeline without ever activating (a quirk of ordering): simulate suspension
        const suspended = { ...r.driver.state, mjpegPaused: true };
        const step = reduceVideo(suspended, { type: "janusStatus", t: 0, status: "error" });
        expect(step.effects.map((e) => e.type)).toContain("webrtcFallback");
        expect(step.state.mjpegPaused).toBe(false);
    });

    it("W4: an error after video was seen keeps the video; the session stopping falls back", () => {
        const r = liveNative({ janus: "ok" });
        r.webrtcUp();
        r.clear();
        r.janus.handlers?.onStatus("error");
        expect(r.fx).toEqual([]);
        r.janus.handlers?.onActive(false);
        expect(r.signals()).toEqual(["offline"]);
        expect(r.count("webrtcFallback")).toBe(1);
        const kinds = r.fx.map((e) => e.type);
        expect(kinds.indexOf("freeze")).toBeGreaterThanOrEqual(0); // held while the <img> reloads...
        expect(kinds.indexOf("freeze")).toBeLessThan(kinds.indexOf("webrtcFallback")); // ...before the <video> goes
        expect(r.count("loadMjpeg")).toBe(1);
        expect(r.driver.state.mjpegPaused).toBe(false);
        expect(r.driver.state.webrtcActive).toBe(false);
    });

    it("W5: the 8 s start guard with no video is a harmless fallback", () => {
        const r = liveNative({ janus: "ok" });
        r.advance(8000);
        expect(r.count("loadMjpeg")).toBe(0);
        expect(r.count("webrtcFallback")).toBe(0);
    });
});

describe("blank frames", () => {
    it("B1: needs MORE than 2.5 s of uniform picture, and one varied sample resets the wait", () => {
        const r = liveNative();
        r.send({ type: "blankSample", uniform: true });
        r.advance(2500);
        r.send({ type: "blankSample", uniform: true });
        expect(r.driver.state.blank.blank).toBe(false);
        r.advance(1);
        r.send({ type: "blankSample", uniform: true });
        expect(r.driver.state.blank.blank).toBe(true);
        expect(r.signals()).toEqual(["nosignal"]);

        const q = liveNative();
        q.send({ type: "blankSample", uniform: true });
        q.advance(2000);
        q.send({ type: "blankSample", uniform: false });
        q.advance(100);
        q.send({ type: "blankSample", uniform: true });
        q.advance(2500);
        q.send({ type: "blankSample", uniform: true });
        expect(q.driver.state.blank.blank).toBe(false);
        q.advance(1);
        q.send({ type: "blankSample", uniform: true });
        expect(q.driver.state.blank.blank).toBe(true);
    });

    it("B2: entering and leaving blank each repaint exactly once", () => {
        const r = liveNative();
        r.send({ type: "blankSample", uniform: true });
        r.advance(3000);
        for (let i = 0; i < 5; i++) {
            r.send({ type: "blankSample", uniform: true });
            r.advance(1500);
        }
        expect(r.signals()).toEqual(["nosignal"]);
        r.clear();
        for (let i = 0; i < 3; i++) r.send({ type: "blankSample", uniform: false });
        expect(r.signals()).toEqual(["live"]);
    });

    it("B2: a blank picture is not 'live' again when the next frame loads", () => {
        const r = liveNative();
        r.send({ type: "blankSample", uniform: true });
        r.advance(3000);
        r.send({ type: "blankSample", uniform: true });
        r.clear();
        r.send({ type: "mjpegLoaded" });
        expect(r.signals()).toEqual([]);
        expect(r.driver.state.signal).toBe("nosignal");
    });

    it("B3: samples are only asked for when there is a picture and someone could see it", () => {
        const r = createVideoRig();
        r.bootNative();
        r.clear();
        r.advance(1500);
        expect(r.count("sampleBlank")).toBe(0); // no frame yet
        r.goLive();
        r.clear();
        r.advance(1500);
        expect(r.of("sampleBlank")).toEqual([{ type: "sampleBlank", source: "image" }]);
        r.send({ type: "visibility", hidden: true });
        r.clear();
        r.advance(1500);
        expect(r.count("sampleBlank")).toBe(0);
        r.send({ type: "need", collapsed: false, watching: true });
        r.advance(1500);
        expect(r.count("sampleBlank")).toBe(1);
    });

    it("B3: samples the <video> once WebRTC is showing", () => {
        const r = liveNative({ janus: "ok" });
        r.webrtcUp();
        r.clear();
        r.advance(1500);
        expect(r.of("sampleBlank")).toEqual([{ type: "sampleBlank", source: "video" }]);
    });
});

describe("lifecycle", () => {
    it("L1: back after more than 1 s replaces the socket and reloads the stream", () => {
        const r = liveNative();
        r.send({ type: "visibility", hidden: true });
        r.advance(1001);
        r.clear();
        r.send({ type: "visibility", hidden: false });
        expect(r.of("hid")).toEqual([{ type: "hid", action: "kick" }]);
        expect(r.count("pollHealth")).toBe(1);
        expect(r.count("loadMjpeg")).toBe(1);
    });

    it("L1: back within 1 s only ensures the socket, and reloads only if the stream is not up", () => {
        const r = liveNative();
        r.send({ type: "visibility", hidden: true });
        r.advance(1000);
        r.clear();
        r.send({ type: "visibility", hidden: false });
        expect(r.of("hid")).toEqual([{ type: "hid", action: "connect" }]);
        expect(r.count("loadMjpeg")).toBe(0);

        r.send({ type: "healthFailed" });
        r.send({ type: "visibility", hidden: true });
        r.advance(100);
        r.clear();
        r.send({ type: "visibility", hidden: false });
        expect(r.count("loadMjpeg")).toBe(1); // not up: reload
    });

    it("L1: snapshot mode just polls again at once", () => {
        const r = createVideoRig();
        r.bootSnapshot();
        r.send({ type: "snapshotDecoded" });
        r.send({ type: "visibility", hidden: true });
        r.advance(10000);
        r.clear();
        r.send({ type: "visibility", hidden: false });
        r.advance(0);
        expect(r.count("fetchSnapshot")).toBe(1);
        expect(r.count("pollHealth")).toBe(0);
    });

    it("L2: network offline says disconnected; online replaces the socket and reloads", () => {
        const r = liveNative();
        r.send({ type: "offline" });
        expect(r.signals()).toEqual(["disconnected"]);
        expect(r.driver.state.serverDown).toBe(true);
        r.clear();
        r.send({ type: "online" });
        expect(r.driver.state.serverDown).toBe(false);
        expect(r.of("hid")).toEqual([{ type: "hid", action: "kick" }]);
        expect(r.count("loadMjpeg")).toBe(1);
    });

    it("L3: the health poll (2.5 s) repeats in native mode only, and disposing cancels everything", () => {
        const r = createVideoRig();
        r.bootNative();
        r.clear();
        r.advance(2500 * 4);
        expect(r.count("pollHealth")).toBe(4);
        r.driver.dispose();
        expect(r.clock.pending()).toBe(0);
        r.clear();
        r.advance(60000);
        expect(r.fx).toEqual([]);

        const s = createVideoRig();
        s.bootSnapshot();
        s.clear();
        s.advance(10000);
        expect(s.count("pollHealth")).toBe(0);
    });

    it("L3: disposing stops the Janus session", () => {
        const r = createVideoRig({ janus: "ok" });
        r.bootNative();
        r.driver.dispose();
        expect(r.janus.stopped).toBe(1);
    });
});

/** The reducer by hand, for what a manual clock cannot do: a page whose timers did not run while it was away. */
function pure(): {
    send(ev: Record<string, unknown> & { type: string; t: number }): VideoEffect[];
    readonly state: VideoState;
} {
    let state = createVideoState();
    return {
        send(ev) {
            const step = reduceVideo(state, ev as unknown as VideoEvent);
            state = step.state;
            return [...step.effects];
        },
        get state() {
            return state;
        },
    };
}

/** A native screen that has shown a frame, at t = 1000, last heartbeat at t = 4000. */
function pureLive() {
    const m = pure();
    m.send({ type: "start", t: 1000, janusAvailable: false, streamKey: "k" });
    m.send({ type: "infoResult", t: 1000, mode: "native" });
    m.send({ type: "mjpegLoaded", t: 1200 });
    m.send({ type: "healthResult", t: 1300, online: true });
    m.send({ type: "timer", t: 4000, id: "blank" });
    return m;
}

const loads = (fx: readonly VideoEffect[]): number => fx.filter((e) => e.type === "loadMjpeg").length;
const hidAction = (fx: readonly VideoEffect[]): unknown => fx.find((e) => e.type === "hid");

describe("coming back from the background", () => {
    it("R1: pageshow (persisted), focus and the Page Lifecycle resume are returns like visibilitychange", () => {
        for (const reason of ["pageshow", "focus", "resume"] as const) {
            const m = pureLive();
            m.send({ type: "freeze", t: 4100 });
            const fx = m.send({ type: "resume", t: 9000, reason, hidden: false });
            expect(hidAction(fx), reason).toEqual({ type: "hid", action: "kick" });
            expect(loads(fx), reason).toBe(1);
        }
    });

    it("R1: a return while document.hidden is not a return: nothing opens, and the page stays hidden", () => {
        const m = pureLive();
        m.send({ type: "visibility", t: 4100, hidden: true });
        const fx = m.send({ type: "resume", t: 9000, reason: "focus", hidden: true });
        expect(fx).toEqual([]);
        expect(m.state.documentHidden).toBe(true);
        expect(m.state.hiddenAt).toBe(4100);
    });

    it("R2: a page frozen without ever being told is found by the gap in its own heartbeat", () => {
        const m = pureLive();
        const fx = m.send({ type: "timer", t: 64_000, id: "blank" }); // first thing to run after a minute frozen
        expect(hidAction(fx)).toEqual({ type: "hid", action: "kick" });
        expect(loads(fx)).toBe(1);
        expect(fx.some((e) => e.type === "pollHealth")).toBe(true);
    });

    it("R2: the gap has to be a real one: ticks 1.5 s and even 4 s apart are a busy page, not a return", () => {
        const m = pureLive();
        expect(loads(m.send({ type: "timer", t: 5500, id: "blank" }))).toBe(0);
        expect(loads(m.send({ type: "timer", t: 9500, id: "blank" }))).toBe(0); // exactly 4 s
        expect(loads(m.send({ type: "timer", t: 13_501, id: "blank" }))).toBe(1); // 4.001 s
    });

    it("R2: freeze and pagehide start the clock when hidden never came; visible then finds the absence", () => {
        const m = pureLive();
        m.send({ type: "freeze", t: 4100 });
        expect(m.state.hiddenAt).toBe(4100);
        const fx = m.send({ type: "visibility", t: 5200, hidden: false }); // 1.1 s later
        expect(loads(fx)).toBe(1);
        // ...but a freeze never overrides the earlier hidden.
        const n = pureLive();
        n.send({ type: "visibility", t: 4050, hidden: true });
        n.send({ type: "freeze", t: 4900 });
        expect(n.state.hiddenAt).toBe(4050);
    });

    it("R3: a stream that reads live is reloaded after a real absence, and a short one is left alone", () => {
        const m = pureLive();
        m.send({ type: "visibility", t: 4100, hidden: true });
        expect(m.state.signal).toBe("live");
        expect(loads(m.send({ type: "visibility", t: 5100, hidden: false }))).toBe(0); // exactly 1 s
        m.send({ type: "visibility", t: 5200, hidden: true });
        expect(loads(m.send({ type: "visibility", t: 6201, hidden: false }))).toBe(1);
    });

    it("R3: the picture is held while the new stream loads, and goes live on its first frame, not before", () => {
        const m = pureLive();
        m.send({ type: "visibility", t: 4100, hidden: true });
        const fx = m.send({ type: "visibility", t: 9000, hidden: false });
        expect(fx.map((e) => e.type)).toContain("freeze");
        expect(fx.findIndex((e) => e.type === "freeze")).toBeLessThan(fx.findIndex((e) => e.type === "loadMjpeg"));
        expect(m.state.streamUp).toBe(true); // still believed up until a frame says otherwise
        const fx2 = m.send({ type: "mjpegLoaded", t: 9100 });
        expect(fx2.map((e) => e.type)).toContain("thaw");
        expect(m.state.signal).toBe("live");
    });

    it("R4: visible, pageshow, focus, resume, online and the heartbeat tick make ONE reload", () => {
        const m = pureLive();
        m.send({ type: "visibility", t: 4100, hidden: true });
        const fx = [
            ...m.send({ type: "visibility", t: 20_000, hidden: false }),
            ...m.send({ type: "resume", t: 20_001, reason: "pageshow", hidden: false }),
            ...m.send({ type: "resume", t: 20_002, reason: "focus", hidden: false }),
            ...m.send({ type: "resume", t: 20_003, reason: "resume", hidden: false }),
            ...m.send({ type: "online", t: 20_004 }),
            ...m.send({ type: "timer", t: 20_500, id: "blank" }),
        ];
        expect(loads(fx)).toBe(1);
    });

    it("R4: a reload already waiting for its first frame is not doubled; one that waited too long is", () => {
        const m = pureLive();
        m.send({ type: "mjpegError", t: 4100 }); // reconnect pending, backoff timer armed
        m.send({ type: "timer", t: 4900, id: "reconnect" }); // the backoff fired: a load is on its way
        const quick = m.send({ type: "resume", t: 5000, reason: "focus", hidden: false }); // not an absence; stream not up yet
        expect(loads(quick)).toBe(0);
        const slow = m.send({ type: "resume", t: 12_000, reason: "focus", hidden: false }); // the watchdog's 7 s are long gone
        expect(loads(slow)).toBe(1);
    });

    it("R4: the load that replaces a stream cancels the backoff reconnect that was waiting", () => {
        const m = pureLive();
        m.send({ type: "mjpegError", t: 4100 });
        expect(m.state.reconnectPending).toBe(true);
        m.send({ type: "freeze", t: 4200 });
        const fx = m.send({ type: "resume", t: 9000, reason: "pageshow", hidden: false });
        expect(fx).toContainEqual({ type: "cancelTimer", id: "reconnect" });
        expect(loads(fx)).toBe(1);
        expect(m.state.reconnectPending).toBe(false);
    });

    it("R5: a hidden page opens no connection: not on error, watchdog, need or health recovery", () => {
        const m = pureLive();
        m.send({ type: "visibility", t: 4100, hidden: true });
        const fx = [
            ...m.send({ type: "mjpegError", t: 4200 }),
            ...m.send({ type: "timer", t: 4300, id: "streamWatchdog" }),
            ...m.send({ type: "timer", t: 4400, id: "reconnect" }),
            ...m.send({ type: "need", t: 4500, collapsed: false, watching: false }),
            ...m.send({ type: "healthFailed", t: 4600 }),
            ...m.send({ type: "healthResult", t: 7100, online: true }), // the server came back
        ];
        expect(loads(fx)).toBe(0);
        expect(fx.some((e) => e.type === "startTimer" && e.id === "reconnect")).toBe(false);
        expect(m.state.reconnectPending).toBe(false);
    });

    it("R5: ...and the one reload happens on return, with the server's new stream key", () => {
        const m = pureLive();
        m.send({ type: "visibility", t: 4100, hidden: true });
        m.send({ type: "mjpegError", t: 4200 });
        m.send({ type: "healthFailed", t: 4600 });
        m.send({ type: "healthResult", t: 7100, online: true });
        const fx = m.send({ type: "visibility", t: 30_000, hidden: false });
        expect(loads(fx)).toBe(1);
        expect(fx.find((e) => e.type === "loadMjpeg")).toEqual({ type: "loadMjpeg", key: "k-1" });
    });

    it("R5: background screen alerts are watching, so a hidden page keeps its stream", () => {
        const m = pureLive();
        m.send({ type: "need", t: 4050, collapsed: false, watching: true });
        m.send({ type: "visibility", t: 4100, hidden: true });
        const fx = m.send({ type: "mjpegError", t: 4200 });
        expect(fx).toContainEqual({ type: "startTimer", id: "reconnect", ms: 800 });
    });

    it("R5: through the driver, a minute hidden with the stream cut opens nothing, and the return opens one", () => {
        const r = liveNative();
        r.send({ type: "visibility", hidden: true });
        r.send({ type: "mjpegError" });
        r.clear();
        r.advance(60_000);
        expect(r.count("loadMjpeg")).toBe(0);
        r.send({ type: "visibility", hidden: false });
        expect(r.count("loadMjpeg")).toBe(1);
        r.advance(500);
        expect(r.count("loadMjpeg")).toBe(1);
    });

    it("R6: WebRTC is restarted after an absence over 3 s, with MJPEG holding the picture meanwhile", () => {
        const r = liveNative({ janus: "ok" });
        r.webrtcUp();
        r.send({ type: "visibility", hidden: true });
        r.advance(3001);
        r.clear();
        r.send({ type: "visibility", hidden: false });
        expect(r.janus.stopped).toBe(1);
        expect(r.janus.started).toBe(2);
        expect(r.count("webrtcFallback")).toBe(1);
        expect(r.count("loadMjpeg")).toBe(1);
        expect(r.driver.state.webrtcActive).toBe(false);
        expect(r.driver.state.mjpegPaused).toBe(false);
    });

    it("R6: a shorter absence leaves a working WebRTC session alone, and so does a return that was none", () => {
        const r = liveNative({ janus: "ok" });
        r.webrtcUp();
        r.send({ type: "visibility", hidden: true });
        r.advance(3000);
        r.send({ type: "visibility", hidden: false });
        r.send({ type: "resume", reason: "focus", hidden: false });
        expect(r.janus.stopped).toBe(0);
        expect(r.janus.started).toBe(1);
        expect(r.driver.state.webrtcSwapped).toBe(true);
    });

    it("R6: the stopped session's late words do not undo the new one", () => {
        const r = liveNative({ janus: "ok" });
        r.webrtcUp();
        const old = r.janus.handlers!;
        r.send({ type: "visibility", hidden: true });
        r.advance(5000);
        r.send({ type: "visibility", hidden: false });
        r.webrtcUp(); // the new session delivers
        expect(r.driver.state.webrtcSwapped).toBe(true);
        r.clear();
        old.onActive(false);
        old.onStatus("error");
        expect(r.driver.state.webrtcActive).toBe(true);
        expect(r.count("webrtcFallback")).toBe(0);
    });

    it("R6: the network coming back restarts WebRTC too", () => {
        const r = liveNative({ janus: "ok" });
        r.webrtcUp();
        r.clear();
        r.send({ type: "online" });
        expect(r.janus.stopped).toBe(1);
        expect(r.janus.started).toBe(2);
        expect(r.count("loadMjpeg")).toBe(1);
    });

    it("R6: a page that is not WebRTC never starts a session on return", () => {
        const r = liveNative();
        r.send({ type: "visibility", hidden: true });
        r.advance(20_000);
        r.send({ type: "visibility", hidden: false });
        expect(r.janus.started).toBe(0);
    });

    it("R1: snapshot mode polls at once on any way back", () => {
        const r = createVideoRig();
        r.bootSnapshot();
        r.send({ type: "snapshotDecoded" });
        r.clear();
        r.send({ type: "resume", reason: "pageshow", hidden: false });
        r.advance(0);
        expect(r.count("fetchSnapshot")).toBe(1);
    });
});

describe("status", () => {
    it("U1: the chip says when input is offline, whatever the stream state", () => {
        expect(statusLabel("live", true)).toBe("Live");
        expect(statusLabel("live", false)).toBe("Live · input offline");
        expect(statusLabel("nosignal", false)).toBe("No signal · input offline");
        expect(statusLabel("disconnected", true)).toBe("Screen unavailable");
        expect(statusLabel("offline", true)).toBe("Reconnecting");
        expect(statusLabel("reconnecting", true)).toBe("Reconnecting");
        expect(statusLabel("connecting", true)).toBe("Connecting");
    });

    it("the health answer's online flag is false for anything malformed", () => {
        expect(sourceOnline({ result: { source: { online: true } } })).toBe(true);
        expect(sourceOnline({ result: { source: { online: false } } })).toBe(false);
        expect(sourceOnline({ result: {} })).toBe(false);
        expect(sourceOnline(null)).toBe(false);
        expect(sourceOnline("x")).toBe(false);
    });
});
