/**
 * The server's own link to the PiKVM.
 *
 * It holds the target (address and credentials) the reverse proxy forwards to, keeps the kvmd event socket
 * (`/api/ws`) so the host knows the HID state, and sends the idle jiggler's nudges. Everything an agent does to
 * the target goes through the Desk instead (src/server/agent/desk.ts, on @pikvm/kvm-engine).
 *
 * Mouse   : wss://<host>/api/ws  mouse_move (absolute, ±32767) / mouse_relative
 * State   : the same socket pushes `hid` and `streamer` events, cached here.
 */

import axios from "axios";
import { Agent as HttpsAgent } from "https";
import WebSocket from "ws";

export interface PiKvmCredentials {
    origin: string; // e.g. https://pikvm/  (may embed user:pass)
    username?: string;
    password?: string;
    /** Returns the PiKVM `auth_token` cookie value (from the logged-in session). */
    getCookie?: () => Promise<string | undefined> | string | undefined;
}

/** Default keep-awake nudge, in FRAME PIXELS. Big enough that the target OS registers
 *  a real pointer move (sub-pixel jogs are rounded away and never reset an idle
 *  timer), small enough to be barely visible if someone is watching. */
export const NUDGE_PX = 24;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------- *
 * KVMD state stream (/api/ws server→client events)
 *
 * KVMD pushes a full state bundle on connect, then deltas. We cache the HID state
 * (liveness, mouse mode, the Pi's own jiggler) and the streamer's native resolution.
 * -------------------------------------------------------------- */

export interface KvmdHidState {
    online?: boolean;
    busy?: boolean;
    /** null on some firmware = "unknown"; only an explicit false means detached. */
    connected?: boolean | null;
    keyboard?: { online?: boolean };
    mouse?: { online?: boolean; absolute?: boolean; outputs?: { active?: string; available?: string[] } };
    jiggler?: { enabled?: boolean; active?: boolean; interval?: number };
}
export interface KvmdState {
    hid?: KvmdHidState;
    streamer?: { source?: { resolution?: { width?: number; height?: number } } };
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

/** Merge one /api/ws event into the cached state. Pure + total: unknown events
 *  pass through unchanged so it can never throw on a frame shape we don't model. */
export function mergeKvmdEvent(prev: KvmdState, eventType: string, event: unknown): KvmdState {
    switch (eventType) {
        case "hid":
            return { ...prev, hid: deepMerge(prev.hid ?? {}, event) };
        case "streamer":
            return { ...prev, streamer: deepMerge(prev.streamer ?? {}, event) };
        default:
            return prev;
    }
}

export class PiKvmControl {
    private origin: URL;
    private user: string;
    private pass: string;
    private getCookie: PiKvmCredentials["getCookie"];
    private agent: HttpsAgent;
    private ws: WebSocket | undefined;
    private wsReady: Promise<void> | undefined;
    /** Last mouse position in normalized PiKVM units (−32768..32767). */
    private mouse = { x: 0, y: 0 };
    /** Cached KVMD state from the /api/ws stream. */
    private kvmdState: KvmdState = {};
    /** When any HID input was last sent from here (ms epoch) — for the idle jiggler. */
    private lastInputTs = 0;

    constructor(creds: PiKvmCredentials) {
        const u = new URL(creds.origin);
        this.user = creds.username ?? decodeURIComponent(u.username || "");
        this.pass = creds.password ?? decodeURIComponent(u.password || "");
        this.getCookie = creds.getCookie;
        u.username = "";
        u.password = "";
        u.pathname = "/";
        this.origin = u;
        // PiKVM ships a self-signed cert.
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
     * self-signed cert.
     */
    async proxyTarget(): Promise<{ origin: URL; headers: Record<string, string>; rejectUnauthorized: boolean }> {
        return { origin: this.origin, headers: await this.headers(), rejectUnauthorized: false };
    }

    /* -------------------------------------------------------------- *
     * Event socket
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
                }
            });
            // Binary ping frames / non-JSON are swallowed so they can never throw.
            ws.on("message", (raw: WebSocket.RawData) => {
                let msg: { event_type?: string; event?: unknown };
                try {
                    msg = JSON.parse(raw.toString());
                } catch {
                    return;
                }
                if (msg && typeof msg.event_type === "string") {
                    this.kvmdState = mergeKvmdEvent(this.kvmdState, msg.event_type, msg.event);
                }
            });
        });
        return this.wsReady;
    }

    /** Current cached HID state (online/mouse-mode/busy), or undefined if not seen. */
    getHidState(): KvmdHidState | undefined {
        return this.kvmdState.hid;
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

    /** Is the HID actually attached to the target? undefined = unknown (treat as allow);
     *  false = definitely detached (keystrokes would be lost). */
    isHidOnline(): boolean | undefined {
        const h = this.kvmdState.hid;
        if (!h) return undefined;
        if (h.connected === false) return false;
        if (h.online === false || h.keyboard?.online === false) return false;
        if (h.online === true) return true;
        return undefined;
    }

    /* -------------------------------------------------------------- *
     * Mouse (the idle jiggler's nudge)
     * -------------------------------------------------------------- */

    private async send(event: string, payload: unknown): Promise<void> {
        await this.connect();
        this.lastInputTs = Date.now();
        this.ws!.send(JSON.stringify({ event_type: event, event: payload }));
    }

    lastInputAt(): number {
        return this.lastInputTs;
    }

    /** The target's screen as the Pi last said it; undefined until the event socket has told us. */
    getResolution(): { width: number; height: number } | undefined {
        const { width, height } = this.kvmdState.streamer?.source?.resolution ?? {};
        return width && height ? { width, height } : undefined;
    }

    private lastWarmAt = 0;

    /**
     * Start the event socket if it is not up, so the mouse mode and the resolution are known when something asks. Tried at
     * most every few seconds: it is called on every mouse event, and a Pi that is down must not be dialled that often.
     */
    warm(): void {
        if (this.ws?.readyState === WebSocket.OPEN || this.wsReady) return;
        const now = Date.now();
        if (now - this.lastWarmAt < 5_000) return;
        this.lastWarmAt = now;
        this.connect().catch(() => undefined);
    }

    /** The native frame width the nudge is measured against. */
    private frameWidth(): number {
        return this.kvmdState.streamer?.source?.resolution?.width || 1920;
    }

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

    /** A RELATIVE mouse nudge (delta in HID units). */
    private async mouseRelative(dx: number, dy: number): Promise<void> {
        await this.send("mouse_relative", { delta: { x: Math.round(dx), y: Math.round(dy) }, squash: true });
    }

    /** Adopt a cursor position observed on the PROXIED HID stream (the user's own
     *  client driving the Pi), or left by the agent. Without this our idea of the cursor
     *  would be stale and a keep-awake nudge would teleport the pointer instead of netting
     *  back to zero. Coordinates are PiKVM normalized units (−32768..32767). */
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
     *  `px` is in FRAME PIXELS, not HID units: a raw 10 in the normalized ±32767 space is
     *  0.3 of a pixel on a 1920-wide target, which the target rounds away and sleeps anyway. */
    async mouseNudge(px = NUDGE_PX): Promise<void> {
        const d = Math.max(1, Math.round(px));
        if (this.getMouseMode() === "relative") {
            await this.mouseRelative(d, 0);
            await sleep(160);
            await this.mouseRelative(-d, 0);
            return;
        }
        const { x, y } = this.mouse;
        const width = this.frameWidth();
        // Pixels → normalized units, then jog INWARD so a cursor parked on the right
        // edge still travels the full distance instead of being clamped to a no-op.
        const step = this.toNorm(d, width) - this.toNorm(0, width);
        await this.sendMove(this.clampNorm(x + (x > 0 ? -step : step)), y);
        await sleep(160);
        await this.sendMove(x, y);
    }

    /**
     * Point at another PiKVM, or sign in differently, without restarting. The proxy reads the target on
     * every request, so HTTP follows at once; the event socket is closed so the next use reconnects to the
     * new origin. Anything the browser holds open through the proxy (the video, the HID socket) belongs to
     * the old target until the page reloads.
     */
    setTarget(target: { origin: string; username: string; password: string }): void {
        const u = new URL(target.origin);
        u.username = "";
        u.password = "";
        u.pathname = "/";
        this.origin = u;
        this.user = target.username;
        this.pass = target.password;
        this.kvmdState = {};
        try {
            this.ws?.close();
        } catch {
            /* already closed */
        }
        this.ws = undefined;
        this.wsReady = undefined;
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
