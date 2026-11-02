/**
 * Read text off the live picture: the user drags a rectangle on the picture (the screen's
 * picker overlay), kvmd runs tesseract over that region of its CURRENT frame and answers with
 * plain text. The dialog draws nothing while the user is aiming, so the picture is usable.
 *
 * A read takes seconds (about six for a full screen on a Pi), so the dialog says it is reading
 * and lets the user give up; a cancelled pick closes without a word (failure mode 30).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { DialogProps } from "../dialog-seam";
import { type PicturePixelRect, useOcrPicker } from "../ocr-picker";
import { useTarget } from "../session";
import { copyText } from "./kvmd";
import { asList, asRecord, failureText } from "./model/guards";
import { Btn, DialogShell } from "./shell";

type OcrState =
    | { readonly phase: "picking" }
    | { readonly phase: "reading" }
    | { readonly phase: "done"; readonly text: string }
    | { readonly phase: "error"; readonly message: string };

export const OCR_EMPTY = "(no text found in that region)";

/** The snapshot request for one region, in the picture's own pixels. */
export function ocrPath(rect: PicturePixelRect, langs: readonly string[]): string {
    const q = [
        "allow_offline=1",
        "ocr=1",
        `ocr_left=${rect.left}`,
        `ocr_top=${rect.top}`,
        `ocr_right=${rect.right}`,
        `ocr_bottom=${rect.bottom}`,
    ];
    if (langs.length > 0) q.push(`ocr_langs=${encodeURIComponent(langs.join(","))}`);
    return `/api/streamer/snapshot?${q.join("&")}`;
}

export function OcrDialog({ session, onClose }: DialogProps) {
    const picker = useOcrPicker();
    const ocr = useTarget((s) => s.device.ocr);
    const [state, setState] = useState<OcrState>({ phase: "picking" });
    const abort = useRef<AbortController | null>(null);
    const alive = useRef(true);
    const defaultLangs = asList(asRecord(ocr?.langs)?.["default"]).filter((l): l is string => typeof l === "string");
    const langs = useRef(defaultLangs);
    langs.current = defaultLangs;
    const available = ocr?.enabled === true;

    const read = useCallback(
        async (rect: PicturePixelRect): Promise<void> => {
            const controller = new AbortController();
            abort.current = controller;
            setState({ phase: "reading" });
            try {
                const res = await fetch(ocrPath(rect, langs.current), { cache: "no-store", signal: controller.signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const text = (await res.text()).replace(/\s+$/, "");
                if (controller.signal.aborted || !alive.current) return;
                setState({ phase: "done", text });
            } catch (e) {
                if (controller.signal.aborted || !alive.current) return;
                setState({ phase: "error", message: `Could not read the screen: ${failureText(e)}` });
            }
        },
        [],
    );

    const aim = useCallback(async (): Promise<void> => {
        setState({ phase: "picking" });
        const rect = await picker.pick();
        // A stale pick (superseded by a remount) must not close or read anything.
        if (!alive.current) return;
        if (rect === null) {
            onClose();
            return;
        }
        await read(rect);
    }, [picker, read, onClose]);

    useEffect(() => {
        alive.current = true;
        if (available) void aim();
        else setState({ phase: "error", message: "This PiKVM has no text reading available." });
        return () => {
            alive.current = false;
            picker.cancel();
            abort.current?.abort();
        };
        // Aim once, when the dialog opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (state.phase === "picking") return null;

    const found = state.phase === "done" && state.text.length > 0 ? state.text : null;
    const reading = state.phase === "reading";

    return (
        <DialogShell
            title="Text from the screen"
            onClose={() => {
                abort.current?.abort();
                onClose();
            }}
            testId="ocr-dialog"
            initialFocus={found ? "textarea" : "[data-done]"}
            startActions={
                state.phase === "done" || state.phase === "error" ? (
                    <Btn disabled={!available} onClick={() => void aim()}>
                        Read another region
                    </Btn>
                ) : null
            }
            actions={
                <>
                    <Btn
                        disabled={found === null}
                        onClick={() => {
                            if (found === null) return;
                            void copyText(found).then((ok) =>
                                session.notices.notify(ok ? { text: "Text copied" } : { text: "Could not copy", error: true }),
                            );
                        }}
                    >
                        Copy
                    </Btn>
                    <Btn variant="primary" data-done="" onClick={onClose}>
                        {reading ? "Cancel" : "Done"}
                    </Btn>
                </>
            }
        >
            {reading ? (
                <div className="dlg-section" role="status" aria-live="polite">
                    <progress className="dlg-grow" max={100} aria-label="Reading the screen" />
                    <p className="dlg-note">Reading the screen{"\u2026"} this can take several seconds.</p>
                </div>
            ) : state.phase === "error" ? (
                <p className="dlg-note is-warn" role="alert">
                    {state.message}
                </p>
            ) : (
                <textarea
                    className="dlg-input"
                    rows={8}
                    spellCheck={false}
                    readOnly
                    aria-label="Text read from the screen"
                    value={found ?? OCR_EMPTY}
                />
            )}
        </DialogShell>
    );
}
