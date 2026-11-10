import type { TranscriptSegment } from "@pikvm/contracts/recordings";

/**
 * Turning what the recogniser and the diarizer return into the contract's transcript. No model and no I/O: the worker
 * (transcribe-worker.ts) calls these.
 */

export interface Word {
    text: string;
    /** Seconds from the start of the recording. */
    start: number;
    end: number;
}

/** One stretch a diarizer attributes to one speaker (its raw id, 0 up). */
export interface SpeakerSpan {
    start: number;
    end: number;
    speaker: number;
}

/** Words of one recognised speech segment. Tokens that begin with a space begin a word; the others continue it. */
export function wordsOf(tokens: readonly string[], timestamps: readonly number[], durations: readonly number[], offsetSeconds: number): Word[] {
    const words: Word[] = [];
    let open: Word | null = null;
    tokens.forEach((token, i) => {
        const start = offsetSeconds + (timestamps[i] ?? 0);
        const end = start + (durations[i] ?? 0.08);
        if (open === null || token.startsWith(" ")) {
            open = { text: token.trimStart(), start, end };
            words.push(open);
            return;
        }
        open.text += token;
        open.end = end;
    });
    return words.filter((w) => w.text.trim() !== "");
}

/** The raw speaker of each word: the span it overlaps most, else the nearest span, else -1 (no spans at all). */
export function speakersOfWords(words: readonly Word[], spans: readonly SpeakerSpan[]): number[] {
    return words.map((word) => {
        let best = -1;
        let bestOverlap = 0;
        let nearest = -1;
        let nearestGap = Infinity;
        for (const span of spans) {
            const overlap = Math.min(word.end, span.end) - Math.max(word.start, span.start);
            if (overlap > bestOverlap) {
                bestOverlap = overlap;
                best = span.speaker;
            }
            const gap = Math.max(span.start - word.end, word.start - span.end, 0);
            if (gap < nearestGap) {
                nearestGap = gap;
                nearest = span.speaker;
            }
        }
        return best >= 0 ? best : nearest;
    });
}

/**
 * A run of one or two words between two runs of the same speaker is the diarizer wavering, not someone speaking one word in the
 * middle of a sentence: it takes the speaker around it. Longer runs stand.
 */
export function smoothSpeakers(speakers: readonly number[]): number[] {
    const out = [...speakers];
    let i = 0;
    while (i < out.length) {
        let j = i;
        while (j < out.length && out[j] === out[i]) j++;
        const before = i > 0 ? out[i - 1] : undefined;
        const after = j < out.length ? out[j] : undefined;
        if (j - i <= 2 && before !== undefined && before === after) {
            for (let k = i; k < j; k++) out[k] = before;
            // Re-examine from the start of the merged run.
            i = Math.max(0, i - 1);
            while (i > 0 && out[i - 1] === out[i]) i--;
            continue;
        }
        i = j;
    }
    return out;
}

export interface RawSegment {
    /** The words of one speech segment, in order. */
    words: Word[];
    /** The raw speaker of each word. */
    speakers: number[];
}

/** Splits each speech segment where the speaker changes. `label` names a raw speaker. */
export function segmentsOf(raw: readonly RawSegment[], channel: TranscriptSegment["channel"], label: (speaker: number) => string): TranscriptSegment[] {
    const out: TranscriptSegment[] = [];
    for (const segment of raw) {
        let from = 0;
        for (let i = 1; i <= segment.words.length; i++) {
            if (i < segment.words.length && segment.speakers[i] === segment.speakers[from]) continue;
            const run = segment.words.slice(from, i);
            const first = run[0];
            const last = run[run.length - 1];
            if (first && last) {
                out.push({
                    start: round(first.start),
                    end: round(last.end),
                    speaker: label(segment.speakers[from] ?? -1),
                    channel,
                    text: run.map((w) => w.text).join(" ").replace(/\s+([.,!?;:])/g, "$1"),
                });
            }
            from = i;
        }
    }
    return out;
}

const round = (seconds: number): number => Math.round(seconds * 100) / 100;

/** `[mm:ss] Speaker: text`, one line per segment. Minutes run past 59 on a long recording. */
export function transcriptText(segments: readonly TranscriptSegment[]): string {
    return segments
        .map((s) => {
            const whole = Math.floor(s.start);
            const minutes = String(Math.floor(whole / 60)).padStart(2, "0");
            const seconds = String(whole % 60).padStart(2, "0");
            return `[${minutes}:${seconds}] ${s.speaker}: ${s.text}`;
        })
        .join("\n");
}
