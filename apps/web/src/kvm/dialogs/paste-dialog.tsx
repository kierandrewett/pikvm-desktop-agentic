/**
 * Paste text to the target: kvmd types it itself through the chosen keymap, which is
 * layout-correct and far faster than sending keys. The box is prefilled from the host clipboard.
 *
 * A paste is a long operation (kvmd answers when it has typed the last character), and closing
 * the dialog does not stop it, so while it types the dialog says so and shows an estimate.
 */

import { humanCount, humanDuration, keymapChoice, PASTE_DELAY_S, pasteDuration } from "@pikvm/kvm-engine";
import { useEffect, useRef, useState } from "react";
import type { DialogProps } from "../dialog-seam";
import { useTarget } from "../session";
import { useStore } from "../use-store";
import { Btn, DialogShell } from "./shell";

/** How far through a paste the clock says we are, 0..1; null once the estimate has run out. */
export function typingProgress(elapsedMs: number, chars: number): number | null {
    const expected = chars * PASTE_DELAY_S * 1000;
    if (expected <= 0 || elapsedMs >= expected) return null;
    return elapsedMs / expected;
}

export function PasteDialog({ session, onClose }: DialogProps) {
    const [text, setText] = useState("");
    const [typing, setTyping] = useState<{ chars: number; startedAt: number } | null>(null);
    const [now, setNow] = useState(() => session.clock.now());
    const mounted = useRef(true);
    const area = useRef<HTMLTextAreaElement>(null);

    const keymaps = useTarget((s) => s.device.keymaps);
    const choice = keymapChoice(keymaps);
    const chosen = useStore(session.keymap);
    const selected = chosen !== null && choice.options.includes(chosen) ? chosen : (choice.selected ?? "");
    const gate = useStore(session.gate.store);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    // Prefilled from the host clipboard, the thing people paste. Best effort: a browser that asks or
    // refuses just leaves the box empty to type or Ctrl+V into.
    useEffect(() => {
        let alive = true;
        navigator.clipboard?.readText?.().then(
            (clip) => {
                if (!alive || !clip) return;
                setText((current) => {
                    if (current) return current;
                    queueMicrotask(() => area.current?.select());
                    return clip;
                });
            },
            () => {},
        );
        return () => {
            alive = false;
        };
    }, []);

    useEffect(() => {
        if (!typing) return;
        const timer = window.setInterval(() => setNow(session.clock.now()), 500);
        return () => window.clearInterval(timer);
    }, [typing, session.clock]);

    const blocked = gate.macro !== null || gate.pasting || typing !== null;

    const send = async (): Promise<void> => {
        if (!text || typing) return;
        const chars = text.length;
        setNow(session.clock.now());
        setTyping({ chars, startedAt: session.clock.now() });
        // The engine refuses (and says why) while a macro or another paste holds the target, so
        // the Ctrl+Enter path that skips the disabled button is covered here too.
        const result = await session.paster.paste(text);
        // Closing during the paste hands the screen back; closing again would close whatever is open now.
        if (!mounted.current) return;
        if (result.kind === "typed") {
            onClose();
            return;
        }
        setTyping(null);
    };

    const count = text.length;
    const progress = typing ? typingProgress(now - typing.startedAt, typing.chars) : null;
    const remaining = typing ? Math.max(0, typing.chars * PASTE_DELAY_S * 1000 - (now - typing.startedAt)) : 0;

    return (
        <DialogShell
            title="Paste text to the target"
            onClose={onClose}
            testId="paste-dialog"
            initialFocus="textarea"
            actions={
                <>
                    <Btn onClick={onClose}>{typing ? "Close" : "Cancel"}</Btn>
                    <Btn variant="primary" disabled={!text || blocked} onClick={() => void send()}>
                        Type on target
                    </Btn>
                </>
            }
        >
            <textarea
                ref={area}
                className="dlg-input"
                rows={6}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="Text to type on the target"
                placeholder={"Text to type on the target"}
                value={text}
                readOnly={typing !== null}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void send();
                    }
                }}
            />
            <div className="dlg-row wrap">
                {choice.hidden ? null : (
                    <>
                        <label className="dlg-label" htmlFor="paste-keymap">
                            Keymap
                        </label>
                        <select
                            id="paste-keymap"
                            className="dlg-select"
                            value={selected}
                            disabled={choice.disabled || typing !== null}
                            onChange={(e) => session.keymap.setState(e.target.value || null)}
                        >
                            {choice.options.map((name) => (
                                <option key={name} value={name}>
                                    {name}
                                </option>
                            ))}
                        </select>
                    </>
                )}
                <span className="dlg-hint" data-testid="paste-count">
                    {count > 0 ? `${humanCount(count)} ${count === 1 ? "character" : "characters"}` : ""}
                    {count > 0 && pasteDuration(count) ? ` \u00b7 ${pasteDuration(count)}` : ""}
                </span>
            </div>
            {gate.macro !== null && !typing ? (
                <p className="dlg-note is-warn" role="status">
                    {gate.macro} is still running; paste once it has finished.
                </p>
            ) : null}
            {typing ? (
                <div className="dlg-section" role="status" aria-live="polite" data-testid="paste-progress">
                    <div className="dlg-row">
                        <progress
                            className="dlg-grow"
                            max={100}
                            aria-label="Typing progress (estimated)"
                            {...(progress !== null ? { value: Math.min(99, Math.round(progress * 100)) } : {})}
                        />
                    </div>
                    <p className="dlg-note">
                        Typing {humanCount(typing.chars)} {typing.chars === 1 ? "character" : "characters"} on the target.{" "}
                        {progress !== null && remaining >= 10_000 ? `About ${humanDuration(remaining)} left. ` : null}
                        Closing this does not stop it.
                    </p>
                </div>
            ) : null}
        </DialogShell>
    );
}
