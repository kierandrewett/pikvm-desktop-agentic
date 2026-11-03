/**
 * Settings controls. Every control in a row is 36px high (selects, fields, segmented tracks, buttons), so all rows
 * share one control line and one right edge. `sm` and `md` differ in text size and width, not height: `sm` is
 * the compact row family, `md` the form family (setup pages and dialogs). Everything grows to a 44px touch
 * target on coarse pointers and takes colours from tokens only.
 *
 * Controls that need room carry `data-wide` (segmented tracks, row text fields, sliders), and value pickers carry
 * `data-picker` (Select). settings.css uses these on a narrow settings column; see layout.tsx.
 *
 * Inline fields (`onCommit`) keep a local draft and write on blur or Enter, never per keystroke; Escape reverts.
 * Form fields (`onChange`) are controlled.
 */
import { CaretDown, CaretUpDown, Check, Minus, Plus, X } from "@pikvm/icons";
import {
    forwardRef,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ButtonHTMLAttributes,
    type HTMLAttributes,
    type InputHTMLAttributes,
    type ReactNode,
} from "react";
import { useT } from "../../../l10n/provider";
import { cn } from "../../../lib/cn";
import { useIsMobile } from "../../../lib/media";
import { Menu, sheetRow } from "../../ui/menu";
import { Sheet } from "../../ui/sheet";
import { Button, IconButton } from "./feedback";
import { useRowLocked } from "./lock";
import { SearchMark } from "./search";

export interface Option<T extends string = string> {
    value: T;
    label: string;
    icon?: ReactNode;
    /** Not selectable (for example an option the administrator's policy turns off). */
    disabled?: boolean;
    /** CSS font-family to render this option's label in (font pickers). */
    font?: string;
}

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const softBg = "bg-[color-mix(in_oklab,var(--text)_5%,transparent)]";

export type FieldSize = "sm" | "md";

/** Shared text field box: 36px, rounded like the selects. `sm` uses 13px text (rows), `md` 14px (forms). */
export const fieldClass = (size: FieldSize, mono?: boolean) =>
    cn(
        "border border-default bg-transparent text-text placeholder:text-tertiary outline-none focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-0",
        "aria-invalid:border-danger disabled:cursor-not-allowed disabled:opacity-60",
        "h-9 rounded-lg px-3 pointer-coarse:h-11 pointer-coarse:text-md",
        size === "sm" ? "text-sm" : "text-base",
        mono && (size === "sm" ? "font-mono text-xs" : "font-mono text-sm"),
    );

// Switch

/**
 * Switch (spec 6.2): a 32x20 track inside the button; 16px thumb at 2px (off) or 14px (on). Track colour and thumb
 * translate run 150ms cubic-bezier(0, 0, 0.2, 1). Sized like an icon, so it keeps its size at every density.
 */
export function Switch({
    checked,
    onChange,
    disabled,
    label,
}: {
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
    label: string;
}) {
    disabled = useRowLocked(disabled);
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={cn(
                "relative inline-flex shrink-0 items-center text-sm outline-none focus-visible:rounded-full focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']",
            )}
        >
            <span
                className={cn(
                    "relative inline-flex h-[20px] w-[32px] shrink-0 items-center rounded-full transition-colors duration-150 ease-[cubic-bezier(0,0,0.2,1)]",
                    checked ? "bg-accent" : "bg-[color-mix(in_oklab,var(--text)_10%,transparent)]",
                )}
            >
                <span
                    aria-hidden
                    className={cn(
                        "size-[16px] rounded-full border border-default bg-toggle-thumb shadow-toggle-thumb transition-transform duration-150 ease-[cubic-bezier(0,0,0.2,1)]",
                        checked ? "translate-x-[14px]" : "translate-x-[2px]",
                    )}
                />
            </span>
        </button>
    );
}

// Segmented

const segmentTrack = cn(
    "relative inline-flex h-9 max-w-full min-w-0 shrink-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-control-track p-1 no-scrollbar",
    "shadow-[inset_0_0_0_1px_var(--border)] pointer-coarse:h-11",
);
const segmentButton =
    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm leading-[18px] whitespace-nowrap transition-[background-color,box-shadow,color] duration-150 ease-[var(--ease-standard)] pointer-coarse:h-9 pointer-coarse:px-3 [&_svg]:size-4";

/** More segments than this become a value picker on a narrow settings column (iOS keeps segmented controls short). */
const MAX_NARROW_SEGMENTS = 3;

/**
 * Whether equal-width segments fit the row a segmented control sits in. A hidden copy of the track at its natural
 * width is measured against the row, so the answer does not depend on which form is on screen.
 */
function useSegmentsFit(count: number) {
    const root = useRef<HTMLDivElement>(null);
    const probe = useRef<HTMLDivElement>(null);
    const [fits, setFits] = useState(true);
    useLayoutEffect(() => {
        const el = root.current;
        const inner = probe.current;
        const room = el?.closest("[data-row-main]") ?? el?.parentElement;
        if (!el || !inner || !room || typeof ResizeObserver === "undefined") return;
        const measure = () => {
            const avail = room.clientWidth;
            if (!avail) return;
            const widths = [...inner.children].map((c) => (c as HTMLElement).offsetWidth);
            const chrome = inner.offsetWidth - widths.reduce((a, b) => a + b, 0);
            setFits(chrome + Math.max(0, ...widths) * widths.length <= avail + 0.5);
        };
        const ro = new ResizeObserver(measure);
        ro.observe(room);
        ro.observe(inner);
        measure();
        return () => ro.disconnect();
    }, [count]);
    return { root, probe, fits };
}

/**
 * Segmented control: a 36px recessed track (--control-track) holding 28px segments. The selected segment is a
 * raised thumb (--control-thumb, card shadow, full ink); the others are ink 65% and turn full ink on hover. Both
 * tokens derive from the card colour, so the control never blends into the card or a hover tint.
 *
 * On a narrow settings column (settings.css) the track fills the row with equal segments, as on iOS. With more
 * than three segments, or labels that do not fit, it shows as a value picker instead (`data-collapse`): the same
 * choice in a Select, which opens a checked list in a bottom sheet on phones.
 */
export function Segmented<T extends string>({
    value,
    options,
    onChange,
    disabled,
    label,
}: {
    value: T;
    options: Option<T>[];
    onChange: (v: T) => void;
    disabled?: boolean;
    label: string;
}) {
    disabled = useRowLocked(disabled);
    const { root, probe, fits } = useSegmentsFit(options.length);
    const collapse = options.length > MAX_NARROW_SEGMENTS || !fits;
    return (
        <div
            ref={root}
            data-segmented=""
            data-collapse={collapse ? "" : undefined}
            data-wide={collapse ? undefined : ""}
            className="inline-flex max-w-full min-w-0 shrink-0"
        >
            <div aria-hidden className="pointer-events-none invisible absolute start-0 top-0 size-0 overflow-hidden">
                <div ref={probe} inert className={cn(segmentTrack, "w-max max-w-none")}>
                    {options.map((o) => (
                        <span key={o.value} className={cn(segmentButton, "font-medium")}>
                            {o.icon}
                            {o.label}
                        </span>
                    ))}
                </div>
            </div>
            <span data-segmented-picker="">
                <Select value={value} options={options} onChange={onChange} disabled={disabled} label={label} />
            </span>
            <SegmentedTrack value={value} options={options} onChange={onChange} disabled={disabled} label={label} />
        </div>
    );
}

function SegmentedTrack<T extends string>({
    value,
    options,
    onChange,
    disabled,
    label,
}: {
    value: T;
    options: Option<T>[];
    onChange: (v: T) => void;
    disabled?: boolean;
    label: string;
}) {
    disabled = useRowLocked(disabled);
    return (
        <div role="radiogroup" aria-label={label} className={segmentTrack}>
            {options.map((o) => {
                const on = o.value === value;
                return (
                    <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        disabled={disabled || o.disabled}
                        onClick={() => !on && onChange(o.value)}
                        onKeyDown={(e) => {
                            // Arrow keys move the selection, like native radios.
                            const i = options.findIndex((x) => x.value === value);
                            const step =
                                e.key === "ArrowRight" || e.key === "ArrowDown"
                                    ? 1
                                    : e.key === "ArrowLeft" || e.key === "ArrowUp"
                                      ? -1
                                      : 0;
                            if (!step) return;
                            e.preventDefault();
                            const next = options[(i + step + options.length) % options.length];
                            if (next) {
                                onChange(next.value);
                                const btns = e.currentTarget.parentElement?.querySelectorAll("button");
                                (btns?.[options.indexOf(next)] as HTMLButtonElement | undefined)?.focus();
                            }
                        }}
                        tabIndex={on || (!options.some((x) => x.value === value) && o === options[0]) ? 0 : -1}
                        className={cn(
                            segmentButton,
                            on
                                ? "bg-control-thumb font-medium text-text shadow-card"
                                : "text-secondary hover-device:hover:text-text",
                            "disabled:cursor-default disabled:opacity-40",
                            focusRing,
                        )}
                    >
                        {o.icon}
                        <span>
                            <SearchMark text={o.label} />
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

// Select

/**
 * The options of a Select in a bottom sheet (phones): a checked list, as in iOS pickers and Material's
 * single-choice dialogs. It is a listbox: arrow keys, Home and End move between options, Enter or Space (or a
 * tap) picks one and closes the sheet, and Escape closes it unchanged. Focus starts on the current option and
 * goes back to the trigger on close (`onClosed`).
 */
function OptionSheet<T extends string>({
    open,
    onOpenChange,
    label,
    value,
    options,
    onChange,
    onClosed,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    label: string;
    value: T;
    options: Option<T>[];
    onChange: (v: T) => void;
    /** Return focus to the trigger (a tap does not always focus it, so Radix may not know where to go). */
    onClosed: () => void;
}) {
    const list = useRef<HTMLDivElement>(null);
    const current = Math.max(
        0,
        options.findIndex((o) => o.value === value),
    );
    const items = () => [...(list.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];
    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title={label}
            onOpenAutoFocus={(e) => {
                e.preventDefault();
                requestAnimationFrame(() => items()[current]?.focus());
            }}
            onCloseAutoFocus={(e) => {
                e.preventDefault();
                onClosed();
            }}
        >
            <div
                ref={list}
                role="listbox"
                aria-label={label}
                className="flex flex-col pb-2"
                onKeyDown={(e) => {
                    const all = items();
                    const i = all.indexOf(document.activeElement as HTMLElement);
                    const next =
                        e.key === "ArrowDown"
                            ? Math.min(all.length - 1, i + 1)
                            : e.key === "ArrowUp"
                              ? Math.max(0, i - 1)
                              : e.key === "Home"
                                ? 0
                                : e.key === "End"
                                  ? all.length - 1
                                  : -1;
                    if (next < 0) return;
                    e.preventDefault();
                    all[next]?.focus();
                }}
            >
                {options.map((o, i) => {
                    const on = o.value === value;
                    return (
                        <button
                            key={o.value}
                            type="button"
                            role="option"
                            aria-selected={on}
                            tabIndex={i === current ? 0 : -1}
                            onClick={() => {
                                onOpenChange(false);
                                if (!on) onChange(o.value);
                            }}
                            className={cn(sheetRow, "min-h-12", on && "font-medium")}
                        >
                            {o.icon}
                            <span
                                className="min-w-0 flex-1 truncate"
                                style={o.font ? { fontFamily: o.font } : undefined}
                            >
                                {o.label}
                            </span>
                            <Check className={cn("text-accent", !on && "invisible")} weight="bold" aria-hidden />
                        </button>
                    );
                })}
            </div>
        </Sheet>
    );
}

/** The one look for every dropdown trigger in Settings (Select, ModelSelect and anything else that picks a value). */
const pickerTrigger = cn(
    "inline-flex h-9 max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-lg border border-default ps-3 pe-2.5",
    "bg-[color-mix(in_srgb,var(--text)_2.7%,transparent)] text-sm leading-[18px] text-text select-none [&_svg]:shrink-0",
    "hover-device:hover:bg-hover data-[state=open]:bg-hover disabled:cursor-default disabled:opacity-40 pointer-coarse:h-11",
    focusRing,
);

export type PickerTriggerProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value" | "children"> & {
    /** Name of the setting. The accessible name is "<label>: <text>". */
    label: string;
    /** The current value as text; empty shows `placeholder`. */
    text: string;
    placeholder?: string;
    /** Icon, swatch or badge before the value (theme badge, option icon). */
    leading?: ReactNode;
    /** CSS font-family for the value (font pickers). */
    font?: string;
    /** Monospace value (raw ids). */
    mono?: boolean;
};

/**
 * Dropdown trigger (spec 6.2): 36px (44px on touch), 12.5px radius, 1px border, ink 2.7% fill, 13px text, the value
 * truncated, a 16px chevron at ink 47%; hover ink 7%, disabled at 40%. `className` is for width only. The trigger
 * is a `data-picker`: on a narrow settings column it shows as the value and an up-down chevron at the end of the
 * row, and the whole row opens it (settings.css). It opens whatever the caller wires to `onClick` (Select: a menu
 * or an option sheet; ModelSelect: the model browser).
 */
export const PickerTrigger = forwardRef<HTMLButtonElement, PickerTriggerProps>(function PickerTrigger(
    { label, text, placeholder, leading, font, mono, className, type = "button", ...rest },
    ref,
) {
    const t = useT();
    const empty = placeholder ?? t("settings-select-placeholder");
    return (
        <button
            ref={ref}
            type={type}
            data-picker=""
            aria-label={`${label}: ${text || empty}`}
            {...rest}
            className={cn(pickerTrigger, className)}
        >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
                {leading}
                <span
                    className={cn("truncate", !text && "text-tertiary", mono && "font-mono text-xs")}
                    style={font ? { fontFamily: font } : undefined}
                >
                    {text ? <SearchMark text={text} /> : empty}
                </span>
            </span>
            <CaretDown data-caret="field" className="size-4 shrink-0 text-tertiary" aria-hidden />
            <CaretUpDown data-caret="row" className="size-4 shrink-0 text-tertiary" aria-hidden />
        </button>
    );
});

/**
 * Select: a PickerTrigger that opens the shared Menu (desktop) or an OptionSheet (phones). `leading` overrides the
 * current option's icon in the trigger (for example a theme badge).
 *
 * Select or Segmented: Segmented for two or three short options that are worth seeing at once; Select for four or
 * more, long labels, or lists that come from data. On phones a segmented control fills the row under its label, and
 * one whose labels still do not fit turns into this Select (see Segmented).
 */
export function Select<T extends string>({
    value,
    options,
    onChange,
    disabled,
    label,
    placeholder,
    leading,
    className,
}: {
    value: T;
    options: Option<T>[];
    onChange: (v: T) => void;
    disabled?: boolean;
    label: string;
    placeholder?: string;
    leading?: ReactNode;
    /** Width only. */
    className?: string;
}) {
    disabled = useRowLocked(disabled);
    const mobile = useIsMobile();
    const [sheet, setSheet] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    // A pick saves at once, and a saving row disables its controls: focus returns once the trigger is enabled.
    const refocus = useRef(false);
    const focusTrigger = () => {
        const el = triggerRef.current;
        if (el && !el.disabled) el.focus({ preventScroll: true });
        else refocus.current = true;
    };
    useEffect(() => {
        if (disabled || !refocus.current) return;
        refocus.current = false;
        triggerRef.current?.focus({ preventScroll: true });
    }, [disabled]);
    const current = options.find((o) => o.value === value);
    const trigger = (
        <PickerTrigger
            ref={triggerRef}
            label={label}
            text={current?.label ?? ""}
            placeholder={placeholder}
            leading={leading ?? current?.icon}
            font={current?.font}
            disabled={disabled}
            className={className}
            {...(mobile
                ? { "aria-haspopup": "listbox" as const, "aria-expanded": sheet, onClick: () => setSheet(true) }
                : {})}
        />
    );
    // The sheet stays mounted while the row saves (disabled), so it can close normally and hand focus back.
    if (mobile) {
        return (
            <>
                {trigger}
                <OptionSheet
                    open={sheet && !disabled}
                    onOpenChange={setSheet}
                    label={label}
                    value={value}
                    options={options}
                    onChange={onChange}
                    onClosed={focusTrigger}
                />
            </>
        );
    }
    if (disabled) return trigger;
    return (
        <Menu
            title={label}
            align="end"
            trigger={trigger}
            items={options.map((o) => ({
                // The shared menu has no per-item style, so a font preview renders through the icon slot.
                label: o.font ? "" : o.label,
                icon: o.font ? <span style={{ fontFamily: o.font }}>{o.label}</span> : o.icon,
                checked: o.value === value,
                onSelect: () => o.value !== value && onChange(o.value),
            }))}
        />
    );
}

// Text fields

/** A draft that follows `value` until the user edits it. */
function useDraft(value: string) {
    const [draft, setDraft] = useState(value);
    const editing = useRef(false);
    useEffect(() => {
        if (!editing.current) setDraft(value);
    }, [value]);
    return { draft, setDraft, editing };
}

type InputAttrs = Omit<HTMLAttributes<HTMLInputElement>, "onChange" | "defaultValue">;

interface TextFieldBase extends InputAttrs {
    value: string;
    /** Accessible name when there is no visible <label for>. */
    label?: string;
    id?: string;
    size?: FieldSize;
    mono?: boolean;
    type?: "text" | "url" | "email" | "password" | "search";
    placeholder?: string;
    disabled?: boolean;
    required?: boolean;
    autoComplete?: string;
    autoFocus?: boolean;
    list?: string;
    maxLength?: number;
    pattern?: string;
    readOnly?: boolean;
    invalid?: boolean;
    className?: string;
}

export type TextFieldProps =
    | (TextFieldBase & { onCommit: (v: string) => void; onChange?: undefined })
    | (TextFieldBase & { onChange: (v: string) => void; onCommit?: undefined });

/**
 * Text field. With `onCommit` it is an inline row field (28px, writes on blur or Enter, Escape reverts); with
 * `onChange` it is a controlled form field (36px by default).
 */
export function TextField(props: TextFieldProps) {
    const { value, label, size, mono, invalid, className, onCommit, onChange, type = "text", ...rest } = props;
    const inline = !!onCommit;
    const disabled = useRowLocked(rest.disabled);
    const { draft, setDraft, editing } = useDraft(value);
    const sz: FieldSize = size ?? (inline ? "sm" : "md");
    const common = {
        type,
        "aria-label": label,
        "aria-invalid": invalid || undefined,
        disabled,
        spellCheck: false,
        autoCapitalize: "none",
        autoCorrect: "off",
        autoComplete: rest.autoComplete ?? "off",
        className: cn(fieldClass(sz, mono), inline ? "w-[min(240px,100%)]" : "w-full", className),
    };
    if (!inline) {
        return <input {...rest} {...common} value={value} onChange={(e) => onChange?.(e.target.value)} />;
    }
    const commit = () => {
        editing.current = false;
        const v = draft.trim();
        if (v !== value) onCommit(v);
        else setDraft(value);
    };
    return (
        <input
            {...rest}
            {...common}
            // A row field needs room: full width under the label on a narrow settings column.
            data-wide=""
            value={draft}
            onFocus={() => (editing.current = true)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                    setDraft(value);
                    editing.current = false;
                    requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
                }
            }}
        />
    );
}

/** Native input with the form field style, for forms that manage their own events (dialogs). */
export function Input({
    size = "md",
    mono,
    className,
    disabled,
    ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: FieldSize; mono?: boolean }) {
    const locked = useRowLocked(disabled);
    return (
        <input
            spellCheck={false}
            {...rest}
            disabled={locked}
            className={cn(fieldClass(size, mono), "w-full", className)}
        />
    );
}

/**
 * Editor surface for a stacked SettingRow: full-bleed from card edge to card edge, square, on the recessed tone,
 * with hairlines above and below instead of a frame (no border-in-border inside a card). Focus draws the ring inset.
 */
export const flushEditor =
    "-mx-4 w-[calc(100%+2rem)] max-w-none resize-y rounded-none border-0 border-y border-default bg-[color-mix(in_srgb,var(--control-track)_50%,var(--panel))] px-4 py-3 text-text placeholder:text-tertiary outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring disabled:opacity-60";

/** Multi-line field for a stacked row (instructions). Controlled; shows a character count when `maxLength` is set. */
export function TextArea({
    value,
    onChange,
    label,
    rows = 6,
    maxLength,
    placeholder,
    disabled,
}: {
    value: string;
    onChange: (v: string) => void;
    label: string;
    rows?: number;
    maxLength?: number;
    placeholder?: string;
    disabled?: boolean;
}) {
    disabled = useRowLocked(disabled);
    return (
        <div className="flex w-full flex-col gap-1">
            <textarea
                aria-label={label}
                value={value}
                rows={rows}
                maxLength={maxLength}
                placeholder={placeholder}
                disabled={disabled}
                onChange={(e) => onChange(e.target.value)}
                className={cn(flushEditor, "min-h-30 text-base pointer-coarse:text-md")}
            />
            {maxLength !== undefined && (
                <span className="self-end text-xs leading-4 text-tertiary tabular-nums">
                    {value.length.toLocaleString()} / {maxLength.toLocaleString()}
                </span>
            )}
        </div>
    );
}

/** Step a value by `step`, onto the step grid, within the bounds. */
function stepped(value: number | undefined, dir: 1 | -1, step: number, min?: number, max?: number): number {
    const base = value ?? min ?? 0;
    const decimals = (String(step).split(".")[1] ?? "").length;
    let next = Number(((Math.round(base / step) + dir) * step).toFixed(decimals));
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    return next;
}

const stepButton = cn(
    "inline-flex size-9 shrink-0 items-center justify-center text-tertiary hover-device:hover:bg-hover hover-device:hover:text-text",
    "disabled:cursor-default disabled:opacity-40 pointer-coarse:size-11 [&_svg]:size-4",
    "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
);

/**
 * Number field with minus and plus buttons (the app hides native spinners, which crowd the value in Firefox and
 * are too small to tap). Typing writes on blur or Enter; out-of-range input reverts and flags the field. Arrow keys
 * step as in a native number input, and each button press writes at once, clamped to `min` and `max`.
 */
export function NumberField({
    value,
    onCommit,
    label,
    min,
    max,
    step = 1,
    unit,
    disabled,
    placeholder,
}: {
    value: number | undefined;
    onCommit: (v: number) => void;
    label: string;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    disabled?: boolean;
    placeholder?: string;
}) {
    disabled = useRowLocked(disabled);
    const t = useT();
    const { draft, setDraft, editing } = useDraft(value === undefined ? "" : String(value));
    const [invalid, setInvalid] = useState(false);
    const commit = () => {
        editing.current = false;
        const n = Number(draft);
        if (
            draft.trim() === "" ||
            !Number.isFinite(n) ||
            (min !== undefined && n < min) ||
            (max !== undefined && n > max)
        ) {
            setInvalid(draft.trim() !== "");
            setDraft(value === undefined ? "" : String(value));
            return;
        }
        setInvalid(false);
        if (n !== value) onCommit(n);
    };
    const range =
        min !== undefined && max !== undefined
            ? t("settings-number-enter-between", { min, max })
            : min !== undefined
              ? t("settings-number-enter-min", { min })
              : undefined;
    const press = (dir: 1 | -1) => {
        const next = stepped(value, dir, step, min, max);
        setInvalid(false);
        setDraft(String(next));
        if (next !== value) onCommit(next);
    };
    return (
        <span className="inline-flex items-center gap-1.5">
            <span
                className={cn(
                    "inline-flex h-9 items-center overflow-hidden rounded-lg border border-default focus-within:outline-2 focus-within:outline-ring pointer-coarse:h-11",
                    invalid && "border-danger",
                    disabled && "opacity-60",
                )}
            >
                <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t("settings-number-decrease", { label })}
                    disabled={disabled || (min !== undefined && value !== undefined && value <= min)}
                    onClick={() => press(-1)}
                    className={stepButton}
                >
                    <Minus aria-hidden />
                </button>
                <input
                    type="number"
                    inputMode="decimal"
                    aria-label={label}
                    aria-invalid={invalid || undefined}
                    title={invalid ? range : undefined}
                    min={min}
                    max={max}
                    step={step}
                    disabled={disabled}
                    placeholder={placeholder}
                    value={draft}
                    onFocus={() => (editing.current = true)}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    className="h-full w-14 min-w-0 bg-transparent text-center text-sm text-text tabular-nums outline-none placeholder:text-tertiary disabled:cursor-not-allowed pointer-coarse:text-md"
                />
                <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t("settings-number-increase", { label })}
                    disabled={disabled || (max !== undefined && value !== undefined && value >= max)}
                    onClick={() => press(1)}
                    className={stepButton}
                >
                    <Plus aria-hidden />
                </button>
            </span>
            {unit && <span className="text-sm text-tertiary">{unit}</span>}
        </span>
    );
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normaliseHex(v: string): string | null {
    const m = HEX.exec(v.trim());
    if (!m?.[1]) return null;
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    return `#${h.toLowerCase()}`;
}

/** Colour field: 112x36 box with a swatch (opens the system picker) and a hex input. */
export function ColorField({
    value,
    onCommit,
    label,
    disabled,
}: {
    value: string;
    onCommit: (v: string) => void;
    label: string;
    disabled?: boolean;
}) {
    disabled = useRowLocked(disabled);
    const t = useT();
    const { draft, setDraft, editing } = useDraft(value.toUpperCase());
    const picker = useRef<HTMLInputElement>(null);
    const commitRef = useRef(onCommit);
    commitRef.current = onCommit;
    const shown = normaliseHex(draft) ?? normaliseHex(value) ?? "#000000"; // token-lint-ignore: picker value, not styling

    // The native picker fires `input` while dragging and `change` on close; only `change` writes.
    useEffect(() => {
        const el = picker.current;
        if (!el) return;
        const onChange = () => {
            editing.current = false;
            commitRef.current(el.value);
        };
        el.addEventListener("change", onChange);
        return () => el.removeEventListener("change", onChange);
    }, [editing]);

    const commit = () => {
        editing.current = false;
        const hex = normaliseHex(draft);
        if (hex && hex !== normaliseHex(value)) onCommit(hex);
        else setDraft(value.toUpperCase());
    };
    return (
        <div
            className={cn(
                "flex h-9 w-28 shrink-0 items-center gap-2 rounded-lg border border-default ps-2 pe-2.5 focus-within:outline-2 focus-within:outline-ring pointer-coarse:h-11 pointer-coarse:w-32",
                disabled && "opacity-60",
            )}
        >
            <span
                className="relative size-5 shrink-0 rounded-md border border-default"
                style={{ backgroundColor: shown }}
            >
                <input
                    ref={picker}
                    type="color"
                    aria-label={t("settings-color-picker", { label })}
                    disabled={disabled}
                    value={shown}
                    onFocus={() => (editing.current = true)}
                    onChange={(e) => setDraft(e.target.value.toUpperCase())}
                    className="absolute -inset-2 size-[30px] cursor-pointer opacity-0 disabled:cursor-not-allowed"
                />
            </span>
            <input
                aria-label={label}
                disabled={disabled}
                value={draft}
                maxLength={7}
                spellCheck={false}
                onFocus={() => (editing.current = true)}
                onChange={(e) => setDraft(e.target.value.toUpperCase())}
                onBlur={commit}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                className="w-full min-w-0 bg-transparent font-mono text-xs uppercase tabular-nums outline-none disabled:cursor-not-allowed"
            />
        </div>
    );
}

// Slider

/**
 * Slider with snap marks. Follows the thumb locally while dragging and writes once on release (pointer up, key up
 * or blur). Marks are buttons that jump to their value. `preview` renders next to the track with the live value.
 */
export function Slider({
    value,
    onCommit,
    label,
    min,
    max,
    step,
    marks = [],
    disabled,
    preview,
}: {
    value: number;
    onCommit: (v: number) => void;
    label: string;
    min: number;
    max: number;
    step: number;
    marks?: { value: number; label: string }[];
    disabled?: boolean;
    preview?: (v: number) => ReactNode;
}) {
    disabled = useRowLocked(disabled);
    const [draft, setDraft] = useState<number | null>(null);
    const shown = draft ?? value;
    const commit = (v: number) => {
        setDraft(null);
        if (v !== value) onCommit(Math.round(v / step) * step);
    };
    const near = (a: number, b: number) => Math.abs(a - b) < step / 2;
    return (
        <div data-wide="" className="flex items-center gap-4">
            {preview?.(shown)}
            <div className="flex w-44 min-w-0 grow flex-col gap-1">
                <input
                    type="range"
                    aria-label={label}
                    aria-valuetext={marks.find((m) => near(m.value, shown))?.label ?? String(shown)}
                    min={min}
                    max={max}
                    step={step}
                    value={shown}
                    disabled={disabled}
                    onChange={(e) => setDraft(Number(e.target.value))}
                    onPointerUp={(e) => commit(Number(e.currentTarget.value))}
                    onKeyUp={(e) => commit(Number(e.currentTarget.value))}
                    onBlur={(e) => draft !== null && commit(Number(e.currentTarget.value))}
                    className="h-5 w-full accent-[var(--accent)] disabled:opacity-60 pointer-coarse:h-10"
                />
                {marks.length > 0 && (
                    <div className="flex justify-between">
                        {marks.map((m) => (
                            <button
                                key={m.value}
                                type="button"
                                disabled={disabled}
                                onClick={() => commit(m.value)}
                                className={cn(
                                    "rounded-sm text-xs leading-4 hover-device:hover:text-text pointer-coarse:min-h-8",
                                    near(shown, m.value) ? "text-text" : "text-tertiary",
                                    focusRing,
                                )}
                            >
                                {m.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

// Lists

/** Editable list of strings (patterns, origins, arguments, scopes). Changes are reported whole. */
export function ListEditor({
    value,
    onChange,
    label,
    placeholder,
    disabled,
    mono = true,
}: {
    value: string[];
    onChange: (v: string[]) => void;
    label: string;
    placeholder?: string;
    disabled?: boolean;
    mono?: boolean;
}) {
    disabled = useRowLocked(disabled);
    const t = useT();
    const [draft, setDraft] = useState("");
    const add = () => {
        const v = draft.trim();
        if (!v) return;
        if (!value.includes(v)) onChange([...value, v]);
        setDraft("");
    };
    return (
        <div className="flex w-full flex-col gap-1.5">
            {value.length > 0 && (
                <ul aria-label={label} className="flex flex-wrap gap-1.5">
                    {value.map((v, i) => (
                        <li
                            key={`${v}-${i}`}
                            className={cn(
                                "inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-soft ps-2.5 text-sm pointer-coarse:h-9",
                                mono && "font-mono text-xs",
                                disabled && "pe-2.5",
                            )}
                        >
                            <span className="truncate">{v}</span>
                            {!disabled && (
                                <button
                                    type="button"
                                    aria-label={t("settings-list-remove", { item: v })}
                                    onClick={() => onChange(value.filter((_, j) => j !== i))}
                                    className={cn(
                                        "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-tertiary hover-device:hover:text-text pointer-coarse:size-9",
                                        focusRing,
                                    )}
                                >
                                    <X className="size-3.5" />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {!disabled && (
                <div className="flex items-center gap-1.5">
                    <input
                        aria-label={t("settings-list-add-to", { label })}
                        placeholder={placeholder}
                        value={draft}
                        spellCheck={false}
                        autoCapitalize="none"
                        autoCorrect="off"
                        autoComplete="off"
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                add();
                            }
                        }}
                        className={cn(fieldClass("sm", mono), "min-w-0 flex-1")}
                    />
                    <Button onClick={add} disabled={!draft.trim()}>
                        <Plus /> {t("settings-add")}
                    </Button>
                </div>
            )}
        </div>
    );
}

export type Pairs = [string, string][];

export const toPairs = (r: Record<string, string> | undefined): Pairs => Object.entries(r ?? {});
export const fromPairs = (p: Pairs): Record<string, string> | undefined => {
    const out = Object.fromEntries(p.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
    return Object.keys(out).length ? out : undefined;
};

/** Key/value rows (headers, environment, options). Values flagged secret render as password fields. */
export function KeyValueList({
    value,
    onChange,
    label,
    keyPlaceholder,
    valuePlaceholder,
    secret,
    disabled,
}: {
    value: Pairs;
    onChange: (v: Pairs) => void;
    label: string;
    keyPlaceholder?: string;
    valuePlaceholder?: string;
    secret?: boolean;
    /** Edit, add and remove are all off. A locked SettingRow sets this for you. */
    disabled?: boolean;
}) {
    const t = useT();
    disabled = useRowLocked(disabled);
    return (
        <div role="group" aria-label={label} className="flex w-full flex-col gap-1.5">
            {value.map(([k, v], i) => (
                <div key={i} className="flex items-center gap-1.5">
                    <input
                        aria-label={t("settings-pairs-name", { label, index: i + 1 })}
                        placeholder={keyPlaceholder ?? t("settings-pairs-name-placeholder")}
                        value={k}
                        spellCheck={false}
                        autoCapitalize="none"
                        autoCorrect="off"
                        disabled={disabled}
                        onChange={(e) => onChange(value.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))}
                        className={cn(fieldClass("sm", true), "w-2/5 min-w-0")}
                    />
                    <input
                        aria-label={t("settings-pairs-value", { label, index: i + 1 })}
                        placeholder={valuePlaceholder ?? t("settings-pairs-value-placeholder")}
                        type={secret ? "password" : "text"}
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        value={v}
                        spellCheck={false}
                        disabled={disabled}
                        onChange={(e) => onChange(value.map((p, j) => (j === i ? [p[0], e.target.value] : p)))}
                        className={cn(fieldClass("sm", true), "min-w-0 flex-1")}
                    />
                    <IconButton
                        aria-label={k ? t("settings-list-remove", { item: k }) : t("settings-pairs-remove-row")}
                        disabled={disabled}
                        onClick={() => onChange(value.filter((_, j) => j !== i))}
                    >
                        <X />
                    </IconButton>
                </div>
            ))}
            <div>
                <Button disabled={disabled} onClick={() => onChange([...value, ["", ""]])}>
                    <Plus /> {t("settings-add")}
                </Button>
            </div>
        </div>
    );
}

export function Checkbox({
    checked,
    onChange,
    label,
    disabled,
}: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: ReactNode;
    disabled?: boolean;
}) {
    disabled = useRowLocked(disabled);
    return (
        <label
            className={cn(
                "inline-flex min-h-7 cursor-default items-center gap-2 text-sm pointer-coarse:min-h-10",
                disabled && "opacity-60",
            )}
        >
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked)}
                className="size-4 accent-[var(--accent)]"
            />
            {label}
        </label>
    );
}
