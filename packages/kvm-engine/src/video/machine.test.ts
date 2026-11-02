// Failure modes V1-V10, S1-S4, W1-W5, L1-L3, U1: see FAILURE_MODES.md.
//
// Everything runs through the driver on a manual clock, so an outage of minutes
// takes microseconds and every timeout is exact.

import { describe, expect, it } from "vitest";
import { createVideoState, reduceVideo } from "./machine";
import { sourceOnline, streamModeForInfo, streamPath } from "./stream-path";
import { createVideoRig } from "./test-rig";
import type { VideoRig } from "./test-rig";
import { statusLabel } from "./types";

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
    it("L1: back after more than 3 s replaces the socket and reloads the stream", () => {
        const r = liveNative();
        r.send({ type: "visibility", hidden: true });
        r.advance(3001);
        r.clear();
        r.send({ type: "visibility", hidden: false });
        expect(r.of("hid")).toEqual([{ type: "hid", action: "kick" }]);
        expect(r.count("pollHealth")).toBe(1);
        expect(r.count("loadMjpeg")).toBe(1);
    });

    it("L1: back within 3 s only ensures the socket, and reloads only if not live", () => {
        const r = liveNative();
        r.send({ type: "visibility", hidden: true });
        r.advance(3000);
        r.clear();
        r.send({ type: "visibility", hidden: false });
        expect(r.of("hid")).toEqual([{ type: "hid", action: "connect" }]);
        expect(r.count("loadMjpeg")).toBe(0);

        r.send({ type: "healthFailed" });
        r.send({ type: "visibility", hidden: true });
        r.advance(100);
        r.clear();
        r.send({ type: "visibility", hidden: false });
        expect(r.count("loadMjpeg")).toBe(1); // not live: reload
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
