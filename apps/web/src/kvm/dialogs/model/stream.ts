/**
 * Which stream controls the Pi supports and their ranges. The `streamer` event carries
 * `features` (which knobs exist), `limits` (ranges and capturable resolutions) and `applied`
 * (what is in force); the dialog is drawn from all three rather than hardcoding ranges, so an
 * unusual capture board still gets the right sliders.
 */

import type { StreamerSettings } from "@pikvm/kvm-engine";
import { asList, asNumber, asRecord, asString } from "./guards";

export interface SliderSpec {
    readonly param: "quality" | "desired_fps" | "h264_bitrate" | "h264_gop";
    readonly label: string;
    /** `features` key that must be true, or null when the param merely has to be applied. */
    readonly feature: string | null;
    readonly limit: string | null;
    readonly fallback: { readonly min: number; readonly max: number; readonly step: number };
    readonly format: (value: number) => string;
}

export const STREAM_SLIDERS: readonly SliderSpec[] = [
    {
        param: "quality",
        label: "Quality",
        feature: "quality",
        limit: null,
        fallback: { min: 5, max: 100, step: 5 },
        format: (v) => `${v}%`,
    },
    {
        param: "desired_fps",
        label: "Target FPS",
        feature: null,
        limit: "desired_fps",
        fallback: { min: 0, max: 70, step: 1 },
        format: (v) => (v === 0 ? "unlimited" : `${v} fps`),
    },
    {
        param: "h264_bitrate",
        label: "H264 bitrate",
        feature: "h264",
        limit: "h264_bitrate",
        fallback: { min: 25, max: 20000, step: 25 },
        format: (v) => `${v} kbps`,
    },
    {
        param: "h264_gop",
        label: "H264 GOP",
        feature: "h264",
        limit: "h264_gop",
        fallback: { min: 0, max: 60, step: 1 },
        format: String,
    },
];

export interface SliderView {
    readonly spec: SliderSpec;
    readonly min: number;
    readonly max: number;
    readonly step: number;
    /** What the Pi has applied, or the minimum when it has not said. */
    readonly value: number;
}

export interface StreamView {
    readonly resolutions: readonly string[];
    readonly resolution: string | null;
    readonly sliders: readonly SliderView[];
    /** Nothing adjustable was reported. */
    readonly empty: boolean;
}

export function streamView(streamer: StreamerSettings): StreamView {
    const features = asRecord(streamer.features) ?? {};
    const limits = asRecord(streamer.limits) ?? {};
    const applied = asRecord(streamer.applied) ?? {};

    const available = asList(limits["available_resolutions"]).filter((r): r is string => typeof r === "string");
    const hasResolution = !!features["resolution"] && available.length > 0;
    const resolution = asString(applied["resolution"]);

    const sliders: SliderView[] = [];
    for (const spec of STREAM_SLIDERS) {
        const has = spec.feature ? !!features[spec.feature] : applied[spec.param] !== undefined;
        if (!has) continue;
        const range = spec.limit ? asRecord(limits[spec.limit]) : null;
        const min = asNumber(range?.["min"]) ?? spec.fallback.min;
        const max = asNumber(range?.["max"]) ?? spec.fallback.max;
        sliders.push({ spec, min, max, step: spec.fallback.step, value: asNumber(applied[spec.param]) ?? min });
    }
    return {
        resolutions: hasResolution ? available : [],
        resolution: hasResolution ? resolution : null,
        sliders,
        empty: !hasResolution && sliders.length === 0,
    };
}

/** The request path for one change; the one place its shape is decided. */
export function streamParamPath(name: string, value: string | number): string {
    return `/api/streamer/set_params?${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`;
}
