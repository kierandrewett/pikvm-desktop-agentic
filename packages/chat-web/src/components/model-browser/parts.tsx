/**
 * Presentational parts of the model browser. They copy the model picker's look (menu row metrics, hover pill,
 * recessed rail, section labels, hover card), so the picker and the settings pages read as one family.
 * State lives in model-browser.tsx; nothing here fetches or writes.
 */
import type { ModelInfo } from "@pikvm/chat-protocol";
import {
    ArrowLeft,
    Brain,
    Buildings,
    Check,
    CheckSquare,
    Eye,
    HardDrives,
    MinusSquare,
    Square,
    SquaresFour,
    Star,
    Wrench,
} from "@pikvm/icons";
import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocale, useT } from "../../l10n/provider";
import { translate } from "../../l10n/runtime";
import { cn } from "../../lib/cn";
import { shortcutLabel } from "../../lib/media";
import type { MatchRange } from "../../lib/typeahead";
import { EFFORT_LABELS } from "../composer/choice";
import {
    formatCost,
    formatTokens,
    identityOf,
    isFreeCost,
    joinList,
    modelFacts,
    type Group,
    type GroupBy,
} from "../model-picker/models";
import { ModelMark, ProviderLogo } from "../model-picker/provider-logo";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/dialog";
import { HighlightMatch } from "../ui/highlight-match";
import { Tooltip } from "../ui/tooltip";
import { errorDescription, toast } from "../ui/toast";
import { filterLabelIds, type BrowserFilter } from "./search";
import { useThemeLayer } from "../../lib/theme-scope";

/**
 * Tonal tiers instead of dividers, as in the picker: the rail and the detail column sit one step below the list
 * (recessed); the hover card one step above (`--elevated`). Both formulas derive from the theme seeds.
 */
export const tiers =
    "[--browser-recessed:color-mix(in_srgb,var(--menu)_45%,var(--surface-under))] [[data-theme=light]_&]:[--browser-recessed:color-mix(in_srgb,var(--seed-ink)_4.5%,var(--menu))]";

/** Row heights: the shared menu row (36px x density) plus one 16px meta line; taller on touch. */
export function rowHeights(density: number, coarse: boolean) {
    const pad = (n: number) => Math.round(n * density);
    const row = Math.round(36 * density);
    return {
        header: 20 + pad(12),
        model: coarse ? 24 + 16 + pad(16) : row + pad(10),
        pinned: coarse ? 24 + 16 + pad(16) : row + pad(10),
        skeleton: row + pad(10),
    } as const;
}
export type RowHeights = ReturnType<typeof rowHeights>;

/** "Acme · 128K · Free" or "128K · $3/$15"; with `who`, the vendor or provider name leads. */
export function metaLine(m: ModelInfo, who: string | undefined): string {
    const parts: string[] = [];
    if (who) parts.push(who);
    const ctx = formatTokens(m.contextWindow);
    if (ctx) parts.push(ctx);
    const inCost = formatCost(m.cost?.input);
    const outCost = formatCost(m.cost?.output);
    if (isFreeCost(m)) parts.push(translate("models-cost-free"));
    else if (inCost && outCost) parts.push(`${inCost}/${outCost}`);
    if (m.legacy) parts.push(translate("models-legacy"));
    return parts.join(" · ");
}

/** Section label, as in the shared Menu (px-2.5, pb-1, text-sm tertiary). */
export const SectionLabel = memo(function SectionLabel({
    label,
    count,
    height,
    style,
}: {
    label: string;
    count?: number;
    height: number;
    style?: CSSProperties;
}) {
    return (
        <div
            role="presentation"
            style={{ ...style, height }}
            className={cn(
                "flex items-end gap-2 bg-menu px-2.5 pb-1 text-sm leading-5 text-tertiary",
                style && "absolute inset-x-0",
            )}
        >
            <span className="min-w-0 truncate">{label}</span>
            {count !== undefined && <span className="ms-auto shrink-0 text-xs tabular-nums">{count}</span>}
        </div>
    );
});

/** Shared menu row metrics: px-2.5, gap-2.5, radius xl, 20px icons, hover pill. */
const rowBase =
    "group/row absolute inset-x-0 flex cursor-default items-center gap-2.5 rounded-xl px-2.5 text-text select-none";

/** Focus ring on the highlighted row while the list has keyboard focus. */
const rowFocus =
    "group-data-[focused]/list:data-[highlighted]:outline-2 group-data-[focused]/list:data-[highlighted]:-outline-offset-2 group-data-[focused]/list:data-[highlighted]:outline-ring";

export interface RowContext {
    /** The row is the keyboard or pointer highlight. */
    highlighted: boolean;
    /** The row's model is the one in the detail pane. */
    active: boolean;
}

export const ModelRow = memo(function ModelRow({
    id,
    index,
    rowPosition,
    model,
    meta,
    ranges,
    highlighted,
    active,
    current,
    muted,
    favorite,
    selected,
    showCaps,
    coarse,
    renderRowEnd,
    onHover,
    onPick,
    onStar,
    onSelectToggle,
    style,
}: {
    id: string;
    index: number;
    rowPosition: number;
    model: ModelInfo;
    meta: string;
    ranges: readonly MatchRange[] | null;
    highlighted: boolean;
    active: boolean;
    current: boolean;
    muted: boolean;
    /** undefined when favourites are off for this browser. */
    favorite: boolean | undefined;
    /** undefined when the browser has no multi-selection. */
    selected: boolean | undefined;
    showCaps: boolean;
    coarse: boolean;
    renderRowEnd: ((model: ModelInfo, ctx: RowContext) => ReactNode) | undefined;
    onHover: (i: number) => void;
    onPick: (i: number) => void;
    onStar: (id: string) => void;
    onSelectToggle: (id: string) => void;
    style: CSSProperties;
}) {
    const t = useT();
    const vision = model.input.includes("image");
    const end = renderRowEnd?.(model, { highlighted, active });
    return (
        <div
            id={id}
            role="row"
            aria-label={identityOf(model).label}
            aria-rowindex={rowPosition}
            aria-selected={selected ?? (active || current)}
            data-model-id={model.id}
            data-highlighted={highlighted || undefined}
            data-active={active || undefined}
            onPointerMove={(e) => e.pointerType === "mouse" && !highlighted && onHover(index)}
            onClick={() => onPick(index)}
            style={style}
            className={cn(rowBase, rowFocus, active ? "bg-selected" : highlighted && "bg-hover")}
        >
            <div role="gridcell" className="contents">
                {selected !== undefined && (
                    <button
                        type="button"
                        role="checkbox"
                        aria-checked={selected}
                        aria-label={t("models-browser-select-model", { name: model.name })}
                        tabIndex={highlighted ? 0 : -1}
                        onClick={(e) => {
                            e.stopPropagation();
                            onSelectToggle(model.id);
                        }}
                        className={cn(
                            "-ms-1 flex size-7 shrink-0 items-center justify-center rounded-lg outline-none hover-device:hover:bg-hover",
                            selected ? "text-accent-text" : "text-tertiary",
                        )}
                    >
                        {selected ? <CheckSquare weight="fill" className="size-5" /> : <Square className="size-5" />}
                    </button>
                )}
                <span className={cn("flex w-5 shrink-0 justify-center", muted && "opacity-50")}>
                    <ModelMark model={model} size={20} />
                </span>
                <span className={cn("min-w-0 flex-1", muted && "opacity-60")}>
                    <span className={cn("block truncate", coarse ? "text-md leading-6" : "text-sm leading-5")}>
                        <HighlightMatch text={model.name} ranges={ranges} />
                    </span>
                    {meta && <span className="block truncate text-xs leading-4 text-tertiary">{meta}</span>}
                </span>
                {showCaps && (
                    <span className="flex shrink-0 items-center gap-1.5 text-icon-tertiary" aria-hidden>
                        <span className="size-3.5">{model.reasoning && <Brain className="size-3.5" />}</span>
                        <span className="size-3.5">{vision && <Eye className="size-3.5" />}</span>
                        <span className="size-3.5">{model.toolCall && <Wrench className="size-3.5" />}</span>
                    </span>
                )}
                {end !== undefined && end !== null && (
                    // Clicks on host controls must not open the row.
                    <span className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
                        {end}
                    </span>
                )}
                {favorite !== undefined && (
                    <button
                        type="button"
                        aria-label={favorite ? t("models-favorite-remove") : t("models-favorite-add")}
                        aria-pressed={favorite}
                        tabIndex={highlighted ? 0 : -1}
                        onClick={(e) => {
                            e.stopPropagation();
                            onStar(model.id);
                        }}
                        className={cn(
                            "relative flex shrink-0 items-center justify-center rounded-lg outline-none hover-device:hover:bg-hover hover-device:hover:text-text",
                            coarse ? "size-10" : "size-7",
                            favorite ? "text-text" : "text-tertiary",
                            !favorite &&
                                !coarse &&
                                "invisible group-hover/row:visible group-data-[highlighted]/row:visible",
                        )}
                    >
                        <Star weight={favorite ? "fill" : "regular"} className="size-4" />
                    </button>
                )}
                {/* The check sits at the end; other rows with a star keep its slot so the stars line up. */}
                {current ? (
                    <Check aria-label={t("models-current")} className="size-5 shrink-0" />
                ) : (
                    favorite !== undefined && <span aria-hidden className="size-5 shrink-0" />
                )}
            </div>
        </div>
    );
});

/** A host entry above the models (for example "Defaults" on the model features page). */
export const PinnedRow = memo(function PinnedRow({
    id,
    index,
    rowPosition,
    label,
    description,
    icon,
    highlighted,
    active,
    current = false,
    pinId,
    onHover,
    onPick,
    style,
}: {
    id: string;
    index: number;
    rowPosition: number;
    label: string;
    description: string | undefined;
    icon: ReactNode;
    highlighted: boolean;
    active: boolean;
    /** The host's current choice (picker use): a check, like the current model. */
    current?: boolean;
    pinId: string;
    onHover: (i: number) => void;
    onPick: (i: number) => void;
    style: CSSProperties;
}) {
    const t = useT();
    return (
        <div
            id={id}
            role="row"
            aria-rowindex={rowPosition}
            aria-selected={active || current}
            data-pinned-id={pinId}
            data-highlighted={highlighted || undefined}
            onPointerMove={(e) => e.pointerType === "mouse" && !highlighted && onHover(index)}
            onClick={() => onPick(index)}
            style={style}
            className={cn(rowBase, rowFocus, active ? "bg-selected" : highlighted && "bg-hover")}
        >
            <div role="gridcell" className="contents">
                <span className="flex w-5 shrink-0 justify-center text-icon-secondary [&_svg]:size-5">{icon}</span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm leading-5">{label}</span>
                    {description && (
                        <span className="block truncate text-xs leading-4 text-tertiary">{description}</span>
                    )}
                </span>
                {current && <Check aria-label={t("models-browser-current-choice")} className="size-5 shrink-0" />}
            </div>
        </div>
    );
});

export function SkeletonRow({ style }: { style: CSSProperties }) {
    return (
        <div aria-hidden style={style} className="absolute inset-x-0 flex items-center gap-2.5 px-2.5">
            <span className="size-5 shrink-0 animate-pulse rounded-xs bg-hover" />
            <span className="flex-1 space-y-1.5">
                <span className="block h-2.5 w-1/2 animate-pulse rounded-xs bg-hover" />
                <span className="block h-2 w-1/3 animate-pulse rounded-xs bg-soft" />
            </span>
        </div>
    );
}

// Rail

export const ALL = "__all__";
export const FAVORITES = "__favorites__";

/**
 * Vendor or provider rail on the recessed tone. Labelled (icon, name, count) on wide containers; a slim column of
 * logo buttons with the count in the tooltip on narrow ones. A two-way control at the foot groups by vendor or
 * provider. Counts are the matches for the current search and filters, so the rail shows where results are.
 */
export const Rail = memo(function Rail({
    groups,
    counts,
    total,
    favorites,
    tab,
    onTab,
    labelled,
    coarse,
    groupBy,
    onGroupBy,
    groupToggle = true,
    loading,
}: {
    groups: Group[];
    counts: Map<string, number>;
    total: number;
    /** undefined when favourites are off, or when nothing is starred yet (no empty "0" entry). */
    favorites: number | undefined;
    tab: string;
    onTab: (t: string) => void;
    labelled: boolean;
    coarse: boolean;
    groupBy: GroupBy;
    onGroupBy: (by: GroupBy) => void;
    /** Show the vendor/provider switch. Hosts where grouping is not the point (a settings picker) leave it out. */
    groupToggle?: boolean;
    loading: boolean;
}) {
    const t = useT();
    const { locale } = useLocale();
    const rail = useRef<HTMLDivElement>(null);
    // Roving focus: arrows move between entries (wrapping), Home and End jump.
    const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
        const list = [...(rail.current?.querySelectorAll<HTMLButtonElement>("button[data-rail-item]") ?? [])];
        const at = list.indexOf(document.activeElement as HTMLButtonElement);
        if (at < 0 || e.ctrlKey || e.metaKey) return;
        const next =
            e.key === "ArrowDown"
                ? (at + 1) % list.length
                : e.key === "ArrowUp"
                  ? (at - 1 + list.length) % list.length
                  : e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? list.length - 1
                      : -1;
        if (next < 0) return;
        e.preventDefault();
        list[next]?.focus();
    };
    const plural = (n: number) => t("models-count", { count: n });
    const entry = (id: string, name: string, icon: ReactNode, count: number) => {
        const active = tab === id;
        const button = (
            <button
                key={id}
                type="button"
                data-rail-item
                aria-label={t("models-rail-entry-aria", { name, count: plural(count) })}
                aria-pressed={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onTab(id)}
                className={cn(
                    "flex shrink-0 items-center rounded-lg outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    labelled
                        ? "h-8 w-full gap-2.5 px-2 text-start text-sm"
                        : coarse
                          ? "size-10 justify-center"
                          : "size-8 justify-center",
                    active
                        ? "bg-menu text-text shadow-[0_0_0_0.5px_var(--border-strong)]"
                        : "text-tertiary hover-device:hover:bg-hover hover-device:hover:text-text",
                    !active && count === 0 && !loading && "opacity-50",
                )}
            >
                <span className="flex size-5 shrink-0 items-center justify-center [&_svg]:size-5">{icon}</span>
                {labelled && (
                    <>
                        <span className={cn("min-w-0 flex-1 truncate", active ? "text-text" : "text-secondary")}>
                            {name}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-tertiary">
                            {loading ? "" : count.toLocaleString(locale)}
                        </span>
                    </>
                )}
            </button>
        );
        return labelled ? (
            button
        ) : (
            <Tooltip key={id} label={t("models-rail-entry", { name, count: plural(count) })} side="right">
                {button}
            </Tooltip>
        );
    };
    const groupButton = (by: GroupBy, label: string, ariaLabel: string, icon: ReactNode) => {
        const active = groupBy === by;
        const b = (
            <button
                key={by}
                type="button"
                aria-label={ariaLabel}
                aria-pressed={active}
                onClick={() => onGroupBy(by)}
                className={cn(
                    "flex items-center justify-center gap-1.5 rounded-lg text-sm outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    labelled ? "h-7 flex-1 px-2" : coarse ? "size-10" : "size-8",
                    active
                        ? "bg-menu text-text shadow-[0_0_0_0.5px_var(--border-strong)]"
                        : "text-tertiary hover-device:hover:bg-hover hover-device:hover:text-text",
                )}
            >
                <span className="flex [&_svg]:size-5">{icon}</span>
                {labelled && label}
            </button>
        );
        return labelled ? (
            b
        ) : (
            <Tooltip key={by} label={ariaLabel} side="right">
                {b}
            </Tooltip>
        );
    };
    return (
        <div
            className={cn(
                "flex min-h-0 shrink-0 flex-col bg-[var(--browser-recessed)] p-1.5",
                labelled ? "w-52" : "items-center",
            )}
        >
            <div
                ref={rail}
                role="toolbar"
                aria-orientation="vertical"
                aria-label={groupBy === "vendor" ? t("models-vendors") : t("models-providers")}
                onKeyDown={onKey}
                className={cn(
                    "no-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto",
                    !labelled && "items-center",
                )}
            >
                {entry(ALL, t("models-browser-all"), <SquaresFour weight={tab === ALL ? "fill" : "regular"} />, total)}
                {favorites !== undefined &&
                    entry(
                        FAVORITES,
                        t("models-favorites"),
                        <Star weight={tab === FAVORITES ? "fill" : "regular"} />,
                        favorites,
                    )}
                {labelled && groups.length > 0 && (
                    <div className="px-2 pt-3 pb-1 text-xs text-tertiary">
                        {groupBy === "vendor" ? t("models-vendors") : t("models-providers")}
                    </div>
                )}
                {!labelled && groups.length > 0 && <div aria-hidden className="h-1.5 shrink-0" />}
                {loading && !groups.length
                    ? Array.from({ length: 6 }, (_, i) => (
                          <span
                              key={i}
                              aria-hidden
                              className={cn(
                                  "flex shrink-0 items-center gap-2.5 px-2",
                                  labelled ? "h-8 w-full" : "size-8 justify-center",
                              )}
                          >
                              <span className="size-5 shrink-0 animate-pulse rounded-xs bg-hover" />
                              {labelled && <span className="h-2.5 w-2/3 animate-pulse rounded-xs bg-hover" />}
                          </span>
                      ))
                    : groups.map((g) =>
                          entry(
                              g.id,
                              g.name,
                              <ProviderLogo src={g.logo} name={g.name} size={20} />,
                              counts.get(g.id) ?? 0,
                          ),
                      )}
            </div>
            {/* A recessed well (one tier below the rail) instead of a divider rule. */}
            {groupToggle && (
                <div
                    role="group"
                    aria-label={t("models-group-by")}
                    className={cn(
                        "mt-1.5 flex shrink-0 gap-0.5 rounded-xl bg-hover p-0.5",
                        labelled ? "flex-row" : "flex-col",
                    )}
                >
                    {groupButton(
                        "vendor",
                        t("models-browser-group-vendor"),
                        t("models-group-by-vendor"),
                        <Buildings />,
                    )}
                    {groupButton(
                        "provider",
                        t("models-browser-group-provider"),
                        t("models-group-by-provider"),
                        <HardDrives />,
                    )}
                </div>
            )}
        </div>
    );
});

// Filter chips

export function FilterChips({
    filters,
    active,
    onToggle,
}: {
    filters: readonly BrowserFilter[];
    active: ReadonlySet<BrowserFilter>;
    onToggle: (f: BrowserFilter) => void;
}) {
    const t = useT();
    if (!filters.length) return null;
    return (
        <div
            role="group"
            aria-label={t("models-browser-filters")}
            className="no-scrollbar flex shrink-0 gap-1.5 overflow-x-auto px-1 pt-0.5 pb-1.5"
        >
            {filters.map((f) => {
                const on = active.has(f);
                return (
                    <button
                        key={f}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onToggle(f)}
                        className={cn(
                            "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-sm whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:h-9",
                            on
                                ? "bg-accent-bg text-accent-text hover-device:hover:bg-accent-bg-hover"
                                : "text-secondary shadow-[inset_0_0_0_1px_var(--border)] hover-device:hover:bg-hover hover-device:hover:text-text",
                        )}
                    >
                        {on && <Check className="size-3.5" aria-hidden />}
                        {t(filterLabelIds[f])}
                    </button>
                );
            })}
        </div>
    );
}

// Facts and detail

/** Context, output, price, inputs, thinking, dates: the hover card and the detail pane share this list. */
export function ModelFacts({ model, className }: { model: ModelInfo; className?: string }) {
    useT(); // Subscribe to the locale: the facts are formatted outside React.
    const facts = modelFacts(model, { tools: true, effortLabel: (e) => EFFORT_LABELS[e] });
    return (
        <dl className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm leading-5", className)}>
            {facts.map(([k, v]) => (
                <div key={k} className="contents">
                    <dt className="text-tertiary">{k}</dt>
                    <dd className="min-w-0 break-words tabular-nums">{v}</dd>
                </div>
            ))}
        </dl>
    );
}

/** Back to the list from the narrow drill-in view. */
export function BackButton({ onClick }: { onClick: () => void }) {
    const t = useT();
    return (
        <Button
            size="lg"
            uniform
            aria-label={t("models-browser-back")}
            onClick={onClick}
            className="-ms-1.5 -mt-1 shrink-0"
        >
            <ArrowLeft />
        </Button>
    );
}

/** Logo, name, id and who serves it. `back` adds the drill-in back button (narrow containers). */
export function DetailHeader({ model, back }: { model: ModelInfo; back?: () => void }) {
    const who = identityOf(model).byline;
    return (
        <div className="flex items-start gap-2.5">
            {back && <BackButton onClick={back} />}
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-soft">
                <ModelMark model={model} size={20} />
            </span>
            <div className="min-w-0 flex-1">
                <h3 className="text-base leading-6 font-medium break-words text-text">{model.name}</h3>
                <div className="truncate text-xs leading-4 text-tertiary">{who}</div>
                <div className="mt-1 truncate font-mono text-xs leading-4 text-secondary" title={model.id}>
                    {model.id}
                </div>
            </div>
        </div>
    );
}

/**
 * Details beside the browser on hover (only when the host gives no detail pane): the picker's hover card.
 * It sits to the right of the surface, or to the left when there is no room, and stays inside the viewport.
 */
export function HoverCard({
    model,
    anchor,
    surface,
    favoriteShortcut,
}: {
    model: ModelInfo;
    anchor: DOMRect;
    surface: DOMRect;
    favoriteShortcut: boolean;
}) {
    const layer = useThemeLayer();
    const t = useT();
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const gap = 8;
        let left = surface.right + gap;
        if (left + w > innerWidth - 8) left = surface.left - gap - w;
        const top = Math.min(Math.max(8, anchor.top - 6), innerHeight - h - 8);
        setPos({ left: Math.max(8, left), top });
    }, [anchor, surface, model.id]);
    return createPortal(
        <div
            ref={ref}
            role="tooltip"
            className="pointer-events-none fixed z-[140] w-64 rounded-2xl bg-elevated p-3 text-sm leading-5 text-text shadow-dropdown"
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
        >
            <div className="flex items-start gap-2">
                <span className="mt-px flex size-4 shrink-0">
                    <ModelMark model={model} size={16} />
                </span>
                <div className="min-w-0">
                    <div className="font-medium break-words">{model.name}</div>
                    <div className="truncate text-xs text-tertiary">{identityOf(model).byline}</div>
                </div>
            </div>
            <ModelFacts model={model} className="mt-2.5" />
            <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-tertiary">
                <span>
                    <kbd className="font-sans text-secondary">{t("models-key-enter")}</kbd> {t("models-hint-choose")}
                </span>
                {favoriteShortcut && (
                    <span>
                        <kbd className="font-sans text-secondary">{shortcutLabel("Mod+D")}</kbd>{" "}
                        {t("models-hint-favorite")}
                    </span>
                )}
            </div>
        </div>,
        layer ?? document.body,
    );
}

// Bulk actions

export interface BulkAction {
    id: string;
    /** Button text for the number of models it will change, for example (n) => `Enable ${n} models`. */
    label: (count: number) => string;
    /** The models this action would change. Others are skipped and not counted. Default: every target. */
    appliesTo?: (model: ModelInfo) => boolean;
    run: (models: ModelInfo[]) => void | Promise<void>;
    danger?: boolean;
}

/**
 * Footer of the list column. Targets are the selected models when there is a selection, otherwise every model
 * that matches the search, filters and rail entry. Each action counts only the targets it would change and hides
 * at zero. A change of `confirmAt` models or more asks first.
 */
export function BulkBar({
    targets,
    scopeLabel,
    actions,
    confirmAt,
    selection,
}: {
    targets: readonly ModelInfo[];
    scopeLabel: string;
    actions: readonly BulkAction[];
    confirmAt: number;
    selection:
        | { count: number; allSelected: boolean; someSelected: boolean; toggleAll: () => void; clear: () => void }
        | undefined;
}) {
    const t = useT();
    const [pending, setPending] = useState<{ action: BulkAction; models: ModelInfo[] } | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const running = useRef(false);
    const run = async (action: BulkAction, models: ModelInfo[]) => {
        if (running.current) return;
        running.current = true;
        setBusy(action.id);
        try {
            await action.run(models);
        } catch (error) {
            toast.error(t("models-browser-bulk-failed"), { description: errorDescription(error) });
        } finally {
            running.current = false;
            setBusy(null);
        }
    };
    const plans = actions
        .map((action) => ({ action, models: action.appliesTo ? targets.filter(action.appliesTo) : targets.slice() }))
        .filter((p) => p.models.length > 0);
    const names = (ms: ModelInfo[]) => {
        const head = ms.slice(0, 3).map((m) => m.name);
        return ms.length > 3
            ? t("models-browser-bulk-more", { names: joinList(head), count: ms.length - 3 })
            : joinList(head);
    };
    return (
        <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-1.5">
            {selection ? (
                <button
                    type="button"
                    role="checkbox"
                    aria-checked={selection.allSelected ? true : selection.someSelected ? "mixed" : false}
                    onClick={selection.toggleAll}
                    className="inline-flex h-7 items-center gap-1.5 rounded-lg px-1.5 text-sm text-secondary outline-none hover-device:hover:bg-hover hover-device:hover:text-text focus-visible:outline-2 focus-visible:outline-ring"
                >
                    {selection.allSelected ? (
                        <CheckSquare weight="fill" className="size-5 text-accent-text" />
                    ) : selection.someSelected ? (
                        <MinusSquare weight="fill" className="size-5 text-accent-text" />
                    ) : (
                        <Square className="size-5" />
                    )}
                    {selection.count
                        ? t("models-browser-selected", { count: selection.count })
                        : t("models-browser-select-all", { scope: scopeLabel })}
                </button>
            ) : (
                <span className="px-1.5 text-sm text-tertiary tabular-nums">{scopeLabel}</span>
            )}
            {selection && selection.count > 0 && (
                <Button size="md" onClick={selection.clear}>
                    {t("models-browser-clear")}
                </Button>
            )}
            <span className="ms-auto flex flex-wrap items-center gap-1.5">
                {plans.map(({ action, models }) => (
                    <Button
                        key={action.id}
                        size="md"
                        variant={action.danger ? "outline" : "soft"}
                        disabled={busy !== null}
                        aria-busy={busy === action.id || undefined}
                        onClick={() =>
                            action.danger || models.length >= confirmAt
                                ? setPending({ action, models })
                                : void run(action, models)
                        }
                        className="tabular-nums"
                    >
                        {action.label(models.length)}
                    </Button>
                ))}
            </span>
            {pending && (
                <ConfirmDialog
                    open
                    onOpenChange={(o) => !o && setPending(null)}
                    title={t("models-browser-bulk-title", { label: pending.action.label(pending.models.length) })}
                    description={t("models-browser-bulk-description", {
                        count: pending.models.length,
                        names: names(pending.models),
                    })}
                    confirmLabel={pending.action.label(pending.models.length)}
                    danger={pending.action.danger}
                    onConfirm={() => void run(pending.action, pending.models)}
                />
            )}
        </div>
    );
}
