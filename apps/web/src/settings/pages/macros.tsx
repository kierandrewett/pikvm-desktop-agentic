/**
 * Settings -> Macros: the macro manager drawn as Settings pages. A list of the saved macros, and one macro's editor
 * under it with the way back. The state, the saves and the rules are the KVM screen's manager (the shared
 * use-macro-editor.ts), so what either does to the list the other sees.
 */

import { macroGlyph, MACRO_MODS, macroKeyGroups } from "@pikvm/kvm-engine";
import { Plus, Trash } from "@pikvm/icons";
import {
    Button,
    ConfirmDialog,
    DangerZone,
    EmptyState,
    fieldClass,
    IconButton,
    LinkRow,
    Notice,
    NumberField,
    SettingRow,
    SettingsCard,
    SettingsPage,
    SettingsSection,
    Switch,
    TextField,
    toast,
} from "@pikvm/chat-web/settings";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useMacroEditor } from "../../kvm/dialogs/use-macro-editor";
import {
    DEFAULT_DELAY_MS,
    isPinned,
    MACRO_LIMITS,
    moveMacro,
    moveStep,
    newStep,
    removeStep,
    toggleMod,
    type DraftMacro,
    type DraftStep,
} from "../../kvm/dialogs/model/macros";
import { MACRO_ICON_NAMES, MacroIcon } from "../../kvm/macro-icon";
import { useAppKvmSession, useSessionReady } from "../../kvm/session";
import type { KvmSession } from "../../kvm/session";
import { useStore } from "../../kvm/use-store";

const DESCRIPTION = "Key sequences you can run on the target from the KVM screen's toolbar.";

/** The KVM screen's notices ("Could not save macros") shown as this page's toasts. */
function useNoticeToasts(session: KvmSession): void {
    const notice = useStore(session.notices.store);
    useEffect(() => {
        if (!notice.show || !notice.text) return;
        if (notice.error) toast.error(notice.text, { id: "macro-notice" });
        else toast.info(notice.text, { id: "macro-notice" });
    }, [notice.show, notice.text, notice.error]);
}

const describeMacro = (macro: DraftMacro): string => {
    const steps = `${macro.steps.length} step${macro.steps.length === 1 ? "" : "s"}`;
    return isPinned(macro) ? `${steps}, on the toolbar` : steps;
};

const tile =
    "inline-flex size-10 items-center justify-center rounded-lg border border-default text-text outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-checked:border-accent aria-checked:bg-accent-bg aria-checked:text-accent-text hover-device:hover:bg-hover pointer-coarse:size-11 [&_svg]:size-[18px] text-xs font-semibold";

export function MacrosPage() {
    const session = useAppKvmSession();
    // Running a macro from here needs the link to the target, as it does on the KVM screen.
    useSessionReady(session);
    useNoticeToasts(session);

    const root = useRef<HTMLDivElement>(null);
    const [asking, setAsking] = useState<{ target: DraftMacro; answer: (ok: boolean) => void } | null>(null);
    const pending = useRef<((ok: boolean) => void) | null>(null);
    // A page that goes away with the question open answers it "no", so nothing waits forever.
    useEffect(() => () => pending.current?.(false), []);

    const editor = useMacroEditor({
        session,
        openFirst: false,
        scope: () => root.current,
        confirmDelete: (target) =>
            // Executor form on purpose: Promise.withResolvers is iOS 17.4+ and this runs on phones.
            new Promise<boolean>((resolve) => {
                const answer = (ok: boolean) => {
                    pending.current = null;
                    setAsking(null);
                    resolve(ok);
                };
                pending.current = answer;
                setAsking({ target, answer });
            }),
    });
    const { ready, loadError, list, macro, select, add, remove, run, apply, edit, editStep, note } = editor;

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

    const confirm = (
        <ConfirmDialog
            open={asking !== null}
            onOpenChange={(open) => {
                if (!open) asking?.answer(false);
            }}
            title={asking ? `Delete the macro \u201c${asking.target.label}\u201d?` : ""}
            description="This removes it from the list and the toolbar."
            confirmLabel="Delete macro"
            danger
            onConfirm={() => asking?.answer(true)}
        />
    );

    if (!ready) {
        return (
            <SettingsPage title="Macros" description={DESCRIPTION}>
                <SettingsSection>
                    <SettingsCard>
                        {loadError !== null ? (
                            <EmptyState>{`Could not load macros: ${loadError}`}</EmptyState>
                        ) : (
                            <EmptyState loading>{"Loading\u2026"}</EmptyState>
                        )}
                    </SettingsCard>
                </SettingsSection>
            </SettingsPage>
        );
    }

    if (!macro) {
        return (
            <SettingsPage
                title="Macros"
                description={DESCRIPTION}
                // With no macros the empty state carries the one New macro; two buttons of one name would be noise.
                actions={[
                    list.length > 0 && {
                        label: "New macro",
                        icon: <Plus />,
                        onSelect: add,
                        disabled: editor.atMacroLimit,
                    },
                ]}
            >
                <SettingsSection>
                    <SettingsCard>
                        {list.length === 0 ? (
                            <EmptyState
                                size="block"
                                title="No macros yet"
                                action={{ label: "New macro", onClick: add }}
                            >
                                A macro sends a sequence of keys, text and pauses to the target with one tap.
                            </EmptyState>
                        ) : (
                            list.map((m) => (
                                <LinkRow
                                    key={m.id}
                                    id={`macro-${m.id}`}
                                    icon={
                                        <span className="inline-flex size-9 items-center justify-center rounded-lg bg-soft text-text [&_svg]:size-[18px]">
                                            <MacroIcon macro={m} />
                                        </span>
                                    }
                                    label={m.label}
                                    description={describeMacro(m)}
                                    onClick={() => select(m.id)}
                                />
                            ))
                        )}
                    </SettingsCard>
                </SettingsSection>
                {confirm}
            </SettingsPage>
        );
    }

    const iconSet = !!macro.icon && macro.icon.trim() !== "";
    const knownIcon = !!macro.icon && MACRO_ICON_NAMES.includes(macro.icon);
    const first = list[0]?.id === macro.id;
    const last = list[list.length - 1]?.id === macro.id;

    return (
        <SettingsPage title={macro.label} back={{ label: "Macros", onClick: () => select(null) }}>
            <div ref={root} className="contents">
                <SettingsSection>
                    <SettingsCard>
                        <SettingRow
                            id="macro-name"
                            label="Name"
                            control={
                                <TextField
                                    key={macro.id}
                                    data-fk="name"
                                    label="Name"
                                    value={macro.label}
                                    maxLength={MACRO_LIMITS.label}
                                    onCommit={(value) => edit((m) => ({ ...m, label: value.trim() || "Macro" }))}
                                />
                            }
                        />
                        <SettingRow
                            id="macro-icon"
                            label="Icon"
                            description="Shown on the toolbar and in the menu."
                            stack
                            control={
                                <div
                                    role="radiogroup"
                                    aria-label="Icon"
                                    onKeyDown={onIconKey}
                                    className="flex w-full flex-wrap gap-1.5"
                                >
                                    {/* The state every macro starts in, previewed as what the toolbar would draw. */}
                                    <button
                                        type="button"
                                        role="radio"
                                        className={tile}
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
                                            className={tile}
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
                            }
                        />
                        <SettingRow
                            id="macro-pinned"
                            label="Pin to the toolbar and menu"
                            control={
                                <Switch
                                    label="Pin to the toolbar and menu"
                                    checked={isPinned(macro)}
                                    onChange={(pinned) => edit((m) => ({ ...m, pinned }))}
                                />
                            }
                        />
                    </SettingsCard>
                </SettingsSection>

                <SettingsSection title="Steps">
                    <SettingsCard>
                        {macro.steps.length === 0 ? <EmptyState>No steps yet. Add one below.</EmptyState> : null}
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
                    </SettingsCard>
                    {note ? (
                        <div data-testid="macro-unsaved">
                            <Notice tone="warning">{note}</Notice>
                        </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                        {(["chord", "text", "delay"] as const).map((kind) => (
                            <Button
                                key={kind}
                                disabled={editor.atStepLimit}
                                onClick={() =>
                                    edit(
                                        (m) => ({ ...m, steps: [...m.steps, newStep(kind)] }),
                                        `${kind === "chord" ? "k" : kind === "text" ? "t" : "d"}${macro.steps.length}`,
                                    )
                                }
                            >
                                <Plus />
                                {kind === "chord" ? "Add key combo" : kind === "text" ? "Add text" : "Add pause"}
                            </Button>
                        ))}
                    </div>
                </SettingsSection>

                <SettingsSection title="Run">
                    <SettingsCard>
                        <SettingRow
                            id="macro-run"
                            label="Run on the target"
                            description="Sends the steps now, over the link to the target."
                            control={
                                <Button variant="primary" disabled={!editor.canRun} onClick={() => run(macro)}>
                                    Run
                                </Button>
                            }
                        />
                        {/* The list's order is the order of the pinned tiles, so it can be changed here. */}
                        {list.length > 1 ? (
                            <SettingRow
                                id="macro-order"
                                label="Position in the list"
                                description="The list's order is the order of the pinned tiles."
                                control={
                                    <div className="flex flex-wrap justify-end gap-2">
                                        <Button data-fk="mu" disabled={first} onClick={() => apply(moveMacro(list, macro.id, -1), "mu")}>
                                            Move up the list
                                        </Button>
                                        <Button data-fk="md" disabled={last} onClick={() => apply(moveMacro(list, macro.id, 1), "md")}>
                                            Move down the list
                                        </Button>
                                    </div>
                                }
                            />
                        ) : null}
                    </SettingsCard>
                </SettingsSection>

                <DangerZone>
                    <SettingRow
                        id="macro-delete"
                        label="Delete this macro"
                        description="This removes it from the list and the toolbar."
                        control={
                            <Button variant="danger" onClick={() => void remove(macro)}>
                                <Trash />
                                Delete macro
                            </Button>
                        }
                    />
                </DangerZone>
                {confirm}
            </div>
        </SettingsPage>
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

const KIND = { chord: "Keys", text: "Text", delay: "Pause" } as const;

function StepRow({ step, index, count, onChange, onMove, onRemove }: StepRowProps) {
    const n = index + 1;
    const groups = macroKeyGroups();
    return (
        <SettingRow
            id={`macro-step-${index}`}
            label={`${n}. ${KIND[step.type]}`}
            stack
            className="[&_[data-row-control]]:items-start"
            control={
                <div className="flex w-full flex-wrap items-center gap-2" data-testid={`macro-step-${index}`}>
                    {step.type === "chord" ? (
                        <>
                            <div role="group" aria-label={`Modifier keys for step ${n}`} className="flex flex-wrap gap-1.5">
                                {MACRO_MODS.map(([code, label]) => {
                                    const on = step.mods.includes(code);
                                    return (
                                        <Button
                                            key={code}
                                            variant={on ? "primary" : "secondary"}
                                            role="switch"
                                            aria-checked={on}
                                            data-fk={`m${index}:${code}`}
                                            onClick={() => onChange((s) => (s.type === "chord" ? toggleMod(s, code) : s), `m${index}:${code}`)}
                                        >
                                            {label}
                                        </Button>
                                    );
                                })}
                            </div>
                            <select
                                className={`${fieldClass("md")} min-w-0 flex-1 basis-40`}
                                aria-label={`Key for step ${n}`}
                                data-fk={`k${index}`}
                                value={step.code}
                                onChange={(e) => onChange((s) => (s.type === "chord" ? { ...s, code: e.target.value } : s))}
                            >
                                <option value="">{"Choose a key\u2026"}</option>
                                {groups.map(([group, keys]) => (
                                    <optgroup key={group} label={group}>
                                        {keys.map(([code, label]) => (
                                            <option key={code} value={code}>
                                                {label}
                                            </option>
                                        ))}
                                    </optgroup>
                                ))}
                                {/* A macro written by hand or by the agent can hold a code the list does not carry. */}
                                {step.code && !groups.some(([, keys]) => keys.some(([code]) => code === step.code)) ? (
                                    <option value={step.code}>{step.code}</option>
                                ) : null}
                            </select>
                        </>
                    ) : step.type === "text" ? (
                        <TextField
                            data-fk={`t${index}`}
                            label={`Text for step ${n}`}
                            value={step.text}
                            maxLength={MACRO_LIMITS.text}
                            onCommit={(value) => onChange((s) => (s.type === "text" ? { ...s, text: value } : s))}
                        />
                    ) : (
                        <NumberField
                            label={`Pause for step ${n}, milliseconds`}
                            value={step.ms}
                            unit="ms"
                            onCommit={(value) =>
                                onChange((s) =>
                                    s.type === "delay"
                                        ? { ...s, ms: Math.min(MACRO_LIMITS.delayMax, Math.max(1, Math.round(value) || DEFAULT_DELAY_MS)) }
                                        : s,
                                )
                            }
                        />
                    )}
                    <div className="ms-auto flex items-center gap-1">
                        {/* Nothing to reorder in a one-step macro, and a permanently disabled arrow pair reads as a fault. */}
                        {count > 1 ? (
                            <>
                                <IconButton
                                    data-fk={`u${index}`}
                                    aria-label={`Move step ${n} up`}
                                    disabled={index === 0}
                                    onClick={() => onMove(-1)}
                                >
                                    {"\u2191"}
                                </IconButton>
                                <IconButton
                                    data-fk={`n${index}`}
                                    aria-label={`Move step ${n} down`}
                                    disabled={index === count - 1}
                                    onClick={() => onMove(1)}
                                >
                                    {"\u2193"}
                                </IconButton>
                            </>
                        ) : null}
                        <IconButton data-fk={`r${index}`} aria-label={`Remove step ${n}`} onClick={onRemove}>
                            <Trash />
                        </IconButton>
                    </div>
                </div>
            }
        />
    );
}
