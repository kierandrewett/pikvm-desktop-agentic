/**
 * The Pi's own journal (kvmd `api/log`): a read-only snapshot with a refresh. The real UI streams
 * it with follow=1, which is the wrong shape for a dialog opened to answer one question.
 *
 * An hour is ~1.5 MB and a day 18 MB over many seconds, so the body streams and says how much
 * has arrived, and closing or refreshing aborts the read in flight (failure mode 27).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { DialogProps } from "../dialog-seam";
import { copyText } from "./kvmd";
import { failureText, humanBytes } from "./model/guards";
import { capLog, LOG_WINDOWS, logPath } from "./model/log";
import { Btn, DialogShell } from "./shell";

type LogState =
    | { readonly phase: "loading"; readonly bytes: number }
    | { readonly phase: "ready"; readonly text: string }
    | { readonly phase: "error"; readonly message: string };

/** Read a response body progressively, reporting the byte count as it grows. */
async function readProgressively(res: Response, onBytes: (n: number) => void): Promise<string> {
    if (!res.body?.getReader) return res.text();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
        const step = await reader.read();
        if (step.done) break;
        chunks.push(step.value);
        received += step.value.length;
        onBytes(received);
    }
    const merged = new Uint8Array(received);
    let at = 0;
    for (const chunk of chunks) {
        merged.set(chunk, at);
        at += chunk.length;
    }
    return new TextDecoder("utf-8").decode(merged);
}

export function LogDialog({ session, onClose }: DialogProps) {
    const [seek, setSeek] = useState("3600");
    const [state, setState] = useState<LogState>({ phase: "loading", bytes: 0 });
    const abort = useRef<AbortController | null>(null);
    const body = useRef<HTMLPreElement>(null);

    const load = useCallback(async (window: string): Promise<void> => {
        abort.current?.abort();
        const controller = new AbortController();
        abort.current = controller;
        setState({ phase: "loading", bytes: 0 });
        try {
            const res = await fetch(logPath(window), { cache: "no-store", signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await readProgressively(res, (bytes) => {
                if (!controller.signal.aborted) setState({ phase: "loading", bytes });
            });
            if (controller.signal.aborted) return;
            setState({ phase: "ready", text: capLog(text) });
        } catch (e) {
            if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
            setState({ phase: "error", message: `Could not read the log: ${failureText(e)}` });
        }
    }, []);

    useEffect(() => {
        void load(seek);
    }, [load, seek]);

    // Do not leave tens of megabytes downloading into a dialog nobody is looking at.
    useEffect(() => () => abort.current?.abort(), []);

    // Newest last: the end of the log is what anyone opening it wants.
    useEffect(() => {
        if (state.phase === "ready" && body.current) body.current.scrollTop = body.current.scrollHeight;
    }, [state]);

    const copyable = state.phase === "ready" && state.text !== "" ? state.text : null;
    const shown =
        state.phase === "loading"
            ? state.bytes > 0
                ? `Loading ${humanBytes(state.bytes)}`
                : "Loading"
            : state.phase === "error"
              ? state.message
              : state.text || "(nothing in this window)";

    return (
        <DialogShell
            title="PiKVM log"
            size="full"
            onClose={onClose}
            testId="log-dialog"
            actions={
                <>
                    <Btn
                        disabled={copyable === null}
                        onClick={() => {
                            if (copyable === null) return;
                            void copyText(copyable).then((ok) =>
                                session.notices.notify(ok ? { text: "Log copied" } : { text: "Could not copy", error: true }),
                            );
                        }}
                    >
                        Copy
                    </Btn>
                    <Btn variant="primary" onClick={onClose}>
                        Done
                    </Btn>
                </>
            }
        >
            <div className="dlg-row">
                <label className="dlg-label" htmlFor="log-seek">
                    Show
                </label>
                <select id="log-seek" className="dlg-select" value={seek} onChange={(e) => setSeek(e.target.value)}>
                    {LOG_WINDOWS.map((w) => (
                        <option key={w.seek} value={w.seek}>
                            {w.label}
                        </option>
                    ))}
                </select>
                <Btn onClick={() => void load(seek)}>Refresh</Btn>
            </div>
            {/* A tab stop so the log can be scrolled from the keyboard, and a name so it announces what it is. */}
            <pre ref={body} className="dlg-log" tabIndex={0} role="group" aria-label="Log output" data-testid="log-body">
                {shown}
            </pre>
        </DialogShell>
    );
}
