/**
 * A recording's thumbnail: its first frame, taken here.
 *
 * A hidden <video> loads the start of the file from the media route (a few hundred KB: the browser asks for byte ranges), and the
 * first decoded frame is drawn on a small canvas and kept as a JPEG. Chosen over a host endpoint because the host would have to
 * run ffmpeg per recording and keep another file for each, for a picture only this page shows; the browser already has the codecs
 * (Safari plays the MP4s only it records). The cost is one short download per recording, once per page load: results are kept in
 * memory (a bounded cache) and a recording with no decodable picture (or a browser without the codec) gets none, which the page
 * draws as an icon. Two frames are made at a time, so a long list does not open a dozen connections to the host.
 */

import { mediaUrl } from "../kvm/recorder/api";

const WIDTH = 320;
const HEIGHT = 180;
const CONCURRENCY = 2;
const TIMEOUT_MS = 20_000;
const CACHE_LIMIT = 150;

/** id -> object URL of the JPEG, or null for "tried, nothing to show". Oldest first, so the cache can be trimmed. */
const cache = new Map<string, string | null>();
const waiting: Array<() => void> = [];
const pending = new Map<string, Promise<string | null>>();
let running = 0;

function remember(id: string, url: string | null): void {
    cache.delete(id);
    cache.set(id, url);
    while (cache.size > CACHE_LIMIT) {
        const [oldest] = cache.keys();
        if (oldest === undefined) break;
        const dropped = cache.get(oldest);
        cache.delete(oldest);
        // A picture still on screen keeps its URL: revoking only stops new loads of it, and the <img> holds its decoded bitmap.
        if (dropped) URL.revokeObjectURL(dropped);
    }
}

function firstFrame(id: string): Promise<string | null> {
    return new Promise((resolve) => {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        let done = false;
        const finish = (url: string | null): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            video.removeAttribute("src");
            video.load();
            resolve(url);
        };
        const timer = setTimeout(() => finish(null), TIMEOUT_MS);
        video.addEventListener("error", () => finish(null));
        video.addEventListener("loadeddata", () => {
            const width = video.videoWidth;
            const height = video.videoHeight;
            if (width === 0 || height === 0) return finish(null);
            const canvas = document.createElement("canvas");
            canvas.width = WIDTH;
            canvas.height = HEIGHT;
            const context = canvas.getContext("2d");
            if (!context) return finish(null);
            context.fillStyle = "#000";
            context.fillRect(0, 0, WIDTH, HEIGHT);
            // Fit inside the frame, never stretch: a 21:9 recording keeps its shape with bars.
            const scale = Math.min(WIDTH / width, HEIGHT / height);
            const w = width * scale;
            const h = height * scale;
            context.drawImage(video, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
            canvas.toBlob((blob) => finish(blob ? URL.createObjectURL(blob) : null), "image/jpeg", 0.72);
        });
        video.src = mediaUrl(id);
    });
}

/** The first frame of a recording as an object URL, or null when there is none. Cached; asks the host at most once per recording. */
export function loadPoster(id: string): Promise<string | null> {
    if (cache.has(id)) {
        const hit = cache.get(id) ?? null;
        remember(id, hit);
        return Promise.resolve(hit);
    }
    const asked = pending.get(id);
    if (asked) return asked;
    const job = new Promise<string | null>((resolve) => {
        const start = (): void => {
            running += 1;
            void firstFrame(id).then((url) => {
                running -= 1;
                pending.delete(id);
                remember(id, url);
                waiting.shift()?.();
                resolve(url);
            });
        };
        if (running < CONCURRENCY) start();
        else waiting.push(start);
    });
    pending.set(id, job);
    return job;
}

/** A recording was deleted: let go of its picture. */
export function forgetPoster(id: string): void {
    const url = cache.get(id);
    cache.delete(id);
    if (url) URL.revokeObjectURL(url);
}
