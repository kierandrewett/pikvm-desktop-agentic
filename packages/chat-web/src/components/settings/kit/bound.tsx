/**
 * Rows bound to a setting key.
 *
 * - `KeyRow` binds a user key (`/api/settings`, relative to the user); `AdminKeyRow` binds a full key
 *   (`/api/admin/settings`). Both render a SettingRow with the registry description, a lock icon when the value
 *   cannot be changed here, a reset button when this scope holds its own value, and a Saving/Saved/error status.
 * - With `control` omitted the control is inferred from the key's zod schema in `@chat/protocol`, so a new key
 *   needs only a label to appear.
 * - `RawKeyRow` edits any key as validated JSON: the "Advanced" home for keys without a dedicated control.
 * The row anchor id defaults to the setting key (`/settings/<page>#ui.density`).
 */
import { getDef } from "@pikvm/chat-protocol";
import { useEffect, useState, type ReactNode } from "react";
import { erase, fieldBinding, useAdminSetting, useUserSetting, type Binding } from "../bindings";
import { findCategory, findRow } from "../registry";
import { useT } from "../../../l10n/provider";
import { msg, translate } from "../../../l10n/runtime";
import { cn } from "../../../lib/cn";
import { flushEditor, ListEditor, NumberField, Segmented, Select, Switch, TextField, type Option } from "./controls";
import { Button, useSaveStatus } from "./feedback";
import { AdvancedSection, Described, SettingRow, SettingsCard } from "./layout";

// Schema introspection

export type Kind =
    | { type: "boolean" }
    | { type: "enum"; options: string[] }
    | { type: "number"; min?: number; max?: number; int: boolean }
    | { type: "string"; url: boolean }
    | { type: "stringList" }
    | { type: "object"; fields: { name: string; kind: Kind }[] }
    | { type: "other" };

/**
 * Structural view of a zod 4 schema. The protocol package may resolve its own copy of zod, so `instanceof` checks
 * are unreliable; `def.type` and the public getters are stable across copies.
 */
interface Introspect {
    def: {
        type: string;
        innerType?: Introspect;
        element?: Introspect;
        shape?: Record<string, Introspect>;
        entries?: Record<string, string>;
    };
    format?: string | null;
    minValue?: number | null;
    maxValue?: number | null;
    isInt?: boolean;
}

const BIG = 1e15;

export function kindOf(schema: unknown): Kind {
    if (!schema) return { type: "other" };
    let s = schema as Introspect;
    while ((s.def.type === "default" || s.def.type === "optional") && s.def.innerType) s = s.def.innerType;
    switch (s.def.type) {
        case "boolean":
            return { type: "boolean" };
        case "enum":
            return { type: "enum", options: Object.values(s.def.entries ?? {}) };
        case "number": {
            const min = s.minValue ?? undefined;
            const max = s.maxValue ?? undefined;
            return {
                type: "number",
                min: min !== undefined && min > -BIG ? min : undefined,
                max: max !== undefined && max < BIG ? max : undefined,
                int: !!s.isInt,
            };
        }
        case "string":
            return { type: "string", url: s.format === "url" };
        case "array":
            return s.def.element?.def.type === "string" ? { type: "stringList" } : { type: "other" };
        case "object":
            return {
                type: "object",
                fields: Object.entries(s.def.shape ?? {}).map(([name, f]) => ({ name, kind: kindOf(f) })),
            };
        default:
            return { type: "other" };
    }
}

export function humanise(key: string): string {
    const last = key.split(".").pop() ?? key;
    const words = last.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

// Controls

export type ControlSpec =
    | { type: "auto" }
    | { type: "toggle" }
    | { type: "select"; options: Option[] }
    | { type: "segmented"; options: Option[] }
    | { type: "text"; placeholder?: string; inputType?: "text" | "url" | "email"; mono?: boolean; list?: string }
    | { type: "number"; min?: number; max?: number; step?: number; unit?: string }
    | { type: "bytes" }
    | { type: "list"; placeholder?: string }
    | { type: "custom"; render: (b: Binding<unknown>) => ReactNode; stack?: boolean };

const enumLabel = (v: string) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : translate(msg("settings-enum-none")));

function specFor(key: string, kind: Kind): ControlSpec {
    switch (kind.type) {
        case "boolean":
            return { type: "toggle" };
        case "enum": {
            const options = kind.options.map((v) => ({ value: v, label: enumLabel(v) }));
            return options.length <= 3 ? { type: "segmented", options } : { type: "select", options };
        }
        case "number":
            if (/Bytes$/.test(key)) return { type: "bytes" };
            return { type: "number", min: kind.min, max: kind.max, step: kind.int ? 1 : 0.5 };
        case "string":
            return { type: "text", inputType: kind.url ? "url" : "text", mono: kind.url };
        case "stringList":
            return { type: "list" };
        default:
            return { type: "custom", render: () => <EditInAdvanced /> };
    }
}

function EditInAdvanced() {
    const t = useT();
    return <span className="text-xs text-tertiary">{t("settings-edit-in-advanced")}</span>;
}

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** Byte sizes shown in MB or GB. The unit only changes the display. */
export function BytesField({
    value,
    onCommit,
    label,
    disabled,
}: {
    value: number;
    onCommit: (v: number) => void;
    label: string;
    disabled?: boolean;
}) {
    const t = useT();
    const [unit, setUnit] = useState<"MB" | "GB">(value >= GB ? "GB" : "MB");
    const size = unit === "GB" ? GB : MB;
    const shown = Math.round((value / size) * 100) / 100;
    return (
        <span className="inline-flex items-center gap-1.5">
            <NumberField
                value={shown}
                onCommit={(n) => onCommit(Math.round(n * size))}
                label={t("settings-bytes-in-unit", { label, unit })}
                min={0}
                step={0.1}
                disabled={disabled}
            />
            <Segmented
                label={t("settings-bytes-unit", { label })}
                disabled={disabled}
                value={unit}
                options={[
                    { value: "MB", label: "MB" },
                    { value: "GB", label: "GB" },
                ]}
                onChange={setUnit}
            />
        </span>
    );
}

/** Registry key for a binding key: drops `users.<id>.` and any field suffix of an object key. */
function baseOf(key: string): string {
    const segs = key.split(".");
    const rest = segs[0] === "users" ? segs.slice(2) : segs;
    for (let n = rest.length; n > 0; n--) {
        const k = rest.slice(0, n).join(".");
        if (getDef(k)) return k;
    }
    return rest.join(".");
}

const resolveSpec = (b: Binding<unknown>, spec: ControlSpec): ControlSpec =>
    spec.type === "auto" ? specFor(b.key, kindOf(getDef(baseOf(b.key))?.schema)) : spec;

export function renderControl(b: Binding<unknown>, spec: ControlSpec, label: string): ReactNode {
    const disabled = !b.writable || !!b.lock;
    const s = resolveSpec(b, spec);
    switch (s.type) {
        case "auto":
            return null;
        case "toggle":
            return <Switch checked={!!b.value} onChange={b.set} disabled={disabled} label={label} />;
        case "select":
            return (
                <Select
                    value={String(b.value ?? "")}
                    options={s.options}
                    onChange={b.set}
                    disabled={disabled}
                    label={label}
                />
            );
        case "segmented":
            return (
                <Segmented
                    value={String(b.value ?? "")}
                    options={s.options}
                    onChange={b.set}
                    disabled={disabled}
                    label={label}
                />
            );
        case "text":
            return (
                <TextField
                    value={String(b.value ?? "")}
                    onCommit={b.set}
                    label={label}
                    placeholder={s.placeholder}
                    type={s.inputType}
                    mono={s.mono}
                    list={s.list}
                    disabled={disabled}
                />
            );
        case "number":
            return (
                <NumberField
                    value={typeof b.value === "number" ? b.value : undefined}
                    onCommit={b.set}
                    label={label}
                    min={s.min}
                    max={s.max}
                    step={s.step}
                    unit={s.unit}
                    disabled={disabled}
                />
            );
        case "bytes":
            return <BytesField value={Number(b.value ?? 0)} onCommit={b.set} label={label} disabled={disabled} />;
        case "list":
            return (
                <ListEditor
                    value={Array.isArray(b.value) ? (b.value as string[]) : []}
                    onChange={b.set}
                    label={label}
                    placeholder={s.placeholder}
                    disabled={disabled}
                />
            );
        case "custom":
            return s.render(b);
    }
}

export interface BoundRowProps {
    /** Defaults to the row's label in registry.ts (looked up by `id`). */
    label?: string;
    /** Defaults to the row's description in registry.ts, then the setting's description. Pass "" for none. */
    description?: ReactNode;
    control?: ControlSpec;
    /** Anchor id; defaults to the setting key. */
    id?: string;
    /** Label of the reset button ("Use global value" for per-user overrides). */
    resetLabel?: string;
    /** Hide the per-row reset (pages with their own "Reset to default"). */
    noReset?: boolean;
    /** Short live note under the description. */
    hint?: ReactNode;
}

/**
 * Label and description for a bound row: explicit props win, then registry.ts, then the setting definition.
 * A registry row with `description: ""` shows none.
 */
function rowText(id: string, key: string, label: string | undefined, description: ReactNode | undefined) {
    const reg = findRow(id)?.row;
    const def = getDef(key);
    const regDesc = reg?.description;
    const desc =
        description !== undefined ? (
            description
        ) : regDesc !== undefined ? (
            regDesc
        ) : def ? (
            <Described text={def.description} />
        ) : undefined;
    return { label: label ?? reg?.label ?? humanise(id), description: desc || undefined };
}

export function BoundRow({
    binding,
    label,
    description,
    control = { type: "auto" },
    id,
    resetLabel,
    noReset,
    hint,
}: BoundRowProps & { binding: Binding<unknown> }) {
    const rowId = id ?? baseOf(binding.key);
    const text = rowText(rowId, baseOf(binding.key), label, description);
    const s = resolveSpec(binding, control);
    const stack = s.type === "list" || (s.type === "custom" && !!s.stack);
    const status = useSaveStatus(binding.pending, binding.error);
    return (
        <SettingRow
            id={rowId}
            label={text.label}
            description={text.description}
            hint={hint}
            lock={binding.lock}
            status={status}
            stack={stack}
            reset={binding.reset && !noReset ? { label: resetLabel, onReset: binding.reset } : undefined}
            control={
                binding.loading ? (
                    <span className="h-7 w-16 rounded-full bg-soft" aria-hidden />
                ) : (
                    renderControl(binding, control, text.label)
                )
            }
        />
    );
}

/** A row bound to the current user's setting `k`. */
export function KeyRow<T>(props: BoundRowProps & { k: string }) {
    const b = useUserSetting<T>(props.k);
    return <BoundRow binding={erase(b)} {...props} />;
}

/** A row bound to a full key through the admin API. */
export function AdminKeyRow(props: BoundRowProps & { k: string }) {
    const b = useAdminSetting<unknown>(props.k);
    return <BoundRow binding={b} {...props} />;
}

/** Field of an object-valued key. Label and description default to the registry row `<key>.<field>`. */
export interface ObjectField {
    label?: string;
    description?: ReactNode;
    control?: ControlSpec;
}

/** Fields have no setting description of their own: without a registry description they show none. */
const fieldDescription = (id: string, d: ReactNode | undefined) => d ?? findRow(id)?.row.description ?? "";

/** One row per field of an object-valued key (for example `auth.passkey`). Field controls come from the field schemas. */
export function AdminObjectRows({ k, fields }: { k: string; fields: Record<string, ObjectField> }) {
    const b = useAdminSetting<Record<string, unknown>>(k);
    const kind = kindOf(getDef(k)?.schema);
    if (kind.type !== "object") return null;
    return (
        <>
            {kind.fields
                .filter((f) => fields[f.name])
                .map((f) => {
                    const meta = fields[f.name]!;
                    return (
                        <BoundRow
                            key={f.name}
                            id={`${k}.${f.name}`}
                            binding={erase(fieldBinding(b, f.name))}
                            label={meta.label}
                            description={fieldDescription(`${k}.${f.name}`, meta.description)}
                            control={meta.control ?? specFor(f.name, f.kind)}
                        />
                    );
                })}
        </>
    );
}

/** Same for a user key with an object value (for example `agent.memory`). */
export function UserObjectRows({
    k,
    fields,
}: {
    k: string;
    fields: Record<string, ObjectField & { disabled?: boolean }>;
}) {
    const b = useUserSetting<Record<string, unknown>>(k);
    const kind = kindOf(getDef(k)?.schema);
    if (kind.type !== "object") return null;
    return (
        <>
            {kind.fields
                .filter((f) => fields[f.name])
                .map((f) => {
                    const meta = fields[f.name]!;
                    const fb = erase(fieldBinding(b, f.name));
                    return (
                        <BoundRow
                            key={f.name}
                            id={`${k}.${f.name}`}
                            binding={meta.disabled ? { ...fb, writable: false } : fb}
                            label={meta.label}
                            description={fieldDescription(`${k}.${f.name}`, meta.description)}
                            control={meta.control ?? specFor(f.name, f.kind)}
                        />
                    );
                })}
        </>
    );
}

/**
 * Edit a key as JSON, validated against its schema before saving. Secrets stay masked ("********") and round-trip.
 * `scope="admin"` edits the full key through the admin API.
 */
export function RawKeyRow({ k, scope = "user", label }: { k: string; scope?: "user" | "admin"; label?: string }) {
    const t = useT();
    // Scope is fixed per mounted row, so the hook order is stable.
    const b = scope === "admin" ? useAdminSetting<unknown>(k) : useUserSetting<unknown>(k);
    const def = getDef(baseOf(k));
    // The row's own short description, never the schema text (that feeds docs/settings.md).
    const own = findRow(k)?.row.description;
    const text = JSON.stringify(b.value ?? null, null, 2);
    const [draft, setDraft] = useState(text);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const dirty = editing && draft !== text;
    useEffect(() => {
        if (!editing) setDraft(text);
    }, [text, editing]);
    const status = useSaveStatus(b.pending, b.error);
    const save = async () => {
        if (!b.writable || b.pending) return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(draft);
        } catch (e) {
            return setError(t("settings-json-invalid", { message: (e as Error).message }));
        }
        const r = def?.schema.safeParse(parsed);
        if (r && !r.success) {
            const i = r.error.issues[0];
            return setError(i ? `${i.path.join(".") || "value"}: ${i.message}` : t("settings-json-invalid-value"));
        }
        setError(null);
        try {
            await b.setAsync(parsed);
            setEditing(false);
        } catch {
            // Keep the draft after a failed save. The binding displays the server error.
        }
    };
    return (
        <SettingRow
            id={k}
            stack
            label={label ?? findRow(k)?.row.label ?? humanise(k)}
            description={
                <>
                    <code className="font-mono">{k}</code>
                    {own && <> {own}</>}
                </>
            }
            lock={b.lock}
            status={status}
            error={error}
            reset={b.reset ? { onReset: b.reset } : undefined}
            control={
                <div className="flex w-full flex-col gap-2">
                    <textarea
                        aria-label={t("settings-json-label", { label: label ?? k })}
                        value={draft}
                        spellCheck={false}
                        autoCapitalize="none"
                        autoCorrect="off"
                        disabled={!b.writable}
                        rows={Math.min(12, Math.max(2, draft.split("\n").length))}
                        onChange={(e) => {
                            setEditing(true);
                            setDraft(e.target.value);
                        }}
                        className={cn(flushEditor, "font-mono text-xs leading-5")}
                    />
                    {dirty && (
                        <div className="flex justify-end gap-2">
                            <Button
                                disabled={b.pending}
                                onClick={() => {
                                    setDraft(text);
                                    setEditing(false);
                                    setError(null);
                                }}
                            >
                                {t("settings-cancel")}
                            </Button>
                            <Button
                                variant="primary"
                                busy={b.pending}
                                disabled={!b.writable}
                                onClick={() => void save()}
                            >
                                {t("settings-save")}
                            </Button>
                        </div>
                    )}
                </div>
            }
        />
    );
}
