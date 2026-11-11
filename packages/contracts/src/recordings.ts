/**
 * Session recordings' wire types, shared by the server (src/server/recordings) and the web client (apps/web/src/kvm/recorder).
 * Plain TypeScript: the routes are `/app/api/v1/recordings/*`, answered by hand-written handlers.
 *
 * A recording is made BY THE HOST, not by a browser. The host joins the PiKVM's own Janus stream, writes what the Pi sends
 * without re-encoding it (raw 1080p H.264, a few segments of about 5 minutes), and re-encodes each closed segment in the
 * background at the lowest priority into the file it keeps: H.264 at 720p and 10 frames a second, about 1 to 2 MB a minute all
 * in, with TWO audio tracks named by their handler name:
 *   - `target`: what the target played, stereo AAC (the Pi's audio is true stereo)
 *   - `mic`:    this person's microphone, mono AAC; present only when a browser sent one (see "Microphone")
 * so it needs no browser tab open, and a client that is not a browser (a meeting detector) can start and stop it. A recording
 * the host made says `source: "host"` and is always `video/mp4`. Recordings an older version uploaded from a browser (WebM VP9, or
 * MP4 from Safari, ONE stereo audio track, LEFT the target and RIGHT the person) stay on the host; they say `source: "browser"`
 * and are played, searched, transcribed and deleted like the others. Nothing uploads a recording any more.
 *
 * Routes (every one under RECORDINGS_PATH):
 *   POST   /start                  JSON { target?, mic, title?, transcribe? }  -> RecordingView (status "recording"), 201
 *   POST   /:id/stop               (no body)                                    -> RecordingView (status "finishing", or "ready")
 *   GET    /live                   -> RecordingLive; with `Accept: text/event-stream` a stream of them (see "Live state")
 *   WS     /:id/mic                the microphone's Opus frames (see "Microphone")
 *   GET    /?status=&sort=         -> { recordings: RecordingView[], transcription: TranscriptionStatus }
 *   GET    /search?q=&limit=&offset=&speaker=&from=&to=   -> RecordingSearchResult
 *   GET    /:id                    -> RecordingView
 *   PATCH  /:id                    JSON { title }                               -> RecordingView (rename)
 *   GET    /:id/media              the file, with Range support, for a <video> element (409 until it exists: while "recording" and "finishing")
 *   GET    /:id/transcript         -> Transcript (404 until status is "done")
 *   POST   /:id/transcribe         start or restart the transcription           -> RecordingView
 *   DELETE /:id                    remove the recording, its transcript and its work files; a recording in progress is stopped first
 *
 * Lifecycle: `status` is the one field. "recording" (the host is capturing; the raw stream is on disk) -> "finishing" (it has stopped
 * and the host is re-encoding what it captured and joining the pieces: `progress` says how far; the recording cannot be played yet) ->
 * "ready" (the file exists) -> "transcribing" (when the start asked for it and this host can; `progress`) -> "done" | "failed".
 * A recording that can no longer be made goes to "failed" with `error`. `reason` says why a capture ended (see RecordingEndReason).
 *
 * Start: `target` is a label for the list (default: the PiKVM's host name), `mic` says whether a second audio track will be
 * recorded (fed by the WebSocket below; false for a client that has no microphone), `title` names it, `transcribe` (default true)
 * asks for a transcription once the file exists. There is ONE recording at a time: a second start is 409 `{ error, recording }` with
 * the one in progress. A start when the recordings already take RECORDINGS_MAX_TOTAL_BYTES is 507 `{ error }`. A host with no PiKVM to
 * record is 503. The host connects to the PiKVM in the background: a PiKVM that cannot be reached shows as "reconnecting" in the live
 * state, and the recording goes on when it returns (the gap is a `hole`); after 15 minutes without it the host gives up and keeps what it has.
 *
 * Stop: ends the capture cleanly. On a recording that is already stopped it is 409 `{ error, recording }`.
 *
 * Live state: one object for the recording in progress and for the ones still being re-encoded, so every client shows the same
 * thing even when ANOTHER client (or a meeting detector) started it. With `Accept: text/event-stream` the host sends one `data:` line
 * of JSON at once and again at least every second while a recording runs, and when anything changes. `elapsedMs` was true at `at` (the
 * host's clock); a client counts on from there with its own clock.
 *
 * Microphone: `WS /:id/mic` (a WebSocket, since it is a stream with no reply, in order, and works over HTTP/1.1 where a
 * streaming fetch body does not). The page sends ONE text message first, `{"hello":1,"now":<Date.now()>}`, so the host knows the
 * difference of the two clocks; then BINARY messages, each 8 bytes (IEEE-754 double, big endian: the sender's `Date.now()` when the
 * first sample of the frame was captured, in milliseconds) followed by ONE Opus packet (48 kHz mono, 2.5 to 60 ms, at most
 * MAX_MIC_FRAME_BYTES). The host closes the socket when the recording ends (1000), when no such recording is in progress
 * (4404), when the recording takes no microphone track (4409) and when another page takes the microphone over (4000). A frame whose
 * time is more than 15 s off is dropped; more than MAX_MIC_FRAMES_PER_SECOND frames a second close it (1008).
 * A browser has no way to set `x-pikvm-recording` on a socket, so this route is guarded by the sign-in and the same-origin check
 * the chat socket has. A page encodes with WebCodecs `AudioEncoder` ("opus"); a browser without it (Safari before 26) does not send a
 * microphone, and the page says so.
 *
 * List: `status` is a comma list of RecordingStatus values to keep (an unknown value is 400), `sort` is one of RECORDING_SORTS
 * (default "newest"; a recording with no duration sorts last under "longest"). Both are optional.
 *
 * Rename: `title` is text of at most MAX_TITLE_CHARS characters (runs of white space become one space), or null or "" to go back to
 * the default name. More than that is 400. The title is part of the view and of the search.
 *
 * Search: full text over every finished transcript's segments and over titles, in an index the host keeps beside the recordings
 * (src/server/recordings/search-index.ts). `q` is words, all of which must match (a word matches its other forms: "upgrading" finds
 * "upgrade"), `"in quotes"` is a phrase, and the LAST word, when the query does not end in a space or a quote, also matches by prefix
 * ("stag" finds "staging"). An empty query, one with nothing but punctuation, or one over MAX_SEARCH_QUERY_CHARS is 400. `limit` is
 * 1 to MAX_SEARCH_LIMIT (default SEARCH_DEFAULT_LIMIT), `offset` 0 or more. `speaker` keeps only segments by that exact label ("You",
 * "Speaker 2") and so leaves out title hits. `from` and `to` keep recordings that STARTED in that range: an ISO time, or a date
 * alone (UTC; `to` then includes that whole day). A host that cannot keep the index answers 503 `{ error }`.
 * Hits come title hits first, then segments best match first (ties: newer recording, earlier second).
 *
 * Writes carry `x-pikvm-recording: 1` (a custom header forces a preflight this server never answers, which is what the JSON
 * content-type rule does for the other routes) and a JSON body (an empty write sends `{}`).
 *
 * Errors are JSON `{ error, ...extra }`. Transcribing on a host that cannot is 503 `{ error }`.
 *
 * Who may use it: every route is behind the host's sign-in (the router judges every request before any route runs), and
 * nothing is served without it, the media route included.
 *
 * Retention and disk: recordings can hold passwords and private talk, so they do not stay for ever and they cannot fill
 * the disk. A recording is deleted RECORDING_RETENTION_DAYS after it ended unless the operator sets
 * `PIKVM_RECORDINGS_RETENTION_DAYS` (0 keeps them); the sweep runs at host start and every hour. What a recording takes is
 * its raw segments waiting to be re-encoded plus its stored segments plus its file; a new recording is refused with 507 when the
 * total on disk would pass RECORDINGS_MAX_TOTAL_BYTES (`PIKVM_RECORDINGS_MAX_BYTES` overrides it). A recording in progress is
 * CLOSED CLEANLY (never stalled, and what it holds is kept) when it reaches the per-recording limit (`reason: "recording_cap"`),
 * when it would take the total past the quota (`reason: "quota"`), or when the raw backlog the re-encoder has not caught up with
 * passes its limit (`reason: "backlog_cap"`). Each view says when it will be deleted.
 */

export const RECORDINGS_PATH = "/app/api/v1/recordings";
export const RECORDING_HEADER = "x-pikvm-recording";
export const RECORDING_LIVE_PATH = `${RECORDINGS_PATH}/live`;

/** The most one recording may hold on disk (raw backlog, stored segments and file), so a forgotten recording cannot fill the disk. */
export const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024;
/** The most all recordings together may take on disk. */
export const RECORDINGS_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
/** Days a finished recording is kept by default. */
export const RECORDING_RETENTION_DAYS = 30;

/** The microphone socket: the bytes before the Opus packet in each binary message, and the most one message may carry. */
export const MIC_FRAME_HEADER_BYTES = 8;
export const MAX_MIC_FRAME_BYTES = 1500;
/** A page sends 50 frames a second (20 ms each); a socket that sends more than this on average is closed. */
export const MAX_MIC_FRAMES_PER_SECOND = 150;
/** The first message of the microphone socket. */
export interface MicHello {
    hello: 1;
    /** The sender's `Date.now()`. */
    now: number;
}

/** The longest title a recording may be given. */
export const MAX_TITLE_CHARS = 200;
/** The longest search query the host will take. */
export const MAX_SEARCH_QUERY_CHARS = 200;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;

/** Containers the host keeps: what it makes itself is always MP4; recordings an older version took from a browser may be WebM. */
export const RECORDING_MIMES = ["video/webm", "video/mp4"] as const;
export type RecordingMime = (typeof RECORDING_MIMES)[number];

export type RecordingStatus = "recording" | "finishing" | "ready" | "transcribing" | "done" | "failed";

/** Who made the file: the host (from the PiKVM's own stream) or, for recordings older than that, a browser. */
export type RecordingSource = "host" | "browser";

/**
 * Why a capture ended:
 *   stopped        someone stopped it
 *   quota          the recordings together would have passed RECORDINGS_MAX_TOTAL_BYTES
 *   recording_cap  this recording reached MAX_RECORDING_BYTES
 *   backlog_cap    the raw stream waiting to be re-encoded grew past its limit (the host's re-encoder is behind)
 *   duration       a time limit was reached
 *   error          the PiKVM could not be reached for 15 minutes, or the recorder kept failing; see `error`
 *   interrupted    the host stopped or restarted while it recorded; what it had was recovered
 * Every one but "interrupted" and "error" is a clean end; all keep what was captured.
 */
export type RecordingEndReason = "stopped" | "quota" | "recording_cap" | "backlog_cap" | "duration" | "error" | "interrupted";

/** A stretch of the recording's timeline in which the PiKVM sent no picture (it was unreachable, or restarting). */
export interface RecordingHole {
    fromMs: number;
    toMs: number;
}

/** How a recording may be ordered: by when it started, by length, or by size on disk. */
export const RECORDING_SORTS = ["newest", "oldest", "longest", "largest"] as const;
export type RecordingSort = (typeof RECORDING_SORTS)[number];

export interface RecordingView {
    id: string;
    status: RecordingStatus;
    source: RecordingSource;
    mime: RecordingMime;
    /** ISO time the recording started (the host's clock for a host recording). */
    startedAt: string;
    /** The recording's length; while "recording" the time so far, null until known. */
    durationMs: number | null;
    /** What it takes on disk now: while it is made, the raw and stored segments; afterwards the file. */
    bytes: number;
    /** The name the person gave it (rename), or null for the default one, which the page builds from the start time. */
    title: string | null;
    /** What the person was looking at, for the list: the target's name or address. */
    target: string | null;
    /** ISO time the host will delete this recording, or null when retention is off or it is still recording. */
    expiresAt: string | null;
    /** Set when status is "failed": the reason, in a sentence. Also set when the host closed the capture because of an error but kept what it had (`reason: "error"`). */
    error: string | null;
    /** 0..1 while status is "finishing" (the re-encode) or "transcribing", null when that is not known or the status is another. */
    progress: number | null;
    /** Speakers found, once status is "done". */
    speakers: number | null;
    /** Why the capture ended; null while recording and for a recording a browser uploaded. */
    reason: RecordingEndReason | null;
    /** Stretches with no picture (the PiKVM was out of reach), as far as the host knows. Empty for a browser recording. */
    holes: RecordingHole[];
    /** Whether the file has a second audio track (the microphone). Always false for a browser recording, which has the microphone as the right channel of its one track. */
    hasMic: boolean;
    /** The YouTube upload of this recording, when auto-upload or a manual upload ever started for it. Absent otherwise. */
    youtube?: RecordingYouTube;
    /** Set when auto-upload covers this recording and YouTube has not verified it: the text the delete confirmation shows. */
    youtubeWarning?: string;
}

/** Where a recording's YouTube upload stands. "uploaded" means YouTube itself reports the video as uploaded or processed. */
export type RecordingYouTubeState = "pending" | "uploading" | "verifying" | "uploaded" | "failed";

export interface RecordingYouTube {
    state: RecordingYouTubeState;
    /** The video's id on YouTube, once the upload returned one. */
    videoId: string | null;
    /** Why it failed or is being retried, in a sentence; null otherwise. */
    error: string | null;
    /** ISO time YouTube confirmed the video. */
    uploadedAt: string | null;
}

/** The privacy YouTube gives an upload. */
export const YOUTUBE_PRIVACY = ["private", "unlisted", "public"] as const;
export type YouTubePrivacy = (typeof YOUTUBE_PRIVACY)[number];

/** The host's YouTube upload settings. The client secret and the refresh token are never sent: only whether they are set. */
export interface YouTubeSettings {
    autoUpload: boolean;
    privacy: YouTubePrivacy;
    clientId: string | null;
    clientSecretSet: boolean;
    /** Whether a YouTube account is signed in on the host. */
    connected: boolean;
    /** ISO time auto-upload was turned on: earlier recordings are not uploaded automatically. Null when it is off. */
    autoUploadSince: string | null;
    /** ISO time Google's daily YouTube allowance resets and the queue resumes, while uploads are paused for quota. Null otherwise. */
    quotaResumeAt: string | null;
    /** A sign-in in progress: the code to type at Google's device page. Null when none is. */
    pending: { userCode: string; verificationUrl: string; expiresAt: string } | null;
    /** Why the last sign-in or upload setting failed, in a sentence; null when there is no such failure. */
    lastError: string | null;
    /** Turning auto-upload on also queues the existing recordings that were never uploaded. Off by default. */
    backfillOnEnable: boolean;
    /** The batch of existing recordings being uploaded, oldest first. */
    backfill: YouTubeBackfill;
}

/** Progress of the existing recordings queued for YouTube. `eligible` is how many could be queued now. */
export interface YouTubeBackfill {
    eligible: number;
    total: number;
    uploaded: number;
    failed: number;
    /** Recordings still to go while Google's daily allowance is used up; 0 when uploads are not paused for quota. */
    waitingForQuota: number;
}

export type RecordingConnection = "connecting" | "live" | "reconnecting";

/** The state of the capture in progress and of the recordings being finished. */
export interface RecordingLive {
    /** The host's `Date.now()` when this was made; `elapsedMs` was true then. */
    at: number;
    /** The recording being captured, or null. */
    recording: RecordingView | null;
    elapsedMs: number;
    /** Raw stream waiting for the re-encoder, in bytes. */
    rawBacklogBytes: number;
    /** Raw backlog plus stored segments: what this recording takes on disk now. */
    bytes: number;
    /** How the host's link to the PiKVM is; null with no capture. */
    connection: RecordingConnection | null;
    /** Why the link is down, in words, while "reconnecting". */
    connectionNote: string | null;
    /** Stretches with no picture so far. */
    holes: RecordingHole[];
    /** "off": this recording takes no microphone; "waiting": it does and none is connected; "connected": a page is sending one. */
    mic: "off" | "waiting" | "connected";
    /** Recordings that have stopped and are being re-encoded, with how far each is. */
    finishing: Array<{ id: string; progress: number | null }>;
}

export interface StartRecordingBody {
    target?: string | null;
    mic: boolean;
    title?: string | null;
    /** Default true. */
    transcribe?: boolean;
    /** How long before this request the person clicked Record, in ms. The host's count starts from the click. Default 0. */
    clickedAgoMs?: number;
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

/** One match of a search: a segment of a transcript, or a recording's title. */
export interface RecordingSearchHit {
    recording: RecordingView;
    /** "title": the recording's title matched (no time, no speaker). "transcript": one segment matched. */
    kind: "title" | "transcript";
    /** Milliseconds from the start of the recording; null for a title hit. */
    startMs: number | null;
    endMs: number | null;
    /** The label of whoever spoke ("You", "Speaker 1", ...); null for a title hit. */
    speaker: string | null;
    /**
     * The matching text as PLAIN text, cut to about 220 characters around the first match, with an ellipsis where it was cut. It is
     * never HTML: the page draws it as text and wraps `ranges` in its own marks, so nothing in a transcript can inject markup.
     */
    text: string;
    /** Where the query matched in `text`: [start, end) in UTF-16 code units, in order, not overlapping; words of a phrase are joined. */
    ranges: Array<[number, number]>;
    /** SQLite's bm25 of the match: lower is better, and comparable only between hits of one kind. */
    rank: number;
}

export interface RecordingSearchResult {
    /** The query as sent, trimmed. */
    query: string;
    hits: RecordingSearchHit[];
    /** Every hit the query has with these filters, not only this page. */
    total: number;
    /** In how many recordings. */
    recordings: number;
    offset: number;
    limit: number;
}
