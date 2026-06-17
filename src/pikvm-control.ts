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
    /** Hook fired with text the agent types / keys it presses (for input tracking). */
    onAgentInput: ((info: { text?: string; key?: string }) => void) | undefined;
    /**
     * Capture the already-rendered live view (set by main → mainView.capturePage).
     * Preferred over the PiKVM snapshot endpoint so the agent's screenshots put
     * ZERO extra load on the Pi and never stall the live stream.
     */
    captureScreen: (() => Promise<{ data: Buffer; width: number; height: number } | null>) | undefined;
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
                if (cap && cap.width && cap.height) {
                    this.dims = { width: cap.width, height: cap.height };
                    if (region) {
                        const cropped = this.crop(cap.data, region);
                        if (cropped) return cropped;
                    }
                    return {
                        data: cap.data,
                        base64: cap.data.toString("base64"),
                        mimeType: "image/jpeg",
                        width: cap.width,
                        height: cap.height,
                    };
                }
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
        let width = hw;
        let height = hh;
        if (!width || !height) {
            const parsed = jpegSize(data);
            if (parsed) {
                width = parsed.width;
                height = parsed.height;
            }
        }
        if (width && height) this.dims = { width, height };

        // Optional crop — lets the agent zoom into a window/region of the frame.
        if (region) {
            const cropped = this.crop(data, region);
            if (cropped) return cropped;
        }

        return {
            data,
            base64: data.toString("base64"),
            mimeType: "image/jpeg",
            width: this.dims.width,
            height: this.dims.height,
        };
    }

    /** Crop a JPEG to a clamped region using Electron's nativeImage. */
    private crop(jpeg: Buffer, region: Region): Screenshot | null {
        try {
            const fw = this.dims.width;
            const fh = this.dims.height;
            const x = Math.max(0, Math.min(Math.round(region.x), fw - 1));
            const y = Math.max(0, Math.min(Math.round(region.y), fh - 1));
            const w = Math.max(1, Math.min(Math.round(region.width), fw - x));
            const h = Math.max(1, Math.min(Math.round(region.height), fh - y));
            const out = nativeImage.createFromBuffer(jpeg).crop({ x, y, width: w, height: h }).toJPEG(85);
            return { data: out, base64: out.toString("base64"), mimeType: "image/jpeg", width: w, height: h };
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

    /** Type text with humanlike timing, typos and self-correction. */
    async typeText(
        text: string,
        opts: TypingOptions & {
            signal?: AbortSignal;
            persona?: Persona;
            onProgress?: (done: number, total: number) => void;
        } = {},
    ): Promise<void> {
        const { signal, onProgress, ...typingOpts } = opts;
        const strokes = planTyping(text, {
            intensity: this.humanize,
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
            this.onAgentInput?.({ text });
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

    /** Move the cursor to a pixel coordinate on the current frame, with a
     *  short eased, slightly jittery path for a human feel. */
    async moveMouse(px: number, py: number, opts: { signal?: AbortSignal; instant?: boolean } = {}): Promise<void> {
        const tx = this.toNorm(px, this.dims.width);
        const ty = this.toNorm(py, this.dims.height);
        if (opts.instant) {
            await this.send("mouse_move", { to: { x: tx, y: ty } });
            this.mouse = { x: tx, y: ty };
            return;
        }
        const fromX = this.mouse.x;
        const fromY = this.mouse.y;
        const dist = Math.hypot(tx - fromX, ty - fromY);
        const steps = Math.max(4, Math.min(28, Math.round(dist / 1500)));
        for (let i = 1; i <= steps; i++) {
            if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const t = i / steps;
            // ease-in-out
            const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            const jitter = i < steps ? (Math.random() - 0.5) * 240 : 0;
            const x = Math.round(fromX + (tx - fromX) * e + jitter);
            const y = Math.round(fromY + (ty - fromY) * e + jitter);
            await this.send("mouse_move", {
                to: { x: Math.max(-32768, Math.min(32767, x)), y: Math.max(-32768, Math.min(32767, y)) },
            });
            await sleep(8 + Math.random() * 14, opts.signal);
        }
        await this.send("mouse_move", { to: { x: tx, y: ty } });
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

    /** Scroll. Positive dy scrolls up, negative down (PiKVM convention). */
    async scroll(dx: number, dy: number): Promise<void> {
        await this.send("mouse_wheel", { delta: { x: dx, y: dy } });
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
