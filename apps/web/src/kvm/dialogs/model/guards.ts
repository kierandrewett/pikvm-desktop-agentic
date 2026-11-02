/**
 * kvmd's events are read leniently (the engine keeps the opaque parts as `unknown`), so the
 * dialogs narrow what they show through these and nothing else.
 */

export type Rec = Readonly<Record<string, unknown>>;

export function asRecord(value: unknown): Rec | null {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : null;
}

export function asNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

export function asList(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : [];
}

/** A byte count a person can read at a glance: "3.7 GB", "512 B". Empty for a non-number. */
export function humanBytes(n: unknown): string {
    if (typeof n !== "number" || !Number.isFinite(n)) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = n;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    return `${i === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

/** Text for a failed request: its message, or "network error" when it carries none. */
export function failureText(e: unknown): string {
    if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string" && e.message) {
        return e.message;
    }
    return "network error";
}
