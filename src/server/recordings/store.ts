import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
    RecordingArchive,
    RecordingEndReason,
    RecordingHole,
    RecordingMime,
    RecordingSource,
    RecordingStatus,
    RecordingView,
    Transcript,
} from "@pikvm/contracts/recordings";
import type { RecordingLimits } from "./limits";

/**
 * Where recordings live and what is allowed to happen to them.
 *
 *   <dataDir>/recordings/<id>/<id>.mp4                the file a host capture ends as (H.264 + a `target` and a `mic` audio track)
 *                            recording.webm | recording.mp4   what an older version's browser uploaded (read, never made)
 *                            capture/                         while the host captures and re-encodes: raw/ and stored/ segments, manifest
 *                            meta.json                        the state below (rewritten on every change of status)
 *                            transcript.json, transcript.txt  once transcribed
 *                            work/                            the transcriber's decoded audio, gone when it ends
 *
 * An id is 32 lowercase hex digits from crypto.randomBytes and is checked against ID_PATTERN before any path is built from it, so
 * a request can never name a path outside the recordings directory. Everything that changes one recording runs under that
 * recording's own lock, so a delete waits for the change being written.
 */

export const ID_PATTERN = /^[0-9a-f]{32}$/;
export const isRecordingId = (value: string): boolean => ID_PATTERN.test(value);

const DAY_MS = 86_400_000;

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

/** One file the archive holds for a recording, with what its copy was checked against. */
export interface ArchiveFile {
    bytes: number;
    sha256: string;
}

/** A recording's copy in the archive: "pending" until it is verified, "failed" while it is retried. */
export interface ArchiveMeta {
    state: "pending" | "copied" | "failed";
    /** By file name. A copy is only ever replaced when it is still the one this host made. */
    files: Record<string, ArchiveFile>;
    /** Milliseconds since the epoch: when the copy was verified. */
    copiedAt: number | null;
    attempts: number;
    /** Milliseconds since the epoch: when the next try is due after a failure, or null. */
    nextAt: number | null;
    error: string | null;
}

/** The archive record read back from meta.json, or null when there is none or it is not one. */
function readArchive(raw: unknown): ArchiveMeta | null {
    if (typeof raw !== "object" || raw === null) return null;
    const a = raw as Record<string, unknown>;
    const state = a["state"];
    if (state !== "pending" && state !== "copied" && state !== "failed") return null;
    const files: Record<string, ArchiveFile> = {};
    const rawFiles = typeof a["files"] === "object" && a["files"] !== null ? (a["files"] as Record<string, unknown>) : {};
    for (const [name, value] of Object.entries(rawFiles)) {
        const file = value as Record<string, unknown> | null;
        if (file && typeof file["bytes"] === "number" && typeof file["sha256"] === "string") files[name] = { bytes: file["bytes"], sha256: file["sha256"] };
    }
    return {
        state,
        files,
        copiedAt: typeof a["copiedAt"] === "number" ? a["copiedAt"] : null,
        attempts: typeof a["attempts"] === "number" ? a["attempts"] : 0,
        nextAt: typeof a["nextAt"] === "number" ? a["nextAt"] : null,
        error: typeof a["error"] === "string" ? a["error"] : null,
    };
}

/** The archive copy as the views show it. */
function archiveView(meta: ArchiveMeta | null): RecordingArchive | null {
    if (meta === null) return null;
    return { state: meta.state, copiedAt: meta.copiedAt === null ? null : new Date(meta.copiedAt).toISOString(), error: meta.error };
}

interface Meta {
    id: string;
    status: RecordingStatus;
    source: RecordingSource;
    mime: RecordingMime;
    startedAt: string;
    /** Milliseconds since the epoch, the host's clock. */
    createdAt: number;
    /** When it ended (the retention clock starts here); null while recording. */
    endedAt: number | null;
    durationMs: number | null;
    target: string | null;
    /** The name the person gave it (null: the default). */
    title: string | null;
    error: string | null;
    speakers: number | null;
    reason: RecordingEndReason | null;
    holes: RecordingHole[];
    /** The capture takes (or took) a microphone track: set at the start, true for a recording whose file has a `mic` track. */
    hasMic: boolean;
    /** Transcribe once the file exists. */
    transcribe: boolean;
    /** When the host deleted the file (under retention, or to stay under the disk limit), in ms since the epoch; null while it is kept. The transcript stays. */
    mediaRemovedAt: number | null;
    /** The archive copy, or null when no archive covers this recording. */
    archive: ArchiveMeta | null;
}

interface Entry {
    meta: Meta;
    /** What the recording takes on disk: the file, or while it is made the raw and stored segments. */
    bytes: number;
    /** The length of a capture in progress, in memory; the view uses it until the file's own length is known. */
    liveDurationMs: number | null;
    /** 0..1 while finishing or transcribing; kept in memory, not on disk. */
    progress: number | null;
    /** The chain every change to this recording runs on. */
    tail: Promise<unknown>;
}

export interface StoreOptions {
    dataDir: string;
    limits: RecordingLimits;
    now?: () => number;
    log?: (line: string) => void;
}

export interface HostRecordingInput {
    startedAt: string;
    target: string | null;
    title: string | null;
    mic: boolean;
    transcribe: boolean;
}

export interface Loaded {
    /** Host recordings that were still being captured when the host last stopped. */
    capturing: string[];
    /** Host recordings that had stopped and were being re-encoded. */
    finishing: string[];
    /** Recordings whose transcription was queued or running. */
    transcribing: string[];
    /** Recordings an older version's browser was still uploading: they are closed with what they hold. */
    openUploads: string[];
}

/** What `update` may change. */
export type MetaPatch = Partial<Pick<Meta, "status" | "error" | "speakers" | "durationMs" | "title" | "reason" | "holes" | "hasMic" | "endedAt" | "target" | "archive" | "mediaRemovedAt">>;

const STATUSES: readonly unknown[] = ["recording", "finishing", "ready", "transcribing", "done", "failed"];
const MIMES: readonly unknown[] = ["video/webm", "video/mp4"];
const REASONS: readonly unknown[] = ["stopped", "quota", "recording_cap", "backlog_cap", "duration", "error", "interrupted"];

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

    // -- paths ----------------------------------------------------------------------------------------------------
    /** The directory of a recording. The only place a path is built from an id, and it refuses anything that is not one. */
    dirOf(id: string): string {
        if (!isRecordingId(id)) throw notFound();
        return join(this.root, id);
    }

    mediaPath(id: string): string {
        return join(this.dirOf(id), this.fileName(this.entry(id).meta));
    }

    /** Where a host capture writes its file, whether or not it exists yet. */
    outputPath(id: string): string {
        return join(this.dirOf(id), `${id}.mp4`);
    }

    /** The capture's raw and stored segments; on the same filesystem as the file, which is on the data volume. */
    captureDir(id: string): string {
        return join(this.dirOf(id), "capture");
    }

    workDir(id: string): string {
        return join(this.dirOf(id), "work");
    }

    private fileName(meta: Pick<Meta, "id" | "source" | "mime">): string {
        if (meta.source === "host") return `${meta.id}.mp4`;
        return meta.mime === "video/mp4" ? "recording.mp4" : "recording.webm";
    }

    // -- loading --------------------------------------------------------------------------------------------------
    async load(): Promise<Loaded> {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const loaded: Loaded = { capturing: [], finishing: [], transcribing: [], openUploads: [] };
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
            const info = await stat(join(this.root, name, this.fileName(meta))).catch(() => null);
            this.entries.set(name, { meta, bytes: info?.size ?? 0, liveDurationMs: null, progress: null, tail: Promise.resolve() });
            if (meta.status === "recording") (meta.source === "host" ? loaded.capturing : loaded.openUploads).push(name);
            if (meta.status === "finishing") loaded.finishing.push(name);
            if (meta.status === "transcribing") loaded.transcribing.push(name);
        }
        return loaded;
    }

    private async readMeta(id: string): Promise<Meta | null> {
        try {
            const raw: unknown = JSON.parse(await readFile(join(this.root, id, "meta.json"), "utf8"));
            if (typeof raw !== "object" || raw === null) return null;
            const m = raw as Record<string, unknown>;
            if (m["id"] !== id || !STATUSES.includes(m["status"]) || !MIMES.includes(m["mime"]) || typeof m["startedAt"] !== "string") return null;
            if (typeof m["createdAt"] !== "number") return null;
            const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
            const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
            const holes = Array.isArray(m["holes"])
                ? m["holes"].flatMap((h: unknown) => {
                      const hole = h as Record<string, unknown> | null;
                      return hole && typeof hole["fromMs"] === "number" && typeof hole["toMs"] === "number" ? [{ fromMs: hole["fromMs"], toMs: hole["toMs"] }] : [];
                  })
                : [];
            return {
                id,
                status: m["status"] as RecordingStatus,
                // A meta from before the host recorded has no source: a browser uploaded it.
                source: m["source"] === "host" ? "host" : "browser",
                mime: m["mime"] as RecordingMime,
                startedAt: m["startedAt"],
                createdAt: m["createdAt"],
                endedAt: num(m["endedAt"]),
                durationMs: num(m["durationMs"]),
                target: str(m["target"]),
                title: str(m["title"]),
                error: str(m["error"]),
                speakers: num(m["speakers"]),
                reason: REASONS.includes(m["reason"]) ? (m["reason"] as RecordingEndReason) : null,
                holes,
                hasMic: m["hasMic"] === true,
                transcribe: m["transcribe"] === true,
                mediaRemovedAt: num(m["mediaRemovedAt"]),
                archive: readArchive(m["archive"]),
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

    // -- reading --------------------------------------------------------------------------------------------------
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

    sourceOf(id: string): RecordingSource {
        return this.entry(id).meta.source;
    }

    /** When the recording ended (the host's clock), or null while it is being made. */
    endedAtOf(id: string): number | null {
        return this.entry(id).meta.endedAt;
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

    wantsTranscript(id: string): boolean {
        return this.entry(id).meta.transcribe;
    }

    /** Everything the recordings take on disk, a capture in progress included. */
    totalBytes(): number {
        let total = 0;
        for (const entry of this.entries.values()) total += entry.bytes;
        return total;
    }

    /** The whole recording goes at its end's retention: a finished one keeps its transcript for the transcript's retention. */
    private expiresAt(meta: Meta): string | null {
        const due = this.dueAt(meta, this.recordDays(meta));
        return due === null ? null : new Date(due).toISOString();
    }

    /** The file goes at the file's retention, or with the whole recording if that ends first; null once it is removed. */
    private mediaExpiresAt(meta: Meta): string | null {
        if (meta.mediaRemovedAt !== null) return null;
        const fileDue = this.dueAt(meta, this.limits.retentionDays);
        const recordDue = this.dueAt(meta, this.recordDays(meta));
        const dues = [fileDue, recordDue].filter((due): due is number => due !== null);
        return dues.length === 0 ? null : new Date(Math.min(...dues)).toISOString();
    }

    /** Days the whole recording is kept after it ended: a finished one keeps its transcript for the transcript's retention. */
    private recordDays(meta: Meta): number {
        return meta.status === "done" ? this.limits.transcriptRetentionDays : this.limits.retentionDays;
    }

    /** When `days` after the end falls, in ms since the epoch; null when it never does (kept for ever, or not ended yet). */
    private dueAt(meta: Meta, days: number): number | null {
        if (days <= 0 || meta.endedAt === null || meta.status === "recording" || meta.status === "finishing") return null;
        return meta.endedAt + days * DAY_MS;
    }

    private viewOf(entry: Entry): RecordingView {
        const { meta } = entry;
        const measured = meta.status === "finishing" || meta.status === "transcribing";
        return {
            id: meta.id,
            status: meta.status,
            source: meta.source,
            mime: meta.mime,
            startedAt: meta.startedAt,
            durationMs: meta.durationMs ?? (meta.status === "recording" || meta.status === "finishing" ? entry.liveDurationMs : null),
            bytes: entry.bytes,
            title: meta.title,
            target: meta.target,
            expiresAt: this.expiresAt(meta),
            mediaExpiresAt: this.mediaExpiresAt(meta),
            mediaRemoved: meta.mediaRemovedAt !== null,
            archive: archiveView(meta.archive),
            error: meta.error,
            progress: measured ? (entry.progress ?? (meta.status === "transcribing" ? 0 : null)) : null,
            speakers: meta.status === "done" ? meta.speakers : null,
            reason: meta.reason,
            holes: meta.holes.map((h) => ({ ...h })),
            hasMic: meta.hasMic,
        };
    }

    view(id: string): RecordingView {
        return this.viewOf(this.entry(id));
    }

    /** Every recording's id. */
    ids(): string[] {
        return [...this.entries.keys()];
    }

    /** Newest first. */
    views(): RecordingView[] {
        return [...this.entries.values()].sort((a, b) => b.meta.createdAt - a.meta.createdAt).map((e) => this.viewOf(e));
    }

    /** Recordings past their retention as a whole, oldest first. */
    expiredRecords(): string[] {
        return this.idsAt((meta) => this.dueAt(meta, this.recordDays(meta)), this.now());
    }

    /** Transcribed recordings whose file is past its retention and still here, oldest first. */
    expiredMedia(): string[] {
        const finished = (meta: Meta): number | null =>
            meta.status === "done" && meta.mediaRemovedAt === null ? this.dueAt(meta, this.limits.retentionDays) : null;
        return this.idsAt(finished, this.now());
    }

    /** Transcribed recordings whose file is still here, oldest first: what may be released to stay under the disk limit. */
    mediaCandidates(): string[] {
        return this.idsAt((meta) => (meta.status === "done" && meta.mediaRemovedAt === null ? meta.endedAt : null), Infinity);
    }

    private idsAt(at: (meta: Meta) => number | null, limit: number): string[] {
        const due: Array<{ id: string; at: number }> = [];
        for (const { meta } of this.entries.values()) {
            const when = at(meta);
            if (when !== null && when <= limit) due.push({ id: meta.id, at: when });
        }
        return due.sort((a, b) => a.at - b.at).map((d) => d.id);
    }

    archiveOf(id: string): ArchiveMeta | null {
        return this.entry(id).meta.archive;
    }

    mediaRemoved(id: string): boolean {
        return this.entry(id).meta.mediaRemovedAt !== null;
    }

    /** Deletes a finished recording's file and keeps the rest of it, its transcript included. */
    removeMedia(id: string): Promise<void> {
        const entry = this.entry(id);
        return this.locked(entry, async () => {
            if (this.entries.get(id) !== entry || entry.meta.mediaRemovedAt !== null) return;
            await rm(this.mediaPath(id), { force: true, maxRetries: 3, retryDelay: 100 });
            entry.bytes = 0;
            entry.meta.mediaRemovedAt = this.now();
            await this.writeMeta(entry.meta);
        });
    }

    // -- changing -------------------------------------------------------------------------------------------------
    private locked<T>(entry: Entry, run: () => Promise<T>): Promise<T> {
        const next = entry.tail.then(run, run);
        entry.tail = next.catch(() => undefined);
        return next;
    }

    /** A new host recording, in "recording"; 507 when the recordings already take the whole quota. */
    async createHost(input: HostRecordingInput): Promise<RecordingView> {
        if (this.totalBytes() >= this.limits.maxTotalBytes) {
            throw new RecordingRefusal("The disk limit for recordings is reached on this host. Delete some recordings and try again.", 507);
        }
        const id = randomBytes(16).toString("hex");
        const meta: Meta = {
            id,
            status: "recording",
            source: "host",
            mime: "video/mp4",
            startedAt: input.startedAt,
            createdAt: this.now(),
            endedAt: null,
            durationMs: null,
            target: input.target,
            title: input.title,
            error: null,
            speakers: null,
            reason: null,
            holes: [],
            hasMic: input.mic,
            transcribe: input.transcribe,
            mediaRemovedAt: null,
            archive: null,
        };
        await mkdir(join(this.root, id), { recursive: true, mode: 0o700 });
        await this.writeMeta(meta);
        const entry: Entry = { meta, bytes: 0, liveDurationMs: 0, progress: null, tail: Promise.resolve() };
        this.entries.set(id, entry);
        return this.viewOf(entry);
    }

    /** Changes what meta holds, on disk. A status other than finishing or transcribing forgets the progress. */
    update(id: string, patch: MetaPatch): Promise<RecordingView> {
        const entry = this.entry(id);
        return this.locked(entry, async () => {
            if (this.entries.get(id) !== entry) throw notFound();
            Object.assign(entry.meta, patch);
            if (entry.meta.status !== "transcribing" && entry.meta.status !== "finishing") entry.progress = null;
            else if (entry.progress === null && entry.meta.status === "transcribing") entry.progress = 0;
            await this.writeMeta(entry.meta);
            return this.viewOf(entry);
        });
    }

    /** What the recording takes on disk now (in memory: the files are the truth), and for a capture its length. */
    setBytes(id: string, bytes: number, durationMs?: number): void {
        const entry = this.entries.get(id);
        if (!entry) return;
        entry.bytes = Math.max(0, bytes);
        if (durationMs !== undefined) entry.liveDurationMs = durationMs;
    }

    /** The size of the file, once there is one. */
    async measureFile(id: string): Promise<number> {
        const entry = this.entry(id);
        const info = await stat(join(this.dirOf(id), this.fileName(entry.meta))).catch(() => null);
        entry.bytes = info?.size ?? 0;
        return entry.bytes;
    }

    setProgress(id: string, value: number | null): void {
        const entry = this.entries.get(id);
        if (entry && (entry.meta.status === "transcribing" || entry.meta.status === "finishing")) entry.progress = value === null ? null : Math.min(1, Math.max(0, value));
    }

    /** Removes the recording and every file of it. */
    remove(id: string): Promise<void> {
        const entry = this.entry(id);
        this.entries.delete(id);
        return this.locked(entry, async () => {
            await rm(join(this.root, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        });
    }

    // -- transcript files -----------------------------------------------------------------------------------------
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

    /** Changes when the transcript file does: its modification time and size, or "" when there is none. What the search index was built from. */
    async transcriptSignature(id: string): Promise<string> {
        this.entry(id);
        const info = await stat(join(this.dirOf(id), "transcript.json")).catch(() => null);
        return info ? `${Math.round(info.mtimeMs)}:${info.size}` : "";
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
