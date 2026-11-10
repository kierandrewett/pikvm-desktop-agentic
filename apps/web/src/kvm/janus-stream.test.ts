import { describe, expect, it } from "vitest";
import { resolvePreset } from "./camera";
import { videoTrackFor } from "./janus-stream";

const choice = (deviceId: string, preset = "720p30") => ({ deviceId, preset: resolvePreset(preset) });

describe("K39: the video track the session offers", () => {
    it("only receives the target's picture while the camera is off", () => {
        expect(videoTrackFor(false, choice(""))).toEqual({ type: "video", capture: false, recv: true, add: true });
        // A pinned camera does nothing while the camera is off.
        expect(videoTrackFor(false, choice("cam-1"))).toMatchObject({ capture: false });
    });

    it("sends the browser's default camera, at most 1280x720, when none is pinned", () => {
        const track = videoTrackFor(true, choice(""));
        expect(track).toMatchObject({ type: "video", recv: true, add: true });
        const capture = track["capture"] as Record<string, unknown>;
        expect(capture).toMatchObject({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } });
        expect(capture).not.toHaveProperty("deviceId");
    });

    it("pins a chosen camera with exact, so an unplugged one fails instead of being replaced", () => {
        const capture = videoTrackFor(true, choice("cam-1"))["capture"] as Record<string, unknown>;
        expect(capture["deviceId"]).toEqual({ exact: "cam-1" });
    });
});
