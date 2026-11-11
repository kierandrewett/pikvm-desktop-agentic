import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RecordingYouTubeState as UploadState } from "@pikvm/contracts/recordings";

/**
 * Where one recording's YouTube upload stands, kept in the recording's own directory as `youtube.json`, so deleting the
 * recording deletes its state with it. `sessionUrl` is the resumable upload address: it is kept for a restart and never shown.
 */

export type { UploadState };

export interface UploadRecord {
    state: UploadState;
    /** The video YouTube made, once the upload returned one. */
    videoId: string | null;
    /** The resumable session, while the bytes are going up. Never returned to a client. */
    sessionUrl: string | null;
    attempts: number;
    /** Why it failed or is being retried, in a sentence. */
    error: string | null;
    /** ISO time YouTube confirmed the video (uploadStatus uploaded or processed). */
    uploadedAt: string | null;
    /** Milliseconds since the epoch: when a retry is due, or null. */
    nextAttemptAt: number | null;
}

export const EMPTY_RECORD: UploadRecord = {
    state: "pending",
    videoId: null,
    sessionUrl: null,
    attempts: 0,
    error: null,
    uploadedAt: null,
    nextAttemptAt: null,
};

const STATES: readonly UploadState[] = ["pending", "uploading", "verifying", "uploaded", "failed"];

function text(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

function parse(raw: unknown): UploadRecord | null {
    if (typeof raw !== "object" || raw === null) return null;
    const fields = raw as Record<string, unknown>;
    const state = STATES.find((s) => s === fields["state"]);
    if (state === undefined) return null;
    const attempts = fields["attempts"];
    const next = fields["nextAttemptAt"];
    return {
        state,
        videoId: text(fields["videoId"]),
        sessionUrl: text(fields["sessionUrl"]),
        attempts: typeof attempts === "number" && Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
        error: text(fields["error"]),
        uploadedAt: text(fields["uploadedAt"]),
        nextAttemptAt: typeof next === "number" && Number.isFinite(next) ? next : null,
    };
}

export async function readUploadRecord(dir: string): Promise<UploadRecord | null> {
    const raw = await readFile(join(dir, "youtube.json"), "utf8").catch(() => null);
    if (raw === null) return null;
    try {
        return parse(JSON.parse(raw));
    } catch {
        return null;
    }
}

/** Written through a temporary file, as the recording's own meta is. */
export async function writeUploadRecord(dir: string, record: UploadRecord): Promise<void> {
    const path = join(dir, "youtube.json");
    // A unique temporary name per write: concurrent saves of one recording (two backfill calls, a manual upload and a backfill)
    // must not share one temp file, or one rename finds it already moved.
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, path);
}
