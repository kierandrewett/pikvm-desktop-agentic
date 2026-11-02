/**
 * The macro editor's draft. The server stores only what it can use: a step with no key or no
 * text is dropped and a macro left with no step goes with it (src/macros.ts cleanStep). A macro
 * is built a piece at a time ("add the combo, press Ctrl, then pick the key"), so the editor
 * keeps its own draft and PUTs only the parts that would survive; the server's reply never
 * replaces the draft while it is being edited.
 */

import type { Macro } from "@pikvm/contracts/api";

export type DraftStep =
    | { readonly type: "chord"; readonly mods: readonly string[]; readonly code: string }
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "delay"; readonly ms: number };

export interface DraftMacro {
    readonly id: string;
    readonly label: string;
    readonly icon?: string;
    readonly pinned?: boolean;
    readonly steps: readonly DraftStep[];
}

/** The limits the server enforces on write (packages/contracts, src/macros.ts). */
export const MACRO_LIMITS = { macros: 60, steps: 40, text: 4000, label: 60, delayMax: 10_000, mods: 6 } as const;

export const DEFAULT_DELAY_MS = 200;

export function stepWouldPersist(step: DraftStep | null | undefined): boolean {
    if (!step) return false;
    if (step.type === "chord") return !!step.code;
    if (step.type === "text") return !!step.text;
    return Number(step.ms) > 0;
}

export function macroWouldPersist(macro: DraftMacro | null | undefined): boolean {
    return !!macro && !!macro.label && macro.steps.some(stepWouldPersist);
}

/** Pinned unless explicitly turned off: that is how the toolbar reads a macro written before the toggle. */
export function isPinned(macro: { readonly pinned?: boolean }): boolean {
    return macro.pinned !== false;
}

function cleanStep(step: DraftStep): DraftStep {
    if (step.type === "chord") return { type: "chord", mods: step.mods.slice(0, MACRO_LIMITS.mods), code: step.code };
    if (step.type === "text") return { type: "text", text: step.text.slice(0, MACRO_LIMITS.text) };
    return { type: "delay", ms: Math.min(MACRO_LIMITS.delayMax, Math.max(1, Math.round(step.ms))) };
}

/** What to PUT: only macros and steps the server will keep, in order. */
export function persistable(draft: readonly DraftMacro[]): DraftMacro[] {
    const out: DraftMacro[] = [];
    for (const macro of draft.slice(0, MACRO_LIMITS.macros)) {
        const steps = macro.steps.filter(stepWouldPersist).slice(0, MACRO_LIMITS.steps).map(cleanStep);
        if (!macro.label || steps.length === 0) continue;
        out.push({ ...macro, label: macro.label.slice(0, MACRO_LIMITS.label), steps });
    }
    return out;
}

export function fromStored(macros: ReadonlyArray<Macro>): DraftMacro[] {
    return macros.map((m) => ({
        id: m.id,
        label: m.label,
        ...(m.icon !== undefined ? { icon: m.icon } : {}),
        ...(m.pinned !== undefined ? { pinned: m.pinned } : {}),
        steps: m.steps.map((s) =>
            s.type === "chord"
                ? { type: "chord" as const, mods: [...s.mods], code: s.code }
                : s.type === "text"
                  ? { type: "text" as const, text: s.text }
                  : { type: "delay" as const, ms: s.ms },
        ),
    }));
}

export function newMacro(now: number): DraftMacro {
    return {
        id: `macro-${now.toString(36)}`,
        label: "New macro",
        icon: "command",
        pinned: true,
        steps: [{ type: "chord", mods: [], code: "" }],
    };
}

export function newStep(kind: DraftStep["type"]): DraftStep {
    if (kind === "chord") return { type: "chord", mods: [], code: "" };
    if (kind === "text") return { type: "text", text: "" };
    return { type: "delay", ms: DEFAULT_DELAY_MS };
}

/** The note under the steps: how many would be dropped on save. Null when none. */
export function unsavedNote(macro: DraftMacro): string | null {
    const incomplete = macro.steps.filter((s) => !stepWouldPersist(s)).length;
    if (incomplete === 0) return null;
    if (incomplete === macro.steps.length) {
        return "Not saved yet \u2014 choose the key or enter the text below and it will be kept.";
    }
    return incomplete === 1
        ? "One step is still empty; it will be dropped when saved."
        : `${incomplete} steps are still empty; they will be dropped when saved.`;
}

export function updateMacro(
    draft: readonly DraftMacro[],
    id: string,
    change: (macro: DraftMacro) => DraftMacro,
): DraftMacro[] {
    return draft.map((m) => (m.id === id ? change(m) : m));
}

export function updateStep(macro: DraftMacro, index: number, change: (step: DraftStep) => DraftStep): DraftMacro {
    return { ...macro, steps: macro.steps.map((s, i) => (i === index ? change(s) : s)) };
}

export function moveStep(macro: DraftMacro, index: number, delta: -1 | 1): DraftMacro {
    const to = index + delta;
    if (to < 0 || to >= macro.steps.length) return macro;
    const steps = macro.steps.slice();
    const [moved] = steps.splice(index, 1);
    if (moved) steps.splice(to, 0, moved);
    return { ...macro, steps };
}

/** Removing the last step leaves one empty chord, so the editor never shows a macro with nothing to edit. */
export function removeStep(macro: DraftMacro, index: number): DraftMacro {
    const steps = macro.steps.filter((_, i) => i !== index);
    return { ...macro, steps: steps.length > 0 ? steps : [newStep("chord")] };
}

export function toggleMod(step: Extract<DraftStep, { type: "chord" }>, mod: string): DraftStep {
    const has = step.mods.includes(mod);
    return { ...step, mods: has ? step.mods.filter((m) => m !== mod) : [...step.mods, mod] };
}
