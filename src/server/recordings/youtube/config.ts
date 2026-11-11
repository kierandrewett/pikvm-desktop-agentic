import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { YOUTUBE_PRIVACY, type YouTubePrivacy } from "@pikvm/contracts/recordings";

/**
 * The host's YouTube settings, kept in `<dataDir>/youtube-upload.json` (mode 0600). The client secret and the refresh token are
 * write-only: they are read from here and never returned to a client or written to a log.
 */

export interface YouTubeConfig {
    autoUpload: boolean;
    privacy: YouTubePrivacy;
    clientId: string | null;
    clientSecret: string | null;
    refreshToken: string | null;
    /** Host recordings that ended before this (ms since the epoch) are never uploaded automatically: turning auto-upload on sets it. */
    autoUploadSince: number | null;
    /** Milliseconds since the epoch when Google's daily allowance resets and the queue carries on; null when it is not paused for quota. */
    quotaResumeAt: number | null;
    /** Turning auto-upload on also queues every finished recording never uploaded, oldest first. Off by default: enabling never spends quota by itself. */
    backfillOnEnable: boolean;
    /** Recording ids of the current backfill batch, kept so its progress survives a restart. Null when no batch was started. */
    backfillIds: string[] | null;
}

export const DEFAULT_CONFIG: YouTubeConfig = {
    autoUpload: false,
    privacy: "private",
    clientId: null,
    clientSecret: null,
    refreshToken: null,
    autoUploadSince: null,
    quotaResumeAt: null,
    backfillOnEnable: false,
    backfillIds: null,
};

const FILE_NAME = "youtube-upload.json";

function text(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

/** Reads the file as far as it makes sense: anything missing or of the wrong kind takes its default. */
function parse(raw: unknown): YouTubeConfig {
    if (typeof raw !== "object" || raw === null) return { ...DEFAULT_CONFIG };
    const fields = raw as Record<string, unknown>;
    const privacy = YOUTUBE_PRIVACY.find((p) => p === fields["privacy"]) ?? DEFAULT_CONFIG.privacy;
    const since = fields["autoUploadSince"];
    const resume = fields["quotaResumeAt"];
    const batch = fields["backfillIds"];
    return {
        autoUpload: fields["autoUpload"] === true,
        privacy,
        clientId: text(fields["clientId"]),
        clientSecret: text(fields["clientSecret"]),
        refreshToken: text(fields["refreshToken"]),
        autoUploadSince: typeof since === "number" && Number.isFinite(since) ? since : null,
        quotaResumeAt: typeof resume === "number" && Number.isFinite(resume) ? resume : null,
        backfillOnEnable: fields["backfillOnEnable"] === true,
        backfillIds: Array.isArray(batch) ? batch.filter((id): id is string => typeof id === "string") : null,
    };
}

export class YouTubeConfigStore {
    private readonly path: string;

    constructor(dataDir: string) {
        this.path = join(dataDir, FILE_NAME);
    }

    async load(): Promise<YouTubeConfig> {
        const raw = await readFile(this.path, "utf8").catch(() => null);
        if (raw === null) return { ...DEFAULT_CONFIG };
        try {
            return parse(JSON.parse(raw));
        } catch {
            // A damaged file is not a reason to refuse to start: the host is simply not connected until it is set again.
            return { ...DEFAULT_CONFIG };
        }
    }

    /** Writes through a temporary file, so a crash never leaves half a settings file. */
    async save(config: YouTubeConfig): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const tmp = `${this.path}.tmp`;
        await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
        await rename(tmp, this.path);
    }
}
