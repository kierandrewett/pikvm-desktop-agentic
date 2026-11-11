import { open } from "node:fs/promises";
import {
    YOUTUBE_PRIVACY,
    type RecordingView,
    type RecordingYouTube,
    type YouTubeBackfill,
    type YouTubeSettings,
} from "@pikvm/contracts/recordings";
import { RecordingRefusal, type RecordingStore } from "../store";
import { DEFAULT_CONFIG, YouTubeConfigStore, type YouTubeConfig } from "./config";
import {
    GoogleError,
    SessionGone,
    isQuotaError,
    nextQuotaReset,
    pollDeviceToken,
    refreshAccessToken,
    requestDeviceCode,
    revokeToken,
    sendChunk,
    sessionStatus,
    startUploadSession,
    videoStatus,
    type ChunkResult,
    type FetchLike,
    type PollResult,
} from "./google";
import { EMPTY_RECORD, readUploadRecord, writeUploadRecord, type UploadRecord } from "./state";

/**
 * Uploads finished host recordings to the host owner's YouTube channel (YouTube Data API v3). A recording goes up in a resumable
 * session, in chunks, one recording at a time; it counts as uploaded only once YouTube itself reports the video as uploaded or
 * processed. Its progress is kept in the recording's directory, so a restart carries on where it stopped.
 *
 * Nothing here logs or returns the client secret, the refresh token, or a resumable session address.
 */

/** The part of the recording store this module uses. */
export type YouTubeStore = Pick<RecordingStore, "has" | "ids" | "view" | "status" | "sourceOf" | "endedAtOf" | "bytesOf" | "mimeOf" | "mediaPath" | "dirOf">;

/** The timers the queue waits on: the retries and the quota resume. Tests supply their own so they run without real time. */
export interface YouTubeTimers {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: YouTubeTimers = {
    setTimeout(callback, delayMs) {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return timer;
    },
    clearTimeout(handle) {
        clearTimeout(handle as NodeJS.Timeout | undefined);
    },
};

export interface YouTubeOptions {
    dataDir: string;
    store: YouTubeStore;
    log: (line: string) => void;
    now?: () => number;
    /** Default: the global fetch, looked up at each call. */
    fetch?: FetchLike;
    /** Timers for the retries and the quota resume. Default: the real timers. */
    timers?: YouTubeTimers;
}

export interface YouTubeUploads {
    /** Loads the settings and the recordings' upload states, and carries on with what was in progress. */
    start(): Promise<void>;
    /** Stops retries and waits for the chunk in flight; the state is kept, so the next start carries on. */
    stop(): Promise<void>;
    settings(): YouTubeSettings;
    /** `body` is any of `{ autoUpload?, privacy?, clientId?, clientSecret? }`; null or "" clears a client id or secret. */
    update(body: unknown): Promise<YouTubeSettings>;
    /** Starts the device sign-in. Returns the code to type at Google; the sign-in completes in the background. */
    connect(): Promise<YouTubeSettings>;
    /** Revokes the sign-in at Google, forgets it here, and turns auto-upload off. */
    disconnect(): Promise<YouTubeSettings>;
    /** Queues a recording for upload now (a retry, or the first upload). */
    upload(id: string): Promise<RecordingYouTube>;
    /** Queues every finished host recording that is not on YouTube yet, oldest first. Refused unless connected. */
    backfill(): Promise<YouTubeSettings>;
    /** Called when a host recording's file is ready: queues it when auto-upload covers it. Never throws. */
    consider(id: string): void;
    /** The upload state of a recording, or null when none was ever started for it. */
    stateOf(id: string): RecordingYouTube | null;
    /** Text for the log or the delete confirmation when a recording is about to go without a verified YouTube upload; null otherwise. */
    unverifiedWarning(id: string): string | null;
    /** The recording is being deleted: its upload is dropped. */
    cancel(id: string): void;
}

const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 6 * 3_600_000;
const VERIFY_TRIES = 6;
const VERIFY_GAP_MS = 10_000;
const TOKEN_MARGIN_MS = 60_000;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

/** A job stops here because the host is stopping or the recording is going: its state is left as it was. */
class Interrupted extends Error {}

/** A failure that another attempt cannot fix: the video was rejected, the file is empty, and so on. */
class Terminal extends Error {}

/** The refresh token no longer works: the host must connect again. The recordings wait for that. */
class SignInLost extends Error {
    constructor() {
        super("The YouTube sign-in no longer works. Connect YouTube again.");
    }
}

interface PendingSignIn {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresAt: number;
    intervalMs: number;
    generation: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function asObject(body: unknown): Record<string, unknown> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RecordingRefusal("The request body must be a JSON object.", 400);
    return body as Record<string, unknown>;
}

function toRecordView(record: UploadRecord): RecordingYouTube {
    return { state: record.state, videoId: record.videoId, error: record.error, uploadedAt: record.uploadedAt };
}

function resumable(record: UploadRecord): boolean {
    return record.state === "pending" || record.state === "uploading" || record.state === "verifying";
}

function titleOf(view: RecordingView): string {
    return (view.title ?? `PiKVM recording ${view.startedAt}`).slice(0, 100);
}

export function createYouTubeUploads(options: YouTubeOptions): YouTubeUploads {
    const { store, log } = options;
    const now = options.now ?? Date.now;
    const fetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const timers = options.timers ?? REAL_TIMERS;
    const configs = new YouTubeConfigStore(options.dataDir);

    let config: YouTubeConfig = { ...DEFAULT_CONFIG };
    let configWrites: Promise<void> = Promise.resolve();
    let pending: PendingSignIn | null = null;
    let pollTimer: NodeJS.Timeout | undefined;
    let generation = 0;
    let lastError: string | null = null;
    let access: { token: string; expiresAt: number } | null = null;
    let quotaTimer: unknown = undefined;

    const records = new Map<string, UploadRecord>();
    const queue: string[] = [];
    const queued = new Set<string>();
    const retries = new Map<string, unknown>();
    const cancelled = new Set<string>();
    let running: string | null = null;
    let draining: Promise<void> | null = null;
    let stopping = false;

    const connected = (): boolean => config.clientId !== null && config.clientSecret !== null && config.refreshToken !== null;

    function persistConfig(): Promise<void> {
        configWrites = configWrites.catch(() => undefined).then(() => configs.save(config));
        return configWrites;
    }

    function revokeQuietly(token: string): Promise<void> {
        return revokeToken(token, fetch).catch((error: unknown) => {
            log(`[recordings] the YouTube sign-in could not be revoked at Google (${messageOf(error)}); remove it from the Google account page`);
        });
    }

    function settingsView(): YouTubeSettings {
        return {
            autoUpload: config.autoUpload,
            privacy: config.privacy,
            clientId: config.clientId,
            clientSecretSet: config.clientSecret !== null,
            connected: connected(),
            autoUploadSince: config.autoUploadSince === null ? null : new Date(config.autoUploadSince).toISOString(),
            quotaResumeAt: config.quotaResumeAt === null ? null : new Date(config.quotaResumeAt).toISOString(),
            backfillOnEnable: config.backfillOnEnable,
            backfill: backfillView(),
            pending: pending === null ? null : { userCode: pending.userCode, verificationUrl: pending.verificationUrl, expiresAt: new Date(pending.expiresAt).toISOString() },
            lastError,
        };
    }

    // -- the sign-in -------------------------------------------------------------------------------------------------

    function clearPoll(): void {
        clearTimeout(pollTimer);
        pollTimer = undefined;
    }

    function schedulePoll(gen: number, delayMs: number): void {
        pollTimer = setTimeout(() => void poll(gen).catch((error: unknown) => log(`[recordings] YouTube sign-in: ${messageOf(error)}`)), delayMs);
        pollTimer.unref();
    }

    async function poll(gen: number): Promise<void> {
        const flow = pending;
        if (gen !== generation || flow === null || config.clientId === null || config.clientSecret === null) return;
        if (now() >= flow.expiresAt) {
            pending = null;
            lastError = "The sign-in code expired before it was used. Start again.";
            return;
        }
        let result: PollResult;
        try {
            result = await pollDeviceToken(config.clientId, config.clientSecret, flow.deviceCode, fetch);
        } catch (error) {
            if (gen !== generation) return;
            pending = null;
            lastError = messageOf(error);
            log(`[recordings] YouTube sign-in failed: ${lastError}`);
            return;
        }
        if (gen !== generation) return;
        switch (result.kind) {
            case "pending":
                schedulePoll(gen, flow.intervalMs);
                return;
            case "slow_down":
                flow.intervalMs += 5_000;
                schedulePoll(gen, flow.intervalMs);
                return;
            case "denied":
                pending = null;
                lastError = "Google sign-in was refused.";
                return;
            case "expired":
                pending = null;
                lastError = "The sign-in code expired before it was used. Start again.";
                return;
            case "granted":
                config = { ...config, refreshToken: result.refreshToken };
                access = { token: result.accessToken, expiresAt: now() + result.expiresInSeconds * 1000 };
                pending = null;
                lastError = null;
                await persistConfig();
                log("[recordings] YouTube connected");
                resumeAll();
                return;
        }
    }

    async function getAccessToken(): Promise<string> {
        if (access !== null && access.expiresAt - TOKEN_MARGIN_MS > now()) return access.token;
        const { clientId, clientSecret, refreshToken } = config;
        if (clientId === null || clientSecret === null || refreshToken === null) throw new SignInLost();
        try {
            const fresh = await refreshAccessToken(clientId, clientSecret, refreshToken, fetch);
            access = { token: fresh.accessToken, expiresAt: now() + fresh.expiresInSeconds * 1000 };
            return fresh.accessToken;
        } catch (error) {
            if (error instanceof GoogleError && (error.code === "invalid_grant" || error.code === "invalid_client")) {
                await loseSignIn();
                throw new SignInLost();
            }
            throw error;
        }
    }

    async function loseSignIn(): Promise<void> {
        config = { ...config, refreshToken: null, autoUpload: false, autoUploadSince: null };
        access = null;
        lastError = "The YouTube sign-in no longer works. Connect YouTube again.";
        log("[recordings] the YouTube sign-in no longer works; auto-upload is off until YouTube is connected again");
        await persistConfig();
    }

    // -- the per-recording state -------------------------------------------------------------------------------------

    function current(id: string): UploadRecord {
        return records.get(id) ?? { ...EMPTY_RECORD };
    }

    /** Remembers the state and writes it to the recording's directory. Refuses (Interrupted) once the recording is going. */
    async function save(id: string, record: UploadRecord): Promise<void> {
        if (stopping || cancelled.has(id) || !store.has(id)) throw new Interrupted();
        records.set(id, record);
        await writeUploadRecord(store.dirOf(id), record);
    }

    function ensureActive(id: string): void {
        if (stopping || cancelled.has(id) || !store.has(id)) throw new Interrupted();
    }

    // -- the queue ---------------------------------------------------------------------------------------------------

    function clearRetry(id: string): void {
        const timer = retries.get(id);
        timers.clearTimeout(timer);
        retries.delete(id);
    }

    function scheduleRetry(id: string, delayMs: number): void {
        clearRetry(id);
        const timer = timers.setTimeout(() => {
            retries.delete(id);
            enqueue(id);
        }, delayMs);
        retries.set(id, timer);
    }

    function enqueue(id: string): void {
        if (stopping || queued.has(id) || running === id || !store.has(id)) return;
        clearRetry(id);
        queued.add(id);
        queue.push(id);
        kick();
    }

    function resumeAll(): void {
        if (!connected()) return;
        for (const [id, record] of records) if (resumable(record) && !retries.has(id)) enqueue(id);
        // Oldest first: a recording paused by the quota goes back to the head of the backlog, not behind newer ones.
        queue.sort((a, b) => (store.endedAtOf(a) ?? 0) - (store.endedAtOf(b) ?? 0));
    }

    // -- the daily quota ---------------------------------------------------------------------------------------------

    /** Google's daily allowance is used up: nothing is tried until it resets, then the queue carries on. */
    function pauseForQuota(): void {
        const at = nextQuotaReset(now());
        config = { ...config, quotaResumeAt: at };
        armQuotaTimer(at);
        log(`[recordings] YouTube's daily upload allowance is used up; uploads are paused until ${new Date(at).toISOString()}`);
        persistConfig().catch((error: unknown) => log(`[recordings] could not save the YouTube pause: ${messageOf(error)}`));
    }

    function armQuotaTimer(at: number): void {
        timers.clearTimeout(quotaTimer);
        quotaTimer = timers.setTimeout(() => {
            quotaTimer = undefined;
            resumeFromQuota();
        }, Math.max(0, at - now()));
    }

    function resumeFromQuota(): void {
        const at = config.quotaResumeAt;
        if (at === null || stopping) return;
        if (now() < at) {
            armQuotaTimer(at);
            return;
        }
        config = { ...config, quotaResumeAt: null };
        persistConfig().catch((error: unknown) => log(`[recordings] could not save the YouTube resume: ${messageOf(error)}`));
        log("[recordings] YouTube's daily upload allowance has reset: uploads resume");
        resumeAll();
        kick();
    }

    /** Runs the queue one recording at a time. The flag is cleared in the same synchronous step that ends the loop. */
    function kick(): void {
        if (draining !== null || stopping) return;
        const drain = async (): Promise<void> => {
            while (queue.length > 0 && !stopping && config.quotaResumeAt === null) {
                const id = queue.shift();
                if (id === undefined) break;
                queued.delete(id);
                running = id;
                try {
                    await runJob(id);
                } catch (error) {
                    log(`[recordings] ${id}: the YouTube upload failed unexpectedly: ${messageOf(error)}`);
                } finally {
                    running = null;
                    cancelled.delete(id);
                }
            }
        };
        // Clear the flag only once the drain has settled, so a synchronous early exit cannot leave a stale promise.
        draining = drain().finally(() => {
            draining = null;
        });
    }

    async function runJob(id: string): Promise<void> {
        if (!store.has(id)) return;
        try {
            const record = current(id);
            if (record.state === "verifying" && record.videoId !== null) await verify(id, record.videoId);
            else await upload(id);
        } catch (error) {
            await onJobError(id, error);
        }
    }

    async function onJobError(id: string, error: unknown): Promise<void> {
        if (error instanceof Interrupted || error instanceof SignInLost || !store.has(id)) return;
        const record = current(id);
        const message = messageOf(error);
        if (isQuotaError(error)) {
            // Not this recording's fault: it stays queued, untouched, until the allowance resets.
            await save(id, { ...record, error: message, nextAttemptAt: null }).catch(() => undefined);
            pauseForQuota();
            return;
        }
        const attempts = record.attempts + 1;
        const terminal = error instanceof Terminal || (error instanceof GoogleError && !error.transient);
        if (terminal || attempts >= MAX_ATTEMPTS) {
            const reason = terminal ? message : `Gave up after ${attempts} attempts: ${message}`;
            log(`[recordings] ${id} was not uploaded to YouTube: ${reason}`);
            await save(id, { ...record, state: "failed", attempts, error: reason, nextAttemptAt: null }).catch(() => undefined);
            return;
        }
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
        log(`[recordings] ${id} YouTube upload attempt ${attempts} failed: ${message}; trying again in ${Math.round(delay / 1000)} s`);
        await save(id, { ...record, attempts, error: message, nextAttemptAt: now() + delay }).catch(() => undefined);
        scheduleRetry(id, delay);
    }

    // -- the upload and its check ------------------------------------------------------------------------------------

    async function upload(id: string): Promise<void> {
        const size = store.bytesOf(id);
        if (size === 0) throw new Terminal("The recording is empty: there is nothing to upload.");
        const mime = store.mimeOf(id);
        const view = store.view(id);
        const token = await getAccessToken();
        let record = current(id);
        let session = record.sessionUrl;
        let offset = 0;
        if (session !== null) {
            let status: ChunkResult | null = null;
            try {
                status = await sessionStatus(session, size, fetch);
            } catch (error) {
                if (!(error instanceof SessionGone)) throw error;
                session = null;
            }
            if (status?.kind === "done") {
                await videoUploaded(id, record, status.videoId);
                return;
            }
            if (status !== null) offset = status.next;
        }
        if (session === null) {
            session = await startUploadSession(token, { title: titleOf(view), description: `Recorded with PiKVM Desktop, started ${view.startedAt}.`, privacy: config.privacy }, size, mime, fetch);
            offset = 0;
        }
        record = { ...record, state: "uploading", sessionUrl: session, error: null };
        await save(id, record);

        const handle = await open(store.mediaPath(id), "r");
        try {
            for (;;) {
                ensureActive(id);
                if (offset >= size) {
                    await save(id, { ...record, sessionUrl: null });
                    throw new Error("YouTube took every byte but did not confirm the video; it will start the upload again.");
                }
                const length = Math.min(CHUNK_BYTES, size - offset);
                const chunk = Buffer.alloc(length);
                const { bytesRead } = await handle.read(chunk, 0, length, offset);
                if (bytesRead !== length) throw new Terminal("The recording file changed while it was being uploaded.");
                let result;
                try {
                    result = await sendChunk(session, chunk, offset, size, mime, fetch);
                } catch (error) {
                    if (error instanceof SessionGone) {
                        await save(id, { ...record, sessionUrl: null });
                        throw new Error("The YouTube upload session expired; it will start again.");
                    }
                    throw error;
                }
                if (result.kind === "done") {
                    await videoUploaded(id, record, result.videoId);
                    return;
                }
                offset = result.next;
            }
        } finally {
            await handle.close();
        }
    }

    /** YouTube only lists a new video after a moment: it is asked several times, then the job is tried again later. */
    async function verify(id: string, videoId: string): Promise<void> {
        let seen = "YouTube has not listed the video yet";
        for (let attempt = 1; attempt <= VERIFY_TRIES; attempt++) {
            ensureActive(id);
            const status = await videoStatus(await getAccessToken(), videoId, fetch);
            if (status.found && (status.uploadStatus === "uploaded" || status.uploadStatus === "processed")) {
                const record = current(id);
                await save(id, { ...record, state: "uploaded", videoId, error: null, uploadedAt: new Date(now()).toISOString(), nextAttemptAt: null, attempts: 0 });
                log(`[recordings] ${id} is on YouTube as ${videoId} (${status.uploadStatus})`);
                return;
            }
            if (status.found && (status.uploadStatus === "failed" || status.uploadStatus === "rejected" || status.uploadStatus === "deleted")) {
                const reason = status.rejectionReason ?? status.failureReason;
                throw new Terminal(`YouTube ${status.uploadStatus === "rejected" ? "rejected" : "could not process"} the video${reason ? ` (${reason})` : ""}.`);
            }
            seen = status.found ? `YouTube reports the video as ${status.uploadStatus ?? "not yet known"}` : seen;
            if (attempt < VERIFY_TRIES) await sleep(VERIFY_GAP_MS);
        }
        throw new Error(`${seen}; it will be checked again.`);
    }

    /** The upload is complete at YouTube: the video id is saved before YouTube is asked about it, so a restart checks it instead of uploading again. */
    async function videoUploaded(id: string, record: UploadRecord, videoId: string): Promise<void> {
        await save(id, { ...record, state: "verifying", videoId, sessionUrl: null, error: null });
        await verify(id, videoId);
    }

    // -- starting and stopping ---------------------------------------------------------------------------------------

    async function considerNow(id: string): Promise<void> {
        if (!config.autoUpload || !connected() || !store.has(id) || store.sourceOf(id) !== "host") return;
        const ended = store.endedAtOf(id);
        if (ended === null || config.autoUploadSince === null || ended < config.autoUploadSince) return;
        if (records.has(id)) return;
        await save(id, { ...EMPTY_RECORD });
        enqueue(id);
    }

    // -- backfill ----------------------------------------------------------------------------------------------------

    /**
     * Host recordings that are finished, have bytes, and are not yet on YouTube. Failed ones are left out: they need a manual retry.
     * Oldest first. Includes recordings already queued, so the Settings count is the work still to do.
     */
    function candidateIds(): string[] {
        const found: { id: string; at: number }[] = [];
        for (const id of store.ids()) {
            if (store.sourceOf(id) !== "host") continue;
            const status = store.status(id);
            if (status === "recording" || status === "finishing") continue;
            const at = store.endedAtOf(id);
            if (at === null || store.bytesOf(id) === 0) continue;
            const record = records.get(id);
            if (record !== undefined && !resumable(record)) continue;
            found.push({ id, at });
        }
        return found.sort((a, b) => a.at - b.at).map((f) => f.id);
    }

    /** Candidates that are not already queued, running or waiting on a retry: what a backfill adds to the queue. */
    function eligibleIds(): string[] {
        return candidateIds().filter((id) => !queued.has(id) && running !== id && !retries.has(id));
    }

    /** A batch member is settled when it is on YouTube, failed, or its recording is gone. */
    function settled(id: string): boolean {
        if (!store.has(id)) return true;
        const state = records.get(id)?.state;
        return state === "uploaded" || state === "failed";
    }

    function backfillView(): YouTubeBackfill {
        const batch = (config.backfillIds ?? []).filter((id) => store.has(id));
        let uploaded = 0;
        let failed = 0;
        for (const id of batch) {
            const state = records.get(id)?.state;
            if (state === "uploaded") uploaded += 1;
            else if (state === "failed") failed += 1;
        }
        const total = batch.length;
        return {
            eligible: candidateIds().length,
            total,
            uploaded,
            failed,
            waitingForQuota: config.quotaResumeAt === null ? 0 : total - uploaded - failed,
        };
    }

    /** Resets a recording's attempts and error and queues it. The manual upload and the backfill both start this way. */
    async function requeue(id: string): Promise<void> {
        const record = current(id);
        const state = record.state === "verifying" ? "verifying" : record.state === "uploading" ? "uploading" : "pending";
        await save(id, { ...record, attempts: 0, error: null, nextAttemptAt: null, state });
        enqueue(id);
    }

    /**
     * Queues every eligible recording, oldest first (FIFO queue, so the oldest goes up first). The batch is kept in config so its
     * progress survives a restart; a call while a batch is still running adds to it, and a call after it finished starts a new one.
     * Honours the quota pause: queued recordings wait in the queue until the allowance resets.
     */
    async function startBackfill(): Promise<void> {
        if (!connected()) throw new RecordingRefusal("Connect YouTube before uploading.", 409);
        const eligible = eligibleIds();
        if (eligible.length === 0) return;
        const batch = config.backfillIds ?? [];
        const kept = batch.every(settled) ? [] : batch.filter((id) => store.has(id));
        config = { ...config, backfillIds: [...new Set([...kept, ...eligible])] };
        await persistConfig();
        log(`[recordings] queued ${eligible.length} existing recording(s) for YouTube, oldest first`);
        try {
            for (const id of eligible) await requeue(id);
        } catch (error) {
            if (!(error instanceof Interrupted)) throw error;
        }
    }

    return {
        async start() {
            config = await configs.load();
            if (config.quotaResumeAt !== null) {
                if (now() >= config.quotaResumeAt) {
                    config = { ...config, quotaResumeAt: null };
                    await persistConfig();
                } else {
                    armQuotaTimer(config.quotaResumeAt);
                    log(`[recordings] YouTube uploads are paused for the daily allowance until ${new Date(config.quotaResumeAt).toISOString()}`);
                }
            }
            for (const id of store.ids()) {
                const record = await readUploadRecord(store.dirOf(id));
                if (record !== null) records.set(id, record);
            }
            let waiting = 0;
            for (const [id, record] of records) {
                if (!resumable(record)) continue;
                waiting += 1;
                if (!connected()) continue;
                if (record.nextAttemptAt !== null && record.nextAttemptAt > now()) scheduleRetry(id, record.nextAttemptAt - now());
                else enqueue(id);
            }
            if (waiting > 0) log(`[recordings] ${waiting} YouTube upload(s) waiting${connected() ? " and carried on" : ": YouTube is not connected"}`);
        },

        async stop() {
            stopping = true;
            clearPoll();
            pending = null;
            for (const id of [...retries.keys()]) clearRetry(id);
            timers.clearTimeout(quotaTimer);
            quotaTimer = undefined;
            if (draining !== null) await draining.catch(() => undefined);
            await configWrites.catch(() => undefined);
        },

        settings: settingsView,

        async update(body) {
            const input = asObject(body);
            const next: YouTubeConfig = { ...config };
            if ("backfillOnEnable" in input) {
                if (typeof input["backfillOnEnable"] !== "boolean") throw new RecordingRefusal("backfillOnEnable must be true or false.", 400);
                next.backfillOnEnable = input["backfillOnEnable"];
            }
            if ("autoUpload" in input) {
                if (typeof input["autoUpload"] !== "boolean") throw new RecordingRefusal("autoUpload must be true or false.", 400);
                next.autoUpload = input["autoUpload"];
            }
            if ("privacy" in input) {
                const privacy = YOUTUBE_PRIVACY.find((p) => p === input["privacy"]);
                if (privacy === undefined) throw new RecordingRefusal(`privacy must be ${YOUTUBE_PRIVACY.join(", ")}.`, 400);
                next.privacy = privacy;
            }
            if ("clientId" in input) {
                const raw = input["clientId"];
                if (raw === null || raw === "") next.clientId = null;
                else if (typeof raw === "string" && CLIENT_ID_PATTERN.test(raw.trim())) next.clientId = raw.trim();
                else throw new RecordingRefusal("The client ID is the text Google gave you: letters, digits, dots, dashes and underscores.", 400);
            }
            if ("clientSecret" in input) {
                const raw = input["clientSecret"];
                if (raw === null || raw === "") next.clientSecret = null;
                else if (typeof raw === "string" && raw.trim().length <= 500 && !/\s/.test(raw.trim())) next.clientSecret = raw.trim();
                else throw new RecordingRefusal("The client secret is the text Google gave you, without spaces.", 400);
            }
            // A sign-in belongs to one client: changing or clearing the client id or secret ends it.
            const lost = next.clientId !== config.clientId || next.clientSecret !== config.clientSecret;
            if (lost) {
                next.refreshToken = null;
                next.autoUpload = false;
            }
            // Checked before anything is revoked, so a refused request leaves the sign-in as it was.
            if (next.autoUpload && (next.clientId === null || next.clientSecret === null || next.refreshToken === null)) {
                throw new RecordingRefusal("Connect YouTube before turning on auto-upload.", 409);
            }
            if (lost) {
                generation += 1;
                clearPoll();
                pending = null;
                access = null;
                if (config.refreshToken !== null) await revokeQuietly(config.refreshToken);
            }
            if (!next.autoUpload) next.autoUploadSince = null;
            else if (!config.autoUpload) next.autoUploadSince = now();
            const enabling = next.autoUpload && !config.autoUpload;
            config = next;
            await persistConfig();
            if (enabling && next.backfillOnEnable) {
                await startBackfill().catch((error: unknown) => log(`[recordings] could not queue the existing recordings: ${messageOf(error)}`));
            }
            return settingsView();
        },

        async connect() {
            if (config.clientId === null || config.clientSecret === null) throw new RecordingRefusal("Enter the client ID and client secret first.", 400);
            const gen = ++generation;
            clearPoll();
            let code;
            try {
                code = await requestDeviceCode(config.clientId, fetch);
            } catch (error) {
                lastError = messageOf(error);
                throw new RecordingRefusal(lastError, 502);
            }
            pending = {
                deviceCode: code.deviceCode,
                userCode: code.userCode,
                verificationUrl: code.verificationUrl,
                expiresAt: now() + code.expiresInSeconds * 1000,
                intervalMs: code.intervalSeconds * 1000,
                generation: gen,
            };
            lastError = null;
            schedulePoll(gen, pending.intervalMs);
            return settingsView();
        },

        async disconnect() {
            generation += 1;
            clearPoll();
            pending = null;
            lastError = null;
            const token = config.refreshToken;
            if (token !== null) await revokeQuietly(token);
            config = { ...config, refreshToken: null, autoUpload: false, autoUploadSince: null };
            access = null;
            await persistConfig();
            return settingsView();
        },

        async upload(id) {
            store.view(id);
            if (!connected()) throw new RecordingRefusal("Connect YouTube before uploading.", 409);
            const status = store.status(id);
            if (status === "recording" || status === "finishing") throw new RecordingRefusal("This recording is not finished yet.", 409);
            if (store.bytesOf(id) === 0) throw new RecordingRefusal("This recording is empty.", 409);
            if (queued.has(id) || running === id) throw new RecordingRefusal("This recording is already queued for YouTube.", 409);
            const record = current(id);
            if (record.state === "uploaded") throw new RecordingRefusal("This recording is already on YouTube.", 409);
            await requeue(id);
            return toRecordView(current(id));
        },
        async backfill() {
            await startBackfill();
            return settingsView();
        },

        consider(id) {
            considerNow(id).catch((error: unknown) => log(`[recordings] ${id}: could not queue the YouTube upload: ${messageOf(error)}`));
        },

        stateOf(id) {
            if (!store.has(id)) return null;
            const record = records.get(id);
            return record === undefined ? null : toRecordView(record);
        },

        unverifiedWarning(id) {
            if (!config.autoUpload || config.autoUploadSince === null || !store.has(id) || store.sourceOf(id) !== "host") return null;
            const ended = store.endedAtOf(id);
            if (ended === null || ended < config.autoUploadSince) return null;
            if (records.get(id)?.state === "uploaded") return null;
            return "YouTube auto-upload is on and this recording is not verified as uploaded.";
        },

        cancel(id) {
            const at = queue.indexOf(id);
            if (at !== -1) queue.splice(at, 1);
            queued.delete(id);
            clearRetry(id);
            if (running === id) cancelled.add(id);
            records.delete(id);
        },
    };
}
