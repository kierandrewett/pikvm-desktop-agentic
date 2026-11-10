/**
 * Streams a recording to the host while it is made: create, then every chunk in order and one at a time, then finish.
 *
 * The protocol is strictly in order (the host counts chunks), so there is one request in flight at a time and the rest
 * wait in memory. A chunk that fails is tried again with a growing pause, for as long as the memory cap allows; when the
 * host stays away past the cap the recording is stopped with a sentence that says so, never silently thinned. A 409
 * carries how many chunks the host holds: that many is where sending resumes (a chunk the host stored but whose answer
 * was lost is not sent twice, a chunk the host lost is sent again from the few this keeps).
 *
 * On pagehide the page is going away and a normal request is cancelled with it, so the waiting chunks and the finish
 * are sent with `keepalive`, which survives the page but is capped by the browser at about 64 KiB for all of a page's
 * requests together. What does not fit is lost; the host closes an unfinished recording on its own.
 */

import { createStore, type ReadableStore } from "@pikvm/kvm-engine";
import type { RecordingMime, RecordingView } from "@pikvm/contracts/recordings";
import { createRecording, deleteRecording, finishRecording, getRecording, listRecordings, putChunk, RecordingsError } from "./api";

export interface UploadState {
    readonly id: string | null;
    readonly chunksAcked: number;
    readonly bytesAcked: number;
    readonly queuedBytes: number;
    /** A chunk failed and is waiting to be tried again. */
    readonly retrying: boolean;
    readonly error: string | null;
}

export interface UploaderOptions {
    readonly mime: RecordingMime;
    readonly startedAt: Date;
    readonly target: string | null;
    /** Called once, with a sentence, when the upload can no longer go on. */
    readonly onFail: (message: string) => void;
    /** What may wait in memory while the host is away. */
    readonly maxQueueBytes?: number;
    /** Pauses between tries of one request; the last one repeats. */
    readonly backoffMs?: ReadonlyArray<number>;
    /** How long `finish` keeps trying to empty the queue before it gives up. */
    readonly finishPatienceMs?: number;
}

export interface Uploader {
    readonly store: ReadableStore<UploadState>;
    /** Create the recording on the host. Rejects with a `RecordingsError` (507 when the disk limit is reached). */
    open(): Promise<RecordingView>;
    /** Queue the next chunk of the recording; `endMs` is how long the recording had run when it was cut. */
    push(chunk: Blob, endMs: number): void;
    /** Send what is queued, then close the recording. Rejects when the host cannot be reached for long enough. */
    finish(durationMs: number): Promise<RecordingView>;
    /** The page is going away: send what fits with `keepalive` and close the recording. */
    pageHide(durationMs: number): void;
    /** Give up on the upload: close the recording with what the host holds (or remove it when it holds nothing). */
    abandon(): Promise<void>;
}

interface Item {
    readonly n: number;
    readonly blob: Blob;
    readonly endMs: number;
}

export const DEFAULT_MAX_QUEUE_BYTES = 48 * 1024 * 1024;
export const DEFAULT_BACKOFF_MS: ReadonlyArray<number> = [1000, 2000, 4000, 8000, 15_000];
const DEFAULT_FINISH_PATIENCE_MS = 90_000;
/** Chunks kept after they are acknowledged, so a host that lost the last few can be sent them again. */
const KEEP_SENT = 8;
/** Browsers cap all `keepalive` bodies of a page together at 64 KiB; stay under it. */
const KEEPALIVE_BUDGET_BYTES = 60 * 1024;
const MAX_REPEATED_CONFLICTS = 5;
const FINISH_TRIES = 5;

const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

export function createUploader(options: UploaderOptions): Uploader {
    const maxQueueBytes = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    const patienceMs = options.finishPatienceMs ?? DEFAULT_FINISH_PATIENCE_MS;
    const store = createStore<UploadState>({ id: null, chunksAcked: 0, bytesAcked: 0, queuedBytes: 0, retrying: false, error: null });
    const patch = (next: Partial<UploadState>): void => store.setState({ ...store.getState(), ...next });

    const queue: Item[] = [];
    const sent: Item[] = [];
    const abort = new AbortController();
    let id: string | null = null;
    let nextN = 0;
    let ackedEndMs = 0;
    let lastEndMs = 0;
    let transcribe = false;
    let dead = false;
    let hiding = false;
    let hidingBudget = KEEPALIVE_BUDGET_BYTES;
    const hidingSent = new Set<number>();
    let inFlight: Item | null = null;
    let pumping: Promise<void> | null = null;

    const fail = (message: string): void => {
        if (dead) return;
        dead = true;
        abort.abort();
        patch({ error: message, retrying: false });
        options.onFail(message);
    };

    const sleep = (ms: number): Promise<void> =>
        new Promise<void>((resolve) => {
            if (abort.signal.aborted) return resolve();
            const timer = setTimeout(resolve, ms);
            abort.signal.addEventListener(
                "abort",
                () => {
                    clearTimeout(timer);
                    resolve();
                },
                { once: true },
            );
        });

    const ack = (item: Item): void => {
        queue.shift();
        sent.push(item);
        if (sent.length > KEEP_SENT) sent.shift();
        ackedEndMs = item.endMs;
        const state = store.getState();
        patch({ chunksAcked: state.chunksAcked + 1, bytesAcked: state.bytesAcked + item.blob.size, queuedBytes: state.queuedBytes - item.blob.size, retrying: false });
    };

    /** A 409 said the host holds `received` chunks. True when sending can go on. */
    const reconcile = (item: Item, received: number): boolean => {
        if (received === item.n + 1) {
            ack(item);
            return true;
        }
        if (received > item.n + 1) {
            fail("The host holds more of this recording than this page sent. The recording was stopped; start a new one.");
            return false;
        }
        const back = sent.filter((s) => s.n >= received);
        if (back.length !== item.n - received || (back[0] !== undefined && back[0].n !== received)) {
            fail(`The host lost part of this recording (it holds ${received} of ${item.n} pieces). The recording was stopped; what the host kept can still be played.`);
            return false;
        }
        for (const s of back) sent.splice(sent.indexOf(s), 1);
        queue.unshift(...back);
        const bytes = back.reduce((sum, s) => sum + s.blob.size, 0);
        const state = store.getState();
        patch({ chunksAcked: state.chunksAcked - back.length, bytesAcked: state.bytesAcked - bytes, queuedBytes: state.queuedBytes + bytes });
        return true;
    };

    const run = async (): Promise<void> => {
        let attempt = 0;
        let conflicts = 0;
        while (!dead && !hiding && queue.length > 0 && id !== null) {
            const item = queue[0]!;
            inFlight = item;
            try {
                await putChunk(id, item.n, item.blob, { signal: abort.signal });
                inFlight = null;
                attempt = 0;
                conflicts = 0;
                ack(item);
            } catch (error) {
                inFlight = null;
                if (dead || hiding) return;
                const failure = error instanceof RecordingsError ? error : new RecordingsError("Cannot reach the app server.", null);
                if (failure.status === 409 && failure.received !== null) {
                    if (++conflicts > MAX_REPEATED_CONFLICTS) {
                        fail("The host keeps refusing the next piece of the recording. The recording was stopped.");
                        return;
                    }
                    if (!reconcile(item, failure.received)) return;
                    continue;
                }
                if (!failure.retryable) {
                    fail(failure.message);
                    return;
                }
                patch({ retrying: true });
                await sleep(backoff[Math.min(attempt++, backoff.length - 1)] ?? 1000);
            }
        }
    };

    const pump = (): Promise<void> => {
        pumping ??= run().finally(() => {
            pumping = null;
            if (!dead && !hiding && queue.length > 0) void pump();
        });
        return pumping;
    };

    const flushHiding = (): void => {
        if (id === null) return;
        for (const item of queue) {
            if (item === inFlight || hidingSent.has(item.n)) continue;
            const keep = item.blob.size <= hidingBudget;
            if (keep) hidingBudget -= item.blob.size;
            hidingSent.add(item.n);
            void putChunk(id, item.n, item.blob, { keepalive: keep }).catch(() => {});
            // Whatever follows a piece that could not be kept alive would reach the host out of order.
            if (!keep) break;
        }
    };

    const finishBody = (durationMs: number) => ({ durationMs: Math.max(0, Math.round(durationMs)), transcribe });

    return {
        store,
        async open() {
            const created = createRecording(
                { mime: options.mime, startedAt: options.startedAt.toISOString(), ...(options.target ? { target: options.target } : {}) },
                abort.signal,
            );
            // Whether the host can transcribe is asked beside the create; not knowing it only means "no transcript yet".
            const available = listRecordings(abort.signal).then(
                (list) => list.transcription.available,
                () => false,
            );
            const view = await created;
            id = view.id;
            transcribe = await available;
            patch({ id });
            return view;
        },
        push(chunk, endMs) {
            if (dead || id === null) return;
            lastEndMs = endMs;
            const state = store.getState();
            if (state.queuedBytes + chunk.size > maxQueueBytes) {
                fail(`The app host stayed out of reach and this page ran out of room to hold the recording (${mb(maxQueueBytes)}). The recording was stopped; what reached the host is kept.`);
                return;
            }
            queue.push({ n: nextN++, blob: chunk, endMs });
            patch({ queuedBytes: state.queuedBytes + chunk.size });
            if (hiding) flushHiding();
            else void pump();
        },
        async finish(durationMs) {
            if (id === null) throw new RecordingsError("The recording was never created.", null);
            const giveUp = setTimeout(
                () => fail("The app host stayed out of reach, so the end of the recording could not be saved. What reached the host is kept."),
                patienceMs,
            );
            try {
                while (!dead && queue.length > 0) await pump();
            } finally {
                clearTimeout(giveUp);
            }
            if (dead) throw new RecordingsError(store.getState().error ?? "The upload stopped.", null);
            const recordingId = id;
            let lastError: RecordingsError | null = null;
            for (let attempt = 0; attempt < FINISH_TRIES; attempt++) {
                try {
                    return await finishRecording(recordingId, finishBody(durationMs));
                } catch (error) {
                    const failure = error instanceof RecordingsError ? error : new RecordingsError("Cannot reach the app server.", null);
                    // Finished already (the answer to an earlier try was lost): the recording is in its final state.
                    if (failure.status === 409) return getRecording(recordingId);
                    if (!failure.retryable) throw failure;
                    lastError = failure;
                    await sleep(backoff[Math.min(attempt, backoff.length - 1)] ?? 1000);
                }
            }
            throw lastError ?? new RecordingsError("Cannot reach the app server.", null);
        },
        pageHide(durationMs) {
            if (dead || hiding || id === null) return;
            hiding = true;
            const recordingId = id;
            flushHiding();
            // After the tail the recorder is cut for (its last piece arrives as an event a moment after pagehide).
            setTimeout(() => {
                flushHiding();
                void finishRecording(recordingId, finishBody(durationMs || lastEndMs), { keepalive: true }).catch(() => {});
            }, 50);
        },
        async abandon() {
            const recordingId = id;
            dead = true;
            abort.abort();
            if (recordingId === null) return;
            // A fresh request: the one that was in flight is cancelled above.
            try {
                if (store.getState().chunksAcked === 0) await deleteRecording(recordingId);
                else await finishRecording(recordingId, { durationMs: Math.max(0, Math.round(ackedEndMs)), transcribe: false });
            } catch {
                // The host is the reason this ended; it closes an unfinished recording itself.
            }
        },
    };
}
