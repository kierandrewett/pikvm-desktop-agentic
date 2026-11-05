import { dirname } from "node:path";
import type { HostProvider } from "@pikvm/chat-server";
import type { CheckEntry, WatchSettings, WatchView } from "@pikvm/contracts/watch";
import type { ImageOps } from "../../image-ops";
import { jpegSize, kvmdRequest, type DeskTarget } from "../agent/desk";
import type { ZoneCells } from "./frame-diff";
import { GRID_HEIGHT, GRID_WIDTH, MODEL_FRAME_EDGE, DEFAULT_VISION_MODEL, type WatchLimits } from "./limits";
import { createModelClient, type ModelClient } from "./models";
import { createOcrEngine } from "./ocr-engine";
import type { Ocr } from "./ocr";
import { createPipeline, type Pipeline } from "./pipeline";
import { createPush, PushError, type Push, type SendResult } from "./push";
import { createWatchStore, SettingsError, type WatchStore } from "./store";
import { createWatcher, type Snapshot, type Watcher } from "./watcher";

/**
 * The screen watch as the host uses it: one poller on the PiKVM shared by every user who switched theirs on, a pipeline
 * per user, the user's settings and log, and the push subscriptions. It starts when the chat server is up (the key lives
 * in its settings) and resumes whoever had it on.
 */

export class WatchRefusal extends Error {
    /** HTTP status the route answers with. */
    constructor(
        message: string,
        readonly status: 400 | 409 | 503 = 409,
    ) {
        super(message);
        this.name = "WatchRefusal";
    }
}

/** The chat host's part the watch needs. */
export interface WatchChat {
    openRouter(userId: string): HostProvider | undefined;
    userDir(userId: string): string;
}

export interface WatchServiceDeps {
    chat: WatchChat;
    target: () => Promise<DeskTarget>;
    images: ImageOps;
    dataDir: string;
    limits: WatchLimits;
    /** Accept push endpoints that are not a browser vendor's (tests, local runs). */
    allowLocalPush?: boolean;
    subject?: string | undefined;
    /** Put pop-up text in the check log (`PIKVM_WATCH_LOG_TEXT=1`); off by default, the log then says how much was read and not what. */
    logText?: boolean;
    /** `PIKVM_WATCH_FAST_CLOUD_FALLBACK=1`: fast alerts may send a crop to the vision model when the OCR fails. Off by default. */
    cloudFallback?: boolean;
    // Test seams.
    /** The OCR fast alerts read pop-ups with. Default: the one in this host's image (ocr-engine.ts). */
    ocr?: Ocr;
    /** The OCR the whole-screen path reads frames with when there is no key. Default: `ocr` when given, else a second engine of its own (a whole frame must not hold up a pop-up). */
    screenOcr?: Ocr;
    models?: ModelClient;
    push?: Push;
    store?: WatchStore;
    snapshot?: (signal: AbortSignal) => Promise<Snapshot>;
    now?: () => number;
    schedule?: (fn: () => void, ms: number) => () => void;
    log?: (line: string) => void;
}

export interface WatchService {
    /** Resume the users who had their watch on. Call once the chat server is up. */
    start(): void;
    view(userId: string): WatchView;
    update(userId: string, patch: Partial<WatchSettings>): WatchView;
    subscribe(userId: string, subscription: unknown, meta: { userAgent?: string | undefined; origin?: string | undefined }): void;
    unsubscribe(userId: string, endpoint: string): boolean;
    /** Send a test notification now. Throws `WatchRefusal` when no device is subscribed or the push key is unusable. */
    test(userId: string): Promise<SendResult>;
    checks(userId: string, limit: number): CheckEntry[];
    /** The shared poller, for tests and status. */
    readonly watcher: Watcher;
    stop(): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NEED_KEY =
    "Add an OpenRouter key in Settings, Providers first. The watch asks an image model what the screen shows, and a decision model whether that matters, and both go through that key.";

export function createWatchService(deps: WatchServiceDeps): WatchService {
    const now = deps.now ?? Date.now;
    const log = deps.log ?? ((line: string) => console.log(line));
    const store =
        deps.store ??
        createWatchStore({ userDir: (userId) => deps.chat.userDir(userId), usersRoot: () => dirname(deps.chat.userDir("x")) });
    const push =
        deps.push ??
        createPush({
            dataDir: deps.dataDir,
            subscriptionsFile: (userId) => store.subscriptionsFile(userId),
            subject: deps.subject,
            allowLocalEndpoints: deps.allowLocalPush === true,
        });
    const models = deps.models ?? createModelClient();
    const ocr = deps.ocr ?? createOcrEngine({ log });
    const screenOcr = deps.screenOcr ?? deps.ocr ?? createOcrEngine({ log });
    const pipelines = new Map<string, Pipeline>();
    const { images } = deps;

    const snapshot =
        deps.snapshot ??
        (async (signal: AbortSignal): Promise<Snapshot> => {
            try {
                const res = await kvmdRequest(await deps.target(), "/api/streamer/snapshot", { timeoutMs: 10_000, signal });
                if (res.status === 200 && res.body.length > 0) return { kind: "frame", jpeg: res.body };
                // kvmd answers 503 for a streamer whose source is offline: nothing is plugged in or the target is off.
                if (res.status === 503) return { kind: "no-signal" };
                return { kind: "unreachable", message: `the PiKVM answered ${res.status}` };
            } catch (error) {
                return { kind: "unreachable", message: error instanceof Error ? error.message : String(error) };
            }
        });

    const watcher = createWatcher({
        snapshot,
        grid: async (jpeg) => (images.gray ? await images.gray(jpeg, GRID_WIDTH, GRID_HEIGHT).catch(() => null) : null),
        intervalMs: deps.limits.intervalMs,
        fastIntervalMs: deps.limits.fast.intervalMs,
        now,
        ...(deps.schedule ? { schedule: deps.schedule } : {}),
        log,
    });

    /** Scale a frame for the model so its long edge is at most MODEL_FRAME_EDGE. */
    async function prepare(jpeg: Buffer): Promise<Buffer> {
        const size = jpegSize(jpeg);
        if (!size || Math.max(size.width, size.height) <= MODEL_FRAME_EDGE) return jpeg;
        const scale = MODEL_FRAME_EDGE / Math.max(size.width, size.height);
        const resized = await images.resize(jpeg, Math.round(size.width * scale), Math.round(size.height * scale), 80);
        return resized ?? jpeg;
    }

    /**
     * The crop of a frame to a rectangle of grid cells, for the OCR (fast alerts): cut from the snapshot as the Pi encoded it, at its
     * own size (a toast's text is small, so it is not scaled down), and scaled only if its long edge passes MODEL_FRAME_EDGE (a
     * crop that large is the vision model's fallback). Throws when it cannot be cut.
     */
    async function cropCells(jpeg: Buffer, cells: ZoneCells): Promise<Buffer> {
        const size = jpegSize(jpeg);
        if (!size) throw new Error("The snapshot's size could not be read, so the corner could not be cut out of it.");
        const x = Math.min(size.width - 1, Math.floor((cells.x0 * size.width) / GRID_WIDTH));
        const y = Math.min(size.height - 1, Math.floor((cells.y0 * size.height) / GRID_HEIGHT));
        const width = Math.max(1, Math.min(size.width, Math.ceil((cells.x1 * size.width) / GRID_WIDTH)) - x);
        const height = Math.max(1, Math.min(size.height, Math.ceil((cells.y1 * size.height) / GRID_HEIGHT)) - y);
        const cropped = await images.crop(jpeg, { x, y, width, height }, 90);
        if (!cropped) throw new Error("The corner could not be cut out of the snapshot.");
        const edge = Math.max(width, height);
        if (edge <= MODEL_FRAME_EDGE) return cropped;
        const scale = MODEL_FRAME_EDGE / edge;
        return (await images.resize(cropped, Math.round(width * scale), Math.round(height * scale), 85)) ?? cropped;
    }

    function hasKey(userId: string): boolean {
        try {
            return deps.chat.openRouter(userId) !== undefined;
        } catch {
            return false;
        }
    }

    function canEnable(userId: string): WatchView["canEnable"] {
        if (!images.gray) return { ok: false, reason: "This host cannot read screenshots for comparing, so it cannot watch the screen." };
        try {
            // With no key the watch still works if this host can read the screen itself (it then cannot judge what matters).
            if (!deps.chat.openRouter(userId) && screenOcr.unavailable?.() !== undefined) return { ok: false, reason: NEED_KEY };
        } catch {
            return { ok: false, reason: "Chat is not running, so the stored key cannot be read." };
        }
        return { ok: true };
    }

    /** Make the poller match the user's setting: attached when on and able, detached otherwise. */
    function reconcile(userId: string): void {
        const wanted = store.read(userId).enabled && canEnable(userId).ok;
        if (!wanted) {
            pipelines.delete(userId);
            watcher.detach(userId);
            return;
        }
        if (pipelines.has(userId)) return;
        const pipeline = createPipeline({
            userId,
            store,
            push,
            models,
            provider: () => {
                try {
                    return deps.chat.openRouter(userId);
                } catch {
                    return undefined;
                }
            },
            settings: () => store.read(userId),
            limits: deps.limits,
            now,
            prepare,
            ocr,
            screenOcr,
            crop: cropCells,
            ...(deps.logText ? { logText: true } : {}),
            ...(deps.cloudFallback ? { cloudFallback: true } : {}),
            log,
        });
        pipelines.set(userId, pipeline);
        watcher.attach(userId, pipeline);
        if (store.read(userId).fastAlerts) ocr.warm?.();
    }

    function pushState(userId: string): WatchView["push"] {
        const subscriptions = push.list(userId).length;
        try {
            return { available: true, publicKey: push.publicKey(), subscriptions };
        } catch (error) {
            return { available: false, reason: error instanceof PushError ? error.message : "Push is not available.", subscriptions };
        }
    }

    return {
        watcher,

        start() {
            for (const userId of store.userIds()) reconcile(userId);
        },

        view(userId) {
            const settings = store.read(userId);
            return {
                ...settings,
                defaultVisionModel: DEFAULT_VISION_MODEL,
                canEnable: canEnable(userId),
                canJudge: hasKey(userId),
                running: pipelines.has(userId) && watcher.running,
                signal: watcher.signal,
                push: pushState(userId),
                limits: {
                    intervalSec: deps.limits.intervalMs / 1000,
                    settleSec: deps.limits.settleMs / 1000,
                    minCheckGapSec: deps.limits.minCheckGapMs / 1000,
                    dailyCap: deps.limits.dailyCap,
                    askedToday: store.askedSince(userId, now() - DAY_MS),
                    fast: {
                        intervalSec: deps.limits.fast.intervalMs / 1000,
                        settleSec: deps.limits.fast.settleMs / 1000,
                        minCheckGapSec: deps.limits.fast.minCheckGapMs / 1000,
                        dailyCap: deps.limits.fast.dailyCap,
                        askedToday: store.askedSince(userId, now() - DAY_MS, "alert"),
                    },
                },
            };
        },

        update(userId, patch) {
            if (patch.enabled === true) {
                const can = canEnable(userId);
                if (!can.ok) throw new WatchRefusal(can.reason, 409);
            }
            if (patch.fastAlerts === true && !(patch.enabled ?? store.read(userId).enabled)) {
                throw new WatchRefusal("Switch the screen watch on first: fast alerts run inside it.", 409);
            }
            try {
                store.write(userId, patch);
            } catch (error) {
                if (error instanceof SettingsError) throw new WatchRefusal(error.message, 400);
                throw error;
            }
            reconcile(userId);
            if (pipelines.has(userId) && store.read(userId).fastAlerts) ocr.warm?.();
            return this.view(userId);
        },

        subscribe(userId, subscription, meta) {
            try {
                push.subscribe(userId, subscription, meta);
            } catch (error) {
                if (error instanceof PushError) throw new WatchRefusal(error.message, error.code === "unavailable" ? 503 : 400);
                throw error;
            }
        },

        unsubscribe: (userId, endpoint) => push.unsubscribe(userId, endpoint),

        async test(userId) {
            const at = now();
            try {
                const result = await push.send(userId, {
                    title: "PiKVM",
                    body: "Test notification. This is how a change on the screen will show up.",
                    tag: "pikvm-test",
                    url: "/app/",
                });
                store.append(userId, {
                    t: at,
                    at: new Date(at).toISOString(),
                    kind: "test",
                    score: null,
                    outcome: result.sent > 0 ? "pushed" : "error",
                    asked: false,
                    push: { sent: result.sent, removed: result.removed, failed: result.failed.length },
                    ...(result.sent > 0 ? {} : { reason: result.failed[0]?.message ?? "every subscription had expired" }),
                });
                return result;
            } catch (error) {
                if (error instanceof PushError) throw new WatchRefusal(error.message, error.code === "unavailable" ? 503 : 409);
                throw error;
            }
        },

        checks: (userId, limit) => store.log(userId, limit),

        stop() {
            pipelines.clear();
            watcher.stop();
            ocr.close();
            screenOcr.close();
        },
    };
}
