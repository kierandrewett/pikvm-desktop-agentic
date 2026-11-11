/**
 * The page's calls to the host's YouTube upload API (src/server/recordings/youtube/, routes in src/server/recordings/routes.ts).
 * The settings page and the Recordings library both use it. Writes carry the marker header the host requires.
 */

import { RECORDING_HEADER, RECORDINGS_PATH, type RecordingYouTube, type YouTubeSettings } from "@pikvm/contracts/recordings";

export const YOUTUBE_PATH = `${RECORDINGS_PATH}/youtube`;
export const youtubeKey = ["recordings", "youtube"] as const;

/** A request to this host's recordings API. A failure carries the host's own sentence when it sent one. */
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (method !== "GET") headers[RECORDING_HEADER] = "1";
    let res: Response;
    try {
        res = await fetch(path, {
            method,
            headers,
            credentials: "same-origin",
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
    } catch {
        throw new Error("The host could not be reached.");
    }
    const text = await res.text().catch(() => "");
    const parsed: unknown = text === "" ? undefined : (JSON.parse(text) as unknown);
    if (!res.ok) {
        const reason = typeof parsed === "object" && parsed !== null && "error" in parsed ? String(parsed.error) : "";
        throw new Error(reason || `The server answered ${res.status}.`);
    }
    return parsed as T;
}

export const readYouTubeSettings = (): Promise<YouTubeSettings> => request<YouTubeSettings>("GET", YOUTUBE_PATH);

/** Queues a recording for YouTube now (a first upload or a retry). Resolves with where its upload stands. */
export const uploadRecordingToYouTube = (id: string): Promise<RecordingYouTube> =>
    request<RecordingYouTube>("POST", `${RECORDINGS_PATH}/${encodeURIComponent(id)}/youtube`);
