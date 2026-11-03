/**
 * The macro manager's state, shared by its two frames: the dialog on the KVM screen (macros-dialog.tsx) and the
 * Settings page (settings/pages/macros.tsx). The list is read from the server, edited as a draft, and every edit
 * saves (`PUT /app/api/v1/macros`); only the parts the server would keep are sent (see model/macros.ts). A frame
 * draws the controls and calls what this returns; neither has a copy of the rules.
 *
 * Saves are serialised through one chain shared by every instance of the editor and coalesced (failure mode 33):
 * the last draft wins, and an editor opened a moment after an edit waits for that edit to land before it reads the
 * list.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listMacros, replaceMacros, runApi } from "../../api/client";
import { macrosKey } from "../../api/queries";
import type { KvmSession } from "../session";
import { failureText } from "./model/guards";
import {
    fromStored,
    macroWouldPersist,
    newMacro,
    persistable,
    unsavedNote,
    updateMacro,
    updateStep,
    MACRO_LIMITS,
    type DraftMacro,
    type DraftStep,
} from "./model/macros";

/** Every save, in order, across editor instances. */
let saveChain: Promise<void> = Promise.resolve();
let saveVersion = 0;

export function resetMacroSaveChainForTests(): void {
    saveChain = Promise.resolve();
    saveVersion = 0;
}

export interface MacroEditorOptions {
    readonly session: KvmSession;
    /** Asked before a macro is deleted; resolves true only when the user confirms. */
    readonly confirmDelete: (target: DraftMacro) => Promise<boolean>;
    /** Running a macro leaves the editor (the dialog closes); a page stays. */
    readonly onRun?: () => void;
    /** The element whose `[data-fk]` controls focus follows: the dialog's panel, the page's column. */
    readonly scope: () => HTMLElement | null;
    /** Which macro is open when the list loads: the first (the dialog's two panes), or none (the page's list). */
    readonly openFirst: boolean;
}

export interface MacroEditor {
    /** False until the list has loaded (or failed to). */
    readonly ready: boolean;
    readonly loadError: string | null;
    readonly list: readonly DraftMacro[];
    readonly selected: string | null;
    readonly select: (id: string | null) => void;
    /** The open macro, if any. */
    readonly macro: DraftMacro | null;
    readonly add: () => void;
    readonly remove: (target: DraftMacro) => Promise<void>;
    readonly run: (target: DraftMacro) => void;
    /** Apply a whole new list (reordering) and save it. */
    readonly apply: (next: readonly DraftMacro[], focus?: string) => void;
    /** Change the open macro and save. `focus` names the `[data-fk]` control that keeps the focus. */
    readonly edit: (change: (m: DraftMacro) => DraftMacro, focus?: string) => void;
    readonly editStep: (index: number, change: (step: DraftStep) => DraftStep, focus?: string) => void;
    /** What the server would drop from the open macro, said as a warning. */
    readonly note: string | null;
    readonly atStepLimit: boolean;
    readonly atMacroLimit: boolean;
    readonly canRun: boolean;
}

export function useMacroEditor({ session, confirmDelete, onRun, scope, openFirst }: MacroEditorOptions): MacroEditor {
    const queryClient = useQueryClient();
    const [draft, setDraft] = useState<readonly DraftMacro[] | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const latest = useRef<readonly DraftMacro[]>([]);
    const focusKey = useRef<string | null>(null);
    const scopeRef = useRef(scope);
    scopeRef.current = scope;

    // An editor opened just after an edit reads the list only once that edit has landed, and
    // reads it from the server rather than trusting a cache that edit may have outdated.
    useEffect(() => {
        let on = true;
        void saveChain
            .then(() => queryClient.fetchQuery({ queryKey: macrosKey, queryFn: ({ signal }) => runApi(listMacros(), signal), staleTime: 0 }))
            .then(
                (macros) => {
                    if (!on) return;
                    const initial = fromStored(macros);
                    latest.current = initial;
                    setDraft(initial);
                    setSelected(openFirst ? (initial[0]?.id ?? null) : null);
                },
                (e: unknown) => {
                    if (on) setLoadError(failureText(e));
                },
            );
        return () => {
            on = false;
        };
    }, [queryClient, openFirst]);

    // Focus follows the control that moved (a reordered step, a chosen icon), not the one that was there.
    useLayoutEffect(() => {
        const key = focusKey.current;
        if (!key) return;
        focusKey.current = null;
        const root = scopeRef.current();
        const find = (k: string): HTMLElement | null => root?.querySelector<HTMLElement>(`[data-fk="${k}"]`) ?? null;
        let el = find(key);
        // A move can push the step or macro to an end, which disables the arrow that got it there: the opposite one is still under the finger.
        if (el instanceof HTMLButtonElement && el.disabled && /^([un]\d+|m[ud])$/.test(key)) {
            el = find(/^m/.test(key) ? (key === "mu" ? "md" : "mu") : `${key[0] === "u" ? "n" : "u"}${key.slice(1)}`);
        }
        if (el && !(el instanceof HTMLButtonElement && el.disabled)) {
            el.focus();
            if (el instanceof HTMLInputElement && el.type === "text") el.select();
        }
    });

    const save = useCallback(
        (next: readonly DraftMacro[]): void => {
            latest.current = next;
            const version = ++saveVersion;
            saveChain = saveChain.then(async () => {
                // A newer edit is queued behind this one: it will send the later draft.
                if (version !== saveVersion) return;
                try {
                    const result = await runApi(replaceMacros(persistable(latest.current)));
                    queryClient.setQueryData(macrosKey, result);
                } catch (e) {
                    session.notices.notify({ text: `Could not save macros: ${failureText(e)}`, error: true });
                }
            });
        },
        [queryClient, session.notices],
    );

    const apply = useCallback(
        (next: readonly DraftMacro[], focus?: string): void => {
            if (focus) focusKey.current = focus;
            setDraft(next);
            save(next);
        },
        [save],
    );

    const list: readonly DraftMacro[] = draft ?? [];
    const macro = list.find((m) => m.id === selected) ?? null;

    const add = (): void => {
        const base = newMacro(session.clock.now());
        let id = base.id;
        for (let n = 2; list.some((m) => m.id === id); n++) id = `${base.id}-${n}`;
        const next = [...list, { ...base, id }];
        setDraft(next);
        latest.current = next;
        setSelected(id);
        // Into the name, selected: the label is a placeholder and the first thing anyone does is replace it.
        focusKey.current = "name";
        // Not saved yet: a step with no key is dropped by the server, so it only persists once it does something.
    };

    const remove = async (target: DraftMacro): Promise<void> => {
        if (!(await confirmDelete(target))) return;
        const next = list.filter((m) => m.id !== target.id);
        // The dialog's two panes keep one open; a page returns to its list.
        setSelected(openFirst ? (next[0]?.id ?? null) : null);
        // The last one going takes the form (and the button just pressed) with it: land on New macro.
        apply(next, next.length === 0 ? "new" : undefined);
    };

    const run = (target: DraftMacro): void => {
        const [ready] = persistable([target]);
        if (!ready) return;
        onRun?.();
        void session.macros.run(ready);
    };

    const edit = (change: (m: DraftMacro) => DraftMacro, focus?: string): void => {
        if (!macro) return;
        apply(updateMacro(list, macro.id, change), focus);
    };

    const editStep = (index: number, change: (step: DraftStep) => DraftStep, focus?: string): void =>
        edit((m) => updateStep(m, index, change), focus);

    return {
        ready: draft !== null,
        loadError,
        list,
        selected,
        select: setSelected,
        macro,
        add,
        remove,
        run,
        apply,
        edit,
        editStep,
        note: macro ? unsavedNote(macro) : null,
        atStepLimit: !!macro && macro.steps.length >= MACRO_LIMITS.steps,
        atMacroLimit: list.length >= MACRO_LIMITS.macros,
        canRun: macroWouldPersist(macro),
    };
}
