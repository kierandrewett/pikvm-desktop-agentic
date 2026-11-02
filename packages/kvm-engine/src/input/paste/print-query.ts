import type { KvmdKeymaps } from "../../target/wire";

/**
 * 20 ms between keys: kvmd's own default, slow enough that a target under load does not drop
 * characters. Named because the wait it implies is shown to the user, and a rate on the wire
 * that disagreed with the estimate on screen would be worse than no estimate.
 */
export const PASTE_DELAY_S = 0.02;

/** Query string for `POST /api/hid/print`, the one place its shape is decided. */
export function printQuery(keymap: string | null | undefined): string {
    const q = ["limit=0", `delay=${PASTE_DELAY_S}`];
    if (keymap) q.push(`keymap=${encodeURIComponent(keymap)}`);
    return q.join("&");
}

/** The request path for typing text on the target. */
export function printPath(keymap: string | null | undefined): string {
    return `/api/hid/print?${printQuery(keymap)}`;
}

export function humanCount(n: number, locale?: string): string {
    return Number.isFinite(n) ? n.toLocaleString(locale) : String(n);
}

export function humanDuration(ms: number): string {
    const secs = Math.round(ms / 1000);
    if (secs < 90) return `about ${secs}s`;
    return `about ${Math.round(secs / 60)} min`;
}

/**
 * How long kvmd will spend typing `chars` characters, or "" when it is not worth saying.
 *
 * A paste is not a click. kvmd types the string itself at the rate above and answers when it is
 * done, so 12,000 characters is a little over four minutes, during which the target is being
 * typed into and closing the dialog does not stop it. Nothing under ten seconds says anything,
 * because a number beside every short paste is noise and would make the ones that matter easier
 * to miss.
 */
export function pasteDuration(chars: number): string {
    const ms = chars * PASTE_DELAY_S * 1000;
    return ms < 10_000 ? "" : humanDuration(ms);
}

export interface KeymapChoice {
    /** Sorted keymap names, with the Pi's default included even if it did not list itself. */
    readonly options: readonly string[];
    /** What the Pi will type with unless told otherwise. */
    readonly selected: string | null;
    /** One option is information (which keymap is used) but not a choice. */
    readonly disabled: boolean;
    /** Nothing to show: the control (and its label) should go away rather than sit empty. */
    readonly hidden: boolean;
    /** Identity of the option set, so a repaint can leave the user's pick alone when it did not change. */
    readonly key: string;
}

/**
 * The keymap list for the paste control, from the `hid_keymaps` event.
 *
 * kvmd's `available` is a MAP of name -> details, not a list of names. Reading it as an array
 * left the select with exactly one option and disabled, so choosing the layout the target
 * actually uses was impossible. Both shapes are accepted rather than swapping one assumption
 * for another. Sorted so the order does not depend on how the keys happened to serialise.
 */
export function keymapChoice(keymaps: KvmdKeymaps | null): KeymapChoice {
    const supplied = keymaps?.available;
    const names = Array.isArray(supplied)
        ? supplied.filter((n): n is string => typeof n === "string")
        : supplied && typeof supplied === "object"
          ? Object.keys(supplied)
          : [];
    names.sort();
    const fallback = keymaps?.default;
    // The default is what the Pi will use, so it belongs in the list even if it somehow is not among the ones it offered.
    if (fallback && !names.includes(fallback)) names.unshift(fallback);
    return {
        options: names,
        selected: fallback || null,
        disabled: names.length < 2,
        hidden: names.length === 0,
        key: names.join(","),
    };
}
