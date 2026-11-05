import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRID_CELLS, type Grid } from "../../src/server/watch/frame-diff";
import { GRID_WIDTH } from "../../src/server/watch/limits";
import type { Decided, Described, ModelClient, ModelProvider, Verdict } from "../../src/server/watch/models";
import { ModelError, verdictOf } from "../../src/server/watch/models";
import type { Ocr } from "../../src/server/watch/ocr";
import type { Push, PushPayload, SendOptions, SendResult, StoredSubscription } from "../../src/server/watch/push";
import { PushError } from "../../src/server/watch/push";
import { createWatchStore, type WatchStore } from "../../src/server/watch/store";

/** The bytes of a JPEG header that says it is `width` x `height` (all `jpegSize` reads), then `label`: a fake snapshot a test can tell apart. */
export function fakeJpeg(width: number, height: number, label: string): Buffer {
    const head = Buffer.alloc(11);
    head.writeUInt16BE(0xffd8, 0);
    head.writeUInt16BE(0xffc0, 2);
    head.writeUInt16BE(17, 4);
    head[6] = 8;
    head.writeUInt16BE(height, 7);
    head.writeUInt16BE(width, 9);
    return Buffer.concat([head, Buffer.from(label)]);
}

/** The label `fakeJpeg` was given. */
export const fakeJpegLabel = (jpeg: Buffer): string => jpeg.subarray(11).toString();

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
    /** The corner crops described for fast alerts, as their labels. */
    alerted: string[];
    /** What a crop's description is, by its label; the default is "Alert <label>. Something else." */
    alertText: Record<string, string>;
    /** Called once a fast description is made, so a test can let time pass while a model is "thinking". */
    afterAlert: (() => void) | null;
    /** While set, a fast description waits for it: a model that has not answered yet. */
    alertGate: Promise<void> | null;
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
        alerted: [],
        alertText: {},
        afterAlert: null,
        alertGate: null,
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
        async describeAlert(_provider, _model, jpeg): Promise<Described> {
            if (models.describeError) throw models.describeError;
            const label = jpeg.toString();
            models.alerted.push(label);
            if (models.alertGate) await models.alertGate;
            models.afterAlert?.();
            return { text: models.alertText[label] ?? `Alert ${label}. Something else.`, costUsd: models.costPerCall, cached: false };
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
    sent: { userId: string; payload: PushPayload; options: SendOptions | undefined }[];
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
        async send(userId, payload, options) {
            if (push.fail) throw push.fail;
            push.sent.push({ userId, payload, options });
            return push.result;
        },
    };
    return push;
}

export interface FakeOcr extends Ocr {
    /** The lines a crop reads as, by the crop's label (the bytes the test's `crop` made); an unknown crop reads as nothing. */
    texts: Record<string, string[]>;
    /** Where each of those lines is, by the crop's label, as fractions of the crop; without it the engine says nothing about places. */
    boxes: Record<string, { x0: number; y0: number; x1: number; y1: number }[]>;
    /** The labels read, in order. */
    reads: string[];
    /** The time limits each read was given. */
    limits: number[];
    /** Make every read fail with this. */
    error: Error | null;
    /** While set, a read waits for it: an OCR that has not finished yet. */
    gate: Promise<void> | null;
    /** Called once a read is done, so a test can let time pass while the OCR is "working". */
    afterRead: (() => void) | null;
    /** What each read reports as its own time. */
    msPerRead: number;
    closed: boolean;
    /** Why the engine cannot run here; undefined when it can. */
    unavailableReason: string | undefined;
}

export function fakeOcr(): FakeOcr {
    const ocr: FakeOcr = {
        texts: {},
        boxes: {},
        reads: [],
        limits: [],
        error: null,
        gate: null,
        afterRead: null,
        msPerRead: 120,
        closed: false,
        unavailableReason: undefined,
        unavailable: () => ocr.unavailableReason,
        async read(image, timeoutMs) {
            const label = image.toString();
            ocr.reads.push(label);
            ocr.limits.push(timeoutMs);
            if (ocr.gate) await ocr.gate;
            if (ocr.error) throw ocr.error;
            ocr.afterRead?.();
            const boxes = ocr.boxes[label];
            return { lines: ocr.texts[label] ?? [], ...(boxes ? { boxes } : {}), ms: ocr.msPerRead };
        },
        close() {
            ocr.closed = true;
        },
    };
    return ocr;
}
