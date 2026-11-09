import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import type { KeyboardLayout } from "@pikvm/contracts/api";
import {
    DeskError,
    type AgentActivity,
    type Desk,
    type DeskCall,
    type DeskSession,
    type FrameSize,
    type MouseButton,
    type Point,
    type Region,
    type ScreenInfo,
    type ScreenWatchReport,
    type Shot,
    type WaitResult,
} from "@pikvm/mcp";
import {
    AgentAbort,
    createAgentInput,
    insideFrame,
    LinkClosed,
    parseChord,
    pixelFrac,
    referenceSize,
    regionToNative,
    sameSize,
    UnmappableText,
    DEFAULT_MAX_EDGE,
    type AgentInput,
    type AgentTiming,
} from "@pikvm/kvm-engine/agent";
import { systemClock, createTargetLink, fracToNorm, type Clock, type HttpPort, type SocketFactory, type TargetLink } from "@pikvm/kvm-engine";
import { nodeSocket } from "@pikvm/kvm-engine/node";
import { FP_SETTLE, fpDiff } from "../../ambient/fingerprint";
import type { ImageOps } from "../../image-ops";
import type { ActivityStore } from "./activity";
import type { OperatorPresence } from "./presence";
import type { ScreenWaits, WaitView } from "../watch/screen-wait";
import { listenToTarget } from "./audio";

/**
 * The Desk: everything the agent does to the PiKVM, behind the one door the MCP server uses.
 *
 * It owns the agent's own link to kvmd (a separate socket from any person's browser, so the
 * agent's input never passes the proxy and the proxy sees only people), the screenshots, the
 * reference frame each conversation works in, and who holds control.
 *
 * Control, in one place:
 *  - A run is granted control when a person's message starts it (`beginRun`).
 *  - Any input a person sends through the proxy after that releases it, aborts the action in
 *    flight and lifts everything the agent held. Later calls answer `control_released`.
 *  - Control returns only by an explicit act: a new message (`beginRun`) or `handBack`. Moving
 *    the mouse back never re-grants it.
 *  - One run at a time holds the desk; another conversation is told so.
 *
 * The PiKVM's credentials arrive per request from `target()` and are used only to reach it; the
 * agent sees tool results and nothing else.
 */

/** Where the Pi is and how to authenticate, as `PiKvmControl.proxyTarget()` reports it. */
export interface DeskTarget {
    readonly origin: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly rejectUnauthorized: boolean;
}

export interface DeskOptions {
    target: () => Promise<DeskTarget>;
    /** Electron's nativeImage, or sharp on the web host. */
    images: ImageOps;
    /** The saved target layout, read for each text entry. kvmd's default keymap is not the target OS layout. */
    keyboardLayout: () => KeyboardLayout;
    presence: OperatorPresence;
    activity: ActivityStore;
    /** The long edge of the reference frame; read on every screenshot. */
    maxEdge?: () => number;
    /**
     * Told where the agent left the pointer, in kvmd units, and whether the Pi's mouse is absolute (there it is exact; on a
     * relative one the agent swept into the corner and stepped from there, so it is the agent's best account). The idle
     * jiggler returns to it and not to a stale spot, and every client's cursor moves to it.
     */
    onPointer?: (norm: Point, absolute: boolean) => void;
    clock?: Clock;
    now?: () => number;
    timing?: Partial<AgentTiming>;
    /** A run that has called no tool for this long loses control. */
    leaseMs?: number;
    /** The agent's socket to the Pi is closed this long after the last run ends. */
    linkIdleMs?: number;
    /** How long to wait for the Pi's socket and its first state. */
    connectMs?: number;
    /** Test seam: the socket factory the link uses. */
    socket?: SocketFactory;
    /**
     * The agent's screen waits (watch/screen-wait.ts), read at each call: the desk is made before the watch service it needs, and a host
     * with no watch has none. Absent, the three watch tools say they are not available here.
     */
    screenWaits?: () => ScreenWaits | undefined;
}

export interface RunLifecycle {
    /** A person's message started a run: grant it control. */
    beginRun(conversationId: string): void;
    /** The run ended or was stopped. */
    endRun(conversationId: string): void;
}

export interface AgentDesk extends Desk, RunLifecycle {
    /** Release control from one conversation, or every one: the person pressed Stop. */
    stop(conversationId?: string): void;
    /** Give control back to the runs a person took it from. Returns how many. */
    handBack(): number;
    /** Whether an agent run is using the PiKVM. The idle jiggler holds off while it is. */
    busy(): boolean;
    /** Free runs whose lease has run out. Called on a timer; exposed so a test need not wait. */
    sweepLeases(): void;
    dispose(): Promise<void>;
}

type ReleaseReason = "operator" | "stopped" | "lease_timeout";

const RELEASE_MESSAGE: Readonly<Record<ReleaseReason, string>> = {
    operator:
        "The person took over the mouse or keyboard, so control was taken from you. Stop what you are doing and ask them to hand control back. Do not try again until they do.",
    stopped: "The person pressed Stop. Stop what you are doing and wait for their next message.",
    lease_timeout:
        "Control timed out after a long silence, so it was taken back. Ask the person to send another message if you should continue.",
};

interface Run {
    grantedAt: number;
    abort: AbortController;
    released: ReleaseReason | null;
    /** The agent has used a desk tool in this run, so the KVM tab shows it working. */
    engaged: boolean;
    lastCallAt: number;
}

interface Frame {
    id: number;
    native: FrameSize;
    reference: FrameSize;
}

const DEFAULTS = {
    leaseMs: 10 * 60_000,
    linkIdleMs: 60_000,
    connectMs: 6000,
    settlePollMs: 300,
    snapshotTimeoutMs: 10_000,
    ocrTimeoutMs: 25_000,
    sweepMs: 15_000,
};

export interface KvmdResponse {
    readonly status: number;
    readonly headers: IncomingHttpHeaders;
    readonly body: Buffer;
}

export function kvmdRequest(
    target: DeskTarget,
    path: string,
    init: { method?: "GET" | "POST"; timeoutMs: number; signal?: AbortSignal; body?: string; contentType?: string },
): Promise<KvmdResponse> {
    const { promise, resolve, reject } = Promise.withResolvers<KvmdResponse>();
    const secure = target.origin.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;
    const headers: Record<string, string | number> = { ...target.headers, host: target.origin.host };
    if (init.body !== undefined) {
        headers["content-type"] = init.contentType ?? "text/plain";
        headers["content-length"] = Buffer.byteLength(init.body);
    }
    const req = send(
        {
            protocol: target.origin.protocol,
            hostname: target.origin.hostname,
            port: target.origin.port || (secure ? 443 : 80),
            method: init.method ?? "GET",
            path,
            headers,
            rejectUnauthorized: target.rejectUnauthorized,
            signal: init.signal,
        },
        (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on("error", reject);
        },
    );
    req.setTimeout(init.timeoutMs, () => req.destroy(new Error("the PiKVM did not answer in time")));
    req.on("error", reject);
    req.end(init.body);
    return promise;
}

/** Width and height from a JPEG's start-of-frame marker, for a snapshot that carries no size headers. */
export function jpegSize(data: Buffer): FrameSize | null {
    let i = 2;
    while (i + 9 < data.length) {
        if (data[i] !== 0xff) {
            i++;
            continue;
        }
        const marker = data[i + 1]!;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
        }
        i += 2 + data.readUInt16BE(i + 2);
    }
    return null;
}

function numberHeader(headers: IncomingHttpHeaders, name: string): number {
    const value = Number(headers[name]);
    return Number.isFinite(value) ? value : 0;
}

export function createDesk(options: DeskOptions): AgentDesk {
    const clock = options.clock ?? systemClock;
    const now = options.now ?? Date.now;
    const leaseMs = options.leaseMs ?? DEFAULTS.leaseMs;
    const linkIdleMs = options.linkIdleMs ?? DEFAULTS.linkIdleMs;
    const connectMs = options.connectMs ?? DEFAULTS.connectMs;
    const maxEdge = options.maxEdge ?? (() => DEFAULT_MAX_EDGE);
    const { activity } = options;

    const runs = new Map<string, Run>();
    const frames = new Map<string, Frame>();
    const lastLookAt = new Map<string, number>();
    let holder: string | null = null;
    let frameCounter = 0;
    /** What the last snapshot said the native resolution is, for when the Pi's own event has not. */
    let snapshotNative: FrameSize | null = null;

    let target: DeskTarget | null = null;
    let link: TargetLink | null = null;
    let input: AgentInput | null = null;
    let linkIdentity = "";
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    // ---- the link to the Pi ----------------------------------------------------------------

    const http: HttpPort = {
        async request(req) {
            if (!target) throw new Error("no target yet");
            const res = await kvmdRequest(target, req.path, {
                method: req.method,
                timeoutMs: 10_000,
                ...(req.body !== undefined ? { body: req.body } : {}),
                ...(req.contentType ? { contentType: req.contentType } : {}),
            });
            return { ok: res.status >= 200 && res.status < 300, status: res.status };
        },
    };

    const nativeNow = (): FrameSize | null => {
        const source = link?.store.getState().device.streamerSource;
        if (typeof source === "object" && source !== null && "resolution" in source) {
            const r = source.resolution;
            if (typeof r === "object" && r !== null && "width" in r && "height" in r) {
                const width = Number(r.width);
                const height = Number(r.height);
                if (width > 0 && height > 0) return { width, height };
            }
        }
        return snapshotNative;
    };

    const waitForLink = async (signal: AbortSignal): Promise<void> => {
        const active = link;
        if (!active) throw new DeskError("target_offline", "The PiKVM is not configured.");
        const ready = (): boolean => {
            const s = active.store.getState();
            return s.link.open && s.device.mouse.absolute !== null;
        };
        if (ready()) return;
        if (signal.aborted) return;
        const { promise, resolve } = Promise.withResolvers<void>();
        const done = (): void => {
            unsubscribe();
            cancel();
            signal.removeEventListener("abort", done);
            resolve();
        };
        const unsubscribe = active.store.subscribe(() => {
            if (ready()) done();
        });
        const cancel = clock.setTimeout(done, connectMs);
        signal.addEventListener("abort", done, { once: true });
        await promise;
        // Open is enough to act: an old kvmd may never say which mouse mode it is in.
        if (!active.isOpen()) {
            throw new DeskError("target_offline", "The PiKVM did not answer. Check that it is on and reachable, then try again.");
        }
    };

    const ensureLink = async (signal: AbortSignal): Promise<TargetLink> => {
        const next = await options.target().catch(() => null);
        if (!next) throw new DeskError("target_offline", "The PiKVM is not configured.");
        target = next;
        clearTimeout(idleTimer);
        idleTimer = undefined;
        /* A different PiKVM, or the same one with another sign-in, is a different link: the active PiKVM can change
         * between runs and the open socket belongs to the old one. Held in memory only, never logged. */
        const identity = `${next.origin.href}\n${JSON.stringify(next.headers)}`;
        if (!link || linkIdentity !== identity) {
            await link?.stop();
            const wsUrl = `${next.origin.protocol === "https:" ? "wss:" : "ws:"}//${next.origin.host}/api/ws`;
            const created = createTargetLink({
                url: wsUrl,
                socket: options.socket ?? nodeSocket({ headers: () => target?.headers ?? {} }),
                http,
                clock,
            });
            link = created;
            linkIdentity = identity;
            input = createAgentInput({
                link: created,
                native: () => nativeNow() ?? { width: 1920, height: 1080 },
                layout: options.keyboardLayout,
                clock,
                ...(options.timing ? { timing: options.timing } : {}),
            });
            created.start();
        }
        await waitForLink(signal);
        return link;
    };

    const scheduleIdleClose = (): void => {
        if (idleTimer || runs.size > 0 || !link) return;
        idleTimer = setTimeout(() => {
            idleTimer = undefined;
            if (runs.size > 0) return;
            const closing = link;
            link = null;
            input = null;
            linkIdentity = "";
            void closing?.stop();
        }, linkIdleMs);
        idleTimer.unref();
    };

    // ---- control -----------------------------------------------------------------------------

    const publish = (run: Run, conversationId: string, extra: Partial<Omit<AgentActivity, "at" | "state">> = {}): void => {
        if (holder !== conversationId) return;
        const prev = activity.current();
        activity.set({
            state: run.released ? "released" : "working",
            conversationId,
            ...(prev.tool ? { tool: prev.tool } : {}),
            ...(prev.pointer ? { pointer: prev.pointer } : {}),
            ...(run.released ? { reason: run.released } : {}),
            ...extra,
        });
    };

    const release = (conversationId: string, reason: ReleaseReason): void => {
        const run = runs.get(conversationId);
        if (!run || run.released) return;
        run.released = reason;
        // Abort first: the action in flight lifts what it holds in its own finally, and every
        // later call is refused with the reason.
        run.abort.abort(new DeskError("control_released", RELEASE_MESSAGE[reason]));
        if (holder === conversationId) {
            // The action in flight lifts what it holds in its own finally; this covers one that is between steps.
            input?.releaseAll();
            if (run.engaged) publish(run, conversationId);
            holder = null;
        }
    };

    const unsubscribePresence = options.presence.subscribe((event) => {
        for (const [conversationId, run] of runs) {
            if (event.at > run.grantedAt) release(conversationId, "operator");
        }
    });

    const sweepTimer = setInterval(() => sweepLeases(), DEFAULTS.sweepMs);
    sweepTimer.unref();

    function sweepLeases(): void {
        const t = now();
        for (const [conversationId, run] of runs) {
            if (!run.released && run.engaged && t - run.lastCallAt > leaseMs) release(conversationId, "lease_timeout");
        }
    }

    const holderIsLive = (): boolean => {
        if (holder === null) return false;
        const run = runs.get(holder);
        return !!run && !run.released && now() - run.lastCallAt <= leaseMs;
    };

    // ---- frames ------------------------------------------------------------------------------

    const currentFrame = (conversationId: string): Frame => {
        const frame = frames.get(conversationId);
        if (!frame) {
            throw new DeskError(
                "stale_frame",
                "You have not taken a screenshot in this conversation, so there is no picture for coordinates to refer to. Take a screenshot first.",
            );
        }
        const native = nativeNow();
        if (native && !sameSize(native, frame.native)) {
            throw new DeskError(
                "stale_frame",
                `The screen resolution changed from ${frame.native.width}x${frame.native.height} to ${native.width}x${native.height} since your last screenshot. Take a new screenshot; your coordinates no longer match.`,
            );
        }
        return frame;
    };

    const frac = (frame: Frame, point: Point): { fx: number; fy: number } => {
        if (!insideFrame(frame.reference, point)) {
            throw new DeskError(
                "invalid_arguments",
                `(${point.x}, ${point.y}) is outside the ${frame.reference.width}x${frame.reference.height} screenshot. Coordinates run from 0 to ${frame.reference.width - 1} across and 0 to ${frame.reference.height - 1} down.`,
            );
        }
        return pixelFrac(frame.reference, point);
    };

    // ---- the snapshot ------------------------------------------------------------------------

    const snapshot = async (signal: AbortSignal): Promise<{ jpeg: Buffer; native: FrameSize }> => {
        if (!target) throw new DeskError("target_offline", "The PiKVM is not configured.");
        let res: KvmdResponse;
        try {
            res = await kvmdRequest(target, "/api/streamer/snapshot?allow_offline=1", {
                timeoutMs: DEFAULTS.snapshotTimeoutMs,
                signal,
            });
        } catch (error) {
            if (signal.aborted) throw error;
            throw new DeskError("target_offline", "The PiKVM did not give a screenshot. Check that it is reachable.");
        }
        if (res.status !== 200 || res.body.length === 0) {
            throw new DeskError("target_offline", `The PiKVM gave no screenshot (status ${res.status}); the video source may be off.`);
        }
        const width = numberHeader(res.headers, "x-ustreamer-width");
        const height = numberHeader(res.headers, "x-ustreamer-height");
        const native = width > 0 && height > 0 ? { width, height } : jpegSize(res.body);
        if (!native) throw new DeskError("target_offline", "The PiKVM sent a screenshot that could not be read.");
        snapshotNative = native;
        return { jpeg: res.body, native };
    };

    const signature = async (jpeg: Buffer): Promise<string> => {
        const grey = options.images.gray ? await options.images.gray(jpeg, 16, 16).catch(() => null) : null;
        return grey ? Buffer.from(grey).toString("base64") : createHash("sha1").update(jpeg).digest("base64");
    };

    const sameScreen = async (a: Buffer, b: Buffer): Promise<boolean> => {
        const gray = options.images.gray;
        if (gray) {
            const [ga, gb] = await Promise.all([gray(a, 16, 16).catch(() => null), gray(b, 16, 16).catch(() => null)]);
            if (ga && gb) return fpDiff(ga, gb) < FP_SETTLE;
        }
        return (await signature(a)) === (await signature(b));
    };

    // ---- running an action -------------------------------------------------------------------

    /** Actions on the target never overlap: two at once would interleave their keys and clicks. */
    let queue: Promise<unknown> = Promise.resolve();
    const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
        const result = queue.then(work, work);
        queue = result.catch(() => undefined);
        return result;
    };

    const refused = (session: DeskSession): DeskError | null =>
        session.signal.aborted && session.signal.reason instanceof DeskError ? session.signal.reason : null;

    const translate = (error: unknown, session: DeskSession): unknown => {
        const released = refused(session);
        if (released) return released;
        if (error instanceof LinkClosed) {
            return new DeskError("target_offline", "The connection to the PiKVM dropped. Nothing further was sent; wait a moment and try again.");
        }
        if (error instanceof UnmappableText) return new DeskError("unsupported_text", `${error.message}. Nothing was typed.`);
        if (error instanceof AgentAbort) return new Error("aborted");
        return error;
    };

    const act = <T>(session: DeskSession, tool: string, work: (agent: AgentInput, link: TargetLink) => Promise<T>): Promise<T> =>
        exclusive(async () => {
            const released = refused(session);
            if (released) throw released;
            if (session.signal.aborted) throw new Error("aborted");
            if (!input || !link) throw new DeskError("target_offline", "The connection to the PiKVM closed. Try again.");
            const run = runs.get(session.conversationId);
            if (run) {
                run.lastCallAt = now();
                publish(run, session.conversationId, { tool });
            }
            try {
                return await work(input, link);
            } catch (error) {
                throw translate(error, session);
            } finally {
                // Whatever ended the action, nothing it pressed stays pressed.
                input.releaseAll();
            }
        });

    const movePublished = (conversationId: string, at: { fx: number; fy: number }): void => {
        const run = runs.get(conversationId);
        if (run) publish(run, conversationId, { pointer: at });
        options.onPointer?.({ x: fracToNorm(at.fx), y: fracToNorm(at.fy) }, link?.isAbsolute() === true);
    };

    // ---- screen waits ------------------------------------------------------------------------

    const screenWaits = (): ScreenWaits => {
        const waits = options.screenWaits?.();
        if (!waits) throw new DeskError("watch_unavailable", "Screen waits are not available on this host.");
        return waits;
    };

    /** The host's refusal (watch/service.ts) as an error the model can act on. Checked by name: this file is imported by the service. */
    const watchRefusal = (error: unknown): unknown => {
        if (error instanceof Error && error.name === "WatchRefusal") {
            return new DeskError(Reflect.get(error, "status") === 400 ? "invalid_arguments" : "watch_unavailable", error.message);
        }
        return error;
    };

    const noSuchWatch = (): DeskError =>
        new DeskError("no_such_watch", "This conversation has no screen wait with that id. It was never started, or it ended more than 30 minutes ago.");

    const seconds = (ms: number): number => Math.round(ms / 1000);

    const reportOf = (view: WaitView): ScreenWatchReport => ({
        id: view.id,
        status: view.status,
        question: view.question,
        elapsedSeconds: seconds(view.elapsedMs),
        changes: view.changes,
        asked: view.asked,
        repeated: view.repeated,
        skipped: view.skipped,
        dropped: view.dropped,
        bestProbability: view.bestProbability,
        ...(view.match ? { match: { probability: view.match.probability, excerpt: view.match.excerpt, atSeconds: seconds(view.match.atMs) } } : {}),
        ...(view.reason !== undefined ? { reason: view.reason } : {}),
        screen: view.screen,
    });

    // ---- the Desk port -----------------------------------------------------------------------

    const desk: AgentDesk = {
        beginRun(conversationId) {
            const previous = runs.get(conversationId);
            // A new message is the explicit act that returns control: a fresh grant, a fresh abort controller.
            previous?.abort.abort(new Error("superseded by a new run"));
            runs.set(conversationId, {
                grantedAt: now(),
                abort: new AbortController(),
                released: null,
                engaged: false,
                lastCallAt: now(),
            });
            clearTimeout(idleTimer);
            idleTimer = undefined;
        },

        endRun(conversationId) {
            const run = runs.get(conversationId);
            if (!run) return;
            run.abort.abort(new Error("the run ended"));
            runs.delete(conversationId);
            frames.delete(conversationId);
            lastLookAt.delete(conversationId);
            if (holder === conversationId) {
                input?.releaseAll();
                holder = null;
            }
            if (activity.current().conversationId === conversationId) activity.set({ state: "idle" });
            scheduleIdleClose();
        },

        stop(conversationId) {
            for (const id of conversationId ? [conversationId] : [...runs.keys()]) release(id, "stopped");
            // Stop is the person saying: no more. A watch left running would go on reading the screen and asking a model for an agent that was told to stop.
            options.screenWaits?.()?.cancelFor(conversationId);
        },

        handBack() {
            let count = 0;
            for (const [conversationId, run] of runs) {
                if (!run.released) continue;
                run.released = null;
                run.grantedAt = now();
                run.abort = new AbortController();
                run.lastCallAt = now();
                holder = holder ?? conversationId;
                publish(run, conversationId);
                count++;
            }
            return count;
        },

        busy() {
            for (const run of runs.values()) if (run.engaged && !run.released) return true;
            return false;
        },

        sweepLeases,

        async open(call: DeskCall, intent) {
            const run = runs.get(call.conversationId);
            if (!run) {
                throw new DeskError(
                    "control_released",
                    "Nobody has given you control of the PiKVM: it is handed over while the person's message is being answered. Ask them to send a message.",
                );
            }
            if (run.released) throw new DeskError("control_released", RELEASE_MESSAGE[run.released]);
            const contended = (): boolean => holder !== null && holder !== call.conversationId && holderIsLive();
            const busyMessage = "Another conversation is using the PiKVM right now. Wait for it to finish, or tell the person.";
            if (contended()) throw new DeskError("another_conversation_holds_control", busyMessage);
            const connected = await ensureLink(call.signal);
            // Two conversations can arrive together; whichever reaches here first takes the desk.
            if (contended()) throw new DeskError("another_conversation_holds_control", busyMessage);
            holder = call.conversationId;
            run.lastCallAt = now();
            if (intent === "act") {
                currentFrame(call.conversationId);
                const hid = connected.store.getState().device.hid;
                if (hid?.online === false || hid?.connected === false) {
                    throw new DeskError("target_offline", "The keyboard and mouse are not connected to the target, so input would be lost.");
                }
            }
            // The wait for the Pi can outlast a person's reaction; their input in that time still counts.
            if (run.released) throw new DeskError("control_released", RELEASE_MESSAGE[run.released]);
            run.engaged = true;
            publish(run, call.conversationId);
            const looked = lastLookAt.get(call.conversationId);
            return {
                conversationId: call.conversationId,
                signal: AbortSignal.any([call.signal, run.abort.signal]),
                lookAgeMs: looked === undefined ? null : now() - looked,
            };
        },

        async info(session): Promise<ScreenInfo> {
            const device = link?.store.getState().device;
            const frame = frames.get(session.conversationId);
            const source = device?.streamerSource;
            const online = typeof source === "object" && source !== null && "online" in source ? source.online === true : null;
            const hid = device?.hid;
            return {
                reference: frame?.reference ?? null,
                native: nativeNow(),
                frameId: frame?.id ?? null,
                mouse: device?.mouse.absolute === true ? "absolute" : device?.mouse.absolute === false ? "relative" : "unknown",
                hidOnline: hid ? hid.online !== false && hid.connected !== false : null,
                sourceOnline: online,
                control: runs.get(session.conversationId)?.released ? "released" : holder === session.conversationId ? "you" : "another_conversation",
            };
        },

        async screenshot(session, region?: Region): Promise<Shot> {
            const { jpeg, native } = await snapshot(session.signal);
            const device = link?.store.getState().device;
            const mouse = device?.mouse.absolute === true ? "absolute" : device?.mouse.absolute === false ? "relative" : "unknown";
            const source = device?.streamerSource;
            const sourceOnline = typeof source === "object" && source !== null && "online" in source ? source.online === true : null;
            const hidOnline = device?.hid ? device.hid.online !== false && device.hid.connected !== false : null;
            const edge = maxEdge();
            lastLookAt.set(session.conversationId, now());

            if (region) {
                const frame = currentFrame(session.conversationId);
                const area = regionToNative(frame.reference, frame.native, region);
                if (!area) {
                    throw new DeskError(
                        "invalid_arguments",
                        `The region is outside the ${frame.reference.width}x${frame.reference.height} screenshot.`,
                    );
                }
                const cropped = await options.images.crop(jpeg, area, 88);
                if (!cropped) {
                    throw new DeskError("invalid_arguments", "Zoom is not available on this host. Use read_text, or take a screenshot.");
                }
                const fit = referenceSize(area, edge);
                const image = sameSize(fit, area) ? cropped : ((await options.images.resize(cropped, fit.width, fit.height, 85)) ?? cropped);
                const size = image === cropped ? area : fit;
                return {
                    jpeg: image,
                    width: size.width,
                    height: size.height,
                    frameId: frame.id,
                    reference: frame.reference,
                    region,
                    mouse,
                    sourceOnline,
                    hidOnline,
                };
            }

            let reference = referenceSize(native, edge);
            let image: Buffer = jpeg;
            if (!sameSize(reference, native)) {
                const scaled = await options.images.resize(jpeg, reference.width, reference.height, 78);
                // No image tools on this host: the frame is the native one, and coordinates still agree with it.
                if (scaled) image = scaled;
                else reference = native;
            }
            const frame: Frame = { id: ++frameCounter, native, reference };
            frames.set(session.conversationId, frame);
            return { jpeg: image, width: reference.width, height: reference.height, frameId: frame.id, reference, mouse, sourceOnline, hidOnline };
        },

        async listen(session, durationMs) {
            try {
                return await listenToTarget(await options.target(), durationMs, session.signal);
            } catch (error) {
                session.signal.throwIfAborted();
                throw new DeskError("target_offline", error instanceof Error ? error.message : "The PiKVM audio capture failed.");
            }
        },

        async readText(session, region?: Region) {
            const device = link?.store.getState().device;
            if (device?.ocr && device.ocr.enabled === false) {
                throw new DeskError("ocr_unavailable", "This PiKVM has OCR turned off or not installed. Use screenshot with a region to zoom in.");
            }
            const frame = currentFrame(session.conversationId);
            const area = region ? regionToNative(frame.reference, frame.native, region) : { x: 0, y: 0, ...frame.native };
            if (!area) throw new DeskError("invalid_arguments", `The region is outside the ${frame.reference.width}x${frame.reference.height} screenshot.`);
            if (!target) throw new DeskError("target_offline", "The PiKVM is not configured.");
            const query = new URLSearchParams({
                allow_offline: "1",
                ocr: "1",
                ocr_langs: "eng",
                ocr_left: String(area.x),
                ocr_top: String(area.y),
                ocr_right: String(area.x + area.width),
                ocr_bottom: String(area.y + area.height),
            });
            let res: KvmdResponse;
            try {
                res = await kvmdRequest(target, `/api/streamer/snapshot?${query}`, {
                    timeoutMs: DEFAULTS.ocrTimeoutMs,
                    signal: session.signal,
                });
            } catch (error) {
                if (session.signal.aborted) throw refused(session) ?? error;
                throw new DeskError("target_offline", "The PiKVM did not answer the OCR request.");
            }
            if (res.status !== 200) throw new DeskError("ocr_unavailable", `The PiKVM could not read text (status ${res.status}).`);
            return res.body.toString("utf8");
        },

        async mouseMove(session, to) {
            const frame = currentFrame(session.conversationId);
            const at = frac(frame, to);
            await act(session, "mouse_move", async (agent) => {
                await agent.moveTo(at, session.signal);
                movePublished(session.conversationId, at);
            });
        },

        async click(session, at: Point, button: MouseButton, count: number) {
            const f = frac(currentFrame(session.conversationId), at);
            await act(session, "click", async (agent) => {
                await agent.click(f, button, count, session.signal);
                movePublished(session.conversationId, f);
            });
        },

        async drag(session, from, to, button) {
            const frame = currentFrame(session.conversationId);
            const a = frac(frame, from);
            const b = frac(frame, to);
            await act(session, "drag", async (agent) => {
                try {
                    await agent.drag(a, b, button, session.signal);
                } finally {
                    movePublished(session.conversationId, agent.pointer() ?? a);
                }
            });
        },

        async scroll(session, at, dx, dy) {
            const f = frac(currentFrame(session.conversationId), at);
            await act(session, "scroll", async (agent) => {
                await agent.scroll(f, dx, dy, session.signal);
                movePublished(session.conversationId, f);
            });
        },

        async typeText(session, text) {
            currentFrame(session.conversationId);
            return act(session, "type_text", async (agent, active) => {
                const kvmdDefaultKeymap = active.store.getState().device.keymaps?.default ?? null;
                const analysis = await agent.typeText(text, session.signal);
                // Only known keymap families can be compared. Neither family identifies the OS layout.
                const family = kvmdDefaultKeymap?.toLowerCase().replace(/_/g, "-");
                const kvmdLayout = /^en-us(?:$|[-.])/.test(family ?? "")
                    ? "us"
                    : /^en-gb(?:$|[-.])/.test(family ?? "") ? "uk" : null;
                return {
                    ...analysis,
                    kvmdDefaultKeymap,
                    keymapMatchesLayout: kvmdLayout === null ? null : kvmdLayout === analysis.layout,
                    outputVerified: false as const,
                };
            });
        },

        async key(session, chords) {
            currentFrame(session.conversationId);
            await act(session, "key", (agent) => agent.chords(chords.map(parseChord), session.signal));
        },

        async wait(session, ms, untilStable): Promise<WaitResult> {
            const started = now();
            const sleep = (delay: number): Promise<void> => {
                const { promise, resolve, reject } = Promise.withResolvers<void>();
                const cancel = clock.setTimeout(() => {
                    session.signal.removeEventListener("abort", onAbort);
                    resolve();
                }, delay);
                const onAbort = (): void => {
                    cancel();
                    reject(refused(session) ?? new Error("aborted"));
                };
                if (session.signal.aborted) onAbort();
                else session.signal.addEventListener("abort", onAbort, { once: true });
                return promise;
            };
            if (!untilStable) {
                await sleep(ms);
                return { waitedMs: ms };
            }
            // Two identical frames in a row, as a person judges "the page has finished loading".
            let previous: Buffer | null = null;
            for (;;) {
                const { jpeg } = await snapshot(session.signal);
                if (previous && (await sameScreen(previous, jpeg))) return { waitedMs: now() - started, stable: true };
                previous = jpeg;
                if (now() - started + DEFAULTS.settlePollMs > ms) return { waitedMs: now() - started, stable: false };
                await sleep(DEFAULTS.settlePollMs);
            }
        },

        async watchScreen(session, request) {
            const waits = screenWaits();
            // The whole screen unless the agent gave a rectangle of its screenshot, which is turned into fractions of the screen.
            let zone = { x0: 0, y0: 0, x1: 1, y1: 1 };
            if (request.region) {
                const frame = currentFrame(session.conversationId);
                const area = regionToNative(frame.reference, frame.native, request.region);
                if (!area) throw new DeskError("invalid_arguments", `The region is outside the ${frame.reference.width}x${frame.reference.height} screenshot.`);
                zone = {
                    x0: area.x / frame.native.width,
                    y0: area.y / frame.native.height,
                    x1: (area.x + area.width) / frame.native.width,
                    y1: (area.y + area.height) / frame.native.height,
                };
            }
            let started: WaitView;
            try {
                started = waits.start(session.conversationId, { question: request.question, zone, timeoutMs: request.timeoutSeconds * 1000 });
            } catch (error) {
                throw watchRefusal(error);
            }
            return reportOf((await waits.wait(session.conversationId, started.id, request.waitSeconds * 1000, session.signal)) ?? started);
        },

        async watchResult(session, id, waitSeconds) {
            const view = await screenWaits().wait(session.conversationId, id, waitSeconds * 1000, session.signal);
            if (!view) throw noSuchWatch();
            return reportOf(view);
        },

        async watchCancel(session, id) {
            const view = screenWaits().cancel(session.conversationId, id);
            if (!view) throw noSuchWatch();
            return reportOf(view);
        },

        async power(session, action) {
            const device = link?.store.getState().device;
            if (device?.atx && device.atx.enabled === false) {
                throw new DeskError("target_offline", "This PiKVM has no ATX power control connected.");
            }
            const on = device?.atx?.leds["power"];
            if (action === "on" && on === true) return "The target is already on; nothing was pressed.";
            if (action === "off" && on === false) return "The target is already off; nothing was pressed.";
            const button = action === "reset" ? "reset" : "power";
            return exclusive(async () => {
                if (!target) throw new DeskError("target_offline", "The PiKVM is not configured.");
                const res = await kvmdRequest(target, `/api/atx/click?button=${button}`, {
                    method: "POST",
                    timeoutMs: 15_000,
                    signal: session.signal,
                });
                if (res.status !== 200) throw new DeskError("target_offline", `The PiKVM refused the power action (status ${res.status}).`);
                return action === "reset" ? "Pressed the ATX reset button." : `Pressed the ATX power button (${action}).`;
            });
        },

        approving(session, tool, waiting) {
            const run = runs.get(session.conversationId);
            if (!run || holder !== session.conversationId) return;
            if (waiting) {
                activity.set({ state: "waiting_approval", conversationId: session.conversationId, tool });
            } else if (!run.released) {
                publish(run, session.conversationId, { tool });
            }
        },

        async dispose() {
            unsubscribePresence();
            clearInterval(sweepTimer);
            clearTimeout(idleTimer);
            options.screenWaits?.()?.cancelFor();
            for (const run of runs.values()) run.abort.abort(new Error("the desk was disposed"));
            runs.clear();
            input?.releaseAll();
            await link?.stop();
            link = null;
            input = null;
        },
    };
    return desk;
}
