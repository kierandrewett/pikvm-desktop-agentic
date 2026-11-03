/**
 * Turns any thrown value into words a person can act on, plus the raw facts for the "Details" disclosure.
 *
 * Callers keep the context-specific title ("Could not load chats"); this module supplies the reason and the
 * recovery ("Check your connection, then try again"). It never blames the user and never shows a stack.
 *
 * Kinds, in the order they are checked:
 * - offline: the browser says it has no network
 * - unreachable: fetch failed, a proxy answered with HTML (JSON parse error), or a 502/503/504 gateway status
 * - session: 401, the sign-in has ended
 * - forbidden: 403
 * - not-found: 404
 * - quota: 413 or 507, the server message is specific so it is used as is
 * - server: any other 5xx
 * - request: any other 4xx, the server message is used as is
 * - unknown: anything else (a render crash, a thrown string)
 */
import { translate } from "../l10n/runtime";
import { ApiError } from "./api";

export type ErrorKind =
    "offline" | "unreachable" | "session" | "forbidden" | "not-found" | "quota" | "server" | "request" | "unknown";

export interface DescribedError {
    kind: ErrorKind;
    /** Generic title, for callers without a better one. */
    title: string;
    /** One or two short sentences: what happened and what to do. */
    message: string;
    /** HTTP status, when the error came from the API. */
    status?: number;
    /** Machine code from the API body ("quota_exceeded") or the error name ("TypeError"). */
    code?: string;
    /** The original message, for the Details disclosure. */
    raw: string;
}

const NETWORK_MESSAGE = /failed to fetch|networkerror|network error|load failed|network request failed|err_connection/i;

function rawMessage(error: unknown): string {
    if (error instanceof Error) return error.message || error.name;
    if (typeof error === "string") return error;
    try {
        return JSON.stringify(error) ?? String(error);
    } catch {
        return String(error);
    }
}

function isOffline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function describeError(error: unknown): DescribedError {
    const raw = rawMessage(error);
    const status = error instanceof ApiError ? error.status : undefined;
    const code = error instanceof ApiError ? error.code : error instanceof Error ? error.name : undefined;
    const base = { raw, status, code };

    if (isOffline()) {
        return {
            ...base,
            kind: "offline",
            title: translate("errors-offline-title"),
            message: translate("errors-offline-message"),
        };
    }
    const network =
        (error instanceof TypeError && NETWORK_MESSAGE.test(raw)) ||
        // A dev proxy or load balancer answers with an HTML error page when the server is down.
        error instanceof SyntaxError ||
        status === 502 ||
        status === 503 ||
        status === 504;
    if (network) {
        return {
            ...base,
            kind: "unreachable",
            title: translate("errors-unreachable-title"),
            message: translate("errors-unreachable-message"),
        };
    }
    if (status === 401) {
        return { ...base, kind: "session", title: translate("errors-session-title"), message: translate("errors-session-message") };
    }
    if (status === 403) {
        return {
            ...base,
            kind: "forbidden",
            title: translate("errors-forbidden-title"),
            message: translate("errors-forbidden-message"),
        };
    }
    if (status === 404) {
        return {
            ...base,
            kind: "not-found",
            title: translate("errors-not-found-title"),
            message: translate("errors-not-found-message"),
        };
    }
    if (status === 413) {
        return { ...base, kind: "quota", title: translate("errors-too-large-title"), message: sentence(raw) };
    }
    if (status === 507) {
        return { ...base, kind: "quota", title: translate("errors-no-space-title"), message: sentence(raw) };
    }
    if (status === 429) {
        return { ...base, kind: "request", title: translate("errors-rate-title"), message: translate("errors-rate-message") };
    }
    if (status !== undefined && status >= 500) {
        return {
            ...base,
            kind: "server",
            title: translate("errors-generic-title"),
            message: translate("errors-server-message"),
        };
    }
    if (status !== undefined && status >= 400) {
        return { ...base, kind: "request", title: translate("errors-request-title"), message: sentence(raw) };
    }
    return {
        ...base,
        kind: "unknown",
        title: translate("errors-generic-title"),
        message: translate("errors-unknown-message"),
    };
}

/** Server messages arrive as fragments ("Storage quota exceeded"); end them like a sentence. */
function sentence(text: string): string {
    const t = text.trim();
    if (!t) return translate("errors-try-again-sentence");
    const capital = t[0]!.toUpperCase() + t.slice(1);
    return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** One line for the Details disclosure: "500 internal: Internal server error". */
export function errorDetails(error: unknown): string {
    const d = describeError(error);
    const head = [d.status, d.code].filter((p) => p !== undefined && p !== "").join(" ");
    return head ? `${head}: ${d.raw}` : d.raw;
}
