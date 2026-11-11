/**
 * The recordings routes of the app host, typed from the contract (packages/contracts/src/recordings.ts).
 *
 * Plain fetch on purpose: the routes answer hand-written JSON, not the Effect HttpApi the rest of the app uses. Every failure
 * becomes a `RecordingsError` whose `message` is fit to show a person.
 */

import {
    RECORDING_HEADER,
    RECORDING_LIVE_PATH,
    RECORDINGS_PATH,
    type RecordingArchiveSummary,
    type RecordingLive,
    type RecordingSearchResult,
    type RecordingView,
    type StartRecordingBody,
    type Transcript,
    type TranscriptionStatus,
} from "@pikvm/contracts/recordings";

export interface RecordingsList {
    readonly recordings: ReadonlyArray<RecordingView>;
    readonly transcription: TranscriptionStatus;
    readonly archive: RecordingArchiveSummary;
}

/** `status` is null when the host could not be reached at all. `recording` is set on a 409 (the recording in progress, or the one already stopped). */
export class RecordingsError extends Error {
    readonly status: number | null;
    readonly recording: RecordingView | null;

    constructor(message: string, status: number | null, recording: RecordingView | null = null) {
        super(message);
        this.name = "RecordingsError";
        this.status = status;
        this.recording = recording;
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
    409: "A recording is already in progress.",
    507: "The disk limit for recordings is reached on the host. Delete some recordings and try again.",
};

/** The `error` field of a JSON error body, when there is one. */
function bodyError(body: unknown): string | null {
    if (typeof body !== "object" || body === null || !("error" in body)) return null;
    const value = body.error;
    return typeof value === "string" && value !== "" ? value : null;
}

/** The `recording` a 409 carries, when it is one. */
function recordingField(body: unknown): RecordingView | null {
    if (typeof body !== "object" || body === null || !("recording" in body)) return null;
    const value: unknown = body.recording;
    return typeof value === "object" && value !== null && "id" in value && "status" in value ? (value as RecordingView) : null;
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
    readonly json?: unknown;
    readonly signal?: AbortSignal;
    /** Writes carry the marker header; reads do not need it. */
    readonly write?: boolean;
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (options.write) headers[RECORDING_HEADER] = "1";
    let body: string | undefined;
    if (options.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.json);
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
            recordingField(parsed),
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

/** The host starts recording the PiKVM's stream. 409 while one is in progress, 507 when the disk limit is reached. */
export async function startRecording(body: StartRecordingBody, signal?: AbortSignal): Promise<RecordingView> {
    return (await call("POST", `${RECORDINGS_PATH}/start`, { write: true, json: body, ...(signal ? { signal } : {}) })) as RecordingView;
}

export async function stopRecording(id: string): Promise<RecordingView> {
    return (await call("POST", `${idPath(id)}/stop`, { write: true })) as RecordingView;
}

/** One reading of the live state (the page follows it as a stream: live.ts). */
export async function getLive(signal?: AbortSignal): Promise<RecordingLive> {
    return (await call("GET", RECORDING_LIVE_PATH, signal ? { signal } : {})) as RecordingLive;
}

/** Where the microphone's frames go: the WebSocket of a recording in progress. */
export function micSocketUrl(id: string): string {
    const base = new URL(`${idPath(id)}/mic`, window.location.href);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    return base.toString();
}
