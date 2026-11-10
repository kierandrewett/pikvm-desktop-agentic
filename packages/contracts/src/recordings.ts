/**
 * Session recordings' wire types, shared by the server (src/server/recordings) and the web client (apps/web/src/kvm/recorder).
 * Plain TypeScript: the routes are `/app/api/v1/recordings/*`, answered by hand-written handlers.
 *
 * A recording is ONE file, small on purpose:
 *   - video: the target's screen, VP9 (WebM) at a low bitrate, or H.264 (MP4) where the browser cannot do VP9 (Safari)
 *   - audio: ONE stereo Opus (or AAC) track. LEFT is what the target played (its speakers), RIGHT is this person's
 *     microphone. The split is the first step of "who said what": the right channel is always one voice, the left is
 *     one or more, and the transcriber separates those with diarization.
 *
 * Upload protocol (the browser streams as it records, so a closed tab loses seconds, not the session):
 *   POST   /app/api/v1/recordings                     JSON { mime, startedAt, target? }      -> RecordingView (status "recording")
 *   PUT    /app/api/v1/recordings/:id/chunks/:n       body = bytes, n counts from 0, in order -> { received: n + 1 }
 *   POST   /app/api/v1/recordings/:id/finish          JSON { durationMs, transcribe }        -> RecordingView
 *   GET    /app/api/v1/recordings                     -> { recordings: RecordingView[], transcription: TranscriptionStatus }
 *   GET    /app/api/v1/recordings/:id                 -> RecordingView
 *   GET    /app/api/v1/recordings/:id/media           the file, with Range support, for a <video> element
 *   GET    /app/api/v1/recordings/:id/transcript      -> Transcript (404 until status is "done")
 *   POST   /app/api/v1/recordings/:id/transcribe      start or restart the transcription -> RecordingView
 *   DELETE /app/api/v1/recordings/:id                 remove the recording, its transcript and its audio work files
 *
 * Writes carry `x-pikvm-recording: 1` (a custom header forces a preflight this server never answers, which is what the JSON
 * content-type rule does for the other routes). Chunk bodies are `application/octet-stream`; every other write is JSON.
 *
 * Errors are JSON `{ error }`. A chunk that is not the next one (a repeat or a gap) is 409 `{ error, received }`, `received` being the
 * number of chunks the host holds, so the browser sends from there. A finish on a recording that is already finished, or that the host
 * closed at a limit, is 409 `{ error, recording }`. A chunk over MAX_CHUNK_BYTES is 413; a chunk that would pass
 * MAX_RECORDING_BYTES (413) or RECORDINGS_MAX_TOTAL_BYTES (507) closes the recording with the bytes the host holds and answers
 * `{ error, received, recording }`; a new recording past the total is 507. Transcribing on a host that cannot is 503 `{ error }`.
 *
 * Who may use it: every route is behind the host's sign-in (the router judges every request before any route runs), and
 * nothing is served without it, the media route included.
 *
 * Retention and disk: recordings can hold passwords and private talk, so they do not stay for ever and they cannot fill
 * the disk. A recording is deleted RECORDING_RETENTION_DAYS after it ended unless the operator sets
 * `PIKVM_RECORDINGS_RETENTION_DAYS` (0 keeps them); the sweep runs at host start and every hour. A new recording is refused
 * with 507 when the total on disk would pass RECORDINGS_MAX_TOTAL_BYTES (`PIKVM_RECORDINGS_MAX_BYTES` overrides it), and a
 * recording in progress is closed at the per-recording limit. Each view says when it will be deleted.
 */

export const RECORDINGS_PATH = "/app/api/v1/recordings";
export const RECORDING_HEADER = "x-pikvm-recording";

/** The most one chunk may carry: a 10 s slice of a 300 kbit/s recording is about 400 KB. */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** The most one recording may hold, so a forgotten recording cannot fill the disk. */
export const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024;
/** The most all recordings together may take on disk. */
export const RECORDINGS_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
/** Days a finished recording is kept by default. */
export const RECORDING_RETENTION_DAYS = 30;

/** Containers the browser may record and the host will keep. */
export const RECORDING_MIMES = ["video/webm", "video/mp4"] as const;
export type RecordingMime = (typeof RECORDING_MIMES)[number];

export type RecordingStatus = "recording" | "ready" | "transcribing" | "done" | "failed";

export interface RecordingView {
    id: string;
    status: RecordingStatus;
    mime: RecordingMime;
    /** ISO time the recording started, from the browser's clock. */
    startedAt: string;
    durationMs: number | null;
    bytes: number;
    /** What the person was looking at, for the list: the target's name or address. */
    target: string | null;
    /** ISO time the host will delete this recording, or null when retention is off or it is still recording. */
    expiresAt: string | null;
    /** Set when status is "failed": the reason, in a sentence. */
    error: string | null;
    /** 0..1 while status is "transcribing", else null. */
    progress: number | null;
    /** Speakers found, once status is "done". */
    speakers: number | null;
}

/** Whether this host can transcribe, and what it uses: the page shows no "Transcribe" button without it. */
export interface TranscriptionStatus {
    available: boolean;
    /** Why not, when unavailable (models missing, ffmpeg missing). */
    reason: string | null;
    /** Human names of the models in use, for the page. */
    models: { recognizer: string; diarizer: string } | null;
}

export interface TranscriptSegment {
    /** Seconds from the start of the recording. */
    start: number;
    end: number;
    /** "You" for the microphone channel; "Speaker 1", "Speaker 2", ... for the target channel. */
    speaker: string;
    channel: "mic" | "target";
    text: string;
}

export interface Transcript {
    id: string;
    durationMs: number;
    /** Distinct speaker labels in order of first appearance. */
    speakers: string[];
    segments: TranscriptSegment[];
    /** Plain text, one `[mm:ss] Speaker: text` line per segment. */
    text: string;
    models: { recognizer: string; diarizer: string };
    /** Seconds the transcription took. */
    tookSeconds: number;
}
