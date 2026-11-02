// Pure helpers for choosing and addressing the stream.

/** ustreamer MJPEG path with the per-browser quirk param the PiKVM UI uses. */
export function streamPath(key: string, userAgent = ""): string {
    let p = "/streamer/stream?key=" + encodeURIComponent(key);
    const isIOS = /iPad|iPhone|iPod/.test(userAgent);
    const isSafari = /Safari/.test(userAgent) && !/Chrome|CriOS|Chromium|Android/.test(userAgent);
    const isBlink = /Chrome|CriOS|Chromium/.test(userAgent);
    if (isIOS || isSafari) p += "&dual_final_frames=1";
    else if (isBlink) p += "&advance_headers=1";
    return p;
}

/** Select a screen transport from the target's advertised capabilities (`GET /api/info`). */
export function streamModeForInfo(info: unknown): "native" | "snapshot" {
    const extras = (info as { result?: { extras?: { vnc_lab?: { enabled?: unknown } } } } | null | undefined)?.result?.extras;
    return extras?.vnc_lab?.enabled === true ? "snapshot" : "native";
}

/** The health answer's `result.source.online`, false for anything malformed. */
export function sourceOnline(state: unknown): boolean {
    return !!(state as { result?: { source?: { online?: unknown } } } | null | undefined)?.result?.source?.online;
}
