/**
 * ModelBrowser: search, filter and act on a long model list (hundreds or thousands of models). Built from the
 * composer's model picker (rail, search field, grouped rows, hover card, favourites, `ui.models.groupBy`) as one
 * embeddable primitive for settings pages and popovers.
 *
 * Layout follows the container, not the viewport:
 * - wide (>= 760px with `renderDetail`): rail | list | detail column, all in one surface.
 * - narrow: rail | list; Enter or a click on a row drills into the detail view with a back button.
 * - the rail shows names and counts from 600px (980px with a detail column), logo buttons below that.
 *
 * Keyboard. Two focus stops: the search field and the list (one tab stop, `aria-activedescendant`).
 * - Search field: type to search; ArrowDown moves into the list; Enter opens the first result; Escape clears,
 *   then calls `onEscape`.
 * - List: arrows, Page Up/Down, Home/End move; Space runs `onToggle` (the row's primary control) or toggles the
 *   selection; Enter or ArrowRight opens the detail (or calls `onSelect`); typing goes back to the search field;
 *   ArrowUp on the first row and Escape return to it. Mod+D toggles a favourite.
 *
 * Scale: the index folds every searchable field once per catalogue; each keystroke ranks with `indexOf` on short
 * strings and renders only the visible rows (fixed heights, so offsets are exact). No debounce.
 */
import type { ModelInfo } from "@pikvm/chat-protocol";
import { Cube, MagnifyingGlass } from "@pikvm/icons";
import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
    type RefObject,
} from "react";
import { useLocale, useT } from "../../l10n/provider";
import { cn } from "../../lib/cn";
import { isMac, useCoarsePointer } from "../../lib/media";
import { useSetting } from "../../lib/queries";
import { typeaheadChar } from "../../lib/typeahead";
import { rowByline, useFavorites, writeSetting, type GroupBy } from "../model-picker/models";
import { EmptyState, ErrorState } from "../ui/state";
import {
    ALL,
    BackButton,
    BulkBar,
    DetailHeader,
    FAVORITES,
    FilterChips,
    HoverCard,
    metaLine,
    ModelFacts,
    ModelRow,
    PinnedRow,
    Rail,
    rowHeights,
    SectionLabel,
    SkeletonRow,
    tiers,
    type BulkAction,
    type RowContext,
} from "./parts";
import {
    buildIndex,
    capabilityFilters,
    highlightRanges,
    passes,
    queryTerms,
    rankEntries,
    type BrowserFilter,
    type IndexedModel,
    type ModelRowState,
} from "./search";

/**
 * A host entry listed above the models on "All models". Either it has its own detail (`renderDetail`, for example
 * "Defaults" on the features page) or it is a choice of its own (`onPick`, for example "Automatic" in a picker).
 * Search matches its label and description.
 */
export interface PinnedEntry {
    id: string;
    label: string;
    description?: string;
    icon?: ReactNode;
    renderDetail?: () => ReactNode;
    onPick?: () => void;
    /** The host's current choice: a check on the row. */
    current?: boolean;
}

export interface ModelBrowserSelection {
    ids: ReadonlySet<string>;
    onChange: (ids: Set<string>) => void;
}

export interface FavoritesBinding {
    ids: readonly string[];
    toggle: (id: string) => void;
}

export interface DetailContext {
    /** Set in the narrow drill-in view: go back to the list. */
    back?: () => void;
}

export interface ModelBrowserProps {
    models: readonly ModelInfo[];
    /** First load: skeleton rows until models arrive. */
    loading?: boolean;
    /** The list could not load. Shown only while there are no models. */
    error?: unknown;
    onRetry?: () => void;
    /** Grouping. Default: the `ui.models.groupBy` setting, written back when the rail control changes it. */
    groupBy?: GroupBy;
    onGroupByChange?: (by: GroupBy) => void;
    /** Favourites. Default: the `ui.models.favorites` setting. `false` hides the star and the rail entry. */
    favorites?: FavoritesBinding | false;
    /** The current model: a check on its row (picker use). */
    value?: string;
    /** A row was chosen (click, Enter) and there is no detail pane. */
    onSelect?: (model: ModelInfo) => void;
    /** Multi-selection: a checkbox per row and "Select all" in the footer. Bulk actions then run on it. */
    selection?: ModelBrowserSelection;
    /** Host state per row: drives the "Enabled" and "Changed" filters and dims muted rows. */
    rowState?: (model: ModelInfo) => ModelRowState;
    /** Controls at the end of each row: a Switch, an allow/deny/inherit control, a radio. */
    renderRowEnd?: (model: ModelInfo, ctx: RowContext) => ReactNode;
    /** Space on a row: flip its primary control (the one `renderRowEnd` shows). */
    onToggle?: (model: ModelInfo) => void;
    /** Detail pane for the active model: right column when wide, drill-in when narrow. */
    renderDetail?: (model: ModelInfo, ctx: DetailContext) => ReactNode;
    /** Host entries above the models: a detail of their own (needs `renderDetail`) or a choice (`onPick`). */
    pinned?: readonly PinnedEntry[];
    /** Heading over the pinned entries. Default "General" with a detail pane, none without. */
    pinnedLabel?: string;
    /**
     * The vendor or provider rail. "auto" (default) hides it when there is one group and nothing starred, where it
     * would only repeat "All models".
     */
    rail?: "auto" | "always";
    /** The vendor/provider switch at the foot of the rail. Default true. */
    groupToggle?: boolean;
    /** Filter chips. Default: the capability filters, plus "Enabled" and "Changed" when `rowState` is given. */
    filters?: readonly BrowserFilter[];
    bulkActions?: readonly BulkAction[];
    /** Ask before a bulk action changes this many models or more. Default 20. */
    confirmAt?: number;
    /** Shown when the host has no models at all (not when a search finds nothing). */
    emptyState?: ReactNode;
    /** CSS height. Default "100%": fill the container. */
    height?: number | string;
    /** No border or radius: the host gives the surface (popovers). */
    bare?: boolean;
    autoFocus?: boolean;
    initialQuery?: string;
    onEscape?: () => void;
    /** Accessible name of the list. Default "Models". */
    label?: string;
    /** Details on hover when there is no detail pane. Default true. */
    hoverCard?: boolean;
    className?: string;
}

type Item =
    | { kind: "header"; key: string; label: string; count?: number }
    | { kind: "model"; key: string; entry: IndexedModel }
    | { kind: "pinned"; key: string; pin: PinnedEntry }
    | { kind: "skeleton"; key: string };

const OVERSCAN = 6;
const HOVER_CARD_DELAY = 400;
const SPLIT_AT = 760;
const PIN = "pin:";

const selectable = (it: Item | undefined) => !!it && (it.kind === "model" || it.kind === "pinned");
const keyOf = (it: Item | undefined) =>
    it?.kind === "model" ? it.entry.model.id : it?.kind === "pinned" ? PIN + it.pin.id : undefined;

function useDensity(): number {
    const [density, setDensity] = useState(1);
    useLayoutEffect(() => {
        const root = document.documentElement;
        const measure = () => {
            const value = parseFloat(getComputedStyle(root).getPropertyValue("--density"));
            setDensity(Number.isFinite(value) && value > 0 ? value : 1);
        };
        measure();
        const observer = new MutationObserver(measure);
        observer.observe(root, { attributes: true, attributeFilter: ["style", "data-density"] });
        return () => observer.disconnect();
    }, []);
    return density;
}

/** Width of an element, kept current with a ResizeObserver. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
    const [w, setW] = useState(0);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        setW(el.clientWidth);
        const ro = new ResizeObserver(() => setW(el.clientWidth));
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
    return w;
}

export function ModelBrowser({
    models,
    loading = false,
    error,
    onRetry,
    groupBy: groupByProp,
    onGroupByChange,
    favorites: favoritesProp,
    value,
    onSelect,
    selection,
    rowState,
    renderRowEnd,
    onToggle,
    renderDetail,
    pinned,
    pinnedLabel,
    rail = "auto",
    groupToggle = true,
    filters: filtersProp,
    bulkActions,
    confirmAt = 20,
    emptyState,
    height = "100%",
    bare = false,
    autoFocus = false,
    initialQuery = "",
    onEscape,
    label,
    hoverCard = true,
    className,
}: ModelBrowserProps) {
    const t = useT();
    const { locale } = useLocale();
    const listLabel = label ?? t("models-browser-list");
    // Settings-backed defaults. Both hooks run always (hook order); a controlled prop wins.
    const groupBySetting = useSetting<GroupBy>("ui.models.groupBy", "vendor");
    const favoritesSetting = useFavorites();
    const groupBy = groupByProp ?? groupBySetting;
    const setGroupBy = useCallback(
        (by: GroupBy) => (onGroupByChange ? onGroupByChange(by) : writeSetting("ui.models.groupBy", by)),
        [onGroupByChange],
    );
    const fav =
        favoritesProp === false
            ? undefined
            : (favoritesProp ?? { ids: favoritesSetting.favorites, toggle: favoritesSetting.toggle });
    const favIds = fav?.ids;
    const favSet = useMemo(() => new Set(favIds ?? []), [favIds]);
    const toggleFavorite = fav?.toggle;

    const coarse = useCoarsePointer();
    const density = useDensity();
    const heights = useMemo(() => rowHeights(density, coarse), [density, coarse]);

    const root = useRef<HTMLDivElement>(null);
    const width = useWidth(root);
    const split = !!renderDetail && width >= SPLIT_AT;
    const labelledRail = width >= (split ? 980 : 600);

    const [query, setQuery] = useState(initialQuery);
    const [tab, setTab] = useState(ALL);
    const [filters, setFilters] = useState<ReadonlySet<BrowserFilter>>(() => new Set());
    const chips = useMemo(
        () => filtersProp ?? [...capabilityFilters, ...(rowState ? (["enabled", "changed"] as const) : [])],
        [filtersProp, rowState],
    );

    // Index, rank, filter. Each step is memoised on its own inputs, so a filter toggle does not re-rank.
    const index = useMemo(() => buildIndex(models, groupBy), [models, groupBy]);
    const terms = useMemo(() => queryTerms(query), [query]);
    const termsKey = terms.join(" ");
    const ranked = useMemo(() => rankEntries(index.entries, terms), [index, termsKey]); // eslint-disable-line react-hooks/exhaustive-deps
    const matches = useMemo(() => {
        if (!filters.size) return ranked;
        const fs = [...filters];
        const needsState = fs.some((f) => f === "enabled" || f === "changed");
        return ranked.filter((e) => {
            const st = needsState ? rowState?.(e.model) : undefined;
            return fs.every((f) => passes(f, e.model, st));
        });
    }, [ranked, filters, rowState]);
    const counts = useMemo(() => {
        const c = new Map<string, number>();
        let favorites = 0;
        for (const e of matches) {
            c.set(e.group.id, (c.get(e.group.id) ?? 0) + 1);
            if (favSet.has(e.model.id)) favorites++;
        }
        return { groups: c, favorites };
    }, [matches, favSet]);
    // A rail entry that no longer exists (group-by switched) falls back to All.
    const tabValid = tab === ALL || (tab === FAVORITES && !!fav) || index.groups.some((g) => g.id === tab);
    const scope = tabValid ? tab : ALL;
    const inScope = useMemo(() => {
        if (scope === ALL) return matches;
        if (scope === FAVORITES) return matches.filter((e) => favSet.has(e.model.id));
        return matches.filter((e) => e.group.id === scope);
    }, [matches, scope, favSet]);

    const searching = terms.length > 0;
    const narrowed = searching || filters.size > 0 || scope !== ALL;

    const items: Item[] = useMemo(() => {
        if (loading && !models.length)
            return Array.from({ length: 8 }, (_, i) => ({ kind: "skeleton" as const, key: `s${i}` }));
        const out: Item[] = [];
        const pins = (pinned ?? []).filter((p) => p.onPick || renderDetail);
        if (searching) {
            if (scope === ALL && !filters.size) {
                for (const pin of pins) {
                    const text = `${pin.label} ${pin.description ?? ""}`.toLowerCase();
                    if (terms.every((t) => text.includes(t))) out.push({ kind: "pinned", key: PIN + pin.id, pin });
                }
            }
            for (const e of inScope) out.push({ kind: "model", key: e.model.id, entry: e });
            return out;
        }
        if (scope === ALL) {
            if (pins.length && !filters.size) {
                const heading = pinnedLabel ?? (renderDetail ? t("models-browser-general") : undefined);
                if (heading) out.push({ kind: "header", key: "h:pinned", label: heading });
                for (const pin of pins) out.push({ kind: "pinned", key: PIN + pin.id, pin });
            }
            const buckets = new Map<string, IndexedModel[]>();
            for (const e of inScope) {
                const b = buckets.get(e.group.id);
                if (b) b.push(e);
                else buckets.set(e.group.id, [e]);
            }
            for (const g of index.groups) {
                const b = buckets.get(g.id);
                if (!b) continue;
                out.push({ kind: "header", key: `h:${g.id}`, label: g.name, count: b.length });
                for (const e of b) out.push({ kind: "model", key: e.model.id, entry: e });
            }
            return out;
        }
        const name =
            scope === FAVORITES ? t("models-favorites") : (index.groups.find((g) => g.id === scope)?.name ?? scope);
        if (inScope.length) out.push({ kind: "header", key: `h:${scope}`, label: name, count: inScope.length });
        for (const e of inScope) out.push({ kind: "model", key: e.model.id, entry: e });
        return out;
    }, [
        loading,
        models.length,
        searching,
        inScope,
        scope,
        pinned,
        pinnedLabel,
        renderDetail,
        filters.size,
        index.groups,
        termsKey,
        t,
    ]); // eslint-disable-line react-hooks/exhaustive-deps

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

    const listId = useId();
    const optionId = (i: number) => `${listId}-o${i}`;
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const detail = useRef<HTMLDivElement>(null);
    const [scroll, setScroll] = useState({ top: 0, height: 480 });
    const [highlight, setHighlight] = useState(-1);
    const [listFocused, setListFocused] = useState(false);
    const itemsRef = useRef(items);
    itemsRef.current = items;

    // Active entry (detail pane) and the narrow drill-in.
    const [active, setActive] = useState<string | undefined>(undefined);
    const [drill, setDrill] = useState(false);
    const activeKey = useMemo(() => {
        if (!renderDetail) return undefined;
        if (active && (items.some((it) => keyOf(it) === active) || drill)) return active;
        // The wide pane is never blank: it follows the first entry until the user picks one.
        return split ? keyOf(items.find(selectable)) : undefined;
    }, [renderDetail, active, items, split, drill]);

    // Card on hover (no detail pane only).
    const [card, setCard] = useState<{ key: string; rect: DOMRect; surface: DOMRect } | null>(null);
    const cardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(cardTimer.current), []);
    const cards = hoverCard && !renderDetail && !coarse;

    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const measure = () => setScroll({ top: el.scrollTop, height: el.clientHeight });
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [drill, split]);

    // A new search, filter or rail entry starts at the top; a search highlights its best result.
    useLayoutEffect(() => {
        setHighlight(searching ? itemsRef.current.findIndex(selectable) : -1);
        clearTimeout(cardTimer.current);
        setCard(null);
        scroller.current?.scrollTo({ top: 0 });
    }, [termsKey, filters, scope, groupBy, searching]);

    useEffect(() => {
        if (autoFocus && !coarse) input.current?.focus({ preventScroll: true });
    }, [autoFocus, coarse]);

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
            const pinnedLabel = heights.header;
            if (top - pinnedLabel < el.scrollTop) el.scrollTop = Math.max(0, top - pinnedLabel);
            else if (top + h > el.scrollTop + el.clientHeight) el.scrollTop = top + h - el.clientHeight;
        },
        [layout, heights],
    );

    const move = useCallback((from: number, dir: 1 | -1, steps = 1) => {
        const l = itemsRef.current;
        let i = from;
        let last = from;
        let left = steps;
        while (left > 0) {
            i += dir;
            if (i < 0 || i >= l.length) break;
            if (selectable(l[i])) {
                last = i;
                left--;
            }
        }
        return last;
    }, []);

    const go = useCallback(
        (i: number) => {
            if (i < 0) return;
            setHighlight(i);
            reveal(i);
            clearTimeout(cardTimer.current);
            setCard(null);
            // Wide: the detail follows the keyboard (selection follows focus).
            if (split) setActive(keyOf(itemsRef.current[i]));
        },
        [reveal, split],
    );

    const focusList = useCallback(() => list.current?.focus({ preventScroll: true }), []);
    const back = useCallback(() => {
        setDrill(false);
        requestAnimationFrame(focusList);
    }, [focusList]);

    /** Open a row: the detail (with focus moving into it when asked) or the host's onSelect. */
    const open = useCallback(
        (i: number, fromKeyboard: boolean) => {
            const it = itemsRef.current[i];
            const k = keyOf(it);
            if (!it || !k) return;
            setHighlight(i);
            if (it.kind === "pinned" && it.pin.onPick) {
                it.pin.onPick();
                return;
            }
            if (renderDetail || it.kind === "pinned") {
                setActive(k);
                if (!split) setDrill(true);
                if (fromKeyboard) requestAnimationFrame(() => detail.current?.focus({ preventScroll: true }));
                return;
            }
            if (it.kind === "model") onSelect?.(it.entry.model);
        },
        [renderDetail, split, onSelect],
    );
    const onPick = useCallback((i: number) => open(i, false), [open]);

    const selectionIds = selection?.ids;
    const onSelectionChange = selection?.onChange;
    const toggleSelect = useCallback(
        (id: string) => {
            if (!selectionIds || !onSelectionChange) return;
            const next = new Set(selectionIds);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            onSelectionChange(next);
        },
        [selectionIds, onSelectionChange],
    );

    const toggleRow = useCallback(
        (i: number) => {
            const it = itemsRef.current[i];
            if (it?.kind !== "model") return;
            if (onToggle) onToggle(it.entry.model);
            else toggleSelect(it.entry.model.id);
        },
        [onToggle, toggleSelect],
    );

    const showCard = useCallback(
        (i: number, delay: number) => {
            clearTimeout(cardTimer.current);
            if (!cards) return;
            cardTimer.current = setTimeout(() => {
                const el = document.getElementById(`${listId}-o${i}`);
                const item = itemsRef.current[i];
                if (el && root.current && item?.kind === "model") {
                    setCard({
                        key: item.key,
                        rect: el.getBoundingClientRect(),
                        surface: root.current.getBoundingClientRect(),
                    });
                }
            }, delay);
        },
        [cards, listId],
    );

    const onHover = useCallback(
        (i: number) => {
            setHighlight(i);
            setCard(null);
            showCard(i, HOVER_CARD_DELAY);
        },
        [showCard],
    );

    const page = Math.max(1, Math.floor(scroll.height / heights.model) - 1);

    const onRootKey = (e: KeyboardEvent<HTMLDivElement>) => {
        const mod = isMac ? e.metaKey : e.ctrlKey;
        if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "d" && toggleFavorite) {
            const it = itemsRef.current[highlight];
            if (it?.kind !== "model") return;
            e.preventDefault();
            e.stopPropagation();
            toggleFavorite(it.entry.model.id);
        }
    };

    const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            const i = highlight >= 0 ? highlight : itemsRef.current.findIndex(selectable);
            if (i < 0) return;
            go(i);
            focusList();
        } else if (e.key === "Enter") {
            e.preventDefault();
            const i = highlight >= 0 ? highlight : itemsRef.current.findIndex(selectable);
            if (i >= 0) open(i, true);
        } else if (e.key === "Escape") {
            if (query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
            } else if (onEscape) {
                e.preventDefault();
                e.stopPropagation();
                onEscape();
            }
        }
    };

    const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return;
        const n = itemsRef.current.length;
        const first = itemsRef.current.findIndex(selectable);
        const handled = () => {
            e.preventDefault();
            e.stopPropagation();
        };
        switch (e.key) {
            case "ArrowDown":
                handled();
                go(highlight < 0 ? first : move(highlight, 1));
                return;
            case "ArrowUp":
                handled();
                if (highlight <= first) input.current?.focus();
                else go(move(highlight, -1));
                return;
            case "PageDown":
            case "PageUp":
                handled();
                go(move(highlight < 0 ? first : highlight, e.key === "PageDown" ? 1 : -1, page));
                return;
            case "Home":
                handled();
                go(first);
                return;
            case "End":
                handled();
                go(move(n, -1));
                return;
            case " ":
                handled();
                if (highlight >= 0) toggleRow(highlight);
                return;
            case "Enter":
            case "ArrowRight":
                if (highlight < 0) return;
                handled();
                open(highlight, true);
                return;
            case "Escape":
                handled();
                input.current?.focus();
                return;
            case "Backspace":
                handled();
                setQuery((q) => q.slice(0, -1));
                input.current?.focus();
                return;
        }
        const ch = typeaheadChar(e);
        if (ch) {
            handled();
            setQuery((q) => q + ch);
            input.current?.focus();
        }
    };

    const onDetailKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        if (!split) back();
        else focusList();
    };

    const toggleFilter = useCallback((f: BrowserFilter) => {
        setFilters((s) => {
            const next = new Set(s);
            if (next.has(f)) next.delete(f);
            else next.add(f);
            return next;
        });
    }, []);
    const clearAll = useCallback(() => {
        setQuery("");
        setFilters(new Set());
        setTab(ALL);
        input.current?.focus();
    }, []);
    const switchTab = useCallback((t: string) => {
        setTab(t);
        setCard(null);
    }, []);

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
    const pinnedHeader = pinnedIndex >= 0 && scroll.top > 0 ? items[pinnedIndex] : undefined;
    let pinnedShift = 0;
    if (pinnedHeader) {
        let next = -1;
        for (let i = pinnedIndex + 1; i < Math.min(items.length, end + 1); i++) {
            if (items[i]?.kind === "header") {
                next = i;
                break;
            }
        }
        if (next >= 0) pinnedShift = Math.min(0, (offsets[next] ?? 0) - scroll.top - heights.header);
    }

    // Bulk targets: the selection when there is one, else what the list shows.
    const bulkTargets = useMemo(() => {
        if (!bulkActions?.length && !selection) return [];
        if (selectionIds?.size) return index.entries.filter((e) => selectionIds.has(e.model.id)).map((e) => e.model);
        return inScope.map((e) => e.model);
    }, [bulkActions, selection, selectionIds, index, inScope]);
    const allInScopeSelected =
        !!selectionIds && inScope.length > 0 && inScope.every((e) => selectionIds.has(e.model.id));
    const someInScopeSelected = !!selectionIds && inScope.some((e) => selectionIds.has(e.model.id));
    const toggleAll = () => {
        if (!selectionIds || !onSelectionChange) return;
        const next = new Set(selectionIds);
        if (allInScopeSelected) for (const e of inScope) next.delete(e.model.id);
        else for (const e of inScope) next.add(e.model.id);
        onSelectionChange(next);
    };
    const scopeLabel = t("models-count", { count: inScope.length });

    // States.
    const hasRows = items.some(selectable) || items[0]?.kind === "skeleton";
    let overlay: ReactNode = null;
    if (!models.length && !loading && error !== undefined && error !== null) {
        overlay = <ErrorState size="panel" title={t("models-browser-error-title")} error={error} onRetry={onRetry} />;
    } else if (!models.length && !loading) {
        overlay = emptyState ?? (
            <EmptyState
                size="panel"
                icon={Cube}
                title={t("models-no-models-title")}
                description={t("models-browser-empty-description")}
            />
        );
    } else if (!hasRows) {
        overlay = (
            <EmptyState
                size="panel"
                icon={MagnifyingGlass}
                title={
                    searching
                        ? t("models-browser-no-match", { query: query.trim() })
                        : scope === FAVORITES && !filters.size
                          ? t("models-browser-no-favorites")
                          : t("models-browser-no-filter-match")
                }
                description={
                    scope === FAVORITES && !searching && !filters.size
                        ? t("models-browser-no-favorites-hint")
                        : t("models-browser-no-match-hint")
                }
                action={narrowed ? { label: t("models-browser-clear-filters"), onClick: clearAll } : undefined}
            />
        );
    }

    const cardEntry = card ? index.byId.get(card.key) : undefined;
    const selectableItems = useMemo(() => items.filter(selectable), [items]);
    const rowPositions = useMemo(
        () => new Map(selectableItems.map((item, position) => [item.key, position + 1])),
        [selectableItems],
    );
    // Keep the active descendant mounted when a pointer scroll moves it outside the virtual window.
    const visibleIndices = Array.from({ length: end - start }, (_, position) => start + position);
    if (selectable(items[highlight]) && (highlight < start || highlight >= end)) visibleIndices.push(highlight);
    const effectiveSelectedCount = selectionIds
        ? index.entries.reduce((count, entry) => count + Number(selectionIds.has(entry.model.id)), 0)
        : 0;
    const activeItem = activeKey ? items.find((it) => keyOf(it) === activeKey) : undefined;
    const activeEntry = activeKey && !activeKey.startsWith(PIN) ? index.byId.get(activeKey) : undefined;
    const activePin = activeKey?.startsWith(PIN)
        ? (pinned?.find((p) => PIN + p.id === activeKey) ??
          (activeItem?.kind === "pinned" ? activeItem.pin : undefined))
        : undefined;
    const showDrill = !split && drill && (activeEntry || activePin);
    // Hide the rail where it would only repeat "All models": one group and nothing starred.
    const showRail = rail === "always" || index.groups.length > 1 || favSet.size > 0 || (loading && !models.length);
    const listWidth = width - (showRail ? (labelledRail ? 208 : coarse ? 52 : 44) : 0) - (split ? 352 : 0);
    const showCaps = listWidth >= 440;

    const detailView = (narrow: boolean) => (
        <div
            ref={detail}
            tabIndex={-1}
            role="region"
            aria-label={
                activeEntry
                    ? t("models-browser-details", { name: activeEntry.model.name })
                    : (activePin?.label ?? t("models-browser-details-default"))
            }
            onKeyDown={onDetailKey}
            className={cn(
                "min-h-0 overflow-y-auto overscroll-contain p-4 outline-none",
                narrow ? "flex-1" : "w-[352px] shrink-0 bg-[var(--browser-recessed)]",
            )}
            data-model-browser-detail
        >
            {activeEntry ? (
                <>
                    <DetailHeader model={activeEntry.model} back={narrow ? back : undefined} />
                    <div className="mt-4">{renderDetail?.(activeEntry.model, { back: narrow ? back : undefined })}</div>
                    <section className="mt-5">
                        <h4 className="mb-1.5 text-xs text-tertiary">{t("models-browser-about")}</h4>
                        <ModelFacts model={activeEntry.model} />
                    </section>
                </>
            ) : activePin ? (
                <>
                    <div className="flex items-start gap-2.5">
                        {narrow && <BackButton onClick={back} />}
                        {activePin.icon && (
                            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-soft text-icon-secondary [&_svg]:size-5">
                                {activePin.icon}
                            </span>
                        )}
                        <div className="min-w-0 flex-1">
                            <h3 className="text-base leading-6 font-medium text-text">{activePin.label}</h3>
                            {activePin.description && (
                                <p className="text-xs leading-4 text-tertiary">{activePin.description}</p>
                            )}
                        </div>
                    </div>
                    <div className="mt-4">{activePin.renderDetail?.()}</div>
                </>
            ) : (
                <EmptyState
                    size="panel"
                    title={t("models-browser-nothing-title")}
                    description={t("models-browser-nothing-description")}
                />
            )}
        </div>
    );

    return (
        <div
            ref={root}
            data-model-browser-surface
            onKeyDown={onRootKey}
            style={{ height }}
            className={cn(
                tiers,
                "flex min-h-0 w-full min-w-0 overflow-hidden bg-menu text-text",
                !bare && "rounded-2xl border border-default",
                className,
            )}
        >
            {showDrill ? (
                detailView(true)
            ) : (
                <>
                    {showRail && (
                        <Rail
                            groups={index.groups}
                            counts={counts.groups}
                            total={matches.length}
                            favorites={fav && (favSet.size > 0 || scope === FAVORITES) ? counts.favorites : undefined}
                            tab={scope}
                            onTab={switchTab}
                            labelled={labelledRail}
                            coarse={coarse}
                            groupBy={groupBy}
                            onGroupBy={setGroupBy}
                            groupToggle={groupToggle}
                            loading={loading && !models.length}
                        />
                    )}
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-1.5">
                        <label className="flex min-h-[var(--menu-row-height)] shrink-0 items-center gap-2.5 rounded-xl px-2.5">
                            <MagnifyingGlass aria-hidden className="size-5 shrink-0 text-tertiary" />
                            <input
                                ref={input}
                                type="search"
                                aria-label={
                                    label
                                        ? t("models-browser-search", { label: label.toLocaleLowerCase(locale) })
                                        : t("models-browser-search-default")
                                }
                                aria-controls={listId}
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                placeholder={t("models-browser-search-placeholder")}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={onInputKey}
                                className={cn(
                                    "min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-tertiary focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden",
                                    coarse ? "h-10 text-md" : "text-sm leading-5",
                                )}
                            />
                            {searching && (
                                <span className="shrink-0 text-xs text-tertiary tabular-nums" aria-live="polite">
                                    {inScope.length.toLocaleString(locale)}
                                </span>
                            )}
                        </label>
                        <FilterChips filters={chips} active={filters} onToggle={toggleFilter} />
                        <div className="relative min-h-0 flex-1">
                            {pinnedHeader?.kind === "header" && (
                                <div
                                    aria-hidden
                                    className="pointer-events-none absolute inset-x-0 top-0 z-10"
                                    style={{ transform: `translateY(${pinnedShift}px)` }}
                                >
                                    <SectionLabel
                                        label={pinnedHeader.label}
                                        count={pinnedHeader.count}
                                        height={heights.header}
                                    />
                                </div>
                            )}
                            <div
                                ref={scroller}
                                onScroll={onScroll}
                                onPointerLeave={() => {
                                    if (!listFocused) setHighlight(-1);
                                    clearTimeout(cardTimer.current);
                                    setCard(null);
                                }}
                                className="h-full touch-pan-y overflow-y-auto overscroll-contain"
                                data-sheet-scroll
                            >
                                <div
                                    ref={list}
                                    id={listId}
                                    role="grid"
                                    aria-label={listLabel}
                                    aria-rowcount={selectableItems.length}
                                    aria-colcount={1}
                                    aria-busy={loading || undefined}
                                    aria-multiselectable={selection ? true : undefined}
                                    aria-activedescendant={
                                        highlight >= 0 && selectable(items[highlight]) ? optionId(highlight) : undefined
                                    }
                                    tabIndex={hasRows ? 0 : -1}
                                    data-focused={listFocused || undefined}
                                    onFocus={(e) => {
                                        if (e.target !== e.currentTarget) return;
                                        setListFocused(true);
                                        if (highlight < 0) {
                                            const i = itemsRef.current.findIndex(selectable);
                                            if (i >= 0) go(i);
                                        }
                                    }}
                                    onBlur={(e) => e.target === e.currentTarget && setListFocused(false)}
                                    onKeyDown={onListKey}
                                    className="group/list relative outline-none"
                                    style={{ height: Math.max(total, 1) }}
                                >
                                    {visibleIndices.map((i) => {
                                        const it = items[i];
                                        if (!it) return null;
                                        const style = { top: offsets[i], height: heights[it.kind] };
                                        if (it.kind === "header")
                                            return (
                                                <SectionLabel
                                                    key={it.key}
                                                    label={it.label}
                                                    count={it.count}
                                                    height={heights.header}
                                                    style={style}
                                                />
                                            );
                                        if (it.kind === "skeleton") return <SkeletonRow key={it.key} style={style} />;
                                        if (it.kind === "pinned")
                                            return (
                                                <PinnedRow
                                                    key={it.key}
                                                    id={optionId(i)}
                                                    index={i}
                                                    rowPosition={rowPositions.get(it.key) ?? 1}
                                                    label={it.pin.label}
                                                    description={it.pin.description}
                                                    icon={it.pin.icon}
                                                    highlighted={highlight === i}
                                                    active={activeKey === it.key}
                                                    current={it.pin.current}
                                                    pinId={it.pin.id}
                                                    onHover={onHover}
                                                    onPick={onPick}
                                                    style={style}
                                                />
                                            );
                                        const { model: m } = it.entry;
                                        const who = rowByline(m, groupBy, searching || scope === FAVORITES);
                                        return (
                                            <ModelRow
                                                key={it.key}
                                                id={optionId(i)}
                                                index={i}
                                                rowPosition={rowPositions.get(it.key) ?? 1}
                                                model={m}
                                                meta={metaLine(m, who)}
                                                ranges={searching ? highlightRanges(m.name, terms) : null}
                                                highlighted={highlight === i}
                                                active={activeKey === m.id}
                                                current={m.id === value}
                                                muted={rowState?.(m).muted === true}
                                                favorite={fav ? favSet.has(m.id) : undefined}
                                                selected={selectionIds ? selectionIds.has(m.id) : undefined}
                                                showCaps={showCaps}
                                                coarse={coarse}
                                                renderRowEnd={renderRowEnd}
                                                onHover={onHover}
                                                onPick={onPick}
                                                onStar={toggleFavorite ?? noop}
                                                onSelectToggle={toggleSelect}
                                                style={style}
                                            />
                                        );
                                    })}
                                </div>
                                {overlay && <div className="absolute inset-0 overflow-y-auto">{overlay}</div>}
                            </div>
                        </div>
                        {(bulkActions?.length || selection) && models.length > 0 && (
                            <BulkBar
                                targets={bulkTargets}
                                scopeLabel={scopeLabel}
                                actions={bulkActions ?? []}
                                confirmAt={confirmAt}
                                selection={
                                    selection
                                        ? {
                                              count: effectiveSelectedCount,
                                              allSelected: allInScopeSelected,
                                              someSelected: someInScopeSelected,
                                              toggleAll,
                                              clear: () => onSelectionChange?.(new Set()),
                                          }
                                        : undefined
                                }
                            />
                        )}
                    </div>
                    {split && detailView(false)}
                </>
            )}
            {cards && cardEntry && card && (
                <HoverCard
                    model={cardEntry.model}
                    anchor={card.rect}
                    surface={card.surface}
                    favoriteShortcut={!!toggleFavorite}
                />
            )}
        </div>
    );
}

const noop = () => {};
