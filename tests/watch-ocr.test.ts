/**
 * The local OCR: the process around it (warm, one job at a time, killed and started afresh when a read passes its time) with a fake
 * worker, and ONE test of the real engine that runs only where the engine is installed.
 *
 * Failure modes, before behaviour:
 *  O1. A read waits for the models to load every time (no warm worker), or two reads run at once.
 *  O2. A read that hangs hangs the check forever (no time limit), or leaves a stuck process for the next read.
 *  O3. A missing model or a worker that cannot start is an unexplained crash, or is retried in a loop.
 *  O4. A worker that died takes the next read down with it.
 *  O5. The real engine cannot read a toast (skipped, with the reason, where it is not installed).
 *
 * The real engine needs onnxruntime-node and sharp (the image installs them) and the PP-OCRv4 models (the image fetches them):
 *   PIKVM_OCR_NODE_MODULES=<a node_modules with both> PIKVM_OCR_MODELS=<the models directory> yarn test
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createOcrEngine } from "../src/server/watch/ocr-engine";
import { OcrTimeoutError, OcrUnavailableError } from "../src/server/watch/ocr";
import { createPaddleReader, type OrtLike, type SharpLike } from "../src/server/watch/ocr-paddle";
import { readToast } from "../src/server/watch/toast-rules";
import { tempDir } from "./support/watch-rig";

const dir = tempDir("pikvm-ocr-");
after(() => dir.remove());
const models = join(dir.path, "models");
mkdirSync(models);
for (const name of ["ch_PP-OCRv4_det_infer.onnx", "ch_PP-OCRv4_rec_infer.onnx", "ppocr_keys_v1.txt"]) writeFileSync(join(models, name), "x");
const worker = join(dir.path, "ocr-worker.js");
writeFileSync(worker, "// a worker script that exists");

type Message = { id: number; image: Uint8Array };

/** A worker process that answers as the real one does, as scripted. */
class FakeChild extends EventEmitter {
    killed = false;
    received: Message[] = [];
    /** What to do with each message. */
    onMessage: (message: Message, child: FakeChild) => void = (message, child) => child.emit("message", { id: message.id, lines: [`read ${message.image.length}`], boxes: [{ x0: 0, y0: 0, x1: 1, y1: 1 }], ms: 5 });
    send(message: Message): boolean {
        this.received.push(message);
        queueMicrotask(() => this.onMessage(message, this));
        return true;
    }
    kill(): boolean {
        this.killed = true;
        queueMicrotask(() => this.emit("exit", null, "SIGKILL"));
        return true;
    }
}

function engine(over: { ready?: "ready" | "fatal" | "never"; modelsDir?: string; onChild?: (child: FakeChild) => void } = {}) {
    const children: FakeChild[] = [];
    const logs: string[] = [];
    const ocr = createOcrEngine({
        workerPath: worker,
        modelsDir: over.modelsDir ?? models,
        threads: 1,
        log: (line) => logs.push(line),
        fork: ((path: string) => {
            const child = new FakeChild();
            children.push(child);
            over.onChild?.(child);
            if ((over.ready ?? "ready") === "ready") setImmediate(() => child.emit("message", { ready: true }));
            if (over.ready === "fatal") setImmediate(() => child.emit("message", { fatal: "no onnxruntime" }));
            assert.equal(path, worker);
            return child;
        }) as never,
    });
    return { ocr, children, logs };
}

describe("the process around the OCR", () => {
    it("O1: the first read starts one worker and waits for its models; the ones after reuse it; warm starts it early", async () => {
        const { ocr, children } = engine();
        const first = await ocr.read(Buffer.from("abc"), 1000);
        assert.deepEqual(first.lines, ["read 3"]);
        assert.deepEqual(first.boxes, [{ x0: 0, y0: 0, x1: 1, y1: 1 }], "the places of the lines come through");
        await ocr.read(Buffer.from("abcd"), 1000);
        assert.equal(children.length, 1, "one warm worker");

        const early = engine();
        early.ocr.warm?.();
        assert.equal(early.children.length, 1, "warm started it before any read");
        early.ocr.warm?.();
        assert.equal(early.children.length, 1, "and once");
        ocr.close();
        early.ocr.close();
    });

    it("O1: reads run one at a time, in the order they were asked", async () => {
        const order: string[] = [];
        let busy = 0;
        const { ocr } = engine({
            onChild(child) {
                child.onMessage = (message, self) => {
                    busy++;
                    assert.equal(busy, 1, "never two at once");
                    order.push(`start ${message.id}`);
                    setImmediate(() => {
                        busy--;
                        order.push(`end ${message.id}`);
                        self.emit("message", { id: message.id, lines: [String(message.id)], ms: 1 });
                    });
                };
            },
        });
        const results = await Promise.all([ocr.read(Buffer.from("a"), 1000), ocr.read(Buffer.from("b"), 1000), ocr.read(Buffer.from("c"), 1000)]);
        assert.deepEqual(results.map((result) => result.lines[0]), ["1", "2", "3"]);
        assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
        ocr.close();
    });

    // The two time-limit tests below use the engine's real timer (40 ms): the limit is the thing under test, and a fake child that never answers cannot be advanced.
    it("O2: a read past its time is an OcrTimeoutError, the worker is killed, and the next read gets a fresh one", async () => {
        let first = true;
        const { ocr, children, logs } = engine({
            onChild(child) {
                if (first) child.onMessage = () => undefined;
                first = false;
            },
        });
        await assert.rejects(ocr.read(Buffer.from("slow"), 40), (error: unknown) => error instanceof OcrTimeoutError && /ocr timed out after 40 ms/.test(error.message));
        assert.equal(children[0]!.killed, true);
        assert.ok(logs.some((line) => /passed 40 ms/.test(line)));
        const next = await ocr.read(Buffer.from("again"), 1000);
        assert.deepEqual(next.lines, ["read 5"]);
        assert.equal(children.length, 2);
        ocr.close();
    });

    it("O2: the time limit counts the load of the models too: a worker that never gets ready is a timeout", async () => {
        const { ocr, children } = engine({ ready: "never" });
        await assert.rejects(ocr.read(Buffer.from("x"), 40), OcrTimeoutError);
        assert.equal(children[0]!.killed, true);
        ocr.close();
    });

    it("O3: missing models or a missing worker say so and start nothing", async () => {
        const missing = engine({ modelsDir: join(dir.path, "nowhere") });
        await assert.rejects(missing.ocr.read(Buffer.from("x"), 100), (error: unknown) => error instanceof OcrUnavailableError && /OCR models are not installed/.test(error.message));
        assert.equal(missing.children.length, 0);

        const noWorker = createOcrEngine({ workerPath: join(dir.path, "absent.js"), modelsDir: models, fork: (() => assert.fail("must not start")) as never });
        await assert.rejects(noWorker.read(Buffer.from("x"), 100), /worker .* is not built/);
    });

    it("O3: a worker that cannot load its models is unavailable, once and for good, not restarted for every toast", async () => {
        const { ocr, children, logs } = engine({ ready: "fatal" });
        await assert.rejects(ocr.read(Buffer.from("x"), 1000), (error: unknown) => error instanceof OcrUnavailableError && /could not start: no onnxruntime/.test(error.message));
        await assert.rejects(ocr.read(Buffer.from("y"), 1000), OcrUnavailableError);
        assert.equal(children.length, 1);
        assert.ok(logs.some((line) => /no onnxruntime/.test(line)));
        ocr.close();
    });

    it("O4: a worker that died mid-read fails that read only; the next one starts a new worker", async () => {
        let first = true;
        const { ocr, children } = engine({
            onChild(child) {
                if (first) child.onMessage = (_message, self) => self.emit("exit", 1, null);
                first = false;
            },
        });
        await assert.rejects(ocr.read(Buffer.from("x"), 1000), /the OCR process exited/);
        const next = await ocr.read(Buffer.from("yy"), 1000);
        assert.deepEqual(next.lines, ["read 2"]);
        assert.equal(children.length, 2);
        ocr.close();
    });

    it("a read the worker reports as failed carries its message; a closed engine reads nothing", async () => {
        const { ocr } = engine({
            onChild(child) {
                child.onMessage = (message, self) => self.emit("message", { id: message.id, error: "bad image" });
            },
        });
        await assert.rejects(ocr.read(Buffer.from("x"), 1000), /bad image/);
        ocr.close();
        await assert.rejects(ocr.read(Buffer.from("x"), 1000), OcrUnavailableError);
    });
});

// ---- the real engine --------------------------------------------------------------------------------------------------------

const nodeModules = process.env["PIKVM_OCR_NODE_MODULES"];
const modelsDir = process.env["PIKVM_OCR_MODELS"];

function realEngine(): { ort: OrtLike; sharp: SharpLike } | string {
    if (!nodeModules || !modelsDir) return "set PIKVM_OCR_NODE_MODULES (a node_modules with onnxruntime-node and sharp) and PIKVM_OCR_MODELS (the PP-OCRv4 models directory) to run it";
    try {
        // The module names are built at run time so the test bundle does not try to bundle native addons.
        const load = createRequire(join(nodeModules, "x.js"));
        const names = ["onnxruntime", "sharp"].map((name) => (name === "onnxruntime" ? "onnxruntime-node" : name));
        return { ort: load(names[0]!) as OrtLike, sharp: load(names[1]!) as SharpLike };
    } catch (error) {
        return `the engine's packages cannot be loaded from ${nodeModules}: ${error instanceof Error ? error.message : String(error)}`;
    }
}

describe("the real engine", () => {
    const real = realEngine();
    const skip = typeof real === "string" ? `skipped: ${real}` : false;

    it("O5: reads a Teams call toast and an Outlook mail toast, and the rules make a notification of them", { skip }, async () => {
        if (typeof real === "string") return;
        const reader = await createPaddleReader(
            { det: join(modelsDir!, "ch_PP-OCRv4_det_infer.onnx"), rec: join(modelsDir!, "ch_PP-OCRv4_rec_infer.onnx"), dict: join(modelsDir!, "ppocr_keys_v1.txt") },
            real.ort,
            real.sharp,
        );
        const callRead = await reader.read(readFileSync(join(process.cwd(), "tests", "fixtures", "toast-teams-call.jpg")));
        assert.equal(callRead.boxes.length, callRead.lines.length, "a box for every line");
        assert.ok(callRead.boxes.every((box) => box.x0 >= 0 && box.y0 >= 0 && box.x1 <= 1 && box.y1 <= 1 && box.x1 > box.x0 && box.y1 > box.y0));
        const call = readToast(callRead.lines);
        assert.equal(call?.kind, "call");
        assert.equal(call?.title, "Incoming call: Priya Shah");
        assert.equal(call?.urgency, "high");
        const mail = readToast((await reader.read(readFileSync(join(process.cwd(), "tests", "fixtures", "toast-outlook-mail.jpg")))).lines);
        assert.equal(mail?.kind, "email");
        assert.equal(mail?.title, "Outlook");
        assert.match(mail?.body ?? "", /Anna Berg/);
        assert.match(mail?.body ?? "", /Lunch on Thursday/);
    });
});
