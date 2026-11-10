/** What can be done with a transcript from the list and the watch page: fetch it, copy it, save it. */

import type { Transcript } from "@pikvm/contracts/recordings";
import { copyText } from "../kvm/dialogs/kvmd";
import { getTranscript } from "../kvm/recorder/api";
import { displayTitle } from "./format";
import { fileStem, saveFile, TRANSCRIPT_FORMATS, type TranscriptFormat, toText, transcriptAs } from "./transcript-export";

/** Copies the transcript as `[mm:ss] Speaker: text` lines. False if there is none or the browser refused. */
export async function copyTranscript(id: string, loaded?: Transcript): Promise<boolean> {
    try {
        return await copyText(toText(loaded ?? (await getTranscript(id))));
    } catch {
        return false;
    }
}

export function downloadTranscript(transcript: Transcript, title: Parameters<typeof displayTitle>[0], format: TranscriptFormat): void {
    const mime = TRANSCRIPT_FORMATS.find((f) => f.id === format)?.mime ?? "text/plain;charset=utf-8";
    saveFile(`${fileStem(displayTitle(title))}.${format}`, mime, transcriptAs(transcript, format));
}
