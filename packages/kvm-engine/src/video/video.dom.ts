// DOM adapter for the video machine: performs the effects it asks for (set the <img>
// src, fetch, draw the freeze canvas, sample the picture) and turns what the page
// reports (image load, visibility, network) into events.
//
// No decisions live here. The Janus client is passed in as a port, and `fetch` is
// injectable so the whole adapter can be exercised without a network.

import { BLANK_GRID_H, BLANK_GRID_W, lumaGrid } from "./blank";
import type { VideoDriver } from "./driver";
import { sourceOnline, streamModeForInfo, streamPath } from "./stream-path";
import type { SignalState, VideoRenderEffect } from "./types";

export interface VideoDomElements {
    /** The pane that carries `data-stream-state` and the offline/has-frame/frozen classes. */
    readonly pane: HTMLElement;
    readonly img: HTMLImageElement;
    readonly video: HTMLVideoElement;
    /** Holds the last good frame while the stream restarts. */
    readonly freezeCanvas?: HTMLCanvasElement | null;
}

export interface VideoDomOptions {
    readonly elements: VideoDomElements;
    readonly userAgent?: string;
    readonly fetch?: typeof fetch;
    /** A paint hook for the chip/overlay; the pane's own attribute and classes are handled here. */
    readonly onSignal?: (state: SignalState) => void;
    /** The screen mode was decided (titles, which controls apply). */
    readonly onScreenMode?: (mode: "native" | "snapshot") => void;
    /** WebRTC became the picture (reveal audio toggles, start meters, resolution toast). */
    readonly onWebrtc?: (event: { type: "activated" } | { type: "swapped"; first: boolean } | { type: "fallback"; wasActive: boolean }) => void;
    /** The machine wants the input socket replaced (`kick`) or ensured (`connect`). */
    readonly onHid?: (action: "kick" | "connect") => void;
    /** Each luminance grid read back for blank detection, for the screen-change alert to reuse. */
    readonly onLuma?: (lum: Float32Array) => void;
}

export interface VideoDom {
    /** Pass as the driver's `render`. */
    render(effect: VideoRenderEffect): void;
    /** Wire page events to the driver; returns the detach function. */
    attach(driver: VideoDriver): () => void;
}

export function createVideoDom(opts: VideoDomOptions): VideoDom {
    const { pane, img, video, freezeCanvas } = opts.elements;
    const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    let driver: VideoDriver | null = null;
    let snapshotUrl: string | null = null;
    let candidate: { url: string; image: HTMLImageElement } | null = null;
    let sampleCtx: CanvasRenderingContext2D | null = null;
    let lumSlot = 0;
    const lumBuffers: [Float32Array | undefined, Float32Array | undefined] = [undefined, undefined];

    const withAbort = (ms: number): { signal: AbortSignal | undefined; done: () => void } => {
        if (typeof AbortController === "undefined") return { signal: undefined, done: () => {} };
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ms);
        return { signal: ctrl.signal, done: () => clearTimeout(timer) };
    };

    const freezeFrame = (): void => {
        if (!freezeCanvas || !pane.classList.contains("has-frame")) return;
        const useVideo = !video.classList.contains("hidden") && video.videoWidth > 0;
        const src = useVideo ? video : img;
        const w = useVideo ? video.videoWidth : img.naturalWidth;
        const h = useVideo ? video.videoHeight : img.naturalHeight;
        if (!w || !h) return;
        try {
            freezeCanvas.width = w;
            freezeCanvas.height = h;
            freezeCanvas.getContext("2d")?.drawImage(src, 0, 0, w, h);
            pane.classList.add("frozen");
        } catch {
            // A source that cannot be drawn yet is not worth losing the reconnect over.
        }
    };

    const fetchInfo = (timeoutMs: number): void => {
        const { signal, done } = withAbort(timeoutMs);
        doFetch("/api/info", { cache: "no-store", ...(signal ? { signal } : {}) })
            .then((r) => {
                if (!r.ok) throw new Error(`info ${r.status}`);
                return r.json() as Promise<unknown>;
            })
            .then((info) => {
                done();
                const mode = streamModeForInfo(info);
                driver?.send({ type: "infoResult", mode });
            })
            .catch(() => {
                done();
                driver?.send({ type: "infoFailed" });
            });
    };

    const pollHealth = (timeoutMs: number): void => {
        const { signal, done } = withAbort(timeoutMs);
        doFetch("/streamer/state", { cache: "no-store", ...(signal ? { signal } : {}) })
            .then((r) => {
                if (!r.ok) throw new Error("bad");
                return r.json() as Promise<unknown>;
            })
            .then((j) => {
                done();
                driver?.send({ type: "healthResult", online: sourceOnline(j) });
            })
            .catch(() => {
                done();
                driver?.send({ type: "healthFailed" });
            });
    };

    const fetchSnapshot = (timeoutMs: number): void => {
        const { signal, done } = withAbort(timeoutMs);
        doFetch(`/api/streamer/snapshot?t=${Date.now()}`, { cache: "no-store", ...(signal ? { signal } : {}) })
            .then((r) => {
                if (!r.ok) throw new Error(`snapshot ${r.status}`);
                if (!(r.headers.get("content-type") ?? "").startsWith("image/")) throw new Error("snapshot was not an image");
                return r.blob();
            })
            .then((blob) => {
                done();
                const url = URL.createObjectURL(blob);
                const image = new Image();
                image.onload = () => {
                    candidate = { url, image };
                    driver?.send({ type: "snapshotDecoded" });
                };
                image.onerror = () => {
                    URL.revokeObjectURL(url);
                    driver?.send({ type: "snapshotFailed" });
                };
                image.src = url;
            })
            .catch(() => {
                done();
                driver?.send({ type: "snapshotFailed" });
            });
    };

    const sampleBlank = (source: "video" | "image"): void => {
        const el = source === "video" ? video : img;
        const w = source === "video" ? video.videoWidth : img.naturalWidth;
        const h = source === "video" ? video.videoHeight : img.naturalHeight;
        if (!w || !h) return;
        if (!sampleCtx) {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = BLANK_GRID_W;
                canvas.height = BLANK_GRID_H;
                sampleCtx = canvas.getContext("2d", { willReadFrequently: true });
            } catch {
                return;
            }
        }
        if (!sampleCtx) return;
        try {
            sampleCtx.drawImage(el, 0, 0, BLANK_GRID_W, BLANK_GRID_H);
            const px = sampleCtx.getImageData(0, 0, BLANK_GRID_W, BLANK_GRID_H).data;
            // Two grids, ping-ponged, so a sample never allocates and the previous one stays intact for diffing.
            lumSlot ^= 1;
            const result = lumaGrid(px, lumBuffers[lumSlot]);
            lumBuffers[lumSlot] = result.lum;
            opts.onLuma?.(result.lum);
            driver?.send({ type: "blankSample", uniform: result.uniform });
        } catch {
            // Draw or read failed: do not guess.
        }
    };

    const render = (effect: VideoRenderEffect): void => {
        switch (effect.type) {
            case "signal":
                pane.setAttribute("data-stream-state", effect.state);
                pane.classList.toggle("offline", effect.state !== "live");
                opts.onSignal?.(effect.state);
                return;
            case "freeze":
                freezeFrame();
                return;
            case "thaw":
                if (freezeCanvas) pane.classList.remove("frozen");
                return;
            case "loadMjpeg":
                // Marked before the src changes: assigning it is what blanks the <img>.
                img.src = `${streamPath(effect.key, opts.userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : ""))}&t=${Date.now()}`;
                return;
            case "dropMjpeg":
                img.removeAttribute("src");
                return;
            case "fetchInfo":
                fetchInfo(effect.timeoutMs);
                return;
            case "pollHealth":
                pollHealth(effect.timeoutMs);
                return;
            case "fetchSnapshot":
                fetchSnapshot(effect.timeoutMs);
                return;
            case "presentSnapshot": {
                if (!candidate) return;
                const previous = snapshotUrl;
                snapshotUrl = candidate.url;
                img.src = candidate.url;
                img.classList.remove("hidden");
                pane.classList.add("has-frame");
                candidate = null;
                if (previous) {
                    const release = (): void => URL.revokeObjectURL(previous);
                    if (typeof requestAnimationFrame === "function") requestAnimationFrame(release);
                    else release();
                }
                return;
            }
            case "discardSnapshot":
                if (candidate) URL.revokeObjectURL(candidate.url);
                candidate = null;
                return;
            case "screenMode":
                if (effect.mode === "snapshot") {
                    video.classList.add("hidden");
                    img.classList.remove("hidden");
                }
                opts.onScreenMode?.(effect.mode);
                return;
            case "webrtcActivated":
                video.classList.remove("hidden");
                video.classList.add("warming"); // decoding but transparent until "playing": MJPEG shows through
                video.muted = true; // always muted to start (Safari autoplay); audio is applied once it plays
                void video.play().catch(() => {});
                opts.onWebrtc?.({ type: "activated" });
                return;
            case "videoSwapped":
                if (effect.first) {
                    video.classList.remove("warming"); // confirmed playing: reveal the video
                    img.classList.add("hidden");
                    img.removeAttribute("src"); // release the Pi's MJPEG connection only now
                }
                opts.onWebrtc?.({ type: "swapped", first: effect.first });
                return;
            case "webrtcFallback":
                video.classList.add("hidden");
                video.classList.remove("warming");
                img.classList.remove("hidden");
                try {
                    const stream = video.srcObject as MediaStream | null;
                    stream?.getTracks().forEach((t) => {
                        try {
                            t.stop();
                        } catch {
                            // already stopped
                        }
                    });
                } catch {
                    // no stream to stop
                }
                video.srcObject = null;
                opts.onWebrtc?.({ type: "fallback", wasActive: effect.wasActive });
                return;
            case "sampleBlank":
                sampleBlank(effect.source);
                return;
            case "hid":
                opts.onHid?.(effect.action);
                return;
        }
    };

    return {
        render,
        attach(d) {
            driver = d;
            const off: (() => void)[] = [];
            const listen = <T extends EventTarget>(target: T, type: string, fn: (e: Event) => void): void => {
                target.addEventListener(type, fn);
                off.push(() => target.removeEventListener(type, fn));
            };
            listen(img, "load", () => {
                pane.classList.add("has-frame");
                d.send({ type: "mjpegLoaded" });
            });
            listen(img, "error", () => d.send({ type: "mjpegError" }));
            listen(video, "playing", () => d.send({ type: "videoPlaying" }));
            listen(document, "visibilitychange", () => {
                d.send({ type: "visibility", hidden: document.hidden });
                // Safari pauses a playing <video> in the background and does not start it again.
                if (!document.hidden && video.srcObject && video.paused) void video.play().catch(() => {});
            });
            // A page that is frozen or put in the back/forward cache may never be told it is hidden; a
            // restored one may never be told it is visible. These are how it finds out it was gone.
            listen(document, "freeze", () => d.send({ type: "freeze" }));
            listen(window, "pagehide", () => d.send({ type: "freeze" }));
            listen(document, "resume", () => d.send({ type: "resume", reason: "resume", hidden: document.hidden }));
            listen(window, "pageshow", (e) => {
                if ((e as PageTransitionEvent).persisted) d.send({ type: "resume", reason: "pageshow", hidden: document.hidden });
            });
            listen(window, "focus", () => d.send({ type: "resume", reason: "focus", hidden: document.hidden }));
            listen(window, "online", () => d.send({ type: "online" }));
            listen(window, "offline", () => d.send({ type: "offline" }));
            return () => {
                off.forEach((f) => f());
                driver = null;
                if (candidate) URL.revokeObjectURL(candidate.url);
                if (snapshotUrl) URL.revokeObjectURL(snapshotUrl);
            };
        },
    };
}
