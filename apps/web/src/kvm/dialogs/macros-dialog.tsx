/**
 * The macro manager and editor as a dialog on the KVM screen: a list on one side, the selected macro on the
 * other (a strip above it on a phone). The state, the saves and the rules are the editor's (use-macro-editor.ts),
 * which Settings > Macros draws as a page too; only the frame and the controls differ.
 */

import { macroGlyph, MACRO_MODS, macroKeyGroups } from "@pikvm/kvm-engine";
import { type KeyboardEvent, useRef } from "react";
import type { DialogProps } from "../dialog-seam";
import { MACRO_ICON_NAMES, MacroIcon } from "../macro-icon";
import {
    DEFAULT_DELAY_MS,
    isPinned,
    MACRO_LIMITS,
    moveMacro,
    moveStep,
    newStep,
    removeStep,
    toggleMod,
    type DraftStep,
} from "./model/macros";
import { Btn, CommitInput, DialogShell, Note, useConfirm } from "./shell";
import { useMacroEditor } from "./use-macro-editor";

export function MacrosDialog({ session, onClose }: DialogProps) {
    const confirm = useConfirm();
    const body = useRef<HTMLDivElement>(null);
    const editor = useMacroEditor({
        session,
        openFirst: true,
        scope: () => body.current?.closest(".dlg") ?? null,
        onRun: onClose,
        confirmDelete: (target) =>
            confirm.ask({
                title: `Delete the macro "${target.label}"?`,
                body: "This removes it from the list and the toolbar.",
                confirm: "Delete macro",
                danger: true,
            }),
    });
    const { ready, loadError, list, selected, select, macro, add, remove, run, apply, edit, editStep, note, atStepLimit } =
        editor;

    const onIconKey = (e: KeyboardEvent<HTMLDivElement>): void => {
        if (e.altKey || e.ctrlKey || e.metaKey || !macro) return;
        const names = ["", ...MACRO_ICON_NAMES];
        const current = names.indexOf(macro.icon && names.includes(macro.icon) ? macro.icon : "");
        let next = -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (current + 1) % names.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (current - 1 + names.length) % names.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = names.length - 1;
        if (next < 0) return;
        e.preventDefault();
        const name = names[next] ?? "";
        // Arrows move the selection, not just focus: that is what a radiogroup does.
        edit((m) => ({ ...m, icon: name }), `icon:${name}`);
    };

    const iconSet = !!macro?.icon && macro.icon.trim() !== "";
    const knownIcon = !!macro?.icon && MACRO_ICON_NAMES.includes(macro.icon);

    return (
        <>
            <DialogShell
                title="Macros"
                size="full"
                onClose={onClose}
                testId="macros-dialog"
                initialFocus="[data-fk='first']"
                startActions={
                    <Btn data-fk="new" disabled={!ready || editor.atMacroLimit} onClick={add}>
                        New macro
                    </Btn>
                }
                actions={
                    <Btn variant="primary" onClick={onClose}>
                        Done
                    </Btn>
                }
            >
                <div className="macro-body" ref={body}>
                    <div className="macro-list" role="group" aria-label="Saved macros">
                        {ready && list.length === 0 ? <p className="dlg-note">No macros yet.</p> : null}
                        {list.map((m, i) => (
                            <button
                                key={m.id}
                                type="button"
                                data-fk={i === 0 ? "first" : undefined}
                                aria-current={m.id === selected ? "true" : undefined}
                                onClick={() => select(m.id)}
                            >
                                {m.icon && MACRO_ICON_NAMES.includes(m.icon) ? (
                                    <span className="macro-row-icon" aria-hidden="true">
                                        <MacroIcon macro={m} />
                                    </span>
                                ) : null}
                                {m.label}
                            </button>
                        ))}
                    </div>

                    <div className="macro-edit">
                        {!ready ? (
                            <Note live>{loadError !== null ? `Could not load macros: ${loadError}` : "Loading"}</Note>
                        ) : !macro ? (
                            <Note>{list.length > 0 ? "Select a macro to edit it." : "Use New macro to add one."}</Note>
                        ) : (
                            <>
                                <div className="dlg-row stack">
                                    <span className="dlg-label">Name</span>
                                    <CommitInput
                                        key={macro.id}
                                        data-fk="name"
                                        label="Name"
                                        value={macro.label}
                                        maxLength={MACRO_LIMITS.label}
                                        className="dlg-text dlg-grow"
                                        onCommit={(value) => edit((m) => ({ ...m, label: value.trim() || "Macro" }))}
                                    />
                                </div>
                                <div className="dlg-section">
                                    <span className="dlg-label" id="macro-icons-label">
                                        Icon
                                    </span>
                                    <div
                                        className="macro-icons"
                                        role="radiogroup"
                                        aria-labelledby="macro-icons-label"
                                        onKeyDown={onIconKey}
                                    >
                                        {/* The state every macro starts in, previewed as what the toolbar would draw. */}
                                        <button
                                            type="button"
                                            role="radio"
                                            className="macro-icon"
                                            aria-checked={!iconSet}
                                            aria-label="No icon"
                                            title="No icon"
                                            data-fk="icon:"
                                            tabIndex={!iconSet || (iconSet && !knownIcon) ? 0 : -1}
                                            onClick={() => edit((m) => ({ ...m, icon: "" }))}
                                        >
                                            {macroGlyph({ icon: "", label: macro.label })}
                                        </button>
                                        {MACRO_ICON_NAMES.map((name) => (
                                            <button
                                                key={name}
                                                type="button"
                                                role="radio"
                                                className="macro-icon"
                                                aria-checked={macro.icon === name}
                                                aria-label={name}
                                                title={name}
                                                data-fk={`icon:${name}`}
                                                tabIndex={macro.icon === name ? 0 : -1}
                                                onClick={() => edit((m) => ({ ...m, icon: name }))}
                                            >
                                                <MacroIcon macro={{ icon: name, label: name }} />
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <label className="dlg-check">
                                    <input
                                        type="checkbox"
                                        checked={isPinned(macro)}
                                        onChange={(e) => edit((m) => ({ ...m, pinned: e.target.checked }))}
                                    />
                                    Pin to the toolbar and menu
                                </label>

                                <div className="macro-steps" role="list" aria-label="Steps">
                                    {macro.steps.map((step, index) => (
                                        <StepRow
                                            // The index is the identity: steps have none, and edits keep the order.
                                            key={`${macro.id}:${index}`}
                                            step={step}
                                            index={index}
                                            count={macro.steps.length}
                                            onChange={(change, focus) => editStep(index, change, focus)}
                                            onMove={(delta) =>
                                                edit((m) => moveStep(m, index, delta), `${delta < 0 ? "u" : "n"}${index + delta}`)
                                            }
                                            onRemove={() =>
                                                edit((m) => removeStep(m, index), `r${Math.max(0, Math.min(index, macro.steps.length - 2))}`)
                                            }
                                        />
                                    ))}
                                </div>
                                {note ? (
                                    <p className="dlg-note is-warn" data-testid="macro-unsaved">
                                        {note}
                                    </p>
                                ) : null}

                                <div className="macro-step-add">
                                    {(["chord", "text", "delay"] as const).map((kind) => (
                                        <Btn
                                            key={kind}
                                            disabled={atStepLimit}
                                            onClick={() =>
                                                edit(
                                                    (m) => ({ ...m, steps: [...m.steps, newStep(kind)] }),
                                                    `${kind === "chord" ? "k" : kind === "text" ? "t" : "d"}${macro.steps.length}`,
                                                )
                                            }
                                        >
                                            {kind === "chord" ? "Add key combo" : kind === "text" ? "Add text" : "Add pause"}
                                        </Btn>
                                    ))}
                                </div>
                                <div className="dlg-row wrap">
                                    <Btn variant="primary" disabled={!editor.canRun} onClick={() => run(macro)}>
                                        Run
                                    </Btn>
                                    {/* The list's order is the order of the pinned tiles, so it can be changed here. */}
                                    {list.length > 1 ? (
                                        <>
                                            <Btn
                                                data-fk="mu"
                                                disabled={list[0]?.id === macro.id}
                                                onClick={() => apply(moveMacro(list, macro.id, -1), "mu")}
                                            >
                                                Move up the list
                                            </Btn>
                                            <Btn
                                                data-fk="md"
                                                disabled={list[list.length - 1]?.id === macro.id}
                                                onClick={() => apply(moveMacro(list, macro.id, 1), "md")}
                                            >
                                                Move down the list
                                            </Btn>
                                        </>
                                    ) : null}
                                    {/* Destructive, and apart from the buttons that add. */}
                                    <Btn variant="danger" style={{ marginLeft: "auto" }} onClick={() => void remove(macro)}>
                                        Delete macro
                                    </Btn>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </DialogShell>
            {confirm.element}
        </>
    );
}

interface StepRowProps {
    readonly step: DraftStep;
    readonly index: number;
    readonly count: number;
    readonly onChange: (change: (step: DraftStep) => DraftStep, focus?: string) => void;
    readonly onMove: (delta: -1 | 1) => void;
    readonly onRemove: () => void;
}

function StepRow({ step, index, count, onChange, onMove, onRemove }: StepRowProps) {
    const n = index + 1;
    return (
        <div className="macro-step" role="listitem" data-testid={`macro-step-${index}`}>
            <span className="macro-kind">{step.type === "chord" ? "Keys" : step.type === "text" ? "Text" : "Pause"}</span>
            <div className="macro-step-body">
                {step.type === "chord" ? (
                    <>
                        <div className="macro-mods" role="group" aria-label={`Modifier keys for step ${n}`}>
                            {MACRO_MODS.map(([code, label]) => {
                                const on = step.mods.includes(code);
                                return (
                                    <Btn
                                        key={code}
                                        className="macro-mod"
                                        role="switch"
                                        aria-checked={on}
                                        data-fk={`m${index}:${code}`}
                                        onClick={() => onChange((s) => (s.type === "chord" ? toggleMod(s, code) : s), `m${index}:${code}`)}
                                    >
                                        {label}
                                    </Btn>
                                );
                            })}
                        </div>
                        <select
                            className="dlg-select macro-key"
                            aria-label={`Key for step ${n}`}
                            data-fk={`k${index}`}
                            value={step.code}
                            onChange={(e) => onChange((s) => (s.type === "chord" ? { ...s, code: e.target.value } : s))}
                        >
                            <option value="">{"Choose a key"}</option>
                            {macroKeyGroups().map(([group, keys]) => (
                                <optgroup key={group} label={group}>
                                    {keys.map(([code, label]) => (
                                        <option key={code} value={code}>
                                            {label}
                                        </option>
                                    ))}
                                </optgroup>
                            ))}
                            {/* A macro written by hand or by the agent can hold a code the list does not carry. */}
                            {step.code && !macroKeyGroups().some(([, keys]) => keys.some(([code]) => code === step.code)) ? (
                                <option value={step.code}>{step.code}</option>
                            ) : null}
                        </select>
                    </>
                ) : step.type === "text" ? (
                    <CommitInput
                        data-fk={`t${index}`}
                        label={`Text for step ${n}`}
                        value={step.text}
                        maxLength={MACRO_LIMITS.text}
                        className="dlg-text dlg-grow"
                        onCommit={(value) => onChange((s) => (s.type === "text" ? { ...s, text: value } : s))}
                    />
                ) : (
                    <>
                        <CommitInput
                            data-fk={`d${index}`}
                            type="number"
                            label={`Pause for step ${n}, milliseconds`}
                            value={String(step.ms)}
                            min={1}
                            max={MACRO_LIMITS.delayMax}
                            className="dlg-text"
                            onCommit={(value) =>
                                onChange((s) =>
                                    s.type === "delay"
                                        ? { ...s, ms: Math.min(MACRO_LIMITS.delayMax, Math.max(1, Math.round(Number(value)) || DEFAULT_DELAY_MS)) }
                                        : s,
                                )
                            }
                        />
                        <span className="dlg-hint">ms</span>
                    </>
                )}
            </div>
            <div className="macro-actions">
                {/* Nothing to reorder in a one-step macro, and a permanently disabled arrow pair reads as a fault. */}
                {count > 1 ? (
                    <>
                        <Btn
                            className="macro-move"
                            data-fk={`u${index}`}
                            aria-label={`Move step ${n} up`}
                            disabled={index === 0}
                            onClick={() => onMove(-1)}
                        >
                            {"\u2191"}
                        </Btn>
                        <Btn
                            className="macro-move"
                            data-fk={`n${index}`}
                            aria-label={`Move step ${n} down`}
                            disabled={index === count - 1}
                            onClick={() => onMove(1)}
                        >
                            {"\u2193"}
                        </Btn>
                    </>
                ) : null}
                <Btn data-fk={`r${index}`} aria-label={`Remove step ${n}`} onClick={onRemove}>
                    Remove
                </Btn>
            </div>
        </div>
    );
}
