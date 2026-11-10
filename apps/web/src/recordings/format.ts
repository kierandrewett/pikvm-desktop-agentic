/**
 * What the Recordings page says about a recording, as text: names, lengths, sizes, when it goes, what state it is in. Pure, so the
 * list, the search results and the watch page say the same thing in the same words.
 */

import type { RecordingSort, RecordingView } from "@pikvm/contracts/recordings";

const DAY_MS = 86_400_000;
/** A recording is "expiring soon" when it will be deleted within this many days. */
export const EXPIRING_DAYS = 7;

const dayMonth = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dayMonthYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** `1:05`, `12:30`, `1:02:03`: a length or a position. */
export function formatDuration(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms)) return "--:--";
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const two = (n: number): string => String(n).padStart(2, "0");
    return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** `Today, 14:32`, `Yesterday, 09:05`, `3 Nov, 14:32`, `3 Nov 2025`: when it started. */
export function formatStarted(iso: string, now: number = Date.now()): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return "";
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const ago = Math.floor((midnight.getTime() - new Date(at).setHours(0, 0, 0, 0)) / DAY_MS);
    if (ago === 0) return `Today, ${clock.format(at)}`;
    if (ago === 1) return `Yesterday, ${clock.format(at)}`;
    if (at.getFullYear() === new Date(now).getFullYear()) return `${dayMonth.format(at)}, ${clock.format(at)}`;
    return dayMonthYear.format(at);
}

/** The name shown for a recording: the one it was given, else one built from when it started. */
export function displayTitle(recording: Pick<RecordingView, "title" | "startedAt">): string {
    if (recording.title !== null && recording.title !== "") return recording.title;
    const at = new Date(recording.startedAt);
    if (Number.isNaN(at.getTime())) return "Recording";
    return `Recording, ${dayMonthYear.format(at)} ${clock.format(at)}`;
}

export interface ExpiryView {
    /** "Deleted in 12 days", "Deleted tomorrow", "Deleted today", or "Kept until you delete it". */
    readonly text: string;
    readonly soon: boolean;
}

/** Null while the recording is still being made or finished: it has no end, so nothing to count down. */
export function expiryOf(recording: Pick<RecordingView, "status" | "expiresAt">, now: number = Date.now()): ExpiryView | null {
    if (recording.status === "recording" || recording.status === "finishing") return null;
    if (recording.expiresAt === null) return { text: "Kept until you delete it", soon: false };
    const left = Date.parse(recording.expiresAt) - now;
    if (left <= 0) return { text: "Deleted today", soon: true };
    const days = Math.ceil(left / DAY_MS);
    const text = days <= 1 ? "Deleted tomorrow" : `Deleted in ${days} days`;
    return { text: left < DAY_MS ? "Deleted today" : text, soon: days <= EXPIRING_DAYS };
}

export type PillTone = "neutral" | "busy" | "ok" | "bad" | "live";

export interface StatusView {
    readonly label: string;
    readonly tone: PillTone;
    /** 0..1 while finishing or transcribing. */
    readonly progress: number | null;
    /** What the bar measures. */
    readonly measures: "re-encode" | "transcription" | null;
    /** A fuller sentence, for a tooltip. */
    readonly title: string;
}

export function statusOf(recording: RecordingView): StatusView {
    switch (recording.status) {
        case "recording":
            return { label: "Recording", tone: "live", progress: null, measures: null, title: "The host is recording this now." };
        case "finishing": {
            const progress = recording.progress;
            return {
                label: progress === null ? "Finishing" : `Finishing ${Math.round(progress * 100)}%`,
                tone: "busy",
                progress,
                measures: progress === null ? null : "re-encode",
                title: "The host stopped recording and is shrinking what it captured into the file it keeps. It can be played when this is done.",
            };
        }
        case "ready":
            return { label: "Not transcribed", tone: "neutral", progress: null, measures: null, title: "Saved, with no transcript." };
        case "transcribing": {
            const progress = recording.progress ?? 0;
            return { label: `Transcribing ${Math.round(progress * 100)}%`, tone: "busy", progress, measures: "transcription", title: "The host is turning the speech into text." };
        }
        case "done": {
            const speakers = recording.speakers;
            return {
                label: speakers === null ? "Transcribed" : `Transcribed, ${speakers} ${speakers === 1 ? "speaker" : "speakers"}`,
                tone: "ok",
                progress: null,
                measures: null,
                title: "The transcript is ready and searchable.",
            };
        }
        case "failed":
            return { label: "Failed", tone: "bad", progress: null, measures: null, title: recording.error ?? "The recording failed." };
    }
}

/** A sentence on how a capture that ended early ended, or null for an ordinary end. */
export function endedEarly(recording: Pick<RecordingView, "reason" | "error">): string | null {
    switch (recording.reason) {
        case "quota":
            return "Closed when the host's recordings reached their disk limit. What was captured is kept.";
        case "recording_cap":
            return "Closed at the size limit for one recording. What was captured is kept.";
        case "backlog_cap":
            return "Closed because the host could not shrink it as fast as it recorded. What was captured is kept.";
        case "error":
            return `${recording.error ?? "The recording stopped because of an error."} What was captured is kept.`;
        case "interrupted":
            return "The host restarted while this was recording, so it ends there. What was captured is kept.";
        case "duration":
            return "Closed at its time limit.";
        case "stopped":
        case null:
            return null;
    }
}

/** `1 gap (0:12 to 0:19)`, `3 gaps`: the stretches the PiKVM sent no picture, or null when there are none. */
export function holesText(holes: RecordingView["holes"]): string | null {
    if (holes.length === 0) return null;
    if (holes.length === 1) {
        const hole = holes[0]!;
        return `1 gap in the picture (${formatDuration(hole.fromMs)} to ${formatDuration(hole.toMs)})`;
    }
    const total = holes.reduce((sum, h) => sum + Math.max(0, h.toMs - h.fromMs), 0);
    return `${holes.length} gaps in the picture (${formatDuration(total)} in all)`;
}

/** Who made the file and what it holds, in a few words, for the line under a title. */
export function sourceText(recording: Pick<RecordingView, "source" | "hasMic">): string {
    if (recording.source === "browser") return "Uploaded from a browser";
    return recording.hasMic ? "Recorded on the host, with your microphone" : "Recorded on the host";
}

export type RecordingFilter = "all" | "done" | "transcribing" | "failed" | "expiring";

export const FILTERS: ReadonlyArray<{ readonly id: RecordingFilter; readonly label: string }> = [
    { id: "all", label: "All" },
    { id: "done", label: "Transcribed" },
    { id: "transcribing", label: "Transcribing" },
    { id: "failed", label: "Failed" },
    { id: "expiring", label: "Expiring soon" },
];

export function matchesFilter(recording: RecordingView, filter: RecordingFilter, now: number = Date.now()): boolean {
    switch (filter) {
        case "all":
            return true;
        case "done":
            return recording.status === "done";
        case "transcribing":
            return recording.status === "transcribing";
        case "failed":
            return recording.status === "failed";
        case "expiring":
            return expiryOf(recording, now)?.soon === true && recording.expiresAt !== null;
    }
}

export const SORTS: ReadonlyArray<{ readonly id: RecordingSort; readonly label: string }> = [
    { id: "newest", label: "Newest first" },
    { id: "oldest", label: "Oldest first" },
    { id: "longest", label: "Longest first" },
    { id: "largest", label: "Largest first" },
];

export function sortRecordings(recordings: ReadonlyArray<RecordingView>, sort: RecordingSort): RecordingView[] {
    const started = (r: RecordingView): number => Date.parse(r.startedAt);
    const by: Record<RecordingSort, (a: RecordingView, b: RecordingView) => number> = {
        newest: (a, b) => started(b) - started(a),
        oldest: (a, b) => started(a) - started(b),
        longest: (a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1) || started(b) - started(a),
        largest: (a, b) => b.bytes - a.bytes || started(b) - started(a),
    };
    return [...recordings].sort(by[sort]);
}
