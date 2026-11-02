/**
 * Stream settings (kvmd `api/streamer/set_params`). Each row shows only if the Pi reports the
 * feature, and its range is the Pi's own limit.
 *
 * A slider is NOT a React-controlled input on purpose: its label follows the drag, but the change
 * is posted when it is released (kvmd re-encodes on every change, and a drag across the range
 * would hammer it), and a Pi event must never rewrite a control the user is holding. The native
 * `input` and `change` events give exactly that split; React's onChange merges them.
 */

import { errorMessage } from "@pikvm/kvm-engine";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DialogProps } from "../dialog-seam";
import type { KvmSession } from "../session";
import { useTarget } from "../session";
import { saveScreenshot } from "../platform";
import { failureLine, kvmdPost } from "./kvmd";
import { streamParamPath, streamView, type SliderView } from "./model/stream";
import { Btn, DialogShell, Note, useConfirm } from "./shell";

/** One change to the streamer; false (after saying why) when the Pi refused it. */
export async function setStreamParam(session: KvmSession, name: string, value: string | number): Promise<boolean> {
    const result = await kvmdPost(session, streamParamPath(name, value));
    if (result.ok) return true;
    session.notices.notify({
        text:
            result.status !== null
                ? `Could not change the stream ${name.replace(/_/g, " ")} (${result.status})`
                : `Could not change the stream: ${result.message}`,
        error: true,
    });
    return false;
}

/** Save a screenshot once at a time: three rapid taps would otherwise save three files. */
export function useScreenshot(session: KvmSession): { busy: boolean; save: () => Promise<void> } {
    const [busy, setBusy] = useState(false);
    const running = useRef(false);
    const save = useCallback(async (): Promise<void> => {
        if (running.current) return;
        running.current = true;
        setBusy(true);
        try {
            await saveScreenshot();
            session.notices.notify({ text: "Screenshot saved" });
        } catch (e) {
            session.notices.notify({ text: `Screenshot failed: ${errorMessage(e)}`, error: true });
        } finally {
            running.current = false;
            setBusy(false);
        }
    }, [session]);
    return { busy, save };
}

interface SliderProps {
    readonly view: SliderView;
    readonly id: string;
    /** Resolves true when the Pi took the change. */
    readonly onCommit: (value: number) => Promise<boolean>;
}

function Slider({ view, id, onCommit }: SliderProps) {
    const input = useRef<HTMLInputElement>(null);
    const held = useRef(false);
    const applied = useRef(view.value);
    applied.current = view.value;
    const format = view.spec.format;
    const [text, setText] = useState(() => format(view.value));
    const commit = useRef(onCommit);
    commit.current = onCommit;

    // Show what the Pi has, unless the user is holding the control.
    useEffect(() => {
        const el = input.current;
        if (!el || held.current) return;
        el.value = String(view.value);
        setText(format(Number(el.value)));
    }, [view.value, view.min, view.max, format]);

    useEffect(() => {
        const el = input.current;
        if (!el) return;
        const hold = (): void => {
            held.current = true;
        };
        const release = (): void => {
            held.current = false;
        };
        const onInput = (): void => setText(format(Number(el.value)));
        const onChange = (): void => {
            held.current = false;
            const next = Number(el.value);
            void commit.current(next).then((ok) => {
                if (ok || !input.current) return;
                // A rejected change puts the control back to what the Pi actually has.
                input.current.value = String(applied.current);
                setText(format(applied.current));
            });
        };
        el.addEventListener("pointerdown", hold);
        el.addEventListener("keydown", hold);
        el.addEventListener("pointerup", release);
        el.addEventListener("pointercancel", release);
        el.addEventListener("blur", release);
        el.addEventListener("input", onInput);
        el.addEventListener("change", onChange);
        return () => {
            el.removeEventListener("pointerdown", hold);
            el.removeEventListener("keydown", hold);
            el.removeEventListener("pointerup", release);
            el.removeEventListener("pointercancel", release);
            el.removeEventListener("blur", release);
            el.removeEventListener("input", onInput);
            el.removeEventListener("change", onChange);
        };
    }, [format]);

    return (
        <div className="dlg-row">
            <label className="dlg-label" htmlFor={id}>
                {view.spec.label}
            </label>
            <input
                ref={input}
                id={id}
                type="range"
                className="dlg-range"
                min={view.min}
                max={view.max}
                step={view.step}
                defaultValue={view.value}
                aria-valuetext={text}
            />
            <span className="dlg-hint" aria-hidden="true">
                {text}
            </span>
        </div>
    );
}

export function StreamDialog({ session, onClose }: DialogProps) {
    const streamer = useTarget((s) => s.device.streamer);
    const view = streamView(streamer);
    const confirm = useConfirm();
    const shot = useScreenshot(session);

    const reset = async (): Promise<void> => {
        const ok = await confirm.ask({
            title: "Reset the stream?",
            body: "The picture drops for a moment while the streamer restarts.",
            confirm: "Reset stream",
        });
        if (!ok) return;
        const result = await kvmdPost(session, "/api/streamer/reset");
        session.notices.notify(
            result.ok
                ? { text: "Stream reset" }
                : { text: failureLine("reset the stream", result), error: true },
        );
    };

    return (
        <>
            <DialogShell
                title="Stream settings"
                onClose={onClose}
                testId="stream-dialog"
                startActions={
                    <>
                        <Btn disabled={shot.busy} onClick={() => void shot.save()}>
                            Save screenshot
                        </Btn>
                        <Btn onClick={() => void reset()}>Reset stream</Btn>
                    </>
                }
                actions={
                    <Btn variant="primary" onClick={onClose}>
                        Done
                    </Btn>
                }
            >
                <div className="dlg-sliders dlg-section">
                    {view.resolutions.length > 0 ? (
                        <div className="dlg-row">
                            <label className="dlg-label" htmlFor="sp-resolution">
                                Resolution
                            </label>
                            <select
                                id="sp-resolution"
                                className="dlg-select"
                                value={view.resolution ?? ""}
                                onChange={(e) => void setStreamParam(session, "resolution", e.target.value)}
                            >
                                {view.resolution === null || view.resolutions.includes(view.resolution) ? null : (
                                    <option value={view.resolution}>{view.resolution}</option>
                                )}
                                {view.resolutions.map((r) => (
                                    <option key={r} value={r}>
                                        {r}
                                    </option>
                                ))}
                            </select>
                        </div>
                    ) : null}
                    {view.sliders.map((slider) => (
                        <Slider
                            key={slider.spec.param}
                            id={`sp-${slider.spec.param}`}
                            view={slider}
                            onCommit={(value) => setStreamParam(session, slider.spec.param, value)}
                        />
                    ))}
                </div>
                {view.empty ? <Note>The Pi has not reported any adjustable stream settings.</Note> : null}
            </DialogShell>
            {confirm.element}
        </>
    );
}
