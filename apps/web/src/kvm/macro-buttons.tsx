/**
 * Pinned macros, where a macro can be RUN: tiles in the phone sheet and a strip in the desktop
 * toolbar. Editing them is the dialogs' business; running goes through the engine's runner,
 * which refuses while another macro or a paste holds the target and when the keys it needs
 * cannot reach it, and these buttons grey themselves from the same facts so the refusal is
 * visible before the press and not only an apology after it.
 */

import type { Macro } from "@pikvm/contracts/api";
import { macroNeedsInput, type MacroLike } from "@pikvm/kvm-engine";
import { useMacros } from "../api/queries";
import { MacroIcon } from "./icons";
import { useKvmSession, useTarget } from "./session";
import { useStore } from "./use-store";

/**
 * The engine's view of a stored macro. Under exactOptionalPropertyTypes an absent icon and an
 * undefined one are different things, and the schema's decoded value can carry the second.
 */
export function runnable(macro: Macro): MacroLike {
    return { label: macro.label, steps: macro.steps, ...(macro.icon ? { icon: macro.icon } : {}) };
}

/** Macros shown for running: everything the user has not unpinned. */
export function usePinnedMacros(): readonly Macro[] {
    const macros = useMacros();
    return (macros.data ?? []).filter((m) => m.pinned !== false);
}

/** Whether a macro can be started now: nothing else typing, and its keys can reach the target. */
export function useMacroBlocked(): (macro: Macro) => boolean {
    const session = useKvmSession();
    const typing = useStore(session.gate.store);
    const inputOpen = useTarget((s) => s.link.open);
    const busy = typing.macro !== null || typing.pasting;
    return (macro) => busy || (macroNeedsInput(runnable(macro)) && !inputOpen);
}

/** The phone sheet's grid: icon over name, like the mouse row. */
export function MacroTiles({ onRun }: { readonly onRun?: () => void }) {
    const session = useKvmSession();
    const pinned = usePinnedMacros();
    const blocked = useMacroBlocked();
    if (pinned.length === 0) return null;
    return (
        <>
            <div className="kvm-sheet-label" id="kvm-macro-label">
                Macros
            </div>
            <div className="kvm-sheet-grid" role="group" aria-labelledby="kvm-macro-label">
                {pinned.map((macro) => (
                    <button
                        key={macro.id}
                        type="button"
                        className="kvm-item kvm-macro-tile"
                        disabled={blocked(macro)}
                        onClick={() => {
                            void session.macros.run(runnable(macro));
                            onRun?.();
                        }}
                    >
                        <span className="kvm-macro-icon">
                            <MacroIcon macro={runnable(macro)} />
                        </span>
                        <span className="kvm-macro-label">{macro.label}</span>
                    </button>
                ))}
            </div>
        </>
    );
}

/** The desktop toolbar's strip of round icon buttons. */
export function MacroStrip() {
    const session = useKvmSession();
    const pinned = usePinnedMacros();
    const blocked = useMacroBlocked();
    if (pinned.length === 0) return null;
    return (
        <div className="kvm-macro-strip" role="group" aria-label="Run a macro">
            {pinned.map((macro) => (
                <button
                    key={macro.id}
                    type="button"
                    className="kvm-tb-btn"
                    title={macro.label}
                    aria-label={macro.label}
                    disabled={blocked(macro)}
                    onClick={() => void session.macros.run(runnable(macro))}
                >
                    <MacroIcon macro={runnable(macro)} />
                </button>
            ))}
        </div>
    );
}
