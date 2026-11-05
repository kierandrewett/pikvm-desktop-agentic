import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRID_CELLS, type Grid } from "../../src/server/watch/frame-diff";
import { GRID_WIDTH } from "../../src/server/watch/limits";
import type { AlertModel } from "../../src/server/watch/alerts";
import type { Ocr } from "../../src/server/watch/ocr";
import { JUDGE_PROMPT, READ_PROMPT } from "../../src/server/watch/prompts";
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

/** What one step of the fake model answers; a function can make it depend on the message. */
export type FakeAnswer = string | undefined | ((user: string) => string | undefined);

/** The two steps, as a test sees them. */
export type FakeStep = "read" | "judge";

export interface FakeModel extends AlertModel {
    /** A chat model is configured. */
    present: boolean;
    /** The requests made, in order: which step, the instructions, the message and the request's options. */
    asks: { step: FakeStep; system: string; user: string; timeoutMs: number; maxTokens: number; json: boolean }[];
    /** What each step answers. */
    answer: Record<FakeStep, FakeAnswer>;
    /** Make a step fail with this. */
    error: Record<FakeStep, Error | null>;
    /** While set for a step, it never answers: a model that is too slow. */
    hang: Record<FakeStep, boolean>;
    /** Called when a request is made, so a test can let time pass while the model "thinks". */
    onAsk: ((step: FakeStep) => void) | null;
}

/** The facts of a pop-up as step 1 answers them. */
export const FACTS_JSON = JSON.stringify({
    source: "Outlook",
    from: "Anna Berg",
    subject: "Lunch on Thursday?",
    text: "Outlook / Anna Berg / Lunch on Thursday? / Are you free at 12:30 for the quarterly review",
    when: "12:30",
    numbers_and_codes: ["12:30"],
    actions: [],
    urgent_words: [],
});

/** A verdict as step 2 answers it. */
export const verdictJson = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ reason: "person_waiting", notify: true, body: "Anna Berg asks if you are free Thursday at 12:30 for the quarterly review.", title: "Anna Berg", ...over });

export function fakeModel(): FakeModel {
    const model: FakeModel = {
        present: true,
        asks: [],
        answer: { read: FACTS_JSON, judge: verdictJson() },
        error: { read: null, judge: null },
        hang: { read: false, judge: false },
        onAsk: null,
        available: () => model.present,
        async ask(system, user, options) {
            const step: FakeStep = system === READ_PROMPT ? "read" : "judge";
            if (step === "judge" && !system.startsWith(JUDGE_PROMPT)) throw new Error("the fake model was asked something that is neither step");
            model.asks.push({ step, system, user, ...options });
            model.onAsk?.(step);
            if (!model.present) return undefined;
            if (model.hang[step]) return new Promise<never>(() => undefined);
            const error = model.error[step];
            if (error) throw error;
            const answer = model.answer[step];
            return typeof answer === "function" ? answer(user) : answer;
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
