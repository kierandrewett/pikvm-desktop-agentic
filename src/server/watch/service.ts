import { dirname } from "node:path";
import type { CheckEntry, WatchSettings, WatchView } from "@pikvm/contracts/watch";
import type { ImageOps } from "../../image-ops";
import { jpegSize, kvmdRequest, type DeskTarget } from "../agent/desk";
import { createAlerts, type Alerts } from "./alerts";
import type { ZoneCells } from "./frame-diff";
import { GRID_HEIGHT, GRID_WIDTH, type WatchLimits } from "./limits";
import { createOcrEngine } from "./ocr-engine";
import { createPresence, type PresenceReport } from "./presence";
import type { Ocr } from "./ocr";
import { createPush, PushError, type Push, type SendResult } from "./push";
import { createWatchStore, SettingsError, type WatchStore } from "./store";
import { createWatcher, type Snapshot, type Watcher } from "./watcher";

/**
 * The screen watch as the host uses it: one poller on the PiKVM shared by every user who switched theirs on, a pipeline per user
 * (alerts.ts), the user's settings and log, and the push subscriptions. It starts when the chat server is up (the chat model the
 * notification is written with lives in its settings) and resumes whoever had it on.
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
    /** One small text request on the user's chat model. Undefined when there is no model to ask. Rejects on failure or after `timeoutMs`. */
    smallText(userId: string, system: string, user: string, options: { maxTokens?: number; json?: boolean; timeoutMs: number }): Promise<string | undefined>;
    /** Whether `smallText` has a model to ask right now. */
    hasSmallModel(userId: string): boolean;
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
    // Test seams.
    /** The OCR pop-ups are read with. Default: the one in this host's image (ocr-engine.ts). */
    ocr?: Ocr;
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
    /** A page of the app says whether the person is at it (see presence.ts). */
    presence(userId: string, clientId: string, report: PresenceReport): void;
    /**
     * The agent waits for the person (a card in the thread). Sends a notification to their devices unless they switched it off,
     * have no device, or are at the app (the card is in front of them). Never throws and never waits for the push service.
     */
    agentNeeds(userId: string, conversationId: string, kind: "approval" | "question" | "input"): void;
    /** The shared poller, for tests and status. */
    readonly watcher: Watcher;
    stop(): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The words of an agent notification. They never carry what the agent wants to do: a notification crosses a push service and lands on a lock screen. */
const AGENT_WORDS = {
    approval: "The agent needs your approval.",
    question: "The agent has a question for you.",
    input: "The agent needs some information from you.",
} as const;
/** An approval that nobody can still act on after this long is not worth delivering late. */
const AGENT_TTL_S = 15 * 60;

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
    const ocr = deps.ocr ?? createOcrEngine({ log });
    const pipelines = new Map<string, Alerts>();
    const presence = createPresence(now);
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

    /**
     * The crop of a frame to a rectangle of grid cells, for the OCR: cut from the snapshot as the Pi encoded it, at its own size (a toast's
     * text is small, so it is not scaled down). Throws when it cannot be cut.
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
        return cropped;
    }

    /** Whether the watch can run now: this host must be able to compare screenshots and read text from them. */
    function canEnable(): WatchView["canEnable"] {
        if (!images.gray) return { ok: false, reason: "This host cannot read screenshots for comparing, so it cannot watch the screen." };
        const why = ocr.unavailable?.();
        if (why !== undefined) return { ok: false, reason: `This host cannot read pop-ups: ${why}` };
        return { ok: true };
    }

    function hasModel(userId: string): boolean {
        try {
            return deps.chat.hasSmallModel(userId);
        } catch {
            return false;
        }
    }

    /** Make the poller match the user's setting: attached when on and able, detached otherwise. */
    function reconcile(userId: string): void {
        const wanted = store.read(userId).enabled && canEnable().ok;
        if (!wanted) {
            pipelines.delete(userId);
            watcher.detach(userId);
            return;
        }
        if (pipelines.has(userId)) return;
        const alerts = createAlerts({
            userId,
            store,
            push,
            settings: () => store.read(userId),
            limits: deps.limits,
            now,
            ocr,
            model: {
                available: () => hasModel(userId),
                ask: (system, user, options) => deps.chat.smallText(userId, system, user, options),
            },
            crop: cropCells,
            userActive: () => presence.active(userId),
            ...(deps.logText ? { logText: true } : {}),
            log,
        });
        pipelines.set(userId, alerts);
        watcher.attach(userId, alerts);
        ocr.warm?.();
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
                canEnable: canEnable(),
                chatModel: hasModel(userId),
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
                const can = canEnable();
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
                    body: "Test notification. This is how a pop-up on the screen will show up.",
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

        presence: (userId, clientId, report) => presence.report(userId, clientId, report),

        agentNeeds(userId, conversationId, kind) {
            try {
                if (!store.read(userId).notifyAgent) return;
                if (push.list(userId).length === 0) return;
                if (presence.active(userId)) return;
                // Told once for each card when it appears, so each wait notifies once and a second card in the same run is not lost.
                const body = AGENT_WORDS[kind];
                void push
                    .send(userId, { title: "PiKVM", body, tag: `pikvm-agent-${conversationId}`, url: "/app/chat", badge: true }, { urgency: "high", ttlSeconds: AGENT_TTL_S })
                    .catch((error: unknown) => log(`[watch] agent notification not sent: ${error instanceof Error ? error.message : String(error)}`));
            } catch (error) {
                log(`[watch] agent notification not sent: ${error instanceof Error ? error.message : String(error)}`);
            }
        },

        stop() {
            pipelines.clear();
            watcher.stop();
            ocr.close();
        },
    };
}
