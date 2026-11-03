/**
 * Body of the model picker, built as a sibling of the app's other menus: the same surface, row metrics, hover
 * pill and section labels as the shared Menu, the "+" menu and the effort menu.
 *
 * - A slim rail of 28px vendor (or provider) logo buttons sits inside the same surface: Favourites first,
 *   then one button per group, and a two-way segmented control at the foot to group by vendor or provider
 *   (setting `ui.models.groupBy`). Selected is the soft hover pill.
 * - An inline filter at the top (no rule under it), like the "/" menu. While it is empty a muted shortcut
 *   hint shows. Typing ranks every model in one flat list.
 * - Rows: logo, name, one muted meta line ("128K · Free · Vision"). The current model has a check; the star
 *   shows on hover, highlight or when set.
 * - Details live in a hover card beside the menu (after 400ms, or ArrowRight on the highlighted row). It takes
 *   no space until it is asked for.
 *
 * The list is virtualised with fixed row heights (density-aware), so 2,000 models stay cheap per keystroke.
 */
import type { ModelInfo } from "@pikvm/chat-protocol";
import {
    Buildings,
    CaretRight,
    Check,
    Cube,
    HardDrives,
    MagnifyingGlass,
    Plus,
    Sparkle,
    Star,
    WarningCircle,
} from "@pikvm/icons";
import { useNavigate } from "../../nav";
import {
    memo,
    useCallback,
    useDeferredValue,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type KeyboardEvent,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useT } from "../../l10n/provider";
import { translate, type Translate } from "../../l10n/runtime";
import { isMac, shortcutLabel } from "../../lib/media";
import { touchTarget } from "../../lib/touch";
import { useSetting } from "../../lib/queries";
import { EFFORT_LABELS } from "../composer/choice";
import { EmptyState, ErrorState } from "../ui/state";
import { Tooltip } from "../ui/tooltip";
import {
    formatCost,
    formatTokens,
    groupOf,
    groupsOf,
    identityOf,
    inputLabel,
    isFreeCost,
    modelFacts,
    readRecent,
    rowByline,
    sortedModels,
    useFavorites,
    useModels,
    writeSetting,
    type Group,
    type GroupBy,
} from "./models";
import { ModelMark, ProviderLogo } from "./provider-logo";
import { searchModels } from "./search";
import { useThemeLayer } from "../../lib/theme-scope";

type Item =
    | { kind: "header"; key: string; label: string }
    | { kind: "auto"; key: string; label: string; description: string }
    | { kind: "model"; key: string; model: ModelInfo; chip?: number }
    | { kind: "legacy"; key: string; group: string; count: number; expanded: boolean }
    | { kind: "error"; key: string; provider: string; message: string }
    | { kind: "skeleton"; key: string }
    | { kind: "hint"; key: string; title: string; text: string };

export interface PickerContentProps {
    models: ModelInfo[];
    value: string | undefined;
    onSelect: (id: string) => void;
    /** Escape: close without selecting. */
    onClose: () => void;
    mobile: boolean;
    /** Search text on open (for example from "/model fa"). */
    initialQuery?: string;
    /**
     * A pinned first row that chooses "no model" (`onSelect("")`): Automatic in settings. It is checked when `value`
     * is empty, and hidden while a query is typed. `description` says what it resolves to now.
     */
    pinned?: PickerPinned;
    /** Settings section the empty state links to (default "providers"; "admin-providers" for administrators). */
    providersSection?: string;
    /** Show the Mod+Shift+M hint in the filter. Off where that shortcut does not open this picker (settings). */
    shortcutHint?: boolean;
    /** Extra content under the list (settings: "Use a model not in the list"). */
    footer?: ReactNode;
}

export interface PickerPinned {
    label: string;
    description: string;
}

const FAVORITES = "__favorites__";
const OVERSCAN = 6;
const HOVER_CARD_DELAY = 400;

/**
 * Tonal tiers instead of dividers: the rail sits one step below the menu surface (recessed), the list on the menu
 * surface itself, and the hover card one step above (`--elevated`, own shadow). Both recessed formulas derive from
 * the theme seeds, so presets keep the same steps. Dark: a mix of the menu toward the darker page-under tone.
 * Light: the menu with a little ink, because the light page-under tone is too close to white to read.
 */
const tiers =
    "[--picker-recessed:color-mix(in_srgb,var(--menu)_45%,var(--surface-under))] [[data-theme=light]_&]:[--picker-recessed:color-mix(in_srgb,var(--seed-ink)_4.5%,var(--menu))]";

/**
 * Row heights follow the shared menu rows (`--menu-row-height`, 36px x density): single-line rows use it as is,
 * model rows add one 16px meta line. Text lines are fixed, padding follows `--density`.
 */
function rowHeights(density: number, mobile: boolean) {
    const pad = (n: number) => Math.round(n * density);
    const row = Math.round(36 * density);
    return {
        header: 20 + pad(12),
        model: mobile ? 24 + 16 + pad(16) : row + pad(10),
        auto: mobile ? 24 + 16 + pad(16) : row + pad(10),
        legacy: mobile ? 44 : row,
        error: row + pad(10),
        skeleton: row + pad(10),
        hint: 84,
    } as const;
}

function useDensity(): number {
    const [d] = useState(() => {
        const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--density"));
        return Number.isFinite(v) && v > 0 ? v : 1;
    });
    return d;
}

/** "128K · Free · Vision"; with `who`, the vendor or provider name leads. */
function metaLine(m: ModelInfo, who: string | undefined): string {
    const parts: string[] = [];
    if (who) parts.push(who);
    const ctx = formatTokens(m.contextWindow);
    if (ctx) parts.push(ctx);
    const inCost = formatCost(m.cost?.input);
    const outCost = formatCost(m.cost?.output);
    if (isFreeCost(m)) parts.push(translate("models-cost-free"));
    else if (inCost && outCost) parts.push(`${inCost}/${outCost}`);
    for (const i of m.input) if (i !== "text") parts.push(inputLabel(i));
    return parts.join(" · ");
}

function buildItems(
    models: ModelInfo[],
    query: string,
    tab: string,
    favorites: string[],
    recent: string[],
    legacyOpen: Set<string>,
    errors: { provider: string; message: string }[],
    by: GroupBy,
    groups: Map<string, Group>,
    t: Translate,
): Item[] {
    const items: Item[] = [];
    if (query.trim()) {
        for (const m of searchModels(models, query)) items.push({ kind: "model", key: `q:${m.id}`, model: m });
    } else if (tab === FAVORITES) {
        const byId = new Map(models.map((m) => [m.id, m]));
        const favs = favorites.map((id) => byId.get(id)).filter((m): m is ModelInfo => !!m);
        if (favs.length) {
            items.push({ kind: "header", key: "h:fav", label: t("models-favorites") });
            for (const m of favs) items.push({ kind: "model", key: `f:${m.id}`, model: m });
        }
        const favSet = new Set(favorites);
        const recents = recent
            .filter((id) => !favSet.has(id))
            .map((id) => byId.get(id))
            .filter((m): m is ModelInfo => !!m);
        if (recents.length) {
            items.push({ kind: "header", key: "h:recent", label: t("models-picker-recent") });
            for (const m of recents) items.push({ kind: "model", key: `r:${m.id}`, model: m });
        }
        if (!favs.length && !recents.length) {
            items.push({
                kind: "hint",
                key: "hint:fav",
                title: t("models-picker-no-favorites-title"),
                text: t("models-picker-no-favorites-text", { shortcut: shortcutLabel("Mod+D") }),
            });
        }
    } else {
        // Browse order is the shared sort (vendor, family, version, tier); a typed query keeps its own ranking.
        const own = sortedModels(models.filter((m) => groupOf(m, by).id === tab));
        items.push({ kind: "header", key: `h:${tab}`, label: groups.get(tab)?.name ?? tab });
        for (const m of own) if (!m.legacy) items.push({ kind: "model", key: `g:${m.id}`, model: m });
        const legacy = own.filter((m) => m.legacy);
        if (legacy.length) {
            const expanded = legacyOpen.has(tab);
            items.push({ kind: "legacy", key: `l:${tab}`, group: tab, count: legacy.length, expanded });
            if (expanded) for (const m of legacy) items.push({ kind: "model", key: `g:${m.id}`, model: m });
        }
    }
    if (errors.length && !query.trim()) {
        items.push({ kind: "header", key: "h:err", label: t("models-picker-unavailable") });
        for (const e of errors)
            items.push({ kind: "error", key: `e:${e.provider}`, provider: e.provider, message: e.message });
    }
    // Mod+1..9 go to the first nine models in display order.
    let n = 0;
    for (const it of items) {
        if (it.kind !== "model") continue;
        if (n >= 9) break;
        it.chip = ++n;
    }
    return items;
}

const selectable = (it: Item | undefined) =>
    !!it && (it.kind === "model" || it.kind === "legacy" || it.kind === "auto");

/** The row that is the current choice: the model with the id, or the pinned row when the value is empty. */
const isCurrent = (it: Item, value: string | undefined) =>
    (it.kind === "model" && it.model.id === value) || (it.kind === "auto" && !value);

export function PickerContent({
    models,
    value,
    onSelect,
    onClose,
    mobile,
    initialQuery = "",
    pinned: pinnedChoice,
    providersSection = "providers",
    shortcutHint = true,
    footer,
}: PickerContentProps) {
    const t = useT();
    const { favorites, toggle } = useFavorites();
    const { data: catalogue, isLoading, isError, error, refetch, isRefetching } = useModels();
    const navigate = useNavigate();
    const errors = catalogue?.errors ?? [];
    const [recent] = useState(readRecent);
    const current = useMemo(() => models.find((m) => m.id === value), [models, value]);
    const [query, setQuery] = useState(initialQuery);
    const deferredQuery = useDeferredValue(query);
    const searching = deferredQuery.trim().length > 0;
    const groupBy = useSetting<GroupBy>("ui.models.groupBy", "vendor");
    const groups = useMemo(() => groupsOf(models, groupBy), [models, groupBy]);
    const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
    const counts = useMemo(() => {
        const c = new Map<string, number>();
        for (const m of models) {
            const id = groupOf(m, groupBy).id;
            c.set(id, (c.get(id) ?? 0) + 1);
        }
        return c;
    }, [models, groupBy]);
    const homeTab = useCallback(
        () => (current ? groupOf(current, groupBy).id : (groups[0]?.id ?? FAVORITES)),
        [current, groupBy, groups],
    );
    const [tab, setTab] = useState(homeTab);
    useEffect(() => setTab((t) => (t === FAVORITES ? t : homeTab())), [groupBy, homeTab]);
    const tabs = useMemo(() => [FAVORITES, ...groups.map((g) => g.id)], [groups]);
    const [legacyOpen, setLegacyOpen] = useState(() => new Set(current?.legacy ? [groupOf(current, groupBy).id] : []));
    const favSet = useMemo(() => new Set(favorites), [favorites]);
    const density = useDensity();
    const heights = useMemo(() => rowHeights(density, mobile), [density, mobile]);

    const items: Item[] = useMemo(() => {
        const auto: Item[] =
            pinnedChoice && !deferredQuery.trim()
                ? [{ kind: "auto", key: "auto", label: pinnedChoice.label, description: pinnedChoice.description }]
                : [];
        if (isLoading && !models.length)
            return [...auto, ...Array.from({ length: 5 }, (_, i) => ({ kind: "skeleton" as const, key: `s${i}` }))];
        // No models at all: the empty state says why, instead of the Favorites hint.
        if (!models.length) return auto;
        return [
            ...auto,
            ...buildItems(models, deferredQuery, tab, favorites, recent, legacyOpen, errors, groupBy, groupMap, t),
        ];
    }, [
        models,
        deferredQuery,
        tab,
        favorites,
        recent,
        legacyOpen,
        errors,
        isLoading,
        groupBy,
        groupMap,
        t,
        pinnedChoice,
    ]);

    // Fixed heights give exact offsets for the virtual window and the pinned section label.
    const layout = useMemo(() => {
        const offsets = new Array<number>(items.length);
        const section = new Array<number>(items.length);
        let y = 0;
        let head = -1;
        items.forEach((it, i) => {
            offsets[i] = y;
            if (it.kind === "header") head = i;
            section[i] = head;
            y += heights[it.kind];
        });
        return { offsets, section, total: y };
    }, [items, heights]);

    const [highlight, setHighlight] = useState(-1);
    const listId = useId();
    const optionId = (i: number) => `${listId}-o${i}`;
    const input = useRef<HTMLInputElement>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const [scroll, setScroll] = useState({ top: 0, height: 360 });
    const itemsRef = useRef(items);
    itemsRef.current = items;
    const userMoved = useRef(false);

    // Hover card: the row it belongs to and where to put it.
    const [card, setCard] = useState<{ index: number; rect: DOMRect } | null>(null);
    const cardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(cardTimer.current), []);

    // Centre the current row. It runs again while the person has not moved yet, whenever something that decides
    // the offset changes: the catalogue arriving after a cached first paint, a group switch, or the list box getting
    // its real height (Radix sets the popover height after it has measured the page, so the first height can be 0 and
    // the browser would clamp scrollTop to 0). Idempotent, so StrictMode's double effect run gives the same result.
    const layoutRef = useRef(layout);
    layoutRef.current = layout;
    const valueRef = useRef(value);
    valueRef.current = value;
    const searchingRef = useRef(searching);
    searchingRef.current = searching;
    const settle = useCallback(() => {
        const el = scroller.current;
        if (!el || userMoved.current || searchingRef.current || !el.clientHeight) return;
        const i = itemsRef.current.findIndex((it) => isCurrent(it, valueRef.current));
        if (i < 0) return;
        el.scrollTop = Math.max(0, (layoutRef.current.offsets[i] ?? 0) - el.clientHeight / 2 + heights.model / 2);
    }, [heights]);
    const settleRef = useRef(settle);
    settleRef.current = settle;

    useLayoutEffect(() => {
        if (searching) {
            setHighlight(items.findIndex(selectable));
            scroller.current?.scrollTo({ top: 0 });
            return;
        }
        if (userMoved.current) return;
        // Touch has no highlight (it would stick after the tap), but the current row is still scrolled into view.
        if (!mobile) setHighlight(items.findIndex((it) => isCurrent(it, value)));
        settle();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deferredQuery, tab, items.length, models.length, items.find((it) => it.kind !== "auto")?.kind]);

    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const measure = () => {
            setScroll({ top: el.scrollTop, height: el.clientHeight });
            settleRef.current();
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const onScroll = useCallback(() => {
        const el = scroller.current;
        if (el) setScroll({ top: el.scrollTop, height: el.clientHeight });
        clearTimeout(cardTimer.current);
        setCard(null);
    }, []);

    const reveal = useCallback(
        (i: number) => {
            const el = scroller.current;
            const top = layout.offsets[i];
            const it = itemsRef.current[i];
            if (!el || top === undefined || !it) return;
            const h = heights[it.kind];
            const pinned = heights.header;
            if (top - pinned < el.scrollTop) el.scrollTop = Math.max(0, top - pinned);
            else if (top + h > el.scrollTop + el.clientHeight) el.scrollTop = top + h - el.clientHeight;
        },
        [layout, heights],
    );

    const pick = useCallback(
        (i: number) => {
            const it = itemsRef.current[i];
            if (!it) return;
            if (it.kind === "legacy") {
                setLegacyOpen((s) => {
                    const next = new Set(s);
                    if (next.has(it.group)) next.delete(it.group);
                    else next.add(it.group);
                    return next;
                });
                return;
            }
            if (it.kind === "auto") onSelect("");
            else if (it.kind === "model") onSelect(it.model.id);
        },
        [onSelect],
    );

    const move = useCallback((from: number, dir: 1 | -1, steps = 1) => {
        const list = itemsRef.current;
        let i = from;
        let left = steps;
        let last = from;
        for (let guard = 0; guard < list.length * 2 && left > 0; guard++) {
            i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : i + dir;
            if (i < 0 || i >= list.length) {
                if (steps > 1) break;
                i = dir > 0 ? 0 : list.length - 1;
            }
            if (selectable(list[i])) {
                last = i;
                left--;
            }
        }
        return last;
    }, []);

    const switchTab = useCallback((t: string) => {
        userMoved.current = true;
        setTab(t);
        setHighlight(-1);
        clearTimeout(cardTimer.current);
        setCard(null);
        scroller.current?.scrollTo({ top: 0 });
    }, []);

    const showCard = useCallback(
        (i: number, delay: number) => {
            clearTimeout(cardTimer.current);
            if (mobile) return;
            cardTimer.current = setTimeout(() => {
                const el = document.getElementById(`${listId}-o${i}`);
                if (el && itemsRef.current[i]?.kind === "model")
                    setCard({ index: i, rect: el.getBoundingClientRect() });
            }, delay);
        },
        [mobile, listId],
    );
    const hideCard = useCallback(() => {
        clearTimeout(cardTimer.current);
        setCard(null);
    }, []);

    const go = useCallback(
        (i: number) => {
            if (i < 0) return;
            userMoved.current = true;
            setHighlight(i);
            reveal(i);
            clearTimeout(cardTimer.current);
            setCard(null);
        },
        [reveal],
    );

    // Focus the filter on open (desktop only: on touch it would raise the keyboard over the sheet).
    useEffect(() => {
        if (!mobile) input.current?.focus({ preventScroll: true });
    }, [mobile]);

    // Keys while open: Mod+1..9, Mod+D, Mod+Shift+Up/Down.
    const highlightRef = useRef(highlight);
    highlightRef.current = highlight;
    useEffect(() => {
        const onKey = (e: globalThis.KeyboardEvent) => {
            const mod = isMac ? e.metaKey : e.ctrlKey;
            if (!mod || e.altKey) return;
            const list = itemsRef.current;
            if (!e.shiftKey && /^[1-9]$/.test(e.key)) {
                const i = list.findIndex((it) => it.kind === "model" && it.chip === Number(e.key));
                if (i >= 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    pick(i);
                }
                return;
            }
            if (!e.shiftKey && e.key.toLowerCase() === "d") {
                const it = list[highlightRef.current];
                if (it?.kind === "model") {
                    e.preventDefault();
                    e.stopPropagation();
                    toggle(it.model.id);
                }
                return;
            }
            if (e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                e.stopPropagation();
                setTab((t) => {
                    const i = tabs.indexOf(t);
                    return tabs[(i + (e.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length] ?? t;
                });
                userMoved.current = true;
                setHighlight(-1);
                setCard(null);
                scroller.current?.scrollTo({ top: 0 });
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [pick, toggle, tabs]);

    const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.ctrlKey || e.metaKey) return;
        const page = Math.max(1, Math.floor(scroll.height / heights.model) - 1);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            go(move(highlight, e.key === "ArrowDown" ? 1 : -1));
        } else if (e.key === "PageDown" || e.key === "PageUp") {
            e.preventDefault();
            go(move(highlight, e.key === "PageDown" ? 1 : -1, page));
        } else if (e.key === "ArrowRight" && highlight >= 0 && input.current?.selectionStart === query.length) {
            if (itemsRef.current[highlight]?.kind !== "model") return;
            e.preventDefault();
            showCard(highlight, 0);
        } else if (e.key === "ArrowLeft" && card) {
            e.preventDefault();
            hideCard();
        } else if (e.key === "Enter") {
            if (e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (highlight >= 0) pick(highlight);
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (card) hideCard();
            else if (query) setQuery("");
            else onClose();
        }
    };

    // Virtual window.
    const { offsets, section, total } = layout;
    let first = 0;
    {
        let lo = 0;
        let hi = items.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const it = items[mid];
            if ((offsets[mid] ?? 0) + (it ? heights[it.kind] : 0) <= scroll.top) lo = mid + 1;
            else hi = mid - 1;
        }
        first = lo;
    }
    const start = Math.max(0, first - OVERSCAN);
    let end = first;
    while (end < items.length && (offsets[end] ?? 0) < scroll.top + scroll.height) end++;
    end = Math.min(items.length, end + OVERSCAN);

    // Pinned section label: the section of the first visible row, pushed up by the next label.
    const pinnedIndex = section[first] ?? -1;
    const pinned = pinnedIndex >= 0 && scroll.top > 0 ? items[pinnedIndex] : undefined;
    let pinnedShift = 0;
    if (pinned) {
        const next = items.findIndex((it, i) => i > pinnedIndex && it.kind === "header");
        if (next >= 0) pinnedShift = Math.min(0, (offsets[next] ?? 0) - scroll.top - heights.header);
    }

    const onHover = useCallback(
        (i: number) => {
            userMoved.current = true;
            setHighlight(i);
            setCard(null);
            showCard(i, HOVER_CARD_DELAY);
        },
        [showCard],
    );
    // The pinned row alone is not content: the empty states sit under it.
    const empty = items.every((it) => it.kind === "auto");
    const emptyTop = items[0]?.kind === "auto" ? heights.auto : 0;
    const cardItem = card ? items[card.index] : undefined;

    return (
        <div className={cn(tiers, "flex min-h-0 w-full", mobile ? "h-[min(72dvh,600px)]" : "h-full")}>
            <VendorRail
                groups={groups}
                counts={counts}
                favorites={favorites.length}
                tab={searching ? "" : tab}
                onTab={switchTab}
                mobile={mobile}
                groupBy={groupBy}
            />
            <div className={cn("flex min-h-0 min-w-0 flex-col p-1.5", mobile ? "flex-1" : "w-[360px]")}>
                <label className="flex min-h-[var(--menu-row-height)] shrink-0 items-center gap-2.5 rounded-xl px-2.5">
                    <MagnifyingGlass aria-hidden className="size-5 shrink-0 text-tertiary" />
                    <input
                        ref={input}
                        role="combobox"
                        aria-label={t("models-picker-search")}
                        aria-autocomplete="list"
                        aria-expanded
                        aria-controls={listId}
                        aria-activedescendant={
                            highlight >= 0 && selectable(items[highlight]) ? optionId(highlight) : undefined
                        }
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        placeholder={t("models-picker-search")}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={onInputKey}
                        className={cn(
                            "min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-tertiary focus-visible:outline-none",
                            mobile ? "h-10 text-md" : "text-sm leading-5",
                        )}
                    />
                    {!mobile && !query && shortcutHint && (
                        <kbd className="shrink-0 font-sans text-xs text-tertiary">{shortcutLabel("Mod+Shift+M")}</kbd>
                    )}
                </label>
                <div className="relative min-h-0 flex-1">
                    {pinned?.kind === "header" && (
                        <div
                            aria-hidden
                            className="pointer-events-none absolute inset-x-0 top-0 z-10"
                            style={{ transform: `translateY(${pinnedShift}px)` }}
                        >
                            <SectionLabel label={pinned.label} height={heights.header} />
                        </div>
                    )}
                    <div
                        ref={scroller}
                        data-sheet-scroll
                        onScroll={onScroll}
                        onWheel={() => (userMoved.current = true)}
                        onTouchMove={() => (userMoved.current = true)}
                        onPointerLeave={() => {
                            if (!mobile) setHighlight(-1);
                            clearTimeout(cardTimer.current);
                        }}
                        className="h-full touch-pan-y overflow-y-auto overscroll-contain"
                    >
                        <div
                            id={listId}
                            role="listbox"
                            aria-label={t("models-picker-list")}
                            className="relative"
                            style={{ height: Math.max(total, 1) }}
                        >
                            {items.slice(start, end).map((it, k) => {
                                const i = start + k;
                                const style = { top: offsets[i], height: heights[it.kind] };
                                if (it.kind === "header")
                                    return (
                                        <SectionLabel
                                            key={it.key}
                                            label={it.label}
                                            height={heights.header}
                                            style={style}
                                        />
                                    );
                                if (it.kind === "skeleton") return <SkeletonRow key={it.key} style={style} />;
                                if (it.kind === "auto")
                                    return (
                                        <PinnedRow
                                            key={it.key}
                                            id={optionId(i)}
                                            index={i}
                                            label={it.label}
                                            description={it.description}
                                            selected={!value}
                                            highlighted={highlight === i}
                                            mobile={mobile}
                                            onHover={onHover}
                                            onPick={pick}
                                            style={style}
                                        />
                                    );
                                if (it.kind === "error")
                                    return (
                                        <ErrorRow
                                            key={it.key}
                                            provider={it.provider}
                                            message={it.message}
                                            style={style}
                                        />
                                    );
                                if (it.kind === "hint")
                                    return (
                                        <div
                                            key={it.key}
                                            style={style}
                                            className="absolute inset-x-0 flex flex-col justify-center px-3 text-center"
                                        >
                                            <div className="text-sm text-text">{it.title}</div>
                                            <div className="mx-auto mt-1 max-w-64 text-xs text-tertiary">{it.text}</div>
                                        </div>
                                    );
                                if (it.kind === "legacy")
                                    return (
                                        <LegacyRow
                                            key={it.key}
                                            id={optionId(i)}
                                            index={i}
                                            count={it.count}
                                            expanded={it.expanded}
                                            highlighted={highlight === i}
                                            onHover={onHover}
                                            onPick={pick}
                                            style={style}
                                        />
                                    );
                                const m = it.model;
                                const who = rowByline(m, groupBy, searching || it.key[0] !== "g");
                                return (
                                    <ModelRow
                                        key={it.key}
                                        id={optionId(i)}
                                        index={i}
                                        model={m}
                                        meta={metaLine(m, who)}
                                        selected={m.id === value}
                                        highlighted={highlight === i}
                                        favorite={favSet.has(m.id)}
                                        mobile={mobile}
                                        onHover={onHover}
                                        onPick={pick}
                                        onStar={toggle}
                                        style={style}
                                    />
                                );
                            })}
                        </div>
                        {empty && (
                            <div
                                className="absolute inset-x-0 bottom-0 flex flex-col"
                                style={{ top: emptyTop }}
                                data-model-select-empty={!models.length || undefined}
                            >
                                {!models.length && isError ? (
                                    <ErrorState
                                        size="panel"
                                        placement="optical"
                                        title={t("models-error-title")}
                                        error={error}
                                        onRetry={() => void refetch()}
                                        retrying={isRefetching}
                                        details={false}
                                    />
                                ) : !models.length ? (
                                    <EmptyState
                                        size="panel"
                                        placement="optical"
                                        role="status"
                                        icon={Cube}
                                        title={t("models-no-models-title")}
                                        description={t("models-picker-empty-description")}
                                        action={{
                                            label: t("models-picker-add-provider"),
                                            icon: Plus,
                                            onClick: () => {
                                                onClose();
                                                void navigate({
                                                    to: "/settings/$section",
                                                    params: { section: providersSection },
                                                });
                                            },
                                        }}
                                    />
                                ) : (
                                    <EmptyState
                                        size="panel"
                                        placement="optical"
                                        role="status"
                                        icon={MagnifyingGlass}
                                        title={
                                            query
                                                ? t("models-picker-no-match", { query: query.trim() })
                                                : t("models-picker-no-group")
                                        }
                                        description={query ? t("models-picker-no-match-hint") : undefined}
                                    />
                                )}
                            </div>
                        )}
                    </div>
                </div>
                {footer}
            </div>
            {cardItem?.kind === "model" && card && (
                <HoverCard
                    model={cardItem.model}
                    chip={cardItem.chip}
                    favorite={favSet.has(cardItem.model.id)}
                    anchor={card.rect}
                />
            )}
        </div>
    );
}

/** Section label, as in the shared Menu (px-2.5, pb-1, text-sm tertiary). */
const SectionLabel = memo(function SectionLabel({
    label,
    height,
    style,
}: {
    label: string;
    height: number;
    style?: CSSProperties;
}) {
    return (
        <div
            role="presentation"
            style={{ ...style, height }}
            className={cn(
                "flex items-end bg-menu px-2.5 pb-1 text-sm leading-5 text-tertiary",
                style && "absolute inset-x-0",
            )}
        >
            <span className="truncate">{label}</span>
        </div>
    );
});

/** Shared menu row metrics (`menuItem`): px-2.5, gap-2.5, radius xl, text-sm, 20px icons, hover pill. */
const rowBase =
    "group/row absolute inset-x-0 flex cursor-default items-center gap-2.5 rounded-xl px-2.5 text-text select-none";

const ModelRow = memo(function ModelRow({
    id,
    index,
    model,
    meta,
    selected,
    highlighted,
    favorite,
    mobile,
    onHover,
    onPick,
    onStar,
    style,
}: {
    id: string;
    index: number;
    model: ModelInfo;
    meta: string;
    selected: boolean;
    highlighted: boolean;
    favorite: boolean;
    mobile: boolean;
    onHover: (i: number) => void;
    onPick: (i: number) => void;
    onStar: (id: string) => void;
    style: CSSProperties;
}) {
    // Read from context so a locale switch re-renders this memoised row.
    const t = useT();
    const starLabel = favorite ? t("models-favorite-remove") : t("models-favorite-add");
    return (
        <div
            id={id}
            role="option"
            aria-label={identityOf(model).label}
            aria-selected={selected}
            data-highlighted={highlighted || undefined}
            onPointerMove={(e) => e.pointerType === "mouse" && !highlighted && onHover(index)}
            onClick={() => onPick(index)}
            style={style}
            className={cn(rowBase, highlighted && "bg-hover")}
        >
            <span className="flex w-5 shrink-0 justify-center">
                <ModelMark model={model} size={20} />
            </span>
            <span className="min-w-0 flex-1">
                <span className={cn("block truncate", mobile ? "text-md leading-6" : "text-sm leading-5")}>
                    {model.name}
                </span>
                {meta && <span className="block truncate text-xs leading-4 text-tertiary">{meta}</span>}
            </span>
            <button
                type="button"
                aria-label={starLabel}
                aria-pressed={favorite}
                tabIndex={-1}
                onClick={(e) => {
                    e.stopPropagation();
                    onStar(model.id);
                }}
                className={cn(
                    "relative flex shrink-0 items-center justify-center rounded-lg outline-none hover-device:hover:bg-hover hover-device:hover:text-text",
                    mobile ? "size-10" : "size-7",
                    touchTarget,
                    favorite ? "text-text" : "text-tertiary",
                    !favorite && !mobile && "invisible group-hover/row:visible group-data-[highlighted]/row:visible",
                )}
            >
                <Star weight={favorite ? "fill" : "regular"} className="size-4" />
            </button>
            {/* The check sits at the end; other rows keep its slot so the stars line up. */}
            {selected ? (
                <Check aria-label={t("models-current")} className="size-5 shrink-0" />
            ) : (
                <span aria-hidden className="size-5 shrink-0" />
            )}
        </div>
    );
});

/** The pinned "no model" row (Automatic): a Sparkle mark, the label, what it resolves to, and the end check. */
const PinnedRow = memo(function PinnedRow({
    id,
    index,
    label,
    description,
    selected,
    highlighted,
    mobile,
    onHover,
    onPick,
    style,
}: {
    id: string;
    index: number;
    label: string;
    description: string;
    selected: boolean;
    highlighted: boolean;
    mobile: boolean;
    onHover: (i: number) => void;
    onPick: (i: number) => void;
    style: CSSProperties;
}) {
    const t = useT();
    return (
        <div
            id={id}
            role="option"
            aria-label={label}
            aria-selected={selected}
            data-pinned-choice=""
            data-highlighted={highlighted || undefined}
            onPointerMove={(e) => e.pointerType === "mouse" && !highlighted && onHover(index)}
            onClick={() => onPick(index)}
            style={style}
            className={cn(rowBase, highlighted && "bg-hover")}
        >
            <span className="flex w-5 shrink-0 justify-center text-icon-secondary">
                <Sparkle aria-hidden className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
                <span className={cn("block truncate", mobile ? "text-md leading-6" : "text-sm leading-5")}>
                    {label}
                </span>
                <span className="block truncate text-xs leading-4 text-tertiary">{description}</span>
            </span>
            {/* Keeps the star slot of the model rows, so the checks line up. */}
            <span aria-hidden className={cn("shrink-0", mobile ? "size-10" : "size-7")} />
            {selected ? (
                <Check aria-label={t("models-current")} className="size-5 shrink-0" />
            ) : (
                <span aria-hidden className="size-5 shrink-0" />
            )}
        </div>
    );
});

const LegacyRow = memo(function LegacyRow({
    id,
    index,
    count,
    expanded,
    highlighted,
    onHover,
    onPick,
    style,
}: {
    id: string;
    index: number;
    count: number;
    expanded: boolean;
    highlighted: boolean;
    onHover: (i: number) => void;
    onPick: (i: number) => void;
    style: CSSProperties;
}) {
    const t = useT();
    return (
        <div
            id={id}
            role="option"
            aria-selected={false}
            aria-expanded={expanded}
            data-highlighted={highlighted || undefined}
            onPointerMove={(e) => e.pointerType === "mouse" && !highlighted && onHover(index)}
            onClick={() => onPick(index)}
            style={style}
            className={cn(rowBase, "text-tertiary", highlighted && "bg-hover text-text")}
        >
            <span className="flex w-5 shrink-0 justify-center">
                <CaretRight
                    aria-hidden
                    className={cn(
                        "size-4 transition-transform duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]",
                        expanded && "rotate-90",
                    )}
                />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">{t("models-picker-older")}</span>
            <span className="shrink-0 text-xs tabular-nums">{count}</span>
        </div>
    );
});

function ErrorRow({ provider, message, style }: { provider: string; message: string; style: CSSProperties }) {
    return (
        <div role="note" style={style} className="absolute inset-x-0 flex items-center gap-2.5 px-2.5">
            <span className="flex w-5 shrink-0 justify-center text-danger">
                <WarningCircle aria-hidden className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm leading-5 text-danger">{provider}</span>
                <span className="block truncate text-xs leading-4 text-tertiary">{message}</span>
            </span>
        </div>
    );
}

function SkeletonRow({ style }: { style: CSSProperties }) {
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

/**
 * Details beside the menu: same surface as the menu, no animation (like tooltips). It sits to the right of the
 * menu, or to the left when there is no room, and stays inside the viewport.
 */
function HoverCard({
    model,
    chip,
    favorite,
    anchor,
}: {
    model: ModelInfo;
    chip?: number;
    favorite: boolean;
    anchor: DOMRect;
}) {
    const layer = useThemeLayer();
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const menu =
            document.querySelector<HTMLElement>("[data-model-picker-surface]")?.getBoundingClientRect() ?? anchor;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const gap = 8;
        let left = menu.right + gap;
        if (left + w > innerWidth - 8) left = menu.left - gap - w;
        const top = Math.min(Math.max(8, anchor.top - 6), innerHeight - h - 8);
        setPos({ left: Math.max(8, left), top });
    }, [anchor, model.id]);

    const t = useT();
    const facts = modelFacts(model, { tools: false, effortLabel: (e) => EFFORT_LABELS[e] });

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
                    <div className="truncate text-xs text-tertiary">
                        {favorite
                            ? t("models-picker-favorite-note", { byline: identityOf(model).byline })
                            : identityOf(model).byline}
                    </div>
                </div>
            </div>
            <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                {facts.map(([k, v]) => (
                    <div key={k} className="contents">
                        <dt className="text-tertiary">{k}</dt>
                        <dd className="min-w-0 break-words tabular-nums">{v}</dd>
                    </div>
                ))}
            </dl>
            <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-tertiary">
                <span>
                    <kbd className="font-sans text-secondary">{t("models-key-enter")}</kbd> {t("models-hint-choose")}
                </span>
                {chip !== undefined && (
                    <span>
                        <kbd className="font-sans text-secondary">{shortcutLabel(`Mod+${chip}`)}</kbd>{" "}
                        {t("models-hint-pick")}
                    </span>
                )}
                <span>
                    <kbd className="font-sans text-secondary">{shortcutLabel("Mod+D")}</kbd> {t("models-hint-favorite")}
                </span>
            </div>
        </div>,
        layer ?? document.body,
    );
}

/**
 * Slim rail of 28px logo buttons on the menu surface: Favourites first, then one button per group, and a
 * two-way segmented control at the foot to group by vendor or provider. Selected is the soft hover pill.
 */
const VendorRail = memo(function VendorRail({
    groups,
    counts,
    favorites,
    tab,
    onTab,
    mobile,
    groupBy,
}: {
    groups: Group[];
    counts: Map<string, number>;
    favorites: number;
    tab: string;
    onTab: (t: string) => void;
    mobile: boolean;
    groupBy: GroupBy;
}) {
    const t = useT();
    const rail = useRef<HTMLDivElement>(null);
    // Roving focus: arrows move between groups (wrapping), Enter or Space chooses.
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
    const size = mobile ? "size-10" : "size-8";
    const button = (
        id: string,
        label: string,
        icon: ReactNode,
        active: boolean,
        onClick: () => void,
        inRail = true,
    ) => (
        <Tooltip key={id} label={label} side="left">
            <button
                type="button"
                data-rail-item={inRail || undefined}
                aria-label={label}
                aria-pressed={active}
                tabIndex={inRail ? (active || (!tab && id === FAVORITES) ? 0 : -1) : 0}
                onClick={onClick}
                className={cn(
                    "relative flex shrink-0 items-center justify-center rounded-lg outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    size,
                    touchTarget,
                    // Selected lifts to the list tone; hover stays the shared overlay, so both read on the rail.
                    active
                        ? "bg-menu text-text shadow-[0_0_0_0.5px_var(--border-strong)]"
                        : "text-tertiary hover-device:hover:bg-hover hover-device:hover:text-text",
                )}
            >
                {icon}
            </button>
        </Tooltip>
    );
    const plural = (n: number) => t("models-count", { count: n });
    return (
        <div
            ref={rail}
            role="toolbar"
            aria-orientation="vertical"
            aria-label={groupBy === "vendor" ? t("models-vendors") : t("models-providers")}
            onKeyDown={onKey}
            className="no-scrollbar flex shrink-0 flex-col items-center gap-0.5 overflow-y-auto bg-[var(--picker-recessed)] p-1.5"
        >
            {button(
                FAVORITES,
                t("models-rail-entry", { name: t("models-favorites"), count: plural(favorites) }),
                <Star weight={tab === FAVORITES ? "fill" : "regular"} className="size-5" />,
                tab === FAVORITES,
                () => onTab(FAVORITES),
            )}
            {groups.map((g) =>
                button(
                    g.id,
                    t("models-rail-entry", { name: g.name, count: plural(counts.get(g.id) ?? 0) }),
                    <ProviderLogo src={g.logo} name={g.name} size={20} />,
                    tab === g.id,
                    () => onTab(g.id),
                ),
            )}
            {/* A recessed well (one tier below the rail) instead of a divider rule. */}
            <div
                role="group"
                aria-label={t("models-group-by")}
                className="mt-auto flex shrink-0 flex-col gap-0.5 rounded-xl bg-hover p-0.5"
            >
                {button(
                    "by-vendor",
                    t("models-group-by-vendor"),
                    <Buildings className="size-5" />,
                    groupBy === "vendor",
                    () => writeSetting("ui.models.groupBy", "vendor"),
                    false,
                )}
                {button(
                    "by-provider",
                    t("models-group-by-provider"),
                    <HardDrives className="size-5" />,
                    groupBy === "provider",
                    () => writeSetting("ui.models.groupBy", "provider"),
                    false,
                )}
            </div>
        </div>
    );
});
