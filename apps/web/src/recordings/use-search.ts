/**
 * Search results for the page: one query at a time, pages added on request. The query comes from the address, already settled
 * (the box that types it waits for a pause), so a new one cancels the one in flight and starts over. The host judges the text:
 * what it says about an empty or unusable query is shown as it is said.
 */

import type { RecordingSearchHit } from "@pikvm/contracts/recordings";
import { useCallback, useEffect, useRef, useState } from "react";
import { searchRecordings } from "../kvm/recorder/api";
import { errorText } from "./use-library";

export const PAGE_SIZE = 40;

export type SearchState =
    | { readonly phase: "idle" }
    | { readonly phase: "loading" }
    | { readonly phase: "error"; readonly message: string }
    | {
          readonly phase: "ready";
          /** The query these results are for: the box may already show a newer one. */
          readonly query: string;
          readonly hits: ReadonlyArray<RecordingSearchHit>;
          readonly total: number;
          readonly recordings: number;
          readonly more: "idle" | "loading" | { readonly error: string };
      };

export function useSearch(query: string, active: boolean, refreshKey: string): { state: SearchState; more(): void } {
    const [state, setState] = useState<SearchState>({ phase: "idle" });
    const abort = useRef<AbortController | null>(null);
    const current = useRef(state);
    current.current = state;

    useEffect(() => {
        abort.current?.abort();
        if (query.trim() === "" || !active) {
            if (query.trim() === "") setState({ phase: "idle" });
            return;
        }
        const controller = new AbortController();
        abort.current = controller;
        setState((now) => (now.phase === "ready" ? now : { phase: "loading" }));
        searchRecordings(query, { limit: PAGE_SIZE, signal: controller.signal }).then(
            (result) => setState({ phase: "ready", query: result.query, hits: result.hits, total: result.total, recordings: result.recordings, more: "idle" }),
            (error: unknown) => {
                if (!controller.signal.aborted) setState({ phase: "error", message: errorText(error) });
            },
        );
        return () => controller.abort();
        // `refreshKey`: the list changed under the results (a recording was deleted or renamed), so they are asked for again.
    }, [query, active, refreshKey]);

    const more = useCallback((): void => {
        const now = current.current;
        if (now.phase !== "ready" || now.more === "loading" || now.hits.length >= now.total) return;
        const controller = new AbortController();
        abort.current = controller;
        setState({ ...now, more: "loading" });
        searchRecordings(query, { limit: PAGE_SIZE, offset: now.hits.length, signal: controller.signal }).then(
            (result) =>
                setState((latest) =>
                    latest.phase === "ready"
                        ? { phase: "ready", query: latest.query, hits: [...latest.hits, ...result.hits], total: result.total, recordings: result.recordings, more: "idle" }
                        : latest,
                ),
            (error: unknown) => {
                if (!controller.signal.aborted) setState((latest) => (latest.phase === "ready" ? { ...latest, more: { error: errorText(error) } } : latest));
            },
        );
    }, [query]);

    return { state, more };
}
