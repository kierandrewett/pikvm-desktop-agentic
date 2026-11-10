import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RecordingMime, RecordingStatus, RecordingView, Transcript } from "@pikvm/contracts/recordings";
import type { RecordingLimits } from "./limits";

/**
 * Where recordings live and what is allowed to happen to them.
 *
 *   <dataDir>/recordings/<id>/recording.webm | recording.mp4   the one media file, chunks appended in order
 *                            meta.json                         the state below (rewritten on every change of status)
 *                            transcript.json, transcript.txt   once transcribed
 *                            work/                             the transcriber's decoded audio, gone when it ends
 *
 * An id is 32 lowercase hex digits from crypto.randomBytes and is checked against ID_PATTERN before any path is built from it, so
 * a request can never name a path outside the recordings directory. Everything that changes one recording runs under that
 * recording's own lock, so a delete waits for the chunk being written and two uploads of the same chunk cannot both pass.
 */

export const ID_PATTERN = /^[0-9a-f]{32}$/;
export const isRecordingId = (value: string): boolean => ID_PATTERN.test(value);

/** A refusal the route answers as `{ error, ...extra }` with this status. */
export class RecordingRefusal extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly extra: Record<string, unknown> = {},
    ) {
        super(message);
        this.name = "RecordingRefusal";
    }
}

const notFound = (): RecordingRefusal => new RecordingRefusal("There is no such recording.", 404);

/** The size bound a chunk ran into while it was being written. */
class BoundReached extends Error {
    constructor(readonly bound: "chunk" | "recording" | "total") {
        super(`bound reached: ${bound}`);
    }
}

interface Meta {
    id: string;
    status: RecordingStatus;
    mime: RecordingMime;
    startedAt: string;
    /** Milliseconds since the epoch, the host's clock. */
    createdAt: number;
    /** When it was closed (the retention clock starts here); null while recording. */
    endedAt: number | null;
    durationMs: number | null;
    target: string | null;
    error: string | null;
    speakers: number | null;
}

interface Entry {
    meta: Meta;
    /** Bytes in the media file, every chunk counted. */
    bytes: number;
    /** Chunks received: the next chunk's number. Only meaningful while recording. */
    chunks: number;
    /** When the last chunk landed (or the recording was made), milliseconds. */
    lastActivity: number;
    /** 0..1 while transcribing; kept in memory, not on disk. */
    progress: number | null;
    /** The chain every change to this recording runs on. */
    tail: Promise<unknown>;
    /** The chunk in flight, so a delete can stop it. */
    upload: AbortController | null;
}

export interface StoreOptions {
    dataDir: string;
    limits: RecordingLimits;
    now?: () => number;
    log?: (line: string) => void;
}

export interface Created {
    mime: RecordingMime;
    startedAt: string;
    target: string | null;
}

export interface Loaded {
    /** Recordings that were still recording when the host last stopped. */
    open: string[];
    /** Recordings whose transcription was queued or running. */
    transcribing: string[];
}

export class RecordingStore {
    readonly root: string;
    private readonly entries = new Map<string, Entry>();
    private readonly now: () => number;
    private readonly log: (line: string) => void;
    readonly limits: RecordingLimits;

    constructor(options: StoreOptions) {
        this.root = join(options.dataDir, "recordings");
        this.limits = options.limits;
        this.now = options.now ?? Date.now;
        this.log = options.log ?? (() => undefined);
    }

    // ── paths ────────────────────────────────────────────────────────────────────────────────────────────────────
    /** The directory of a recording. The only place a path is built from an id, and it refuses anything that is not one. */
    dirOf(id: string): string {
        if (!isRecordingId(id)) throw notFound();
        return join(this.root, id);
    }

    mediaPath(id: string): string {
        return join(this.dirOf(id), this.fileName(this.entry(id).meta.mime));
    }

    workDir(id: string): string {
        return join(this.dirOf(id), "work");
    }

    private fileName(mime: RecordingMime): string {
        return mime === "video/mp4" ? "recording.mp4" : "recording.webm";
    }

    // ── loading ──────────────────────────────────────────────────────────────────────────────────────────────────
    async load(): Promise<Loaded> {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const loaded: Loaded = { open: [], transcribing: [] };
        for (const name of await readdir(this.root)) {
            if (!isRecordingId(name)) continue;
            const meta = await this.readMeta(name);
            if (!meta) {
                // A crash between the directory and its meta.json leaves an empty directory; anything else is not ours to remove.
                const left = await readdir(join(this.root, name)).catch(() => ["?"]);
                if (left.length === 0) await rm(join(this.root, name), { recursive: true, force: true });
                else this.log(`[recordings] ${name} has no readable meta.json; left alone`);
                continue;
            }
            const file = join(this.root, name, this.fileName(meta.mime));
            const info = await stat(file).catch(() => null);
            this.entries.set(name, {
                meta,
                bytes: info?.size ?? 0,
                chunks: 0,
                lastActivity: info?.mtimeMs ?? meta.createdAt,
                progress: null,
                tail: Promise.resolve(),
                upload: null,
            });
            if (meta.status === "recording") loaded.open.push(name);
            if (meta.status === "transcribing") loaded.transcribing.push(name);
        }
        return loaded;
    }

    private async readMeta(id: string): Promise<Meta | null> {
        try {
            const raw: unknown = JSON.parse(await readFile(join(this.root, id, "meta.json"), "utf8"));
            if (typeof raw !== "object" || raw === null) return null;
            const m = raw as Record<string, unknown>;
            const statuses: readonly unknown[] = ["recording", "ready", "transcribing", "done", "failed"];
            const mimes: readonly unknown[] = ["video/webm", "video/mp4"];
            if (m["id"] !== id || !statuses.includes(m["status"]) || !mimes.includes(m["mime"]) || typeof m["startedAt"] !== "string") return null;
            if (typeof m["createdAt"] !== "number") return null;
            const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
            const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
            return {
                id,
                status: m["status"] as RecordingStatus,
                mime: m["mime"] as RecordingMime,
                startedAt: m["startedAt"],
                createdAt: m["createdAt"],
                endedAt: num(m["endedAt"]),
                durationMs: num(m["durationMs"]),
                target: str(m["target"]),
                error: str(m["error"]),
                speakers: num(m["speakers"]),
            };
        } catch {
            return null;
        }
    }

    private async writeMeta(meta: Meta): Promise<void> {
        const dir = join(this.root, meta.id);
        const tmp = join(dir, "meta.json.tmp");
        await writeFile(tmp, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
        await rename(tmp, join(dir, "meta.json"));
    }

    // ── reading ──────────────────────────────────────────────────────────────────────────────────────────────────
    private entry(id: string): Entry {
        const entry = isRecordingId(id) ? this.entries.get(id) : undefined;
        if (!entry) throw notFound();
        return entry;
    }

    has(id: string): boolean {
        return isRecordingId(id) && this.entries.has(id);
    }

    status(id: string): RecordingStatus {
        return this.entry(id).meta.status;
    }

    bytesOf(id: string): number {
        return this.entry(id).bytes;
    }

    mimeOf(id: string): RecordingMime {
        return this.entry(id).meta.mime;
    }

    durationMsOf(id: string): number | null {
        return this.entry(id).meta.durationMs;
    }

    totalBytes(): number {
        let total = 0;
        for (const entry of this.entries.values()) total += entry.bytes;
        return total;
    }

    private expiresAt(meta: Meta): string | null {
        if (this.limits.retentionDays <= 0 || meta.endedAt === null) return null;
        return new Date(meta.endedAt + this.limits.retentionDays * 86_400_000).toISOString();
    }

    private viewOf(entry: Entry): RecordingView {
        const { meta } = entry;
        return {
            id: meta.id,
            status: meta.status,
            mime: meta.mime,
            startedAt: meta.startedAt,
            durationMs: meta.durationMs,
            bytes: entry.bytes,
            target: meta.target,
            expiresAt: this.expiresAt(meta),
            error: meta.error,
            progress: meta.status === "transcribing" ? (entry.progress ?? 0) : null,
            speakers: meta.status === "done" ? meta.speakers : null,
        };
    }

    view(id: string): RecordingView {
        return this.viewOf(this.entry(id));
    }

    /** Newest first. */
    views(): RecordingView[] {
        return [...this.entries.values()].sort((a, b) => b.meta.createdAt - a.meta.createdAt).map((e) => this.viewOf(e));
    }

    /** Recordings past their retention, as of now. */
    expired(): string[] {
        const days = this.limits.retentionDays;
        if (days <= 0) return [];
        const now = this.now();
        return [...this.entries.values()].filter((e) => e.meta.endedAt !== null && now >= e.meta.endedAt + days * 86_400_000).map((e) => e.meta.id);
    }

    /** Recordings that never finished and have received nothing for the idle time. */
    idle(): string[] {
        const now = this.now();
        return [...this.entries.values()].filter((e) => e.meta.status === "recording" && now - e.lastActivity >= this.limits.idleCloseMs).map((e) => e.meta.id);
    }

    // ── changing ─────────────────────────────────────────────────────────────────────────────────────────────────
    private locked<T>(entry: Entry, run: () => Promise<T>): Promise<T> {
        const next = entry.tail.then(run, run);
        entry.tail = next.catch(() => undefined);
        return next;
    }

    async create(input: Created): Promise<RecordingView> {
        if (this.totalBytes() >= this.limits.maxTotalBytes) {
            throw new RecordingRefusal("The disk limit for recordings is reached on this host. Delete some recordings and try again.", 507);
        }
        const id = randomBytes(16).toString("hex");
        const meta: Meta = {
            id,
            status: "recording",
            mime: input.mime,
            startedAt: input.startedAt,
            createdAt: this.now(),
            endedAt: null,
            durationMs: null,
            target: input.target,
            error: null,
            speakers: null,
        };
        const dir = join(this.root, id);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(join(dir, this.fileName(meta.mime)), "", { mode: 0o600 });
        await this.writeMeta(meta);
        const entry: Entry = { meta, bytes: 0, chunks: 0, lastActivity: meta.createdAt, progress: null, tail: Promise.resolve(), upload: null };
        this.entries.set(id, entry);
        return this.viewOf(entry);
    }

    /**
     * Chunk `n`, streamed to the end of the media file. It must be the next one: a repeat or a gap is a 409 that says how many the
     * host holds, so the browser can send from there. A chunk that fails halfway leaves the file as it was before it.
     */
    async append(id: string, n: number, body: Readable, declaredLength: number | null): Promise<{ received: number; bytes: number }> {
        const entry = this.entry(id);
        const abort = new AbortController();
        return this.locked(entry, async () => {
            if (this.entries.get(id) !== entry) throw notFound();
            if (entry.meta.status !== "recording") {
                throw new RecordingRefusal("This recording is closed; it takes no more chunks.", 409, { received: entry.chunks });
            }
            if (n !== entry.chunks) {
                throw new RecordingRefusal(`The host holds ${entry.chunks} chunk(s); chunk ${entry.chunks} is the next one.`, 409, { received: entry.chunks });
            }
            const { limits } = this;
            if (declaredLength !== null) {
                if (declaredLength > limits.maxChunkBytes) throw new RecordingRefusal(`A chunk is at most ${limits.maxChunkBytes} bytes.`, 413);
                if (entry.bytes + declaredLength > limits.maxRecordingBytes) return this.closeForBound(entry, "recording");
                if (this.totalBytes() + declaredLength > limits.maxTotalBytes) return this.closeForBound(entry, "total");
            }
            const file = join(this.dirOf(id), this.fileName(entry.meta.mime));
            let written = 0;
            const counter = new Transform({
                transform: (chunk: Buffer, _encoding, done) => {
                    written += chunk.length;
                    if (written > limits.maxChunkBytes) return done(new BoundReached("chunk"));
                    if (entry.bytes + written > limits.maxRecordingBytes) return done(new BoundReached("recording"));
                    if (this.totalBytes() + written > limits.maxTotalBytes) return done(new BoundReached("total"));
                    done(null, chunk);
                },
            });
            entry.upload = abort;
            try {
                await pipeline(body, counter, createWriteStream(file, { flags: "r+", start: entry.bytes }), { signal: abort.signal });
            } catch (error) {
                await truncate(file, entry.bytes).catch(() => undefined);
                if (this.entries.get(id) !== entry) throw notFound();
                if (error instanceof BoundReached) {
                    if (error.bound === "chunk") throw new RecordingRefusal(`A chunk is at most ${limits.maxChunkBytes} bytes.`, 413);
                    return this.closeForBound(entry, error.bound);
                }
                if ((error as NodeJS.ErrnoException).code === "ENOSPC") return this.closeForBound(entry, "total");
                throw error;
            } finally {
                entry.upload = null;
            }
            entry.bytes += written;
            entry.chunks += 1;
            entry.lastActivity = this.now();
            return { received: entry.chunks, bytes: entry.bytes };
        });
    }

    /** Closes the recording with what it holds and answers the chunk that did not fit. */
    private async closeForBound(entry: Entry, bound: "recording" | "total"): Promise<never> {
        await this.closeLocked(entry, null);
        const received = entry.chunks;
        if (bound === "recording") {
            this.log(`[recordings] ${entry.meta.id} reached the ${this.limits.maxRecordingBytes} byte limit and was closed`);
            throw new RecordingRefusal("This recording reached the size limit and was closed with what the host holds.", 413, { received, recording: this.viewOf(entry) });
        }
        this.log(`[recordings] ${entry.meta.id} was closed: the disk limit for recordings is reached`);
        throw new RecordingRefusal("The disk limit for recordings is reached on this host; the recording was closed with what the host holds.", 507, {
            received,
            recording: this.viewOf(entry),
        });
    }

    private async closeLocked(entry: Entry, durationMs: number | null): Promise<void> {
        if (entry.meta.status === "recording") {
            entry.meta.status = "ready";
            entry.meta.endedAt = this.now();
        }
        if (durationMs !== null && entry.meta.durationMs === null) entry.meta.durationMs = durationMs;
        await this.writeMeta(entry.meta);
    }

    /** Ends a recording in progress. One that is already closed (finished, or closed at a limit) answers 409 with its view. */
    close(id: string, durationMs: number | null): Promise<RecordingView> {
        const entry = this.entry(id);
        return this.locked(entry, async () => {
            if (this.entries.get(id) !== entry) throw notFound();
            if (entry.meta.status !== "recording") {
                throw new RecordingRefusal("This recording is already finished.", 409, { recording: this.viewOf(entry) });
            }
            await this.closeLocked(entry, durationMs);
            return this.viewOf(entry);
        });
    }

    /** Changes status, error, speakers or duration, on disk. */
    update(id: string, patch: Partial<Pick<Meta, "status" | "error" | "speakers" | "durationMs">>): Promise<RecordingView> {
        const entry = this.entry(id);
        return this.locked(entry, async () => {
            if (this.entries.get(id) !== entry) throw notFound();
            Object.assign(entry.meta, patch);
            if (entry.meta.status !== "transcribing") entry.progress = null;
            else if (entry.progress === null) entry.progress = 0;
            await this.writeMeta(entry.meta);
            return this.viewOf(entry);
        });
    }

    setProgress(id: string, value: number): void {
        const entry = this.entries.get(id);
        if (entry && entry.meta.status === "transcribing") entry.progress = Math.min(1, Math.max(0, value));
    }

    /** Removes the recording and every file of it. A chunk in flight is stopped first. */
    remove(id: string): Promise<void> {
        const entry = this.entry(id);
        this.entries.delete(id);
        entry.upload?.abort();
        return this.locked(entry, async () => {
            await rm(join(this.root, id), { recursive: true, force: true });
        });
    }

    // ── transcript files ─────────────────────────────────────────────────────────────────────────────────────────
    async saveTranscript(id: string, transcript: Transcript): Promise<void> {
        const entry = this.entry(id);
        await this.locked(entry, async () => {
            if (this.entries.get(id) !== entry) throw notFound();
            const dir = this.dirOf(id);
            await writeFile(join(dir, "transcript.json.tmp"), JSON.stringify(transcript) + "\n", { mode: 0o600 });
            await rename(join(dir, "transcript.json.tmp"), join(dir, "transcript.json"));
            await writeFile(join(dir, "transcript.txt"), transcript.text + "\n", { mode: 0o600 });
        });
    }

    /** The stored transcript's JSON text, or null. */
    async readTranscript(id: string): Promise<string | null> {
        this.entry(id);
        return readFile(join(this.dirOf(id), "transcript.json"), "utf8").catch(() => null);
    }

    async clearTranscript(id: string): Promise<void> {
        const dir = this.dirOf(id);
        await rm(join(dir, "transcript.json"), { force: true });
        await rm(join(dir, "transcript.txt"), { force: true });
    }

    /** The transcriber's decoded audio, for one recording; a crash may have left it, and a job clears it before and after. */
    async clearWork(id: string): Promise<void> {
        await rm(this.workDir(id), { recursive: true, force: true });
    }
}
