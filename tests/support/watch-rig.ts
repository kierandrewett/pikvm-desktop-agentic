import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRID_CELLS, type Grid } from "../../src/server/watch/frame-diff";
import { GRID_WIDTH } from "../../src/server/watch/limits";
import type { AlertModel } from "../../src/server/watch/alerts";
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

export interface FakeModel extends AlertModel {
    /** A chat model is configured. */
    present: boolean;
    /** The requests made: the instructions, the message and the time limit. */
    asks: { system: string; user: string; timeoutMs: number }[];
    /** What the model answers; a function can make it depend on the message. */
    answer: string | undefined | ((user: string) => string | undefined);
    /** Make every request fail with this. */
    error: Error | null;
    /** While set, a request never answers: a model that is too slow. */
    hang: boolean;
    /** Called when a request is made, so a test can let time pass while the model "thinks". */
    onAsk: (() => void) | null;
}

export function fakeModel(): FakeModel {
    const model: FakeModel = {
        present: true,
        asks: [],
        answer: "Anna Berg asks if you are free Thursday at 12:30 for the quarterly review",
        error: null,
        hang: false,
        onAsk: null,
        available: () => model.present,
        async ask(system, user, timeoutMs) {
            model.asks.push({ system, user, timeoutMs });
            model.onAsk?.();
            if (!model.present) return undefined;
            if (model.hang) return new Promise<never>(() => undefined);
            if (model.error) throw model.error;
            return typeof model.answer === "function" ? model.answer(user) : model.answer;
        },
    };
    return model;
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
