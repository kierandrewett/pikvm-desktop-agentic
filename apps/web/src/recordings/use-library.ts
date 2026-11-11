/**
 * What the host holds, for the Recordings page: the list, read when the page opens and each time it comes to the front, and read
 * again every few seconds only while something is being made or transcribed. A poll that fails keeps the list on screen and says
 * it is out of date; a first load that fails shows the error and not an empty list.
 */

import type { RecordingArchiveSummary, RecordingView, TranscriptionStatus } from "@pikvm/contracts/recordings";
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteRecording, listRecordings, RecordingsError, renameRecording, transcribeRecording } from "../kvm/recorder/api";
import { forgetPoster } from "./poster";

export const POLL_MS = 3000;

export const errorText = (error: unknown): string => (error instanceof RecordingsError ? error.message : "Something went wrong.");

export type LibraryState =
    | { readonly phase: "loading" }
    | { readonly phase: "error"; readonly message: string }
    | {
          readonly phase: "ready";
          readonly recordings: ReadonlyArray<RecordingView>;
          readonly transcription: TranscriptionStatus;
          readonly archive: RecordingArchiveSummary;
          /** Why the list on screen may be out of date; null when it is fresh. */
          readonly stale: string | null;
      };

export interface Library {
    readonly state: LibraryState;
    reload(): Promise<void>;
    rename(id: string, title: string | null): Promise<void>;
    transcribe(id: string): Promise<void>;
    /** Deletes each; resolves with the ones the host refused, and why. */
    remove(ids: ReadonlyArray<string>): Promise<ReadonlyArray<{ readonly id: string; readonly message: string }>>;
}

export function useLibrary(active: boolean): Library {
    const [state, setState] = useState<LibraryState>({ phase: "loading" });
    const alive = useRef(true);
    // Counts what this page itself changed (a rename, a delete, a transcription started). A list that was asked for before a change
    // and arrives after it is older than the change and is dropped, or it would put the old name or the deleted row back.
    const changes = useRef(0);

    const reload = useCallback(async (): Promise<void> => {
        const asked = changes.current;
        try {
            const list = await listRecordings();
            if (!alive.current || asked !== changes.current) return;
            setState({
                phase: "ready",
                recordings: list.recordings,
                transcription: list.transcription,
                archive: list.archive,
                stale: null,
            });
        } catch (error) {
            if (!alive.current) return;
            setState((now) => (now.phase === "ready" ? { ...now, stale: errorText(error) } : { phase: "error", message: errorText(error) }));
        }
    }, []);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    // Read when the page is in front: it stays mounted while the KVM is, where a recording may have just been made.
    useEffect(() => {
        if (active) void reload();
    }, [active, reload]);

    // A recording being made, transcribed or sent to YouTube is one the list should keep re-reading until it settles.
    const settling = (r: RecordingView): boolean =>
        r.status === "transcribing" || r.status === "recording" || r.status === "finishing" || r.youtube?.state === "uploading" || r.youtube?.state === "verifying";
    const busy = active && state.phase === "ready" && state.recordings.some(settling);
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(() => void reload(), POLL_MS);
        return () => clearInterval(timer);
    }, [busy, reload]);

    const replace = useCallback((view: RecordingView): void => {
        changes.current += 1;
        setState((now) => (now.phase === "ready" ? { ...now, recordings: now.recordings.map((r) => (r.id === view.id ? view : r)) } : now));
    }, []);

    const rename = useCallback(
        async (id: string, title: string | null): Promise<void> => {
            replace(await renameRecording(id, title));
        },
        [replace],
    );

    const transcribe = useCallback(
        async (id: string): Promise<void> => {
            replace(await transcribeRecording(id));
        },
        [replace],
    );

    const remove = useCallback(async (ids: ReadonlyArray<string>) => {
        const refused: Array<{ id: string; message: string }> = [];
        const gone = new Set<string>();
        for (const id of ids) {
            try {
                await deleteRecording(id);
                gone.add(id);
            } catch (error) {
                // Already gone is what was wanted.
                if (error instanceof RecordingsError && error.status === 404) gone.add(id);
                else refused.push({ id, message: errorText(error) });
            }
        }
        for (const id of gone) forgetPoster(id);
        changes.current += 1;
        setState((now) => (now.phase === "ready" ? { ...now, recordings: now.recordings.filter((r) => !gone.has(r.id)) } : now));
        return refused;
    }, []);

    return { state, reload, rename, transcribe, remove };
}
