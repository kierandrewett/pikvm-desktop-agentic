/**
 * The Google endpoints a YouTube upload needs, as plain functions over `fetch`: the OAuth device flow (to sign the host in
 * without a browser on it), refresh, revoke, a resumable upload session, its chunks, and the status of the video it made.
 *
 * Nothing here logs or returns a token. A failure is a GoogleError: `transient` says whether trying again later can help.
 */

export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

/** YouTube's category for "Science & Technology": a screen recording's default. The API requires one. */
const CATEGORY_ID = "28";

/** Every request gives up after this long: a stalled connection must not hold the upload queue for ever. */
const REQUEST_TIMEOUT_MS = 60_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GoogleError extends Error {
    constructor(
        message: string,
        readonly status: number,
        /** Google's own error code when it gave one (`invalid_grant`, `authorization_pending`, ...). */
        readonly code: string | null,
        /** Whether trying again later can succeed. */
        readonly transient: boolean,
        /** Google's error reason (`quotaExceeded`, `rateLimitExceeded`, ...) when the answer named one. */
        readonly reason: string | null = null,
    ) {
        super(message);
        this.name = "GoogleError";
    }
}

/** The upload session is gone (Google answers 404 or 410): it must be started again from the beginning. */
export class SessionGone extends Error {
    constructor() {
        super("The upload session expired.");
        this.name = "SessionGone";
    }
}

export interface DeviceCode {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresInSeconds: number;
    intervalSeconds: number;
}

export type PollResult =
    | { kind: "pending" }
    | { kind: "slow_down" }
    | { kind: "denied" }
    | { kind: "expired" }
    | { kind: "granted"; accessToken: string; expiresInSeconds: number; refreshToken: string };

export interface VideoStatus {
    /** Whether YouTube has a video with that id (it may not yet, right after the upload). */
    found: boolean;
    uploadStatus: string | null;
    failureReason: string | null;
    rejectionReason: string | null;
}

export interface UploadMetadata {
    title: string;
    description: string;
    privacy: "private" | "unlisted" | "public";
}

function signal(): AbortSignal {
    return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

/** Google's reasons for "the day's allowance is used up": they clear at the next reset, so the queue waits for it. */
const QUOTA_REASONS: readonly string[] = ["quotaExceeded", "dailyLimitExceeded", "uploadLimitExceeded"];
/** Google's reasons for "too many requests too fast": a short wait clears them. */
const RATE_REASONS: readonly string[] = ["rateLimitExceeded", "userRateLimitExceeded"];

async function failure(response: Response, what: string): Promise<GoogleError> {
    let code: string | null = null;
    let reason: string | null = null;
    let detail = "";
    try {
        const raw: unknown = await response.json();
        if (typeof raw === "object" && raw !== null) {
            // Google's text for the failure is safe to show; it never contains the secret we sent.
            if ("error" in raw && typeof raw.error === "string") code = raw.error;
            if ("error_description" in raw && typeof raw.error_description === "string") {
                detail = `: ${raw.error_description}`;
            } else if ("error" in raw && typeof raw.error === "object" && raw.error !== null) {
                if ("message" in raw.error && typeof raw.error.message === "string") detail = `: ${raw.error.message}`;
                // The Data API names the cause in error.errors[0].reason, e.g. quotaExceeded.
                if ("errors" in raw.error && Array.isArray(raw.error.errors)) {
                    const first: unknown = raw.error.errors[0];
                    if (typeof first === "object" && first !== null && "reason" in first && typeof first.reason === "string") reason = first.reason;
                }
            }
        }
    } catch {
        // Not JSON: the status says what happened.
    }
    const transient = response.status === 429 || response.status >= 500 || (reason !== null && RATE_REASONS.includes(reason));
    return new GoogleError(`${what} failed (HTTP ${response.status})${detail}`, response.status, code, transient, reason);
}

/** True when Google says the day's YouTube API allowance is used up. */
export function isQuotaError(error: unknown): boolean {
    return error instanceof GoogleError && error.reason !== null && QUOTA_REASONS.includes(error.reason);
}

const PACIFIC_ZONE = "America/Los_Angeles";
const pacificFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
});

/** The Pacific wall clock at `ms`, read as if it were UTC. Its difference from `ms` is the zone's offset then. */
function pacificWallClock(ms: number): number {
    const parts = new Map<string, number>();
    for (const part of pacificFormat.formatToParts(ms)) if (part.type !== "literal") parts.set(part.type, Number(part.value));
    const at = (type: string): number => parts.get(type) ?? 0;
    return Date.UTC(at("year"), at("month") - 1, at("day"), at("hour"), at("minute"), at("second"));
}

/** When Google's daily allowance next resets: the first midnight in Pacific time after `nowMs` (epoch ms). */
export function nextQuotaReset(nowMs: number): number {
    const wall = new Date(pacificWallClock(nowMs));
    const midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1);
    // The offset differs either side of a daylight-saving change, so it is refined once.
    const first = midnight - (pacificWallClock(midnight) - midnight);
    return midnight - (pacificWallClock(first) - first);
}

export async function requestDeviceCode(clientId: string, fetch: FetchLike): Promise<DeviceCode> {
    const response = await fetch(DEVICE_CODE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, scope: YOUTUBE_SCOPE }),
        signal: signal(),
    });
    if (!response.ok) throw await failure(response, "Asking Google for a sign-in code");
    const body = (await response.json()) as Record<string, unknown>;
    const deviceCode = body["device_code"];
    const userCode = body["user_code"];
    const url = body["verification_url"] ?? body["verification_uri"];
    const expires = body["expires_in"];
    const interval = body["interval"];
    if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof url !== "string" || typeof expires !== "number") {
        throw new GoogleError("Google sent a sign-in code this host cannot read.", response.status, null, false);
    }
    return {
        deviceCode,
        userCode,
        verificationUrl: url,
        expiresInSeconds: expires,
        intervalSeconds: typeof interval === "number" && interval > 0 ? interval : 5,
    };
}

/** One poll of the device flow. Google's "not yet" answers are results, not errors. */
export async function pollDeviceToken(clientId: string, clientSecret: string, deviceCode: string, fetch: FetchLike): Promise<PollResult> {
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal: signal(),
    });
    if (response.ok) {
        const body = (await response.json()) as Record<string, unknown>;
        const accessToken = body["access_token"];
        const refreshToken = body["refresh_token"];
        if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
            throw new GoogleError("Google signed the host in without a refresh token; disconnect and connect again.", response.status, null, false);
        }
        const expires = typeof body["expires_in"] === "number" ? body["expires_in"] : 3600;
        return { kind: "granted", accessToken, expiresInSeconds: expires, refreshToken };
    }
    const error = await failure(response, "Waiting for Google's sign-in");
    switch (error.code) {
        case "authorization_pending":
            return { kind: "pending" };
        case "slow_down":
            return { kind: "slow_down" };
        case "access_denied":
            return { kind: "denied" };
        case "expired_token":
            return { kind: "expired" };
        default:
            throw error;
    }
}

/** A fresh access token from the refresh token. `invalid_grant` means the sign-in was revoked or the client changed. */
export async function refreshAccessToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
    fetch: FetchLike,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
        }),
        signal: signal(),
    });
    if (!response.ok) throw await failure(response, "Refreshing the YouTube sign-in");
    const body = (await response.json()) as Record<string, unknown>;
    const accessToken = body["access_token"];
    if (typeof accessToken !== "string") throw new GoogleError("Google sent no access token.", response.status, null, true);
    const expires = typeof body["expires_in"] === "number" ? body["expires_in"] : 3600;
    return { accessToken, expiresInSeconds: expires };
}

/** Best effort: a revoke that fails leaves the token valid at Google, which the host can say in its settings. */
export async function revokeToken(token: string, fetch: FetchLike): Promise<void> {
    const response = await fetch(REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal: signal(),
    });
    if (!response.ok) throw await failure(response, "Revoking the YouTube sign-in");
}

/** Opens a resumable upload session and returns its URL. The metadata is all the video's description the host sends. */
export async function startUploadSession(accessToken: string, meta: UploadMetadata, size: number, mime: string, fetch: FetchLike): Promise<string> {
    const response = await fetch(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json; charset=UTF-8",
            "x-upload-content-length": String(size),
            "x-upload-content-type": mime,
        },
        body: JSON.stringify({
            snippet: { title: meta.title, description: meta.description, categoryId: CATEGORY_ID },
            status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: false },
        }),
        signal: signal(),
    });
    if (!response.ok) throw await failure(response, "Starting the YouTube upload");
    const location = response.headers.get("location");
    if (!location) throw new GoogleError("YouTube started an upload without a session address.", response.status, null, true);
    return location;
}

/** The first byte Google has not kept yet, from a 308 answer (no Range header: nothing kept). */
function nextOffset(response: Response): number {
    const range = response.headers.get("range");
    const match = range ? /^bytes=0-(\d+)$/.exec(range) : null;
    return match ? Number(match[1]) + 1 : 0;
}

/** The video id from a finished upload's answer. */
async function videoIdOf(response: Response): Promise<string> {
    const video = (await response.json()) as { id?: unknown };
    if (typeof video.id !== "string" || video.id === "") throw new GoogleError("YouTube finished the upload without a video id.", response.status, null, true);
    return video.id;
}

/** Asks an open session how much it has, with no body. A session that already finished answers with the video it made. */
export async function sessionStatus(sessionUrl: string, total: number, fetch: FetchLike): Promise<ChunkResult> {
    const response = await fetch(sessionUrl, {
        method: "PUT",
        headers: { "content-range": `bytes */${total}`, "content-length": "0" },
        signal: signal(),
    });
    if (response.status === 404 || response.status === 410) throw new SessionGone();
    if (response.status === 308) return { kind: "kept", next: nextOffset(response) };
    if (!response.ok) throw await failure(response, "Checking the YouTube upload");
    return { kind: "done", videoId: await videoIdOf(response) };
}

export type ChunkResult = { kind: "kept"; next: number } | { kind: "done"; videoId: string };

/** Sends one chunk at `start`. `end` is exclusive; the last chunk of the file ends at `total`. */
export async function sendChunk(
    sessionUrl: string,
    body: Uint8Array,
    start: number,
    total: number,
    mime: string,
    fetch: FetchLike,
): Promise<ChunkResult> {
    const end = start + body.byteLength - 1;
    const response = await fetch(sessionUrl, {
        method: "PUT",
        headers: { "content-type": mime, "content-length": String(body.byteLength), "content-range": `bytes ${start}-${end}/${total}` },
        // A view over the chunk's bytes: a Buffer's ArrayBufferLike backing is not a BodyInit under TypeScript 5.9's lib types.
        body: body as BodyInit,
        // Long chunks on a slow link: the timeout covers a chunk, not the whole file.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4),
    });
    if (response.status === 404 || response.status === 410) throw new SessionGone();
    if (response.status === 308) return { kind: "kept", next: nextOffset(response) };
    if (!response.ok) throw await failure(response, "Uploading to YouTube");
    return { kind: "done", videoId: await videoIdOf(response) };
}

/** What YouTube says about the processing of a video it has. The upload only counts once this says uploaded or processed. */
export async function videoStatus(accessToken: string, videoId: string, fetch: FetchLike): Promise<VideoStatus> {
    const url = `${VIDEOS_URL}?part=status&id=${encodeURIComponent(videoId)}`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: signal() });
    if (!response.ok) throw await failure(response, "Checking the YouTube video");
    const body = (await response.json()) as { items?: { status?: Record<string, unknown> }[] };
    const item = body.items?.[0];
    if (!item) return { found: false, uploadStatus: null, failureReason: null, rejectionReason: null };
    const status = item.status ?? {};
    const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
    return {
        found: true,
        uploadStatus: text(status["uploadStatus"]),
        failureReason: text(status["failureReason"]),
        rejectionReason: text(status["rejectionReason"]),
    };
}
