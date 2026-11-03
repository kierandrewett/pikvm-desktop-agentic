import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRID_CELLS, type Grid } from "../../src/server/watch/frame-diff";
import { GRID_WIDTH } from "../../src/server/watch/limits";
import type { Decided, Described, ModelClient, ModelProvider, Verdict } from "../../src/server/watch/models";
import { ModelError, verdictOf } from "../../src/server/watch/models";
import type { Push, PushPayload, SendResult, StoredSubscription } from "../../src/server/watch/push";
import { PushError } from "../../src/server/watch/push";
import { createWatchStore, type WatchStore } from "../../src/server/watch/store";

/** A flat grey grid. */
export const flat = (level: number): Grid => new Uint8Array(GRID_CELLS).fill(level);

/** `base` with a rectangle of cells set to `level`. */
export function patched(base: Grid, x: number, y: number, w: number, h: number, level: number): Grid {
    const out = base.slice();
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) out[row * GRID_WIDTH + col] = level;
    return out;
}

/** A dialog-sized change: 16 x 8 cells is 5.5% of the grid, far over the threshold. */
export const dialog = (base: Grid): Grid => patched(base, 20, 10, 16, 8, 240);

/** A cursor-sized change: 2 x 2 cells is 0.17%, far under it. */
export const cursor = (base: Grid): Grid => patched(base, 5, 5, 2, 2, 255);

export interface TempDir {
    path: string;
    remove(): void;
}

export function tempDir(prefix = "pikvm-watch-"): TempDir {
    const path = mkdtempSync(join(tmpdir(), prefix));
    return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

export function tempStore(root: string): WatchStore {
    return createWatchStore({ userDir: (id) => join(root, "users", id), usersRoot: () => join(root, "users") });
}

export const PROVIDER: ModelProvider = { baseUrl: "https://openrouter.test/api/v1", apiKey: "sk-test-key-not-real" };

export interface FakeModels extends ModelClient {
    /** The frames described, in order, as their labels (the test's JPEGs are labels). */
    described: string[];
    decided: { previous: string; current: string; rule: string }[];
    /** The verdict probability for the next decisions; the last one repeats. */
    answers: number[];
    describeError: ModelError | null;
    decideError: ModelError | null;
    costPerCall: number;
    /** Decisions asked again with the same request are answered from the cache, as the real client does. */
    cache: boolean;
}

export function fakeModels(): FakeModels {
    const models: FakeModels = {
        described: [],
        decided: [],
        answers: [0.02],
        describeError: null,
        decideError: null,
        costPerCall: 0.0001,
        cache: false,
        async describe(_provider, _model, jpeg): Promise<Described> {
            if (models.describeError) throw models.describeError;
            const label = jpeg.toString();
            models.described.push(label);
            return { text: `Screen ${label}. Something else.`, costUsd: models.costPerCall, cached: false };
        },
        async decide(_provider, input): Promise<Decided> {
            if (models.decideError) throw models.decideError;
            models.decided.push(input);
            const noul = models.answers.length > 1 ? models.answers.shift()! : models.answers[0]!;
            const verdict: Verdict = verdictOf(noul);
            const repeat = models.cache && models.decided.slice(0, -1).some((seen) => JSON.stringify(seen) === JSON.stringify(input));
            return repeat ? { noul, verdict, cached: true } : { noul, verdict, costUsd: models.costPerCall, cached: false };
        },
    };
    return models;
}

export interface FakePush extends Push {
    sent: { userId: string; payload: PushPayload }[];
    subscriptions: StoredSubscription[];
    /** What `send` answers; set `fail` to make it throw. */
    result: SendResult;
    fail: PushError | null;
}

export function fakePush(): FakePush {
    const push: FakePush = {
        sent: [],
        subscriptions: [],
        result: { sent: 1, removed: 0, failed: [] },
        fail: null,
        publicKey: () => "fake-public-key",
        subscribe: () => {
            throw new Error("not used");
        },
        unsubscribe: () => false,
        list: () => push.subscriptions,
        async send(userId, payload) {
            if (push.fail) throw push.fail;
            push.sent.push({ userId, payload });
            return push.result;
        },
    };
    return push;
}
