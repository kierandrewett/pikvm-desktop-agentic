/**
 * Client for the agent runtime's RPC mode: newline-delimited JSON over stdin/stdout.
 *
 * - commands carry an `id`; responses are matched by id, never by order
 * - protocol v2 is negotiated so large frames arrive as `rpc_chunk` sequences, reassembled here
 * - `extension_ui_request` frames that need an answer (select, confirm, input, editor, ask) go to the
 *   `onUiRequest` handler; the reader never blocks on it
 * - every other frame is an event for `onEvent`
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { SpawnSpec } from "./launch.ts";

export type Frame = { type: string; [k: string]: unknown };

/** One question of an `ask` request, as the runtime sends it. */
export interface AskQuestionWire {
    id: string;
    question: string;
    options: { label: string; description?: string; preview?: string }[];
    header?: string;
    multi?: boolean;
    recommended?: number;
}

export interface UiRequest {
    id: string;
    method: "select" | "confirm" | "input" | "editor" | "ask";
    title?: string;
    message?: string;
    options?: string[];
    /** Descriptions aligned with `options` (select). */
    optionDetails?: { description?: string }[];
    placeholder?: string;
    prefill?: string;
    timeout?: number;
    /** Every question of one `ask` tool call. */
    questions?: AskQuestionWire[];
}

export type UiAnswer =
    | { value: string }
    | { confirmed: boolean }
    | { answers: { id: string; selectedOptions: string[]; customInput?: string }[] }
    | { cancelled: true; timedOut?: boolean };

export class RpcError extends Error {
    constructor(
        message: string,
        readonly command: string,
        readonly code?: string,
    ) {
        super(message);
    }
}

const ANSWERED_METHODS = new Set(["select", "confirm", "input", "editor", "ask"]);
const MAX_STDERR_LINES = 200;

export class RpcClient {
    readonly proc: ChildProcessByStdio<Writable, Readable, Readable>;
    readonly exited: Promise<number>;
    readonly stderr: string[] = [];
    onEvent: (frame: Frame) => void = () => {};
    onUiRequest: (req: UiRequest) => Promise<UiAnswer> = async () => ({ cancelled: true });

    #seq = 0;
    #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; command: string }>();
    #chunks = new Map<string, string[]>();
    #ready: Promise<void>;
    #closed = false;

    constructor(spec: SpawnSpec, label: string) {
        const [command, ...args] = spec.argv;
        this.proc = spawn(command!, args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
        // A missing binary or a failed exec arrives as an error event and never as an exit: fold it into `exited`.
        const spawnFailed = new Promise<number>((resolve) => {
            this.proc.once("error", (err) => {
                this.stderr.push(String(err.message));
                resolve(-1);
            });
        });
        // A broken pipe on stdin is reported by #write's caller through the pending command; do not crash the host.
        this.proc.stdin.on("error", () => {});
        let markReady!: () => void;
        let failReady!: (e: Error) => void;
        this.#ready = new Promise((res, rej) => {
            markReady = res;
            failReady = rej;
        });
        this.#readStdout(markReady);
        this.#readStderr(label);
        const exitCode = new Promise<number>((resolve) => {
            this.proc.once("close", (code, signal) => resolve(code ?? (signal ? 128 : -1)));
        });
        this.exited = Promise.race([exitCode, spawnFailed]).then((code) => {
            this.#closed = true;
            const err = new Error(`[agent] ${label} exited with ${code}: ${this.stderr.slice(-5).join(" | ")}`);
            failReady(err);
            for (const p of this.#pending.values()) p.reject(err);
            this.#pending.clear();
            return code;
        });
    }

    get closed(): boolean {
        return this.#closed;
    }

    /** Resolves once the runtime is ready and protocol v2 is negotiated. */
    async ready(timeoutMs = 30_000): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            this.#ready,
            new Promise<never>((_, rej) => {
                timer = setTimeout(() => rej(new Error("[agent] runtime did not become ready")), timeoutMs);
            }),
        ]).finally(() => clearTimeout(timer));
    }

    /**
     * Send a command and wait for its response `data`. `onId` gets the command id before it is sent, for
     * frames that refer back to it (`prompt_result`).
     */
    request<T = unknown>(type: string, payload: Record<string, unknown> = {}, onId?: (id: string) => void): Promise<T> {
        if (this.#closed) return Promise.reject(new RpcError("runtime is not running", type));
        const id = `c${++this.#seq}`;
        onId?.(id);
        const p = new Promise<T>((resolve, reject) => {
            this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, command: type });
        });
        try {
            this.#write({ id, type, ...payload });
        } catch (err) {
            // The pipe broke before the exit was noticed: fail this command, never throw to the caller.
            this.#pending.get(id)?.reject(new RpcError(`runtime is not running (${(err as Error).message})`, type));
            this.#pending.delete(id);
        }
        return p;
    }

    /** Fire-and-forget frame (UI answers, host tool results). Dropped when the runtime is gone. */
    send(frame: Record<string, unknown>): void {
        if (this.#closed) return;
        try {
            this.#write(frame);
        } catch {}
    }

    /** Close stdin and wait for a clean exit; kill if it does not exit in time. */
    async close(graceMs = 3000): Promise<void> {
        if (this.#closed) return;
        try {
            this.proc.stdin.end();
        } catch {}
        const t = setTimeout(() => this.proc.kill("SIGKILL"), graceMs);
        await this.exited;
        clearTimeout(t);
    }

    kill(): void {
        this.proc.kill("SIGKILL");
    }

    #write(obj: unknown): void {
        if (!this.proc.stdin.writable) throw new Error("stdin is closed");
        this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
    }

    async #readStdout(markReady: () => void): Promise<void> {
        const dec = new TextDecoder();
        let buf = "";
        for await (const bytes of this.proc.stdout) {
            buf += dec.decode(bytes as Buffer, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let frame: Frame;
                try {
                    frame = JSON.parse(line);
                } catch {
                    console.warn(`[agent] non-JSON stdout line: ${line.slice(0, 200)}`);
                    continue;
                }
                this.#dispatch(frame, markReady);
            }
        }
    }

    async #readStderr(label: string): Promise<void> {
        const dec = new TextDecoder();
        let buf = "";
        for await (const bytes of this.proc.stderr) {
            buf += dec.decode(bytes as Buffer, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const l of lines) {
                if (!l.trim()) continue;
                this.stderr.push(l);
                if (this.stderr.length > MAX_STDERR_LINES) this.stderr.shift();
                if (process.env.CHAT_AGENT_DEBUG) console.error(`[agent:${label}] ${l}`);
            }
        }
    }

    #dispatch(frame: Frame, markReady: () => void): void {
        switch (frame.type) {
            case "ready":
                this.request("negotiate_protocol", { protocolVersion: 2 })
                    .catch(() => undefined)
                    .finally(markReady);
                return;
            case "rpc_chunk":
                this.#chunk(frame, markReady);
                return;
            case "response":
                this.#response(frame);
                return;
            case "extension_ui_request":
                this.#uiRequest(frame);
                return;
            default:
                this.onEvent(frame);
        }
    }

    #chunk(frame: Frame, markReady: () => void): void {
        const { chunkId, index, count, data } = frame as unknown as {
            chunkId: string;
            index: number;
            count: number;
            data: string;
        };
        const parts = this.#chunks.get(chunkId) ?? new Array<string>(count);
        parts[index] = data;
        this.#chunks.set(chunkId, parts);
        if (parts.filter((p) => p !== undefined).length < count) return;
        this.#chunks.delete(chunkId);
        const bytes = Buffer.concat(parts.map((p) => Buffer.from(p, "base64")));
        this.#dispatch(JSON.parse(bytes.toString("utf8")), markReady);
    }

    #response(frame: Frame): void {
        const id = frame.id as string | undefined;
        const p = id ? this.#pending.get(id) : undefined;
        if (!p) return;
        this.#pending.delete(id!);
        if (frame.success) p.resolve(frame.data);
        else
            p.reject(
                new RpcError(String(frame.error ?? "command failed"), p.command, frame.code as string | undefined),
            );
    }

    #uiRequest(frame: Frame): void {
        const req = frame as unknown as UiRequest & { method: string };
        if (!ANSWERED_METHODS.has(req.method)) {
            this.onEvent(frame);
            return;
        }
        this.onUiRequest(req as UiRequest)
            .catch((): UiAnswer => ({ cancelled: true }))
            .then((answer) => this.send({ type: "extension_ui_response", id: req.id, ...answer }));
    }
}
