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
import { awaitSettled, fpDiff, FP_MEANINGFUL, type SettleResult } from "./ambient/fingerprint";
import type { GridSnapshot, TypingEvent } from "./agent/watched-typing";
import type { ImageOps } from "./image-ops";

export interface Region {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface MousePathSample {
    x: number;
    y: number;
    t?: number;
}

/**
 * Cap the long edge of full-frame screenshots sent to the model. 1280 is the
 * documented click-accuracy sweet spot for vision models (≈XGA/WXGA / ~1.15MP);
 * larger frames cost tokens with no grounding gain and can hurt coordinate
 * prediction. Held fixed per session so the model's pixel sense stays calibrated.
 */
const MAX_SCREENSHOT_DIM = 1280;

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

const TAB_CODE = "Tab";
const ALT_CODES = new Set(["AltLeft", "AltRight", "Alt"]);
const HELD_HOTKEY_TIMEOUT_MS = 12_000;

function isAltCode(code: string): boolean {
    return ALT_CODES.has(code);
}

function parseAltTabPeekHotkey(codes: readonly string[]): { alt: string; transient: string[] } | null {
    if (!codes.includes(TAB_CODE)) return null;
    const alt = codes.find(isAltCode);
    if (!alt) return null;
    return {
        alt,
        transient: codes.filter((c) => c !== TAB_CODE && !isAltCode(c)),
    };
}

export function isAltTabPeekHotkey(codes: readonly string[]): boolean {
    return parseAltTabPeekHotkey(codes) !== null;
}

/** Default keep-awake nudge, in FRAME PIXELS. Big enough that the target OS registers
 *  a real pointer move (sub-pixel jogs are rounded away and never reset an idle
 *  timer), small enough to be barely visible if someone is watching. */
export const NUDGE_PX = 24;

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

/* -------------------------------------------------------------- *
 * KVMD state stream (/api/ws server→client events)
 *
 * KVMD pushes a full state bundle on connect, then deltas. We used to drain it;
 * now we cache the parts useful for accurate, verifiable automation: the target's
 * configured keyboard keymap (to ground our send-side layout instead of guessing
 * US/UK), the HID liveness + Caps-Lock LEDs + mouse mode, the streamer's native
 * resolution + online flag, and the OCR languages.
 * -------------------------------------------------------------- */

export interface KvmdHidState {
    online?: boolean;
    busy?: boolean;
    /** null on some firmware = "unknown"; only an explicit false means detached. */
    connected?: boolean | null;
    keyboard?: { online?: boolean; leds?: { caps?: boolean; scroll?: boolean; num?: boolean } };
    mouse?: { online?: boolean; absolute?: boolean; outputs?: { active?: string; available?: string[] } };
    jiggler?: { enabled?: boolean; active?: boolean; interval?: number };
}
export interface KvmdStreamerState {
    source?: { online?: boolean; resolution?: { width?: number; height?: number }; captured_fps?: number };
    encoder?: { quality?: number };
}
export interface KvmdState {
    hid?: KvmdHidState;
    keymaps?: { default?: string; available?: string[] };
    streamer?: KvmdStreamerState;
    ocr?: { enabled?: boolean; langs?: { default?: string[]; available?: string[] } };
    /** Set once the "loop" event arrives — the initial full-state bundle is complete. */
    ready?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === "object" && !Array.isArray(v);
}
/** Deep-merge plain objects (arrays + primitives replace). KVMD "hid" deltas are
 *  partial, so we merge into the cache rather than replacing it wholesale. */
function deepMerge<T>(base: T, patch: unknown): T {
    if (!isPlainObject(patch)) return base;
    const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
    for (const [k, v] of Object.entries(patch)) {
        out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
    }
    return out as T;
}

/** Merge one /api/ws event into the cached state. Pure + total — unknown events
 *  pass through unchanged so it can never throw on a frame shape we don't model. */
export function mergeKvmdEvent(prev: KvmdState, eventType: string, event: unknown): KvmdState {
    switch (eventType) {
        case "hid":
            return { ...prev, hid: deepMerge(prev.hid ?? {}, event) };
        case "hid_keymaps":
            return { ...prev, keymaps: deepMerge(prev.keymaps ?? {}, isPlainObject(event) ? event.keymaps : undefined) };
        case "streamer":
            return { ...prev, streamer: deepMerge(prev.streamer ?? {}, event) };
        case "ocr":
            return { ...prev, ocr: deepMerge(prev.ocr ?? {}, event) };
        case "loop":
            return { ...prev, ready: true };
        default:
            return prev;
    }
}

/**
 * When the target's Caps Lock is ON, LETTER keys invert: our Shift-for-uppercase
 * yields lowercase and our no-Shift yields uppercase — the "Windows App" → "wINDOWS
 * aPP" bug. Flip the Shift bit for A–Z so the typed OUTPUT is correct, WITHOUT
 * toggling the target's Caps Lock (which would race the live LED state and disturb a
 * human at the keyboard). Only letters are affected by Caps Lock; digits/symbols are
 * left untouched. Mutates + returns the strokes. */
export function compensateCapsLock<T extends { code: string; shift: boolean }>(strokes: T[], capsOn: boolean): T[] {
    if (!capsOn) return strokes;
    for (const s of strokes) if (/^Key[A-Z]$/.test(s.code)) s.shift = !s.shift;
    return strokes;
}

/** Map a KVMD keymap name (e.g. "en-gb", "en-us") to our send-side layout. Returns
 *  undefined for layouts we can't represent (we only send US/UK physical keys), so
 *  the current layout is kept rather than forced to a wrong guess. */
export function keymapToLayout(name: string | undefined): "us" | "uk" | undefined {
    if (!name) return undefined;
    const n = name.toLowerCase();
    if (n === "en-gb" || n.startsWith("en-gb")) return "uk";
    if (n === "en-us" || n.startsWith("en-us")) return "us";
    return undefined;
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
    private heldHotkey: { keys: string[]; timer: ReturnType<typeof setTimeout> | undefined } | null = null;
    /** Default typing humanity (0..1); used when typeText omits an intensity. */
    private humanize = 1;
    /** WindMouse speed factor for cursor moves (higher = faster). */
    private mouseSpeed = 1.9;
    /** Forced WPM (0 = use the random persona). */
    private wpm = 0;
    /** Target keyboard layout (we send physical key codes; the layout sets glyphs). */
    private layout: "us" | "uk" = "us";
    /** True once a layout was pinned by an explicit user choice — stops the keymap
     *  auto-seed (and a stale WS event) from overriding it. */
    private layoutFromUser = false;
    /** Cached KVMD state from the /api/ws stream (HID/keymaps/streamer/OCR). */
    private kvmdState: KvmdState = {};
    /** Fingerprint baseline of the LAST full screen the agent actually saw — so we can
     *  tell if the screen changed underneath it between tool calls (an async popup, a
     *  call, a window opening). Lives here because the MCP server is stateless per request. */
    private lastLook: { fp: Uint8Array | null; at: number } | null = null;
    /** Region monitors the agent registered (label → region + grid baseline). Checked by
     *  the BACKGROUND ambient monitor (a real background task), which alerts the harness
     *  and enqueues an agent-facing notice here. */
    private watches = new Map<string, { region: Region; cells: Uint8Array; cols: number; rows: number; at: number }>();
    /** Agent-facing "a watched region changed" notices, drained onto the next tool result. */
    private watchNotices: string[] = [];
    /** Hook fired with text the agent types / keys it presses (for input tracking). */
    onAgentInput: ((info: { text?: string; key?: string }) => void) | undefined;
    /** Live watched-typing events (progress / verify / self-correct) → overlay X-ray. */
    onTypingEvent: ((ev: TypingEvent) => void) | undefined;
    /** Real generated mouse path samples, for the X-ray trajectory overlay. */
    onMousePath: ((ev: { points: MousePathSample[]; w: number; h: number }) => void) | undefined;
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

    /** Connection details for the vendored document-capture tool, which fetches the
     *  native-resolution snapshot directly with HTTP basic auth (X-KVMD-User/Passwd).
     *  user/password are omitted when we only hold a session cookie (capture then errors
     *  cleanly rather than hanging on an auth prompt). */
    captureTarget(): { host: string; scheme: "http" | "https"; user?: string; password?: string } {
        return {
            host: this.origin.host,
            scheme: this.origin.protocol === "https:" ? "https" : "http",
            ...(this.user ? { user: this.user } : {}),
            ...(this.pass ? { password: this.pass } : {}),
        };
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

    /** Wait until the live screen stops changing — K consecutive settled fingerprint
     *  frames (the "two identical frames" rule), or a timeout. Lets a caller observe
     *  AFTER a slow load/animation rather than mid-render. Resolves ready immediately
     *  if no fingerprint source is wired (degrades gracefully). */
    async waitUntilSettled(opts: { timeoutMs?: number; pollMs?: number; k?: number } = {}): Promise<SettleResult> {
        return awaitSettled(() => (this.captureFingerprint ? this.captureFingerprint() : Promise.resolve(null)), opts);
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

    /**
     * Fast server-side text entry via KVMD's keymap printer (POST /api/hid/print):
     * kvmd types the WHOLE string in one call using its configured keymap — far faster
     * than per-key WS frames and layout-correct (kvmd owns Shift/AltGr), so it's the
     * right path for long PROSE. NEWLINES ARE STRIPPED here (kvmd maps every \n to a real
     * Enter, which would submit a chat/email mid-draft) — line breaks must be emitted
     * DELIBERATELY by the caller (Shift+Enter/Enter). Fire-and-forget: kvmd returns 200
     * even when it silently drops unmappable chars or scrambles keys under lag, so the
     * caller MUST verify the field afterwards (watched typing does a read-back).
     */
    async printText(text: string, opts: { keymap?: string; delayMs?: number; signal?: AbortSignal } = {}): Promise<void> {
        const body = text.replace(/[\r\n]+/g, " ");
        if (!body) return;
        const km = opts.keymap ?? this.getKeymapDefault();
        const params: Record<string, string | number> = { limit: 0 };
        if (km) params.keymap = km;
        // An explicit delay (seconds) overrides on newer kvmd; otherwise slow=1 gives a
        // broadly-compatible ~20ms inter-key spacing. Neither is fully reliable under lag
        // (PIKVM #1564) — the read-back is the real safety net.
        if (typeof opts.delayMs === "number") params.delay = Math.max(0, opts.delayMs) / 1000;
        else params.slow = 1;
        await axios.post(`${this.httpBase()}/api/hid/print`, body, {
            headers: { ...(await this.headers()), "Content-Type": "text/plain" },
            httpsAgent: this.agent,
            timeout: 120_000,
            params,
            ...(opts.signal ? { signal: opts.signal } : {}),
        });
        this.lastInputTs = Date.now();
        this.onAgentInput?.({ text });
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
                    this.clearHeldHotkeyState();
                }
            });
            // Parse inbound KVMD state events into the cache (was: drained + ignored).
            // Binary ping frames / non-JSON are swallowed so they can never throw.
            ws.on("message", (raw: WebSocket.RawData) => {
                let msg: { event_type?: string; event?: unknown };
                try {
                    msg = JSON.parse(raw.toString());
                } catch {
                    return;
                }
                if (msg && typeof msg.event_type === "string") this.applyState(msg.event_type, msg.event);
            });
        });
        return this.wsReady;
    }

    /** Merge a KVMD state event into the cache and react: ground the send-side layout
     *  from the Pi's configured keymap (unless the user pinned one), and adopt the
     *  streamer's native resolution for OCR/coordinate scaling. */
    private applyState(eventType: string, event: unknown): void {
        this.kvmdState = mergeKvmdEvent(this.kvmdState, eventType, event);
        if (eventType === "hid_keymaps" && !this.layoutFromUser) {
            const mapped = keymapToLayout(this.kvmdState.keymaps?.default);
            if (mapped && mapped !== this.layout) this.layout = mapped;
        }
        if (eventType === "streamer") {
            const r = this.kvmdState.streamer?.source?.resolution;
            if (r?.width && r?.height) this.nativeDims = { width: r.width, height: r.height };
        }
    }

    /* ---- KVMD state getters (from the /api/ws cache) ---- */

    /** Current cached HID state (online/leds/mouse-mode/busy), or undefined if not seen. */
    getHidState(): KvmdHidState | undefined {
        return this.kvmdState.hid;
    }
    /** The Pi's configured keymap name (e.g. "en-us", "en-gb"), or undefined. */
    getKeymapDefault(): string | undefined {
        return this.kvmdState.keymaps?.default;
    }
    /** Caps-Lock LED state on the target, or undefined if unknown. */
    getCapsLock(): boolean | undefined {
        return this.kvmdState.hid?.keyboard?.leds?.caps;
    }
    /** Mouse pointer mode the target HID is in. "unknown" until a hid event arrives. */
    getMouseMode(): "absolute" | "relative" | "unknown" {
        const m = this.kvmdState.hid?.mouse;
        if (m?.absolute === true) return "absolute";
        if (m?.absolute === false) return "relative";
        if (m?.outputs?.active === "usb") return "absolute";
        if (m?.outputs?.active === "usb_rel") return "relative";
        return "unknown";
    }
    /** The Pi's OWN mouse jiggler (kvmd `hid.jiggler`). `enabled` means the board
     *  exposes it at all; `active` means it is currently running. Undefined until a
     *  hid event arrives. This is strictly better than nudging from here — it keeps
     *  the target awake even when this app is closed or the laptop is asleep. */
    getNativeJiggler(): { enabled?: boolean; active?: boolean } | undefined {
        return this.kvmdState.hid?.jiggler;
    }

    /** Turn the Pi's own jiggler on or off (POST /api/hid/set_params?jiggler=). */
    async setNativeJiggler(on: boolean): Promise<void> {
        await axios.post(`${this.httpBase()}/api/hid/set_params`, null, {
            headers: await this.headers(),
            httpsAgent: this.agent,
            timeout: 15_000,
            params: { jiggler: on ? 1 : 0 },
        });
    }

    /** Available mouse output modes (e.g. ["usb","usb_rel"]) for set_params gating. */
    getMouseOutputs(): string[] {
        return this.kvmdState.hid?.mouse?.outputs?.available ?? [];
    }
    /** Is the HID actually attached to the target? undefined = unknown (treat as allow);
     *  false = definitely detached (keystrokes would be lost). */
    isHidOnline(): boolean | undefined {
        const h = this.kvmdState.hid;
        if (!h) return undefined;
        if (h.connected === false) return false;
        if (h.online === false || h.keyboard?.online === false) return false;
        // online not-false and keyboard.online not-false here; attached only if explicitly online.
        if (h.online === true) return true;
        return undefined;
    }
    /** Is the captured video source online? undefined = unknown. */
    isSourceOnline(): boolean | undefined {
        return this.kvmdState.streamer?.source?.online;
    }
    /** Installed OCR languages reported by the Pi (for ocr_langs validation). */
    getOcrLangs(): { default: string[]; available: string[] } {
        const o = this.kvmdState.ocr;
        return { default: o?.langs?.default ?? ["eng"], available: o?.langs?.available ?? [] };
    }

    /* ---- Screen freshness + region monitors (perceptual fingerprint / grid) ---- */

    /** Record that the agent just saw the full screen (call after a full-frame look),
     *  capturing a fingerprint baseline for the stale-guard. Region watches track their
     *  own baselines independently (the background monitor owns them). */
    async markAgentLook(): Promise<void> {
        const fp = this.captureFingerprint ? await this.captureFingerprint().catch(() => null) : null;
        this.lastLook = { fp, at: Date.now() };
    }

    /** Has the screen materially changed since the agent's last full-screen look? Used
     *  to refuse acting on a stale view. `changed:true` when it changed OR never looked;
     *  `changed:false` when we can't tell (no fingerprint) so we never wrongly block. */
    async lookFreshness(): Promise<{ hasBaseline: boolean; ageMs: number; delta: number | null; changed: boolean }> {
        const now = Date.now();
        if (!this.lastLook) return { hasBaseline: false, ageMs: Number.POSITIVE_INFINITY, delta: null, changed: true };
        const ageMs = now - this.lastLook.at;
        const cur = this.captureFingerprint ? await this.captureFingerprint().catch(() => null) : null;
        if (!cur || !this.lastLook.fp) return { hasBaseline: true, ageMs, delta: null, changed: false };
        const delta = fpDiff(this.lastLook.fp, cur);
        return { hasBaseline: true, ageMs, delta, changed: delta > FP_MEANINGFUL };
    }

    /** Map a region (in getDimensions() pixel space) to its cells in a grid snapshot. */
    private regionCells(region: Region, grid: GridSnapshot): { cells: Uint8Array; cols: number; rows: number } {
        const W = this.dims.width || 1;
        const H = this.dims.height || 1;
        const c0 = Math.max(0, Math.min(grid.cols - 1, Math.floor((region.x / W) * grid.cols)));
        const r0 = Math.max(0, Math.min(grid.rows - 1, Math.floor((region.y / H) * grid.rows)));
        const c1 = Math.max(c0 + 1, Math.min(grid.cols, Math.ceil(((region.x + region.width) / W) * grid.cols)));
        const r1 = Math.max(r0 + 1, Math.min(grid.rows, Math.ceil(((region.y + region.height) / H) * grid.rows)));
        const cols = c1 - c0;
        const rows = r1 - r0;
        const cells = new Uint8Array(cols * rows);
        for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) cells[(r - r0) * cols + (c - c0)] = grid.cells[r * grid.cols + c] ?? 0;
        return { cells, cols, rows };
    }

    /** Register/replace a region monitor; captures its baseline. Returns false if no
     *  grid source is available to fingerprint the region. */
    async watchRegion(label: string, region: Region): Promise<boolean> {
        const grid = this.captureGrid ? await this.captureGrid().catch(() => null) : null;
        if (!grid) return false;
        this.watches.set(label, { region, ...this.regionCells(region, grid), at: Date.now() });
        return true;
    }
    /** Stop monitoring a region. */
    unwatchRegion(label: string): boolean {
        return this.watches.delete(label);
    }
    /** Labels currently monitored. */
    listWatches(): string[] {
        return [...this.watches.keys()];
    }
    /** Which monitored regions changed since their baseline; refreshes the baselines of
     *  those reported so a single change is reported once, and enqueues an agent-facing
     *  notice for each. Called by the BACKGROUND monitor — the single detector. */
    async changedWatches(): Promise<{ label: string; delta: number }[]> {
        if (!this.watches.size) return [];
        const grid = this.captureGrid ? await this.captureGrid().catch(() => null) : null;
        if (!grid) return [];
        const out: { label: string; delta: number }[] = [];
        for (const [label, w] of this.watches) {
            const cur = this.regionCells(w.region, grid);
            if (cur.cols !== w.cols || cur.rows !== w.rows) continue;
            const delta = fpDiff(w.cells, cur.cells);
            if (delta > FP_MEANINGFUL) {
                out.push({ label, delta });
                this.watches.set(label, { ...w, cells: cur.cells, at: Date.now() });
                this.watchNotices.push(`"${label}" (Δ${Math.round(delta * 100)}%)`);
                if (this.watchNotices.length > 8) this.watchNotices.shift();
            }
        }
        return out;
    }

    /** Drain queued "watched region changed" notices for the agent (onto a tool result). */
    drainWatchNotices(): string[] {
        const n = this.watchNotices;
        this.watchNotices = [];
        return n;
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

    /** Adopt a cursor position observed on the PROXIED HID stream (the user's own
     *  client driving the Pi). Without this our idea of the cursor only tracks moves
     *  WE sent, so a keep-awake nudge would jog off a stale guess and teleport the
     *  user's pointer instead of netting back to zero. Coordinates are PiKVM
     *  normalized units (−32768..32767). */
    noteObservedMouse(x: number, y: number): void {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        this.mouse = { x: this.clampNorm(x), y: this.clampNorm(y) };
    }

    /** A keep-awake nudge that lands the cursor back exactly where it started, using
     *  whichever HID mode the target is actually in. In RELATIVE mode we send a delta
     *  and its inverse. In ABSOLUTE mode (the common USB-HID default, where
     *  mouse_relative is silently ignored) we jog off the last-known position and move
     *  straight back.
     *
     *  `px` is in FRAME PIXELS, not HID units. The old version passed a raw 10 into the
     *  normalized ±32767 space, which on a 1920-wide target is 0.3 of a pixel: the
     *  target rounded it to the same pixel, saw no motion at all, and slept anyway.
     *  That is the reason the jiggler "did nothing" on absolute targets. */
    async mouseNudge(px = NUDGE_PX): Promise<void> {
        const d = Math.max(1, Math.round(px));
        if (this.getMouseMode() === "relative") {
            await this.mouseRelative(d, 0);
            await sleep(160);
            await this.mouseRelative(-d, 0);
            return;
        }
        const { x, y } = this.mouse;
        // Pixels → normalized units, then jog INWARD so a cursor parked on the right
        // edge still travels the full distance instead of being clamped to a no-op.
        const step = this.toNorm(d, this.dims.width) - this.toNorm(0, this.dims.width);
        await this.sendMove(this.clampNorm(x + (x > 0 ? -step : step)), y);
        await sleep(160);
        await this.sendMove(x, y);
    }

    /* -------------------------------------------------------------- *
     * Keyboard
     * -------------------------------------------------------------- */

    private async key(code: string, state: boolean): Promise<void> {
        await this.send("key", { key: code, state });
    }

    private clearHeldHotkeyState(): void {
        if (this.heldHotkey?.timer) clearTimeout(this.heldHotkey.timer);
        this.heldHotkey = null;
    }

    private rememberHeldHotkey(keys: string[]): void {
        this.clearHeldHotkeyState();
        const timer = setTimeout(() => {
            void this.releaseHeldHotkeys("timeout").catch(() => {});
        }, HELD_HOTKEY_TIMEOUT_MS);
        const maybeNodeTimer = timer as { unref?: () => void };
        if (typeof maybeNodeTimer.unref === "function") maybeNodeTimer.unref();
        this.heldHotkey = { keys, timer };
    }

    /** Release a key held deliberately for a look-ahead chord such as Alt+Tab. */
    async releaseHeldHotkeys(_reason = "release"): Promise<boolean> {
        const held = this.heldHotkey;
        if (!held) return false;
        this.clearHeldHotkeyState();
        for (const c of [...held.keys].reverse()) {
            await this.key(c, false).catch(() => {});
        }
        return true;
    }

    private async altTabPeek(codes: string[]): Promise<void> {
        const parsed = parseAltTabPeekHotkey(codes);
        if (!parsed) return;

        const sameAltAlreadyHeld = this.heldHotkey?.keys.includes(parsed.alt) === true;
        if (this.heldHotkey && !sameAltAlreadyHeld) await this.releaseHeldHotkeys("new alt-tab");

        let pressedNewAlt = false;
        const transientDown: string[] = [];
        try {
            if (!sameAltAlreadyHeld) {
                await this.key(parsed.alt, true);
                pressedNewAlt = true;
            }
            for (const c of parsed.transient) {
                await this.key(c, true);
                transientDown.push(c);
            }
            await sleep(50);
            await this.key(TAB_CODE, true);
            await sleep(60);
            await this.key(TAB_CODE, false);
        } catch (e) {
            for (const c of [...transientDown].reverse()) await this.key(c, false).catch(() => {});
            if (pressedNewAlt) await this.key(parsed.alt, false).catch(() => {});
            throw e;
        }

        for (const c of [...transientDown].reverse()) await this.key(c, false).catch(() => {});
        this.rememberHeldHotkey([parsed.alt]);
        this.onAgentInput?.({ key: codes.join("+") });
    }

    /** Press and release a single key (with its modifiers as a code list). */
    async pressKey(code: string): Promise<void> {
        await this.releaseHeldHotkeys("before key");
        await this.key(code, true);
        await sleep(40);
        await this.key(code, false);
        this.onAgentInput?.({ key: code });
    }

    /** Hold a single key down WITHOUT releasing — for a modifier held across a mouse
     *  action (e.g. shift-click range-select, ctrl-click multi-select). Always pair
     *  with keyUp in a finally. */
    async keyDown(code: string): Promise<void> {
        await this.key(code, true);
    }
    /** Release a key held with keyDown. */
    async keyUp(code: string): Promise<void> {
        await this.key(code, false);
    }

    /** Hold several keys down in order, then release in reverse (a chord). */
    async hotkey(codes: string[]): Promise<void> {
        if (isAltTabPeekHotkey(codes)) {
            await this.altTabPeek(codes);
            return;
        }
        await this.releaseHeldHotkeys("before hotkey");
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

    /** Set the target keyboard layout (so symbols map to the right physical keys).
     *  source "user" (default) pins it so the keymap auto-seed won't override; pass
     *  source "auto" when applying a saved default so the Pi's actual keymap can refine it. */
    setLayout(layout: "us" | "uk", opts: { source?: "user" | "auto" } = {}): void {
        if (opts.source !== "auto") this.layoutFromUser = true;
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
        await this.releaseHeldHotkeys("before typing");
        const { signal, onProgress, secret, ...typingOpts } = opts;
        const strokes = planTyping(text, {
            intensity: this.humanize,
            layout: this.layout,
            ...(this.wpm ? { wpm: this.wpm } : {}),
            ...typingOpts,
        });
        // If the target's Caps Lock LED is ON (from the HID WS), invert Shift for letters
        // so the output case is correct despite Caps Lock.
        compensateCapsLock(strokes, this.getCapsLock() === true);
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

    private emitMousePath(points: MousePathSample[]): void {
        if (!this.onMousePath || points.length < 2) return;
        try {
            this.onMousePath({ points, w: this.dims.width, h: this.dims.height });
        } catch {
            /* overlay errors never affect input */
        }
    }

    /** Move the cursor to a pixel coordinate using the WindMouse algorithm:
     *  gravity pulls toward the target while a random "wind" walk perturbs the
     *  path, giving an organic curved trajectory with a natural speed profile,
     *  subtle tremor and an off-centre landing. Runs in frame-pixel space (where
     *  WindMouse's force constants are tuned), then converts to HID units. */
    async moveMouse(px: number, py: number, opts: { signal?: AbortSignal; instant?: boolean } = {}): Promise<void> {
        await this.releaseHeldHotkeys("before mouse move");
        const tx = this.toNorm(px, this.dims.width);
        const ty = this.toNorm(py, this.dims.height);
        // Current position and the target, both as frame pixels.
        const start = { x: this.fromNorm(this.mouse.x, this.dims.width), y: this.fromNorm(this.mouse.y, this.dims.height) };
        const end = { x: px, y: py };

        if (opts.instant) {
            this.emitMousePath([
                { ...start, t: 0 },
                { ...end, t: 0 },
            ]);
            await this.sendMove(tx, ty);
            this.mouse = { x: tx, y: ty };
            return;
        }

        const dist = Math.hypot(end.x - start.x, end.y - start.y);
        if (dist < 2) {
            this.emitMousePath([
                { ...start, t: 0 },
                { ...end, t: 0 },
            ]);
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
        this.emitMousePath([
            ...samples.map((s) => ({ x: s.x, y: s.y, t: s.t })),
            { x: end.x, y: end.y, t: samples[samples.length - 1]?.t ?? 0 },
        ]);

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
        await this.releaseHeldHotkeys("before mouse button");
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
        await this.releaseHeldHotkeys("before scroll");
        const ticks = Math.max(1, Math.min(12, Math.round(Math.max(Math.abs(dx), Math.abs(dy)))));
        const sx = dx / ticks;
        const sy = dy / ticks;
        for (let i = 0; i < ticks; i++) {
            await this.send("mouse_wheel", { delta: { x: Math.round(sx) || (dx ? Math.sign(dx) : 0), y: Math.round(sy) || (dy ? Math.sign(dy) : 0) } });
            await sleep(18 + Math.random() * 22);
        }
    }

    dispose(): void {
        const held = this.heldHotkey;
        this.clearHeldHotkeyState();
        try {
            if (held && this.ws?.readyState === WebSocket.OPEN) {
                for (const c of [...held.keys].reverse()) {
                    this.ws.send(JSON.stringify({ event_type: "key", event: { key: c, state: false } }));
                }
            }
        } catch {
            /* ignore */
        }
        try {
            this.ws?.close();
        } catch {
            /* ignore */
        }
        this.ws = undefined;
        this.wsReady = undefined;
    }
}
