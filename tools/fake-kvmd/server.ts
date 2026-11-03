// A kvmd simulator for end-to-end tests. It speaks just enough of kvmd's HTTP and
// WebSocket API for the console (and the control core) to run against it, records
// every HID message it receives, and has a /__fake control API so a test can read
// that record and push events at connected clients. Nothing here touches a PiKVM.
//
// Run:  node --experimental-strip-types --disable-warning=ExperimentalWarning tools/fake-kvmd/server.ts
//
// Only erasable TypeScript is used (no enums, no parameter properties), so Node can
// strip the types without a build step.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { CHANGED_JPEG, FRAME_HEIGHT, FRAME_JPEG, FRAME_WIDTH } from "./frame.ts";

type Json = Record<string, unknown>;

/** Largest request body kept verbatim in the request log; bigger ones (MSD uploads) log only a length. */
const BODY_LOG_LIMIT = 64 * 1024;
const MJPEG_BOUNDARY = "boundarydonotcross";
const MJPEG_FRAME_MS = 100;

/** The HID message types the console sends over /api/ws; these (and only these) go in /__fake/hid. */
const HID_TYPES = new Set(["key", "mouse_move", "mouse_button", "mouse_wheel", "mouse_relative"]);

export interface FakeKvmdOptions {
    /** TCP port; 0 picks a free one. */
    port?: number;
    host?: string;
}

export interface FakeKvmd {
    port: number;
    url: string;
    close(): Promise<void>;
}

interface HidRecord {
    seq: number;
    /** Epoch milliseconds, for correlating with other logs. */
    ts: number;
    /** Milliseconds since the server started (monotonic, sub-ms precision), for measuring gaps between inputs. */
    t: number;
    client: number;
    event_type: string;
    event: unknown;
}

interface PrintRecord {
    seq: number;
    ts: number;
    t: number;
    text: string;
    limit: string | null;
    delay: string | null;
    keymap: string | null;
}

interface MessageRecord {
    seq: number;
    ts: number;
    t: number;
    client: number;
    /** The raw text frame, or "<binary N bytes>". */
    raw: string;
}

interface RequestRecord {
    seq: number;
    ts: number;
    t: number;
    method: string;
    path: string;
    query: Record<string, string>;
    contentType: string | null;
    /** Text body, or null when it was empty or too large to keep (see bodyLength). */
    body: string | null;
    bodyLength: number;
    /** The X-KVMD-User header, so a test can see that credentials reached the Pi. The password is never kept. */
    authUser: string | null;
}

class HttpError extends Error {
    status: number;
    kind: string;
    constructor(status: number, kind: string, message: string) {
        super(message);
        this.status = status;
        this.kind = kind;
    }
}

/** The state a real kvmd would hold. Rebuilt wholesale by /__fake/reset. */
function freshState() {
    return {
        keyboard: { online: true, leds: { caps: false, scroll: false, num: false } },
        mouse: { online: true, absolute: true, active: "usb" as "usb" | "usb_rel" },
        hid: { online: true, busy: false, connected: true as boolean | null },
        jiggler: { enabled: true, active: false, interval: 60 },
        keysDown: new Set<string>(),
        buttonsDown: new Set<string>(),
        // A map of name -> details, as kvmd sends it (console.js fillKeymaps records
        // that a list of names broke the picker once); the console reads the keys.
        keymaps: { default: "en-us", available: { "en-us": {}, "en-gb": {}, de: {}, fr: {} } as Record<string, object> },
        source: { online: true, width: FRAME_WIDTH, height: FRAME_HEIGHT },
        /** Which picture the streamer serves: the colour bars, a window-sized change, or (snapshots only) the two alternating. */
        picture: "bars" as "bars" | "changed" | "flicker",
        streamerApplied: {
            quality: 80,
            desired_fps: 30,
            resolution: `${FRAME_WIDTH}x${FRAME_HEIGHT}`,
            h264_bitrate: 5000,
            h264_gop: 30,
        } as Record<string, number | string>,
        atx: { enabled: true, busy: false, leds: { power: true, hdd: false } },
        msd: {
            enabled: true,
            online: true,
            busy: false,
            drive: { image: null as string | null, cdrom: true, rw: false, connected: false },
            images: {} as Record<string, { size: number; complete: boolean; mod_ts: number }>,
        },
        gpio: { relay0: { state: false, busy: false } } as Record<string, { state: boolean; busy: boolean }>,
        ocr: {
            enabled: true,
            langs: { default: ["eng"], available: ["eng", "deu", "fra"] },
            /** What an `ocr=1` snapshot answers; a test sets it with POST /__fake/ocr. */
            text: "FAKE KVMD TEST PATTERN\n",
        },
    };
}

type State = ReturnType<typeof freshState>;

export async function startFakeKvmd(options: FakeKvmdOptions = {}): Promise<FakeKvmd> {
    const startedAt = performance.now();
    const now = () => ({ ts: Date.now(), t: Math.round((performance.now() - startedAt) * 1000) / 1000 });

    let state: State = freshState();
    let seq = 0;
    let hidLog: HidRecord[] = [];
    let printLog: PrintRecord[] = [];
    let messageLog: MessageRecord[] = [];
    let requestLog: RequestRecord[] = [];

    let nextClientId = 1;
    /** The X-KVMD-User each /api/ws upgrade carried, in order (null when absent). */
    const wsAuthUsers: (string | null)[] = [];
    const clients = new Map<WebSocket, number>();
    const streams = new Set<ServerResponse>();
    /** While in the future, new /api/ws upgrades are refused (see POST /__fake/drop?refuse_ms=). */
    let refuseUntil = 0;

    // ---- kvmd event payloads -------------------------------------------------

    const hidEvent = (): Json => ({
        online: state.hid.online,
        busy: state.hid.busy,
        connected: state.hid.connected,
        keyboard: {
            online: state.keyboard.online,
            leds: { ...state.keyboard.leds },
            outputs: { available: ["usb"], active: "usb" },
        },
        mouse: {
            online: state.mouse.online,
            absolute: state.mouse.absolute,
            outputs: { available: ["usb", "usb_rel"], active: state.mouse.active },
        },
        jiggler: { ...state.jiggler },
    });
    const keymapsEvent = (): Json => ({ keymaps: { ...state.keymaps, available: { ...state.keymaps.available } } });
    const streamerEvent = (): Json => ({
        features: { quality: true, resolution: true, h264: true, zero_delay: false },
        limits: {
            desired_fps: { min: 0, max: 70 },
            h264_bitrate: { min: 25, max: 20000 },
            h264_gop: { min: 0, max: 60 },
            available_resolutions: [`${FRAME_WIDTH}x${FRAME_HEIGHT}`, "640x360", "1280x720", "1920x1080"],
        },
        // Current kvmd calls this "params"; the console reads "applied". Both carry the same values.
        params: { ...state.streamerApplied },
        applied: { ...state.streamerApplied },
        streamer: {
            source: {
                online: state.source.online,
                resolution: { width: state.source.width, height: state.source.height },
                desired_fps: Number(state.streamerApplied.desired_fps),
                captured_fps: state.source.online ? Number(state.streamerApplied.desired_fps) : 0,
            },
            encoder: { type: "CPU", quality: Number(state.streamerApplied.quality) },
        },
    });
    const infoEvent = (): Json => ({
        health: {
            throttling: {
                raw_flags: 0,
                parsed_flags: {
                    undervoltage: { now: false, past: false },
                    freq_capped: { now: false, past: false },
                    throttled: { now: false, past: false },
                },
                ignore_past: false,
            },
            temp: { cpu: 45.1, gpu: 45.1 },
        },
        fan: { monitored: false, state: null },
        system: {
            kvmd: { version: "4.0-fake" },
            streamer: { app: "ustreamer", version: "6.0-fake", features: { H264: true } },
            kernel: { system: "Linux", release: "fake", version: "#1 fake", machine: "aarch64" },
        },
        node: { hostname: "fake-kvmd" },
    });
    const atxEvent = (): Json => ({ enabled: state.atx.enabled, busy: state.atx.busy, leds: { ...state.atx.leds } });
    const msdEvent = (): Json => ({
        enabled: state.msd.enabled,
        online: state.msd.online,
        busy: state.msd.busy,
        drive: { ...state.msd.drive },
        storage: {
            parts: { "": { size: 8 * 1024 ** 3, free: 7 * 1024 ** 3, writable: true } },
            images: structuredClone(state.msd.images),
            uploading: null,
            downloading: null,
        },
    });
    const gpioEvent = (): Json => ({
        model: {
            scheme: {
                inputs: {},
                outputs: {
                    relay0: { switch: true, pulse: { delay: 0.1, min_delay: 0, max_delay: 10 }, hidden: false },
                },
            },
            view: { header: { title: "GPIO" }, table: [] },
        },
        state: {
            inputs: {},
            outputs: Object.fromEntries(
                Object.entries(state.gpio).map(([name, o]) => [name, { online: true, state: o.state, busy: o.busy }]),
            ),
        },
    });
    const ocrEvent = (): Json => ({ enabled: state.ocr.enabled, langs: structuredClone(state.ocr.langs) });

    /** What a connecting client receives, in this order; "loop" last because it marks the bundle complete. */
    const initialEvents = (): [string, Json][] => [
        ["hid", hidEvent()],
        ["hid_keymaps", keymapsEvent()],
        ["streamer", streamerEvent()],
        ["info", infoEvent()],
        ["atx", atxEvent()],
        ["msd", msdEvent()],
        ["gpio", gpioEvent()],
        ["ocr", ocrEvent()],
        ["loop", {}],
    ];

    // ---- websocket plumbing --------------------------------------------------

    const frame = (eventType: string, event: unknown) => JSON.stringify({ event_type: eventType, event });
    const broadcast = (eventType: string, event: unknown) => {
        const text = frame(eventType, event);
        for (const ws of clients.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(text);
    };

    const wss = new WebSocketServer({ noServer: true });

    /** Apply a key press the way a target's keyboard would: lock keys flip an LED, which kvmd then reports. */
    const applyKey = (key: string, down: boolean) => {
        if (down) state.keysDown.add(key);
        else state.keysDown.delete(key);
        if (!down) return;
        const led = key === "CapsLock" ? "caps" : key === "ScrollLock" ? "scroll" : key === "NumLock" ? "num" : null;
        if (!led) return;
        state.keyboard.leds[led] = !state.keyboard.leds[led];
        broadcast("hid", { keyboard: { leds: { ...state.keyboard.leds } } });
    };

    const onClientMessage = (ws: WebSocket, id: number, data: Buffer, isBinary: boolean) => {
        const stamp = now();
        const raw = isBinary ? `<binary ${data.length} bytes>` : data.toString("utf8");
        messageLog.push({ seq: ++seq, ...stamp, client: id, raw });
        if (isBinary) return;

        // kvmd answers a bare "ping" text frame as well as the JSON form.
        if (raw === "ping") {
            ws.send("pong");
            return;
        }
        let msg: { event_type?: unknown; event?: unknown };
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }
        const type = typeof msg.event_type === "string" ? msg.event_type : "";
        if (type === "ping") {
            ws.send(frame("pong", {}));
            return;
        }
        if (!HID_TYPES.has(type)) return;
        hidLog.push({ seq: ++seq, ...stamp, client: id, event_type: type, event: msg.event });
        const ev = (msg.event ?? {}) as Json;
        if (type === "key" && typeof ev.key === "string") applyKey(ev.key, !!ev.state);
        if (type === "mouse_button" && typeof ev.button === "string") {
            if (ev.state) state.buttonsDown.add(ev.button);
            else state.buttonsDown.delete(ev.button);
        }
    };

    wss.on("connection", (ws: WebSocket) => {
        const id = nextClientId++;
        clients.set(ws, id);
        ws.on("message", (data: Buffer, isBinary: boolean) => onClientMessage(ws, id, data, isBinary));
        ws.on("close", () => clients.delete(ws));
        ws.on("error", () => {});
        for (const [type, event] of initialEvents()) ws.send(frame(type, event));
    });

    // ---- http helpers --------------------------------------------------------

    const send = (res: ServerResponse, status: number, body: string | Buffer, type: string) => {
        res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
        res.end(body);
    };
    const json = (res: ServerResponse, status: number, body: unknown) =>
        send(res, status, JSON.stringify(body), "application/json");
    /** kvmd's success envelope. */
    const okJson = (res: ServerResponse, result: unknown = {}) => json(res, 200, { ok: true, result });
    /** kvmd's error envelope. */
    const errJson = (res: ServerResponse, status: number, kind: string, message: string) =>
        json(res, status, { ok: false, result: { error: kind, error_msg: message } });

    const readBody = (req: IncomingMessage): Promise<Buffer> =>
        new Promise((done, fail) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => done(Buffer.concat(chunks)));
            req.on("error", fail);
        });

    const flag = (q: URLSearchParams, name: string): boolean => {
        const v = q.get(name);
        if (v === null) throw new HttpError(400, "ValidatorError", `Missing argument: ${name}`);
        if (["1", "true", "yes", "on"].includes(v.toLowerCase())) return true;
        if (["0", "false", "no", "off"].includes(v.toLowerCase())) return false;
        throw new HttpError(400, "ValidatorError", `Invalid ${name}: ${v}`);
    };

    const requireMethod = (req: IncomingMessage, method: string) => {
        if (req.method !== method) throw new HttpError(405, "MethodNotAllowed", `${req.method} not allowed here`);
    };

    // ---- video ---------------------------------------------------------------

    const currentFrame = (): Buffer => (state.picture === "changed" ? CHANGED_JPEG : FRAME_JPEG);
    let flicker = false;
    /** One snapshot's picture: under `flicker` it differs from the one before, so the screen never settles. */
    const snapshotFrame = (): Buffer => {
        if (state.picture !== "flicker") return currentFrame();
        flicker = !flicker;
        return flicker ? CHANGED_JPEG : FRAME_JPEG;
    };

    const serveMjpeg = (req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, {
            "Content-Type": `multipart/x-mixed-replace;boundary=${MJPEG_BOUNDARY}`,
            "Cache-Control": "no-store, no-cache, must-revalidate",
            Pragma: "no-cache",
            Connection: "close",
        });
        streams.add(res);
        const write = () => {
            res.write(
                `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${currentFrame().length}\r\n` +
                    `X-Timestamp: ${(Date.now() / 1000).toFixed(6)}\r\n\r\n`,
            );
            res.write(currentFrame());
            res.write("\r\n");
        };
        write();
        const timer = setInterval(write, MJPEG_FRAME_MS);
        const stop = () => {
            clearInterval(timer);
            streams.delete(res);
        };
        req.on("close", stop);
        res.on("close", stop);
    };

    const serveSnapshot = (res: ServerResponse, q: URLSearchParams) => {
        if (!state.source.online && q.get("allow_offline") !== "1") {
            throw new HttpError(503, "UnavailableError", "Streamer source is offline");
        }
        if (q.get("ocr") === "1") {
            if (!state.ocr.enabled) throw new HttpError(503, "UnavailableError", "OCR is disabled");
            send(res, 200, state.ocr.text, "text/plain; charset=utf-8");
            return;
        }
        const picture = snapshotFrame();
        res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": picture.length,
            "Cache-Control": "no-store",
            "X-UStreamer-Online": String(state.source.online),
            "X-UStreamer-Width": String(state.source.width),
            "X-UStreamer-Height": String(state.source.height),
        });
        res.end(picture);
    };

    // ---- kvmd routes ---------------------------------------------------------

    const kvmdRoute = async (req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams, body: Buffer) => {
        const get = req.method === "GET" || req.method === "HEAD";
        switch (path) {
            case "/streamer/stream":
                requireMethod(req, "GET");
                serveMjpeg(req, res);
                return;
            case "/streamer/snapshot":
            case "/api/streamer/snapshot":
                requireMethod(req, "GET");
                serveSnapshot(res, q);
                return;
            case "/streamer/state":
                requireMethod(req, "GET");
                okJson(res, {
                    source: {
                        online: state.source.online,
                        resolution: { width: state.source.width, height: state.source.height },
                        desired_fps: Number(state.streamerApplied.desired_fps),
                        captured_fps: state.source.online ? Number(state.streamerApplied.desired_fps) : 0,
                    },
                    stream: { clients: streams.size, clients_stat: {}, queue_fps: 0 },
                });
                return;
            case "/janus/ws":
                // No WebRTC here: refusing is what sends the console back to MJPEG.
                send(res, 503, "Janus is not available in fake-kvmd", "text/plain; charset=utf-8");
                return;

            case "/api/auth/check":
                okJson(res);
                return;
            case "/api/info":
                requireMethod(req, "GET");
                {
                    const info = infoEvent();
                    okJson(res, {
                        extras: {},
                        hw: { health: info.health, platform: { type: "rpi", base: "fake" } },
                        fan: info.fan,
                        meta: { server: { host: "fake-kvmd" } },
                        system: info.system,
                    });
                }
                return;
            case "/api/log":
                requireMethod(req, "GET");
                send(
                    res,
                    200,
                    "Nov 02 00:00:00 fake-kvmd kvmd[1]: INFO --- fake kvmd started\n" +
                        "Nov 02 00:00:01 fake-kvmd kvmd[1]: INFO --- HID: ready\n",
                    "text/plain; charset=utf-8",
                );
                return;

            // --- HID ---
            case "/api/hid":
                requireMethod(req, "GET");
                okJson(res, hidEvent());
                return;
            case "/api/hid/keymaps":
                requireMethod(req, "GET");
                okJson(res, { keymaps: { default: state.keymaps.default, available: { ...state.keymaps.available } } });
                return;
            case "/api/hid/set_params": {
                requireMethod(req, "POST");
                const delta: Json = {};
                const output = q.get("mouse_output");
                if (output !== null) {
                    if (output !== "usb" && output !== "usb_rel") {
                        throw new HttpError(400, "ValidatorError", `Invalid mouse_output: ${output}`);
                    }
                    if (output !== state.mouse.active) {
                        state.mouse.active = output;
                        state.mouse.absolute = output === "usb";
                        delta.mouse = {
                            absolute: state.mouse.absolute,
                            outputs: { available: ["usb", "usb_rel"], active: output },
                        };
                    }
                }
                if (q.has("jiggler")) {
                    state.jiggler.active = flag(q, "jiggler");
                    delta.jiggler = { ...state.jiggler };
                }
                if (Object.keys(delta).length) broadcast("hid", delta);
                okJson(res);
                return;
            }
            case "/api/hid/set_connected":
                requireMethod(req, "POST");
                state.hid.connected = flag(q, "connected");
                broadcast("hid", { connected: state.hid.connected });
                okJson(res);
                return;
            case "/api/hid/reset":
                requireMethod(req, "POST");
                state.keysDown.clear();
                state.buttonsDown.clear();
                okJson(res);
                return;
            case "/api/hid/print":
                requireMethod(req, "POST");
                printLog.push({
                    seq: ++seq,
                    ...now(),
                    text: body.toString("utf8"),
                    limit: q.get("limit"),
                    delay: q.get("delay"),
                    keymap: q.get("keymap"),
                });
                okJson(res);
                return;

            // --- streamer ---
            case "/api/streamer":
                requireMethod(req, "GET");
                okJson(res, streamerEvent());
                return;
            case "/api/streamer/set_params": {
                requireMethod(req, "POST");
                if (![...q.keys()].length) throw new HttpError(400, "ValidatorError", "No parameters");
                for (const [k, v] of q) {
                    if (!(k in state.streamerApplied)) throw new HttpError(400, "ValidatorError", `Unknown parameter: ${k}`);
                    state.streamerApplied[k] = typeof state.streamerApplied[k] === "number" ? Number(v) : v;
                }
                broadcast("streamer", streamerEvent());
                okJson(res);
                return;
            }
            case "/api/streamer/reset":
                requireMethod(req, "POST");
                broadcast("streamer", streamerEvent());
                okJson(res);
                return;

            // --- ATX ---
            case "/api/atx":
                requireMethod(req, "GET");
                okJson(res, { enabled: state.atx.enabled, busy: state.atx.busy, leds: state.atx.leds });
                return;
            case "/api/atx/click": {
                requireMethod(req, "POST");
                const button = q.get("button");
                if (button !== "power" && button !== "power_long" && button !== "reset") {
                    throw new HttpError(400, "ValidatorError", `Invalid button: ${button}`);
                }
                // A short power press toggles the target; a long one or reset leaves it on a known side.
                if (button === "power") state.atx.leds.power = !state.atx.leds.power;
                if (button === "power_long") state.atx.leds.power = false;
                broadcast("atx", atxEvent());
                okJson(res);
                return;
            }

            // --- mass storage ---
            case "/api/msd":
                requireMethod(req, "GET");
                okJson(res, msdEvent());
                return;
            case "/api/msd/set_params": {
                requireMethod(req, "POST");
                const image = q.get("image");
                if (image !== null) {
                    if (image && !state.msd.images[image]) throw new HttpError(404, "MsdUnknownImageError", `Unknown image: ${image}`);
                    state.msd.drive.image = image || null;
                }
                if (q.has("cdrom")) state.msd.drive.cdrom = flag(q, "cdrom");
                if (q.has("rw")) state.msd.drive.rw = flag(q, "rw");
                broadcast("msd", msdEvent());
                okJson(res);
                return;
            }
            case "/api/msd/set_connected": {
                requireMethod(req, "POST");
                const connected = flag(q, "connected");
                if (connected && !state.msd.drive.image) {
                    throw new HttpError(409, "MsdImageNotSelectedError", "Image is not selected");
                }
                state.msd.drive.connected = connected;
                broadcast("msd", msdEvent());
                okJson(res);
                return;
            }
            case "/api/msd/write": {
                requireMethod(req, "POST");
                const image = q.get("image");
                if (!image) throw new HttpError(400, "ValidatorError", "Missing argument: image");
                state.msd.images[image] = { size: body.length, complete: true, mod_ts: Date.now() / 1000 };
                broadcast("msd", msdEvent());
                okJson(res);
                return;
            }
            case "/api/msd/write_remote": {
                requireMethod(req, "POST");
                const url = q.get("url");
                if (!url) throw new HttpError(400, "ValidatorError", "Missing argument: url");
                const name = q.get("image") || decodeURIComponent(url.split("?")[0]!.split("/").pop() || "remote.iso");
                state.msd.images[name] = { size: 0, complete: true, mod_ts: Date.now() / 1000 };
                broadcast("msd", msdEvent());
                okJson(res, { image: name });
                return;
            }
            case "/api/msd/remove": {
                requireMethod(req, "POST");
                const image = q.get("image");
                if (!image || !state.msd.images[image]) throw new HttpError(404, "MsdUnknownImageError", `Unknown image: ${image}`);
                delete state.msd.images[image];
                if (state.msd.drive.image === image) state.msd.drive = { ...state.msd.drive, image: null, connected: false };
                broadcast("msd", msdEvent());
                okJson(res);
                return;
            }
            case "/api/msd/reset":
                requireMethod(req, "POST");
                state.msd.drive = { image: null, cdrom: true, rw: false, connected: false };
                broadcast("msd", msdEvent());
                okJson(res);
                return;

            // --- GPIO ---
            case "/api/gpio":
                requireMethod(req, "GET");
                okJson(res, gpioEvent());
                return;
            case "/api/gpio/switch": {
                requireMethod(req, "POST");
                const channel = q.get("channel") ?? "";
                const out = state.gpio[channel];
                if (!out) throw new HttpError(400, "GpioChannelNotFoundError", `Unknown channel: ${channel}`);
                out.state = flag(q, "state");
                broadcast("gpio", gpioEvent());
                okJson(res);
                return;
            }
            case "/api/gpio/pulse": {
                requireMethod(req, "POST");
                const channel = q.get("channel") ?? "";
                if (!state.gpio[channel]) throw new HttpError(400, "GpioChannelNotFoundError", `Unknown channel: ${channel}`);
                okJson(res);
                return;
            }
        }
        if (get && path.startsWith("/api/")) throw new HttpError(404, "NotFoundError", `Not implemented by fake-kvmd: ${path}`);
        throw new HttpError(404, "NotFoundError", `No such route: ${req.method} ${path}`);
    };

    // ---- control API ---------------------------------------------------------

    const control = async (req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams, body: Buffer) => {
        const since = Number(q.get("since") ?? 0) || 0;
        switch (path) {
            case "/__fake/hid": {
                requireMethod(req, "GET");
                const type = q.get("type");
                json(res, 200, {
                    events: hidLog.filter((e) => e.seq > since && (!type || e.event_type === type)),
                    prints: printLog.filter((p) => p.seq > since),
                    state: stateView(),
                });
                return;
            }
            case "/__fake/messages":
                requireMethod(req, "GET");
                json(res, 200, { messages: messageLog.filter((m) => m.seq > since) });
                return;
            case "/__fake/requests":
                requireMethod(req, "GET");
                json(res, 200, { requests: requestLog.filter((r) => r.seq > since) });
                return;
            case "/__fake/state":
                requireMethod(req, "GET");
                json(res, 200, stateView());
                return;
            case "/__fake/reset":
                requireMethod(req, "POST");
                state = freshState();
                hidLog = [];
                printLog = [];
                messageLog = [];
                requestLog = [];
                seq = 0;
                refuseUntil = 0;
                wsAuthUsers.length = 0;
                // Clients stay connected; give them the clean state so they do not keep a stale LED.
                broadcast("hid", hidEvent());
                broadcast("streamer", streamerEvent());
                broadcast("atx", atxEvent());
                broadcast("msd", msdEvent());
                broadcast("gpio", gpioEvent());
                json(res, 200, { ok: true });
                return;
            case "/__fake/event": {
                requireMethod(req, "POST");
                let msg: { event_type?: unknown; event?: unknown };
                try {
                    msg = JSON.parse(body.toString("utf8"));
                } catch {
                    throw new HttpError(400, "ValidatorError", "Body must be JSON: {event_type, event}");
                }
                if (typeof msg.event_type !== "string" || !msg.event_type) {
                    throw new HttpError(400, "ValidatorError", "event_type must be a non-empty string");
                }
                broadcast(msg.event_type, msg.event ?? {});
                json(res, 200, { ok: true, clients: clients.size });
                return;
            }
            case "/__fake/drop": {
                requireMethod(req, "POST");
                const graceful = q.get("graceful") === "1";
                const refuseMs = Number(q.get("refuse_ms") ?? 0) || 0;
                if (refuseMs > 0) refuseUntil = Date.now() + refuseMs;
                const dropped = clients.size;
                for (const ws of clients.keys()) {
                    if (graceful) ws.close(1001, "fake-kvmd drop");
                    else ws.terminate();
                }
                json(res, 200, { ok: true, dropped });
                return;
            }
            case "/__fake/picture": {
                requireMethod(req, "POST");
                const name = q.get("name");
                if (name !== "bars" && name !== "changed" && name !== "flicker") {
                    throw new HttpError(400, "ValidatorError", "name must be bars, changed or flicker");
                }
                state.picture = name;
                json(res, 200, { ok: true, picture: name });
                return;
            }
            case "/__fake/source":
                requireMethod(req, "POST");
                state.source.online = flag(q, "online");
                broadcast("streamer", streamerEvent());
                json(res, 200, { ok: true, online: state.source.online });
                return;
            case "/__fake/resolution": {
                requireMethod(req, "POST");
                const width = Number(q.get("width"));
                const height = Number(q.get("height"));
                if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
                    throw new HttpError(400, "ValidatorError", "width and height must be positive integers");
                }
                // The served JPEG keeps its own size; the headers and events are what a client reads.
                state.source.width = width;
                state.source.height = height;
                state.streamerApplied.resolution = `${width}x${height}`;
                broadcast("streamer", streamerEvent());
                json(res, 200, { ok: true, width, height });
                return;
            }
            case "/__fake/ocr": {
                requireMethod(req, "POST");
                if (q.has("enabled")) state.ocr.enabled = flag(q, "enabled");
                if (body.length) state.ocr.text = body.toString("utf8");
                broadcast("ocr", ocrEvent());
                json(res, 200, { ok: true, enabled: state.ocr.enabled });
                return;
            }
            case "/__fake/keymap": {
                requireMethod(req, "POST");
                const name = q.get("name") ?? "";
                if (!(name in state.keymaps.available)) throw new HttpError(400, "ValidatorError", `Unknown keymap: ${name}`);
                state.keymaps.default = name;
                broadcast("hid_keymaps", keymapsEvent());
                json(res, 200, { ok: true, keymap: name });
                return;
            }
        }
        throw new HttpError(404, "NotFoundError", `No such control route: ${req.method} ${path}`);
    };

    const stateView = () => ({
        clients: clients.size,
        wsAuthUsers: [...wsAuthUsers],
        streams: streams.size,
        caps: state.keyboard.leds.caps,
        leds: { ...state.keyboard.leds },
        mouse: { absolute: state.mouse.absolute, output: state.mouse.active },
        hid: { ...state.hid },
        jiggler: { ...state.jiggler },
        keysDown: [...state.keysDown],
        buttonsDown: [...state.buttonsDown],
        source: { ...state.source },
        streamer: { ...state.streamerApplied },
        atx: { ...state.atx, leds: { ...state.atx.leds } },
        msd: { drive: { ...state.msd.drive }, images: Object.keys(state.msd.images) },
        gpio: structuredClone(state.gpio),
    });

    // ---- server --------------------------------------------------------------

    const server: Server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://fake-kvmd");
        const path = url.pathname;
        try {
            const body = req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
            if (path.startsWith("/__fake/")) {
                await control(req, res, path, url.searchParams, body);
                return;
            }
            // kvmd's auth headers (X-KVMD-User, Cookie, Authorization) are accepted and ignored.
            requestLog.push({
                seq: ++seq,
                ...now(),
                method: req.method ?? "GET",
                path,
                query: Object.fromEntries(url.searchParams),
                contentType: req.headers["content-type"] ?? null,
                body: body.length && body.length <= BODY_LOG_LIMIT ? body.toString("utf8") : null,
                bodyLength: body.length,
                authUser: typeof req.headers["x-kvmd-user"] === "string" ? req.headers["x-kvmd-user"] : null,
            });
            await kvmdRoute(req, res, path, url.searchParams, body);
        } catch (e) {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            if (e instanceof HttpError) errJson(res, e.status, e.kind, e.message);
            else errJson(res, 500, "InternalError", e instanceof Error ? e.message : String(e));
        }
    });

    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const path = new URL(req.url ?? "/", "http://fake-kvmd").pathname;
        const refuse = (status: string) => {
            socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
            socket.destroy();
        };
        if (path === "/api/ws") {
            if (Date.now() < refuseUntil) return refuse("503 Service Unavailable");
            wsAuthUsers.push(typeof req.headers["x-kvmd-user"] === "string" ? req.headers["x-kvmd-user"] : null);
            wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
            return;
        }
        // /janus/ws and anything else: refuse, so the console falls back to MJPEG.
        refuse(path === "/janus/ws" ? "503 Service Unavailable" : "404 Not Found");
    });

    await new Promise<void>((done, fail) => {
        server.once("error", fail);
        server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
            server.off("error", fail);
            done();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake-kvmd: no TCP address");
    const host = options.host ?? "127.0.0.1";

    return {
        port: address.port,
        url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
        close: () =>
            new Promise<void>((done) => {
                for (const ws of clients.keys()) ws.terminate();
                for (const res of streams) res.destroy();
                server.close(() => done());
                server.closeAllConnections();
            }),
    };
}

// ---- command line ----------------------------------------------------------

function argValue(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
    const port = Number(argValue("port") ?? process.env.PORT ?? 4510);
    const host = argValue("host") ?? process.env.HOST ?? "127.0.0.1";
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`fake-kvmd: invalid port ${port}`);
        process.exit(2);
    }
    const fake = await startFakeKvmd({ port, host });
    console.log(`fake-kvmd listening on ${fake.url}`);
    const stop = () => void fake.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
}
