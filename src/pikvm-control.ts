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
import { nativeImage } from "electron";
import { Agent as HttpsAgent } from "https";
import WebSocket from "ws";
import { planTyping, type Persona, type TypingOptions } from "./human-typing";

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
    /** Forced WPM (0 = use the random persona). */
    private wpm = 0;
    /** Target keyboard layout (we send physical key codes; the layout sets glyphs). */
    private layout: "us" | "uk" = "us";
    /** Hook fired with text the agent types / keys it presses (for input tracking). */
    onAgentInput: ((info: { text?: string; key?: string }) => void) | undefined;
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
    /** Native stream resolution (for OCR coordinate scaling). */
    private nativeDims: { width: number; height: number } | undefined;

    constructor(creds: PiKvmCredentials) {
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
    private finalize(raw: Buffer, fw: number, fh: number, region?: Region): Screenshot {
        if (region) {
            const sx = fw / (this.dims.width || fw);
            const sy = fh / (this.dims.height || fh);
            const cropped = this.crop(raw, fw, fh, {
                x: region.x * sx,
                y: region.y * sy,
                width: region.width * sx,
                height: region.height * sy,
            });
            if (cropped) return cropped;
        }
        const d = this.downscale(raw, fw, fh);
        this.dims = { width: d.width, height: d.height };
        return { data: d.data, base64: d.data.toString("base64"), mimeType: "image/jpeg", width: d.width, height: d.height };
    }

    /** Downscale a JPEG so its long edge is at most MAX_SCREENSHOT_DIM. */
    private downscale(jpeg: Buffer, w: number, h: number): { data: Buffer; width: number; height: number } {
        const longEdge = Math.max(w, h);
        if (longEdge <= MAX_SCREENSHOT_DIM) return { data: jpeg, width: w, height: h };
        try {
            const scale = MAX_SCREENSHOT_DIM / longEdge;
            const nw = Math.round(w * scale);
            const nh = Math.round(h * scale);
            const out = nativeImage.createFromBuffer(jpeg).resize({ width: nw, height: nh, quality: "good" }).toJPEG(78);
            return { data: out, width: nw, height: nh };
        } catch {
            return { data: jpeg, width: w, height: h };
        }
    }

    /** Crop a full-res JPEG to a clamped region (then cap its size). */
    private crop(jpeg: Buffer, fw: number, fh: number, region: Region): Screenshot | null {
        try {
            const x = Math.max(0, Math.min(Math.round(region.x), fw - 1));
            const y = Math.max(0, Math.min(Math.round(region.y), fh - 1));
            const w = Math.max(1, Math.min(Math.round(region.width), fw - x));
            const h = Math.max(1, Math.min(Math.round(region.height), fh - y));
            const cropBuf = nativeImage.createFromBuffer(jpeg).crop({ x, y, width: w, height: h }).toJPEG(88);
            const d = this.downscale(cropBuf, w, h);
            return { data: d.data, base64: d.data.toString("base64"), mimeType: "image/jpeg", width: d.width, height: d.height };
        } catch {
            return null;
        }
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
        this.ws!.send(JSON.stringify({ event_type: event, event: payload }));
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

    private clampNorm(v: number): number {
        return Math.max(-32768, Math.min(32767, Math.round(v)));
    }

    private async sendMove(x: number, y: number): Promise<void> {
        await this.send("mouse_move", { to: { x: this.clampNorm(x), y: this.clampNorm(y) } });
    }

    /** Move the cursor to a pixel coordinate with a human-feeling path: a gentle
     *  arc (curved, not straight), micro-tremor along the way, a small overshoot,
     *  and a settle with a slight random landing offset (never dead-centre). */
    async moveMouse(px: number, py: number, opts: { signal?: AbortSignal; instant?: boolean } = {}): Promise<void> {
        // Tiny landing offset so we don't hit the exact same pixel / dead centre.
        const ox = (Math.random() * 2 - 1) * 5;
        const oy = (Math.random() * 2 - 1) * 5;
        const tx = this.toNorm(px + ox, this.dims.width);
        const ty = this.toNorm(py + oy, this.dims.height);

        if (opts.instant) {
            await this.sendMove(tx, ty);
            this.mouse = { x: tx, y: ty };
            return;
        }

        const fromX = this.mouse.x;
        const fromY = this.mouse.y;
        const dx = tx - fromX;
        const dy = ty - fromY;
        const dist = Math.hypot(dx, dy);

        // Very short hops: just a couple of steps.
        if (dist < 600) {
            await this.sendMove((fromX + tx) / 2, (fromY + ty) / 2);
            await sleep(10 + Math.random() * 20, opts.signal);
            await this.sendMove(tx, ty);
            this.mouse = { x: tx, y: ty };
            return;
        }

        const steps = Math.max(10, Math.min(48, Math.round(dist / 700)));
        // Quadratic-bezier control point offset perpendicular to the path → an arc.
        const len = dist || 1;
        const perpX = -dy / len;
        const perpY = dx / len;
        const arc = (Math.random() * 2 - 1) * dist * (0.06 + Math.random() * 0.14);
        const cx = (fromX + tx) / 2 + perpX * arc;
        const cy = (fromY + ty) / 2 + perpY * arc;
        // Slight overshoot target the path aims past before settling back.
        const overshoot = 1 + (dist > 6000 ? 0.02 + Math.random() * 0.04 : 0);
        const aimX = fromX + dx * overshoot;
        const aimY = fromY + dy * overshoot;

        const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
        let tremor = 140;
        for (let i = 1; i <= steps; i++) {
            if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const e = ease(i / steps);
            const u = 1 - e;
            let x = u * u * fromX + 2 * u * e * cx + e * e * aimX;
            let y = u * u * fromY + 2 * u * e * cy + e * e * aimY;
            if (i < steps) {
                x += (Math.random() * 2 - 1) * tremor;
                y += (Math.random() * 2 - 1) * tremor;
            }
            tremor *= 0.9; // settle as we approach
            await this.sendMove(x, y);
            await sleep(6 + Math.random() * 15, opts.signal);
        }
        // Settle: one or two small corrective nudges onto the target.
        const settles = 1 + Math.floor(Math.random() * 2);
        for (let k = 0; k < settles; k++) {
            await this.sendMove(tx + (Math.random() * 2 - 1) * 220, ty + (Math.random() * 2 - 1) * 220);
            await sleep(18 + Math.random() * 40, opts.signal);
        }
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
