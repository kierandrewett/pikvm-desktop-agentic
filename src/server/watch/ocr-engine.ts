import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OcrTimeoutError, OcrUnavailableError, type Ocr, type OcrResult } from "./ocr";

/**
 * The OCR as the host runs it: PP-OCRv4 (ocr-paddle.ts) in a forked process of its own (ocr-worker.ts), warm after the first read,
 * one job at a time, killed and started afresh when a read passes its time. No network; the models are files in the image.
 *
 * `PIKVM_OCR_MODELS` (default /opt/ocr/models) is the directory of the two models and the dictionary, `PIKVM_OCR_WORKER` the worker's
 * script (default `ocr-worker.js` beside the host's bundle) and `PIKVM_OCR_THREADS` onnxruntime's threads in it (default 2).
 */

const MODEL_FILES = ["ch_PP-OCRv4_det_infer.onnx", "ch_PP-OCRv4_rec_infer.onnx", "ppocr_keys_v1.txt"] as const;

export interface OcrEngineOptions {
    /** The worker's script. Default: `PIKVM_OCR_WORKER`, else `ocr-worker.js` beside this bundle. */
    workerPath?: string;
    modelsDir?: string;
    threads?: number;
    log?: (line: string) => void;
    /** Test seam: how the worker is started. */
    fork?: typeof fork;
}

interface WorkerReply {
    ready?: true;
    fatal?: string;
    id?: number;
    lines?: string[];
    boxes?: OcrResult["boxes"];
    ms?: number;
    error?: string;
}

interface Live {
    child: ChildProcess;
    ready: Promise<void>;
}

export function createOcrEngine(options: OcrEngineOptions = {}): Ocr {
    const log = options.log ?? (() => undefined);
    const doFork = options.fork ?? fork;
    const modelsDir = options.modelsDir ?? process.env["PIKVM_OCR_MODELS"] ?? "/opt/ocr/models";
    const workerPath = options.workerPath ?? process.env["PIKVM_OCR_WORKER"] ?? join(__dirname, "ocr-worker.js");
    const threads = options.threads ?? Number(process.env["PIKVM_OCR_THREADS"] ?? "2");
    let live: Live | null = null;
    let unavailable: OcrUnavailableError | null = null;
    let nextId = 1;
    let closed = false;
    /** The job in flight, if any: how the worker's replies and its exit reach it. */
    let job: { id: number; settle(reply: WorkerReply | Error): void } | null = null;
    let chain: Promise<unknown> = Promise.resolve();

    function start(): Live {
        const missing = MODEL_FILES.filter((name) => !existsSync(join(modelsDir, name)));
        if (missing.length > 0) throw new OcrUnavailableError(`The OCR models are not installed (${missing.join(", ")} missing from ${modelsDir}).`);
        if (!existsSync(workerPath)) throw new OcrUnavailableError(`The OCR worker ${workerPath} is not built.`);
        const child = doFork(workerPath, [], {
            serialization: "advanced",
            execArgv: [],
            stdio: ["ignore", "inherit", "inherit", "ipc"],
            env: { ...process.env, PIKVM_OCR_MODELS: modelsDir, PIKVM_OCR_THREADS: String(threads), ORT_DISABLE_TELEMETRY: "1" },
        });
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        // A rejection nobody awaits yet (a warm-up that failed) is not an unhandled one.
        promise.catch(() => undefined);
        child.on("message", (message: WorkerReply) => {
            if (message.ready) return resolve();
            if (message.fatal !== undefined) {
                unavailable = new OcrUnavailableError(`The OCR could not start: ${message.fatal}`);
                log(`[watch] ${unavailable.message}`);
                return reject(unavailable);
            }
            if (job && message.id === job.id) job.settle(message);
        });
        child.on("exit", (code, signal) => {
            if (live?.child === child) live = null;
            const why = new Error(`the OCR process exited (${signal ?? code})`);
            reject(why);
            job?.settle(why);
        });
        child.on("error", (error) => {
            reject(error);
            job?.settle(error);
        });
        return { child, ready: promise };
    }

    function stop(): void {
        const current = live;
        live = null;
        current?.child.kill("SIGKILL");
    }

    async function run(image: Buffer, timeoutMs: number): Promise<OcrResult> {
        if (closed) throw new OcrUnavailableError("The OCR was shut down.");
        if (unavailable) throw unavailable;
        const startedAt = performance.now();
        const worker = (live ??= start());
        const id = nextId++;
        const { promise, resolve } = Promise.withResolvers<WorkerReply | Error>();
        const timer = setTimeout(() => resolve(new OcrTimeoutError(timeoutMs)), timeoutMs);
        job = { id, settle: resolve };
        try {
            // The models load on the first read (or when the engine was warmed): that counts against the time, so a stuck load is a timeout too.
            await Promise.race([worker.ready, promise.then((reply) => (reply instanceof Error ? Promise.reject(reply) : undefined))]);
            worker.child.send({ id, image });
            const reply = await promise;
            if (reply instanceof Error) throw reply;
            if (reply.error !== undefined) throw new Error(reply.error);
            return { lines: reply.lines ?? [], ...(reply.boxes ? { boxes: reply.boxes } : {}), ms: Math.round(performance.now() - startedAt) };
        } catch (error) {
            // A read that timed out, or a worker that died, leaves a process in an unknown state: start over next time.
            if (error instanceof OcrTimeoutError) log(`[watch] ocr read passed ${timeoutMs} ms; the worker is restarted`);
            stop();
            throw error;
        } finally {
            clearTimeout(timer);
            job = null;
        }
    }

    return {
        read(image, timeoutMs) {
            // One at a time, in order; a failed read does not stop the ones behind it.
            const result = chain.then(() => run(image, timeoutMs));
            chain = result.catch(() => undefined);
            return result;
        },
        unavailable() {
            if (closed) return "The OCR was shut down.";
            if (unavailable) return unavailable.message;
            const missing = MODEL_FILES.filter((name) => !existsSync(join(modelsDir, name)));
            if (missing.length > 0) return `The OCR models are not installed (${missing.join(", ")} missing from ${modelsDir}).`;
            return existsSync(workerPath) ? undefined : `The OCR worker ${workerPath} is not built.`;
        },
        warm() {
            if (live || unavailable || closed) return;
            try {
                live = start();
            } catch (error) {
                if (error instanceof OcrUnavailableError) unavailable = error;
                log(`[watch] ${error instanceof Error ? error.message : String(error)}`);
            }
        },
        close() {
            closed = true;
            stop();
        },
    };
}
