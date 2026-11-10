/**
 * A transcript as a file: plain text, SubRip (.srt) or WebVTT (.vtt). The host keeps the plain text itself (`Transcript.text`);
 * the caption formats are made here from the segments, so a player can show them over the video.
 */

import type { Transcript, TranscriptSegment } from "@pikvm/contracts/recordings";

export type TranscriptFormat = "txt" | "srt" | "vtt";

export const TRANSCRIPT_FORMATS: ReadonlyArray<{ readonly id: TranscriptFormat; readonly label: string; readonly mime: string }> = [
    { id: "txt", label: "Plain text (.txt)", mime: "text/plain;charset=utf-8" },
    { id: "srt", label: "Subtitles (.srt)", mime: "application/x-subrip;charset=utf-8" },
    { id: "vtt", label: "Web captions (.vtt)", mime: "text/vtt;charset=utf-8" },
];

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** `01:02:03,456` (SubRip) or `01:02:03.456` (WebVTT). */
export function captionTime(seconds: number, separator: "," | "."): string {
    const ms = Math.max(0, Math.round(seconds * 1000));
    return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1000))}${separator}${pad(ms % 1000, 3)}`;
}

/** `[mm:ss]` or `[h:mm:ss]`, the host's own form. */
function stamp(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return h > 0 ? `[${h}:${pad(m)}:${pad(total % 60)}]` : `[${pad(m)}:${pad(total % 60)}]`;
}

/** A cue's text may not hold a blank line (it would end the cue) or, in WebVTT, markup or an arrow. */
const oneBlock = (text: string): string => text.replace(/\r?\n\s*\r?\n/g, "\n").trim();
const vttText = (text: string): string => oneBlock(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/-->/g, "--&gt;");

const live = (segments: ReadonlyArray<TranscriptSegment>): TranscriptSegment[] => segments.filter((s) => s.text.trim() !== "");

export function toText(transcript: Pick<Transcript, "segments">): string {
    return live(transcript.segments)
        .map((s) => `${stamp(s.start)} ${s.speaker}: ${oneBlock(s.text)}`)
        .join("\n");
}

export function toSrt(transcript: Pick<Transcript, "segments">): string {
    return live(transcript.segments)
        .map((s, i) => `${i + 1}\n${captionTime(s.start, ",")} --> ${captionTime(Math.max(s.end, s.start + 0.1), ",")}\n${s.speaker}: ${oneBlock(s.text)}\n`)
        .join("\n");
}

export function toVtt(transcript: Pick<Transcript, "segments">): string {
    const cues = live(transcript.segments).map(
        (s, i) => `${i + 1}\n${captionTime(s.start, ".")} --> ${captionTime(Math.max(s.end, s.start + 0.1), ".")}\n<v ${s.speaker.replace(/[<>&\n]/g, " ")}>${vttText(s.text)}\n`,
    );
    return `WEBVTT\n\n${cues.join("\n")}`;
}

export function transcriptAs(transcript: Pick<Transcript, "segments">, format: TranscriptFormat): string {
    return format === "srt" ? toSrt(transcript) : format === "vtt" ? toVtt(transcript) : toText(transcript) + "\n";
}

/** A file name from a title: letters and digits, dashes between, at most 60 characters; "recording" if nothing is left. */
export function fileStem(title: string): string {
    const stem = title
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
        .replace(/-+$/g, "");
    return stem === "" ? "recording" : stem;
}

/** Hands the browser a file to save. */
export function saveFile(name: string, mime: string, content: string): void {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
