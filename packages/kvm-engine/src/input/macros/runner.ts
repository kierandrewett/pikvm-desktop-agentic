import type { Clock } from "../../clock/index";
import type { HttpPort } from "../../http";
import { errorMessage, type Notify } from "../notice";
import { humanDuration, printPath } from "../paste/print-query";
import type { TypingGate } from "../typing-gate";
import { MACRO_NOTICE_MS, macroDuration, macroNeedsInput, type MacroLike } from "./catalog";

/**
 * Run a macro's steps in order, through the same queue manual keys use.
 *
 * A macro is an ordered sequence and the later steps assume the earlier ones landed ("type the
 * username, Tab, type the password, Enter" carries on into the wrong field, and then submits
 * it, if the first step silently did nothing). So a step that did not happen STOPS the run, and
 * the notice says how many later steps were not sent.
 */

/** The slice of the keyboard a run drives. */
export interface MacroKeys {
    sendChord(mods: readonly string[], code: string, shift?: boolean): void;
    afterKeys(cb: () => void): void;
}

export type MacroResult =
    | {
          readonly kind: "refused";
          /** `running`: another macro; `typing`: a paste; `offline`: it has key steps and the HID socket is down. */
          readonly reason: "running" | "typing" | "offline";
      }
    | { readonly kind: "sent" }
    | { readonly kind: "stopped"; readonly problem: string; readonly remaining: number };

export interface MacroRunnerOptions {
    readonly clock: Clock;
    readonly keys: MacroKeys;
    /** Whether the HID socket is open right now. */
    readonly isInputOpen: () => boolean;
    readonly http: HttpPort;
    readonly gate: TypingGate;
    /** The keymap text steps are typed with: the same as paste uses, read at send time. */
    readonly keymap: () => string | null;
    readonly notify: Notify;
}

export interface MacroRunner {
    /** Resolves when the run ends, or immediately if it was refused. */
    run(macro: MacroLike | null | undefined): Promise<MacroResult>;
}

export function createMacroRunner(options: MacroRunnerOptions): MacroRunner {
    const { clock, keys, http, gate, notify } = options;

    return {
        run(macro) {
            if (!macro) return Promise.resolve({ kind: "refused", reason: "running" });
            const running = gate.store.getState();
            if (running.macro !== null) {
                // Reachable from a menu that has no disabled state to show: saying so beats
                // dropping the click in silence.
                notify({ text: `${running.macro} is still running`, error: true });
                return Promise.resolve({ kind: "refused", reason: "running" });
            }
            if (running.pasting) {
                // A paste can hold the target for minutes; a macro starting during one puts a
                // second POST on /api/hid/print and kvmd types both interleaved.
                notify({ text: "A paste is still typing on the target", error: true });
                return Promise.resolve({ kind: "refused", reason: "typing" });
            }
            if (macroNeedsInput(macro) && !options.isInputOpen()) {
                // The run cannot notice afterwards: chords are queued and played from a timer
                // whatever the socket is doing. So the check has to happen before it starts.
                notify({ text: `${macro.label} has key steps and input is offline`, error: true });
                return Promise.resolve({ kind: "refused", reason: "offline" });
            }
            gate.beginMacro(macro.label);

            // Say a slow run is under way, the same way a long paste does. Only when it is
            // slow enough to be worth a word: Ctrl+Alt+Delete is over in a tenth of a second.
            const runFor = macroDuration(macro);
            if (runFor >= MACRO_NOTICE_MS) {
                notify({ text: `Running ${macro.label} \u2014 ${humanDuration(runFor)}\u2026`, sticky: true });
            }

            // Executor form on purpose: Promise.withResolvers is iOS 17.4+ and this runs on phones.
            return new Promise<MacroResult>((resolve) => {
                const steps = macro.steps;
                let i = 0;
                const finish = (result: MacroResult): void => {
                    gate.endMacro();
                    resolve(result);
                };
                const stopped = (problem: string): void => {
                    const left = steps.length - i;
                    notify({
                        text:
                            `${macro.label} stopped: ${problem}` +
                            (left > 0 ? ` \u2014 ${left} later step${left === 1 ? "" : "s"} not sent.` : ""),
                        error: true,
                    });
                    finish({ kind: "stopped", problem, remaining: left });
                };
                const next = (): void => {
                    const step = steps[i++];
                    if (!step) {
                        // A macro's whole effect happens on the OTHER machine, so without this
                        // the click has no visible consequence here at all.
                        notify({ text: `${macro.label} sent` });
                        finish({ kind: "sent" });
                        return;
                    }
                    if (step.type === "chord") {
                        // Wait for the chord to finish, not for sendChord to return: it returns
                        // at once, and advancing on a zero timeout started the NEXT step while
                        // the modifiers were still down, so "Ctrl+Alt+Delete, then type hi"
                        // arrived as Ctrl+Alt+h and Ctrl+Alt+i.
                        keys.sendChord(step.mods ?? [], step.code, false);
                        keys.afterKeys(next);
                        return;
                    }
                    if (step.type === "text") {
                        // kvmd types it, with the same keymap the paste dialog uses.
                        http.request({
                            method: "POST",
                            path: printPath(options.keymap()),
                            body: step.text,
                            contentType: "text/plain",
                        }).then(
                            (res) => {
                                // A 4xx or 5xx RESOLVES, so the status must be checked as well
                                // as the rejection, or a 500 would still toast "sent".
                                if (res.status === 413) {
                                    stopped("that step is too much text to type in one go");
                                    return;
                                }
                                if (!res.ok) {
                                    stopped(`text step failed (${res.status})`);
                                    return;
                                }
                                next();
                            },
                            (e: unknown) => {
                                stopped(`text step failed: ${errorMessage(e)}`);
                            },
                        );
                        return;
                    }
                    if (step.type === "delay") {
                        clock.setTimeout(next, Number(step.ms) || 0);
                        return;
                    }
                    next();
                };
                next();
            });
        },
    };
}
