/**
 * The recordings routes of the app host, typed from the contract (packages/contracts/src/recordings.ts).
 *
 * Plain fetch on purpose: the routes answer hand-written JSON, not the Effect HttpApi the rest of the app uses, and a
 * chunk body is raw bytes. Every failure becomes a `RecordingsError` whose `message` is fit to show a person.
 */

import {
    RECORDING_HEADER,
    RECORDINGS_PATH,
    type RecordingMime,
    type RecordingSearchResult,
    type RecordingView,
    type Transcript,
    type TranscriptionStatus,
} from "@pikvm/contracts/recordings";

export interface RecordingsList {
    readonly recordings: ReadonlyArray<RecordingView>;
    readonly transcription: TranscriptionStatus;
}

export interface CreateRecordingBody {
    readonly mime: RecordingMime;
    readonly startedAt: string;
    readonly target?: string;
}

export interface FinishRecordingBody {
    readonly durationMs: number;
    readonly transcribe: boolean;
}

/** `status` is null when the host could not be reached at all. `received` is set on a 409 (the chunks the host holds). */
export class RecordingsError extends Error {
    readonly status: number | null;
    readonly received: number | null;

    constructor(message: string, status: number | null, received: number | null = null) {
        super(message);
        this.name = "RecordingsError";
        this.status = status;
        this.received = received;
    }

    /** Worth trying again later: the host was unreachable, is busy, or failed on its side. */
    get retryable(): boolean {
        return this.status === null || this.status === 408 || this.status === 429 || this.status >= 500;
    }
}

const UNREACHABLE = "Cannot reach the app server.";

const FALLBACK: Readonly<Record<number, string>> = {
    401: "Sign in again to use recordings.",
    403: "This host does not allow recordings.",
    404: "The host does not have this recording. It may have been deleted.",
    413: "The host refused a piece of the recording as too large.",
    507: "The disk limit for recordings is reached on the host. Delete some recordings and try again.",
};

/** The `error` field of a JSON error body, when there is one. */
function bodyError(body: unknown): string | null {
    if (typeof body !== "object" || body === null || !("error" in body)) return null;
    const value = body.error;
    return typeof value === "string" && value !== "" ? value : null;
}

/** A numeric field of a JSON reply, when there is one. */
function numberField(body: unknown, key: string): number | null {
    if (typeof body !== "object" || body === null || !(key in body)) return null;
    const value: unknown = Reflect.get(body, key);
    return typeof value === "number" ? value : null;
}

async function readBody(res: Response): Promise<unknown> {
    const text = await res.text().catch(() => "");
    if (text === "") return undefined;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

interface CallOptions {
    readonly body?: BodyInit;
    readonly json?: unknown;
    readonly signal?: AbortSignal;
    readonly keepalive?: boolean;
    /** Writes carry the marker header; reads do not need it. */
    readonly write?: boolean;
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (options.write) headers[RECORDING_HEADER] = "1";
    let body: BodyInit | undefined = options.body;
    if (options.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.json);
    } else if (options.body !== undefined) {
        headers["content-type"] = "application/octet-stream";
    } else if (options.write) {
        // A bodyless write still says JSON, the rule every other write on this host follows.
        headers["content-type"] = "application/json";
    }
    let res: Response;
    try {
        res = await fetch(path, {
            method,
            headers,
            credentials: "same-origin",
            ...(body !== undefined ? { body } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.keepalive ? { keepalive: true } : {}),
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new RecordingsError(UNREACHABLE, null);
    }
    const parsed = await readBody(res);
    if (!res.ok) {
        throw new RecordingsError(
            bodyError(parsed) ?? FALLBACK[res.status] ?? `The server answered ${res.status}.`,
            res.status,
            numberField(parsed, "received"),
        );
    }
    return parsed;
}

const idPath = (id: string): string => `${RECORDINGS_PATH}/${encodeURIComponent(id)}`;

/** The address a `<video>` plays: the host answers it with Range support. */
export const mediaUrl = (id: string): string => `${idPath(id)}/media`;

export async function listRecordings(signal?: AbortSignal): Promise<RecordingsList> {
    return (await call("GET", RECORDINGS_PATH, signal ? { signal } : {})) as RecordingsList;
}

export interface SearchRecordingsOptions {
    readonly limit?: number;
    readonly offset?: number;
    readonly speaker?: string;
    readonly from?: string;
    readonly to?: string;
    readonly signal?: AbortSignal;
}

/** Full text over transcripts and titles. The host judges the query (an empty one is a 400 with its own sentence). */
export async function searchRecordings(query: string, options: SearchRecordingsOptions = {}): Promise<RecordingSearchResult> {
    const params = new URLSearchParams({ q: query });
    for (const key of ["limit", "offset", "speaker", "from", "to"] as const) {
        const value = options[key];
        if (value !== undefined) params.set(key, String(value));
    }
    return (await call("GET", `${RECORDINGS_PATH}/search?${params.toString()}`, options.signal ? { signal: options.signal } : {})) as RecordingSearchResult;
}

/** Renames; null (or empty text) goes back to the default name. */
export async function renameRecording(id: string, title: string | null): Promise<RecordingView> {
    return (await call("PATCH", idPath(id), { write: true, json: { title } })) as RecordingView;
}

export async function getRecording(id: string, signal?: AbortSignal): Promise<RecordingView> {
    return (await call("GET", idPath(id), signal ? { signal } : {})) as RecordingView;
}

export async function getTranscript(id: string, signal?: AbortSignal): Promise<Transcript> {
    return (await call("GET", `${idPath(id)}/transcript`, signal ? { signal } : {})) as Transcript;
}

export async function transcribeRecording(id: string): Promise<RecordingView> {
    return (await call("POST", `${idPath(id)}/transcribe`, { write: true })) as RecordingView;
}

export async function deleteRecording(id: string): Promise<void> {
    await call("DELETE", idPath(id), { write: true });
}

export async function createRecording(body: CreateRecordingBody, signal?: AbortSignal): Promise<RecordingView> {
    return (await call("POST", RECORDINGS_PATH, { write: true, json: body, ...(signal ? { signal } : {}) })) as RecordingView;
}

/** One chunk, in order: `n` counts from 0. Answers how many chunks the host now holds. */
export async function putChunk(
    id: string,
    n: number,
    chunk: Blob,
    options: { readonly signal?: AbortSignal; readonly keepalive?: boolean } = {},
): Promise<number> {
    const reply = await call("PUT", `${idPath(id)}/chunks/${n}`, { write: true, body: chunk, ...options });
    return numberField(reply, "received") ?? n + 1;
}

export async function finishRecording(
    id: string,
    body: FinishRecordingBody,
    options: { readonly signal?: AbortSignal; readonly keepalive?: boolean } = {},
): Promise<RecordingView> {
    return (await call("POST", `${idPath(id)}/finish`, { write: true, json: body, ...options })) as RecordingView;
}
