/**
 * What the engine wants the user told. The UI owns the toast; the engine only supplies words
 * and severity, so a macro that stops half way can say so without importing any UI.
 */
export interface Notice {
    readonly text: string;
    /** Rendered as a failure. */
    readonly error?: boolean;
    /** Stays up until replaced (a long operation under way), instead of timing out. */
    readonly sticky?: boolean;
}

export type Notify = (notice: Notice) => void;


/** The text of a failed request, or "network error" when it carries none (a bare rejection). */
export function errorMessage(e: unknown): string {
    if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string" && e.message) {
        return e.message;
    }
    return "network error";
}