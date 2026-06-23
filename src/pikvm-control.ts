/**
 * PiKVM control core.
 *
 * The single source of truth for talking to a PiKVM: grabbing the target
 * screen (HTTP snapshot) and driving keyboard/mouse over the HID WebSocket.
 * Both the embedded Pi agent tools and the integrated MCP server are thin
 * wrappers over this class — no duplicated PiKVM logic.
 *
 * Screen   : GET <origin>/api/streamer/snapshot  -> JPEG
 * Keyboard : wss://<host>/api/ws  {event_type:"key", event:{key,state}}
 * Mouse    : wss://<host>/api/ws  mouse_move (absolute, ±32767) / mouse_button / mouse_wheel
 */

import axios from "axios";
import { Agent as HttpsAgent } from "https";
import WebSocket from "ws";
import { planTyping, type Persona, type TypingOptions } from "./human-typing";
import { windMousePath } from "./windmouse";
import type { GridSnapshot, TypingEvent } from "./agent/watched-typing";
import type { ImageOps } from "./image-ops";

export interface Region {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Cap the long edge of full-frame screenshots sent to the model (token saving). */
const MAX_SCREENSHOT_DIM = 1400;

export interface PiKvmCredentials {
    origin: string; // e.g. https://pikvm/  (may embed user:pass)
    username?: string;
    password?: string;
    /** Returns the PiKVM `auth_token` cookie value (from the logged-in session). */
    getCookie?: () => Promise<string | undefined> | string | undefined;
}

export interface Screenshot {
    data: Buffer;
    base64: string;
    mimeType: string;
    width: number;
    height: number;
}

export type MouseButton = "left" | "right" | "middle";

const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const t = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });

/** Parse JPEG width/height from SOF markers (fallback when headers are absent). */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
    let i = 2;
    while (i < buf.length) {
        if (buf[i] !== 0xff) {
            i++;
            continue;
        }
        const marker = buf[i + 1]!;
        // SOF0..SOF15 except DHT(c4)/DAC(cc)/RSTn carry frame dimensions.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            const height = buf.readUInt16BE(i + 5);
            const width = buf.readUInt16BE(i + 7);
            return { width, height };
        }
        const len = buf.readUInt16BE(i + 2);
        i += 2 + len;
    }
    return null;
}

export class PiKvmControl {
    private origin: URL;
    private user: string;
    private pass: string;
    private getCookie: PiKvmCredentials["getCookie"];
    private agent: HttpsAgent;
    private ws: WebSocket | undefined;
    private wsReady: Promise<void> | undefined;
    private dims: { width: number; height: number } = { width: 1920, height: 1080 };
    /** Last mouse position in normalized PiKVM units (−32768..32767). */
    private mouse = { x: 0, y: 0 };
    private shiftHeld = false;
    /** Default typing humanity (0..1); used when typeText omits an intensity. */
    private humanize = 1;
    /** WindMouse speed factor for cursor moves (higher = faster). */
    private mouseSpeed = 1.9;
    /** Forced WPM (0 = use the random persona). */
    private wpm = 0;
    /** Target keyboard layout (we send physical key codes; the layout sets glyphs). */
    private layout: "us" | "uk" = "us";
    /** Hook fired with text the agent types / keys it presses (for input tracking). */
    onAgentInput: ((info: { text?: string; key?: string }) => void) | undefined;
    /** Live watched-typing events (progress / verify / self-correct) → overlay X-ray. */
    onTypingEvent: ((ev: TypingEvent) => void) | undefined;
    /**
     * Capture the already-rendered live view (set by main → mainView.capturePage).
     * Preferred over the PiKVM snapshot endpoint so the agent's screenshots put
     * ZERO extra load on the Pi and never stall the live stream.
     */
    captureScreen: (() => Promise<{ data: Buffer; width: number; height: number } | null>) | undefined;
    /**
     * Cheap perceptual fingerprint of the live view (tiny grayscale bitmap, set by
     * main → mainView.capturePage().resize(...).toBitmap()). Used by the ambient
     * monitor to detect meaningful screen changes WITHOUT an LLM or decode lib.
     */
    captureFingerprint: (() => Promise<Uint8Array | null>) | undefined;
    /**
     * Dense grayscale grid of the live view (set by main → capturePage().resize()).
     * Used by watched typing to localise the field via the pixels that change while
     * typing, and to detect "keystrokes aren't landing".
     */
    captureGrid: (() => Promise<GridSnapshot | null>) | undefined;
    /** Native stream resolution (for OCR coordinate scaling). */
    private nativeDims: { width: number; height: number } | undefined;
    /** Injected crop/resize/encode — Electron `nativeImage` or headless `sharp`. */
    private readonly imageOps: ImageOps;

    constructor(creds: PiKvmCredentials, imageOps: ImageOps) {
        this.imageOps = imageOps;
        const u = new URL(creds.origin);
        this.user = creds.username ?? decodeURIComponent(u.username || "");
        this.pass = creds.password ?? decodeURIComponent(u.password || "");
        this.getCookie = creds.getCookie;
        u.username = "";
        u.password = "";
        u.pathname = "/";
        this.origin = u;
        // PiKVM ships a self-signed cert; the Electron app already ignores certs.
        this.agent = new HttpsAgent({ rejectUnauthorized: false });
    }

    private async headers(): Promise<Record<string, string>> {
        const h: Record<string, string> = {};
        if (this.user) {
            h["X-KVMD-User"] = this.user;
            h["X-KVMD-Passwd"] = this.pass;
        }
        // Reuse the logged-in browser session's PiKVM token when we don't have
        // explicit credentials (the common case — the user logged in via the form).
        const cookie = await this.getCookie?.();
        if (cookie) h["Cookie"] = cookie.includes("=") ? cookie : `auth_token=${cookie}`;
        return h;
    }

    private httpBase(): string {
        return this.origin.origin; // protocol//host[:port]
    }

    private wsUrl(): string {
        const proto = this.origin.protocol === "https:" ? "wss:" : "ws:";
        return `${proto}//${this.origin.host}/api/ws`;
    }

    /**
     * Everything the reverse proxy needs to forward a request to the PiKVM target:
     * the origin (protocol/host/port), per-request auth headers (so the browser
     * client never has to log into PiKVM itself), and the fact we ignore the Pi's
     * self-signed cert. Used by src/proxy.ts.
     */
    async proxyTarget(): Promise<{ origin: URL; headers: Record<string, string>; rejectUnauthorized: boolean }> {
        return { origin: this.origin, headers: await this.headers(), rejectUnauthorized: false };
    }

    /* -------------------------------------------------------------- *
     * Screen
     * -------------------------------------------------------------- */

    /** Update the native stream resolution (from kvm-stream-data) for OCR scaling. */
    setNativeDims(width: number, height: number): void {
        if (width && height) this.nativeDims = { width, height };
    }

    async screenshot(region?: Region): Promise<Screenshot> {
        const shot = await this.captureScreenshot(region);
        // Cache full frames so the many background watchers (jiggler / ambient /
        // suggestion / context / region) can share ONE Pi snapshot instead of each
        // fetching + re-encoding their own. The AGENT calls screenshot() directly, so
        // it always gets a fresh frame; only cachedScreenshot() reads the cache.
        if (!region) this.lastFull = { shot, at: Date.now() };
        return shot;
    }

    private lastFull: { shot: Screenshot; at: number } | null = null;

    /** A recent full-frame screenshot if one was taken within `maxAgeMs`, else a fresh
     *  one. For BACKGROUND consumers only — never on the agent's own observe path. */
    async cachedScreenshot(maxAgeMs = 800): Promise<Screenshot> {
        if (this.lastFull && Date.now() - this.lastFull.at <= maxAgeMs) return this.lastFull.shot;
        return this.screenshot();
    }

    private async captureScreenshot(region?: Region): Promise<Screenshot> {
        // Preferred path: grab the already-rendered live frame — no Pi load.
        if (this.captureScreen) {
            try {
                const cap = await this.captureScreen();
                if (cap && cap.width && cap.height) return this.finalize(cap.data, cap.width, cap.height, region);
            } catch {
                /* fall through to the snapshot endpoint */
            }
        }

        const res = await axios.get(`${this.httpBase()}/api/streamer/snapshot`, {
            responseType: "arraybuffer",
            headers: await this.headers(),
            httpsAgent: this.agent,
            timeout: 10_000,
            params: { allow_offline: 1 },
        });
        const data = Buffer.from(res.data as ArrayBuffer);
        const hw = Number(res.headers["x-ustreamer-width"]);
        const hh = Number(res.headers["x-ustreamer-height"]);
        const parsed = !hw || !hh ? jpegSize(data) : null;
        const fw = hw || parsed?.width || this.dims.width;
        const fh = hh || parsed?.height || this.dims.height;
        return this.finalize(data, fw, fh, region);
    }

    /**
     * Turn a full-resolution frame into the image the agent sees:
     *  - region given → crop the FULL-res frame (so zoom keeps detail), scaling
     *    the region from the agent's coordinate space up to full res;
     *  - otherwise → downscale the full frame to keep per-turn tokens low while
     *    preserving the whole view.
     * `this.dims` (the agent's coordinate basis) only tracks full-frame sends.
     */
    private async finalize(raw: Buffer, fw: number, fh: number, region?: Region): Promise<Screenshot> {
        if (region) {
            const sx = fw / (this.dims.width || fw);
            const sy = fh / (this.dims.height || fh);
            const cropped = await this.crop(raw, fw, fh, {
                x: region.x * sx,
                y: region.y * sy,
                width: region.width * sx,
                height: region.height * sy,
            });
            if (cropped) return cropped;
        }
        const d = await this.downscale(raw, fw, fh);
        this.dims = { width: d.width, height: d.height };
        return { data: d.data, base64: d.data.toString("base64"), mimeType: "image/jpeg", width: d.width, height: d.height };
    }

    /** Downscale a JPEG so its long edge is at most MAX_SCREENSHOT_DIM. */
    private async downscale(jpeg: Buffer, w: number, h: number): Promise<{ data: Buffer; width: number; height: number }> {
        const longEdge = Math.max(w, h);
        if (longEdge <= MAX_SCREENSHOT_DIM) return { data: jpeg, width: w, height: h };
        const scale = MAX_SCREENSHOT_DIM / longEdge;
        const nw = Math.round(w * scale);
        const nh = Math.round(h * scale);
        const out = await this.imageOps.resize(jpeg, nw, nh, 78);
        // Op failed (e.g. sharp unavailable) → keep the original full-res frame.
        if (!out) return { data: jpeg, width: w, height: h };
        return { data: out, width: nw, height: nh };
    }

    /** Crop a full-res JPEG to a clamped region (then cap its size). */
    private async crop(jpeg: Buffer, fw: number, fh: number, region: Region): Promise<Screenshot | null> {
        const x = Math.max(0, Math.min(Math.round(region.x), fw - 1));
        const y = Math.max(0, Math.min(Math.round(region.y), fh - 1));
        const w = Math.max(1, Math.min(Math.round(region.width), fw - x));
        const h = Math.max(1, Math.min(Math.round(region.height), fh - y));
        const cropBuf = await this.imageOps.crop(jpeg, { x, y, width: w, height: h }, 88);
        if (!cropBuf) return null;
        const d = await this.downscale(cropBuf, w, h);
        return { data: d.data, base64: d.data.toString("base64"), mimeType: "image/jpeg", width: d.width, height: d.height };
    }

    /** Latest known frame dimensions (updated on every screenshot). */
    getDimensions() {
        return { ...this.dims };
    }

    /** Read on-screen text via PiKVM's built-in OCR (tesseract). Optional region.
     *  Region is given in screenshot (displayed) pixels and scaled to native. */
    async ocr(region?: Region, langs = "eng"): Promise<string> {
        const nat = this.nativeDims ?? this.dims;
        const sx = nat.width / (this.dims.width || nat.width);
        const sy = nat.height / (this.dims.height || nat.height);
        const r = region
            ? { x: region.x * sx, y: region.y * sy, width: region.width * sx, height: region.height * sy }
            : { x: 0, y: 0, width: nat.width, height: nat.height };
        const res = await axios.get(`${this.httpBase()}/api/streamer/snapshot`, {
            responseType: "text",
            headers: await this.headers(),
            httpsAgent: this.agent,
            timeout: 25_000,
            params: {
                allow_offline: 1,
                ocr: 1,
                ocr_langs: langs,
                ocr_left: Math.round(r.x),
                ocr_top: Math.round(r.y),
                ocr_right: Math.round(r.x + r.width),
                ocr_bottom: Math.round(r.y + r.height),
            },
        });
        return String(res.data).trim();
    }

    /* -------------------------------------------------------------- *
     * HID WebSocket
     * -------------------------------------------------------------- */

    async connect(): Promise<void> {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        if (this.wsReady) return this.wsReady;
        const headers = await this.headers();
        this.wsReady = new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(this.wsUrl(), {
                headers,
                rejectUnauthorized: false,
            });
            this.ws = ws;
            const onErr = (e: Error) => {
                this.wsReady = undefined;
                reject(e);
            };
            ws.once("open", () => {
                ws.off("error", onErr);
                resolve();
            });
            ws.once("error", onErr);
            ws.on("close", () => {
                if (this.ws === ws) {
                    this.ws = undefined;
                    this.wsReady = undefined;
                    this.shiftHeld = false;
                }
            });
            // Drain inbound events (state pings); we don't need them here.
            ws.on("message", () => {});
        });
        return this.wsReady;
    }

    private async send(event: string, payload: unknown): Promise<void> {
        await this.connect();
        this.lastInputTs = Date.now();
        this.ws!.send(JSON.stringify({ event_type: event, event: payload }));
    }

    /** When the agent last sent any HID input (ms epoch) — for the idle jiggler. */
    private lastInputTs = 0;
    lastInputAt(): number {
        return this.lastInputTs;
    }
    /** A RELATIVE mouse nudge (delta in HID units). The idle jiggler sends +d then −d
     *  so the cursor nets back to exactly where it was — no need to know its absolute
     *  position. (PiKVM's relative-mouse endpoint; a no-op if the Pi is absolute-only.) */
    async mouseRelative(dx: number, dy: number): Promise<void> {
        await this.send("mouse_relative", { delta: { x: Math.round(dx), y: Math.round(dy) }, squash: true });
    }

    /* -------------------------------------------------------------- *
     * Keyboard
     * -------------------------------------------------------------- */

    private async key(code: string, state: boolean): Promise<void> {
        await this.send("key", { key: code, state });
    }

    /** Press and release a single key (with its modifiers as a code list). */
    async pressKey(code: string): Promise<void> {
        await this.key(code, true);
        await sleep(40);
        await this.key(code, false);
        this.onAgentInput?.({ key: code });
    }

    /** Hold several keys down in order, then release in reverse (a chord). */
    async hotkey(codes: string[]): Promise<void> {
        for (const c of codes) await this.key(c, true);
        await sleep(60);
        for (const c of [...codes].reverse()) await this.key(c, false);
        this.onAgentInput?.({ key: codes.join("+") });
    }

    /** Set the default typing humanity (0 = no typos, 1 = full human). */
    setHumanize(intensity: number): void {
        this.humanize = Math.max(0, Math.min(1, intensity));
    }

    /** Set the baseline typing WPM the random persona centers on (0 = default). */
    setWpm(wpm: number): void {
        this.wpm = Math.max(0, Math.min(220, Math.round(wpm)));
    }

    /** Set the target keyboard layout (so symbols map to the right physical keys). */
    setLayout(layout: "us" | "uk"): void {
        this.layout = layout === "uk" ? "uk" : "us";
    }

    /** Current target keyboard layout (watched typing toggles this on a layout slip). */
    getLayout(): "us" | "uk" {
        return this.layout;
    }

    /** Type text with humanlike timing, typos and self-correction. */
    async typeText(
        text: string,
        opts: TypingOptions & {
            signal?: AbortSignal;
            persona?: Persona;
            onProgress?: (done: number, total: number) => void;
            /** Secret values are typed but never echoed to the activity tracker / model. */
            secret?: boolean;
        } = {},
    ): Promise<void> {
        const { signal, onProgress, secret, ...typingOpts } = opts;
        const strokes = planTyping(text, {
            intensity: this.humanize,
            layout: this.layout,
            ...(this.wpm ? { wpm: this.wpm } : {}),
            ...typingOpts,
        });
        try {
            for (let i = 0; i < strokes.length; i++) {
                const s = strokes[i]!;
                if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
                if (s.shift && !this.shiftHeld) {
                    await this.key("ShiftLeft", true);
                    this.shiftHeld = true;
                } else if (!s.shift && this.shiftHeld) {
                    await this.key("ShiftLeft", false);
                    this.shiftHeld = false;
                }
                await this.key(s.code, true);
                await sleep(s.downMs, signal);
                await this.key(s.code, false);
                await sleep(s.gapMs, signal);
                onProgress?.(i + 1, strokes.length);
            }
            if (!secret) this.onAgentInput?.({ text });
        } finally {
            if (this.shiftHeld) {
                await this.key("ShiftLeft", false).catch(() => {});
                this.shiftHeld = false;
            }
        }
    }

    /* -------------------------------------------------------------- *
     * Mouse
     * -------------------------------------------------------------- */

    private toNorm(px: number, span: number): number {
        const ratio = span > 1 ? px / (span - 1) : 0;
        return Math.max(-32768, Math.min(32767, Math.round(ratio * 65534) - 32767));
    }

    /** Inverse of toNorm: a normalized HID coordinate back to a frame pixel. */
    private fromNorm(n: number, span: number): number {
        return ((n + 32767) / 65534) * Math.max(0, span - 1);
    }

    private clampNorm(v: number): number {
        return Math.max(-32768, Math.min(32767, Math.round(v)));
    }

    private async sendMove(x: number, y: number): Promise<void> {
        await this.send("mouse_move", { to: { x: this.clampNorm(x), y: this.clampNorm(y) } });
    }

    /** Move the cursor to a pixel coordinate using the WindMouse algorithm:
     *  gravity pulls toward the target while a random "wind" walk perturbs the
     *  path, giving an organic curved trajectory with a natural speed profile,
     *  subtle tremor and an off-centre landing. Runs in frame-pixel space (where
     *  WindMouse's force constants are tuned), then converts to HID units. */
    async moveMouse(px: number, py: number, opts: { signal?: AbortSignal; instant?: boolean } = {}): Promise<void> {
        const tx = this.toNorm(px, this.dims.width);
        const ty = this.toNorm(py, this.dims.height);

        if (opts.instant) {
            await this.sendMove(tx, ty);
            this.mouse = { x: tx, y: ty };
            return;
        }

        // Current position and the target, both as frame pixels.
        const start = { x: this.fromNorm(this.mouse.x, this.dims.width), y: this.fromNorm(this.mouse.y, this.dims.height) };
        const end = { x: px, y: py };
        const dist = Math.hypot(end.x - start.x, end.y - start.y);
        if (dist < 2) {
            await this.sendMove(tx, ty);
            this.mouse = { x: tx, y: ty };
            return;
        }

        // Humanize intensity (0..1) scales the extra jitter/scatter/hesitation;
        // the WindMouse geometry and the requested speed stay constant.
        const h = this.humanize;
        let samples = windMousePath(start, end, {
            speed: this.mouseSpeed,
            tremor: 0.5 * h,
            endScatter: 2 * h,
            hes: 0.04 * h,
        });

        // WindMouse emits one point per integration step (~7px apart), so a long
        // move can be 100+ points. Decimate to a sane cap (timing preserved) to
        // avoid flooding the HID WebSocket; wall-clock is unchanged.
        const CAP = 80;
        if (samples.length > CAP) {
            const keep: typeof samples = [];
            for (let i = 0; i < CAP; i++) {
                const s = samples[Math.round((i * (samples.length - 1)) / (CAP - 1))];
                if (s) keep.push(s);
            }
            samples = keep;
        }

        let prevT = 0;
        for (let i = 0; i < samples.length; i++) {
            if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const s = samples[i];
            if (!s) continue;
            await this.sendMove(this.toNorm(s.x, this.dims.width), this.toNorm(s.y, this.dims.height));
            const dt = s.t - prevT;
            prevT = s.t;
            if (i < samples.length - 1 && dt > 0.5) await sleep(dt, opts.signal);
        }
        // Land exactly on the requested target (the click site).
        await this.sendMove(tx, ty);
        this.mouse = { x: tx, y: ty };
    }

    async mouseButton(button: MouseButton, state: boolean): Promise<void> {
        await this.send("mouse_button", { button, state });
    }

    async click(button: MouseButton = "left"): Promise<void> {
        await this.mouseButton(button, true);
        await sleep(40 + Math.random() * 60);
        await this.mouseButton(button, false);
    }

    async doubleClick(button: MouseButton = "left"): Promise<void> {
        await this.click(button);
        await sleep(70 + Math.random() * 60);
        await this.click(button);
    }

    /** Press a button, move to the target with an eased path, then release. */
    async drag(
        from: { x: number; y: number },
        to: { x: number; y: number },
        button: MouseButton = "left",
        opts: { signal?: AbortSignal } = {},
    ): Promise<void> {
        await this.moveMouse(from.x, from.y, opts);
        await sleep(80);
        await this.mouseButton(button, true);
        await sleep(120 + Math.random() * 80);
        await this.moveMouse(to.x, to.y, opts);
        await sleep(120 + Math.random() * 80);
        await this.mouseButton(button, false);
    }

    /** Scroll. Positive dy scrolls up, negative down. Broken into a few ticks
     *  for a natural trackpad-like gesture. */
    async scroll(dx: number, dy: number): Promise<void> {
        const ticks = Math.max(1, Math.min(12, Math.round(Math.max(Math.abs(dx), Math.abs(dy)))));
        const sx = dx / ticks;
        const sy = dy / ticks;
        for (let i = 0; i < ticks; i++) {
            await this.send("mouse_wheel", { delta: { x: Math.round(sx) || (dx ? Math.sign(dx) : 0), y: Math.round(sy) || (dy ? Math.sign(dy) : 0) } });
            await sleep(18 + Math.random() * 22);
        }
    }

    dispose(): void {
        try {
            this.ws?.close();
        } catch {
            /* ignore */
        }
        this.ws = undefined;
        this.wsReady = undefined;
    }
}
