/**
 * The Pi's journal as the dialog shows it. An hour is ~7,200 lines and 1.5 MB, which took 155 ms
 * just to lay out; the newest lines are what anyone opening a log wants, so the rest is dropped
 * and SAID rather than quietly truncated.
 */

export const LOG_MAX_LINES = 1500;

export const LOG_WINDOWS: ReadonlyArray<{ readonly seek: string; readonly label: string }> = [
    { seek: "600", label: "last 10 minutes" },
    { seek: "3600", label: "last hour" },
    { seek: "86400", label: "last day" },
    { seek: "0", label: "everything" },
];

export function capLog(text: string): string {
    if (!text) return text;
    const lines = text.split("\n");
    const dropped = lines.length - LOG_MAX_LINES;
    if (dropped <= 0) return text;
    return (
        `\u2026 ${dropped} earlier lines not shown. Narrow the window above, or read the full journal on the Pi.\n\n` +
        lines.slice(-LOG_MAX_LINES).join("\n")
    );
}

/** `follow=0`: a snapshot, not a stream; the dialog is opened to answer one question. */
export function logPath(seek: string): string {
    return `/api/log?seek=${encodeURIComponent(seek)}&follow=0`;
}
