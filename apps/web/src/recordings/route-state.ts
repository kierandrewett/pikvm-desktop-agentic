/**
 * The address of the Recordings page, as far as the page cares:
 *
 *   /recordings                          the library
 *   /recordings?q=words                  search results
 *   /recordings?filter=failed&sort=longest   the library, filtered and ordered
 *   /recordings/<id>                     one recording
 *   /recordings/<id>?t=95&q=words        opened at second 95 with "words" looked for in the transcript
 *
 * The router reads `t=95` as a number and `q=2024` as a number too, so everything is read back through here.
 */

import type { RecordingSort } from "@pikvm/contracts/recordings";
import { RECORDING_SORTS } from "@pikvm/contracts/recordings";
import type { RecordingFilter } from "./format";
import { FILTERS } from "./format";

/** `undefined` is written out so that a link can say "no query" by leaving it out of the address. */
export interface RecordingsSearch {
    q?: string | undefined;
    t?: number | undefined;
    filter?: Exclude<RecordingFilter, "all"> | undefined;
    sort?: Exclude<RecordingSort, "newest"> | undefined;
}

export function readSearch(raw: Record<string, unknown>): RecordingsSearch {
    const out: RecordingsSearch = {};
    const q = typeof raw["q"] === "string" || typeof raw["q"] === "number" ? String(raw["q"]) : "";
    if (q.trim() !== "") out.q = q;
    const t = typeof raw["t"] === "number" ? raw["t"] : typeof raw["t"] === "string" ? Number(raw["t"]) : NaN;
    if (Number.isFinite(t) && t >= 0) out.t = Math.floor(t);
    const filter = FILTERS.find((f) => f.id === raw["filter"])?.id;
    if (filter !== undefined && filter !== "all") out.filter = filter;
    const sort = RECORDING_SORTS.find((s) => s === raw["sort"]);
    if (sort !== undefined && sort !== "newest") out.sort = sort;
    return out;
}

/** The recording an address names, or null for the library. */
export function recordingIdOf(pathname: string): string | null {
    const match = /^\/recordings\/([^/]+)\/?$/.exec(pathname);
    if (!match?.[1]) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return null;
    }
}
