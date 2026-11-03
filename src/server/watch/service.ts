import { dirname } from "node:path";
import type { HostProvider } from "@pikvm/chat-server";
import type { CheckEntry, WatchSettings, WatchView } from "@pikvm/contracts/watch";
import type { ImageOps } from "../../image-ops";
import { jpegSize, kvmdRequest, type DeskTarget } from "../agent/desk";
import { GRID_HEIGHT, GRID_WIDTH, MODEL_FRAME_EDGE, DEFAULT_VISION_MODEL, type WatchLimits } from "./limits";
import { createModelClient, type ModelClient } from "./models";
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
    // Test seams.
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

    function canEnable(userId: string): WatchView["canEnable"] {
        if (!images.gray) return { ok: false, reason: "This host cannot read screenshots for comparing, so it cannot watch the screen." };
        try {
            if (!deps.chat.openRouter(userId)) return { ok: false, reason: NEED_KEY };
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
            log,
        });
        pipelines.set(userId, pipeline);
        watcher.attach(userId, pipeline);
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
                running: pipelines.has(userId) && watcher.running,
                signal: watcher.signal,
                push: pushState(userId),
                limits: {
                    intervalSec: deps.limits.intervalMs / 1000,
                    settleSec: deps.limits.settleMs / 1000,
                    minCheckGapSec: deps.limits.minCheckGapMs / 1000,
                    dailyCap: deps.limits.dailyCap,
                    askedToday: store.askedSince(userId, now() - DAY_MS),
                },
            };
        },

        update(userId, patch) {
            if (patch.enabled === true) {
                const can = canEnable(userId);
                if (!can.ok) throw new WatchRefusal(can.reason, 409);
            }
            try {
                store.write(userId, patch);
            } catch (error) {
                if (error instanceof SettingsError) throw new WatchRefusal(error.message, 400);
                throw error;
            }
            reconcile(userId);
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
        },
    };
}
