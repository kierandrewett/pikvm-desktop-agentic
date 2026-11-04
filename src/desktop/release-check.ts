import type { DesktopUpdate } from "@pikvm/contracts/desktop";

/**
 * Is there a newer release than the one running? Asks GitHub for the latest release of this project,
 * which is the one a person would download: drafts and prereleases are never "latest". No Electron
 * here, so it can be exercised on its own.
 *
 * Anonymous calls to the GitHub API are limited to 60 an hour per address, so an answer is kept for an
 * hour and a failure is not retried inside the same minute.
 */

export const LATEST_RELEASE_URL = "https://api.github.com/repos/kierandrewett/pikvm-desktop-agentic/releases/latest";
const ANSWER_TTL_MS = 60 * 60_000;
const FAILURE_TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;

/** "v1.14.0" or "1.14.0" as numbers, or null when it is not a release number. Anything after the patch (a suffix) is ignored. */
export function parseVersion(text: string): [number, number, number] | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isNewer(latest: string, current: string): boolean {
    const a = parseVersion(latest);
    const b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i]! !== b[i]!) return a[i]! > b[i]!;
    }
    return false;
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
    ok: boolean;
    json(): Promise<unknown>;
}>;

/** The release page for a tag, taken from GitHub's own answer; only an https github.com address is accepted. */
function releasePage(value: unknown): string | null {
    if (typeof value !== "string") return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : null;
    } catch {
        return null;
    }
}

export async function lookUpRelease(current: string, request: Fetch = fetch as unknown as Fetch): Promise<DesktopUpdate> {
    try {
        const response = await request(LATEST_RELEASE_URL, {
            headers: { Accept: "application/vnd.github+json", "User-Agent": "pikvm-desktop" },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) return { state: "unknown" };
        const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
        const tag = typeof body.tag_name === "string" ? body.tag_name : "";
        const url = releasePage(body.html_url);
        if (!parseVersion(tag) || !url) return { state: "unknown" };
        return isNewer(tag, current) ? { state: "available", latest: tag, url } : { state: "current", latest: tag };
    } catch {
        return { state: "unknown" };
    }
}

/** lookUpRelease with the answer kept, so several windows and the hourly timer share one request. */
export function releaseChecker(
    current: string,
    request?: Fetch,
    now: () => number = Date.now,
): () => Promise<DesktopUpdate> {
    let kept: { at: number; ttl: number; answer: DesktopUpdate } | undefined;
    let inFlight: Promise<DesktopUpdate> | undefined;
    return () => {
        if (kept && now() - kept.at < kept.ttl) return Promise.resolve(kept.answer);
        inFlight ??= lookUpRelease(current, request).then((answer) => {
            kept = { at: now(), ttl: answer.state === "unknown" ? FAILURE_TTL_MS : ANSWER_TTL_MS, answer };
            inFlight = undefined;
            return answer;
        });
        return inFlight;
    };
}
