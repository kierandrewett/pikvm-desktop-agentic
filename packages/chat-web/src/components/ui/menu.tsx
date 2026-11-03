/**
 * Data-driven menu (reference spec 5.2). Desktop: Radix dropdown with the shared menu surface.
 * Touch/mobile: the same items in a bottom sheet with 44px rows; submenus open as drill-down pages with a
 * back row, so long menus stay readable on a phone.
 *
 * Rows use --menu-row-height (the sidebar row height, density-scaled) with 20px icons, so dropdowns and
 * context menus match the rest of the interface instead of the reference desktop app's compact menus.
 *
 * Entry kinds: item (optionally `keepOpen` for quick changes that should stay visible), separator, label,
 * submenu (optional `hint` showing the current value), header (custom content such as a profile row) and
 * toggle (a switch that flips without closing the menu). Long menus and submenus scroll within the viewport.
 *
 * Type to jump (every menu, submenu and the mobile sheet): printable keys build a buffer (lib/typeahead.ts),
 * focus moves to the best match (prefix, then word start, then substring), the matched letters are marked in its
 * label and the buffer shows in a chip at the bottom. A buffer that stops matching restarts from the last key, so
 * "del" then "re" lands on Rename. It resets after 1s idle and on arrows, Escape, Enter, Space or pointer
 * movement. Radix's own typeahead is suppressed (we preventDefault before it runs) so the two never fight. A
 * filter field for long menus was considered and left out: it would take the same keys, and no menu here is long
 * enough to need it.
 */
import { CaretLeft, CaretRight, Check } from "@pikvm/icons";
import { DropdownMenu as M } from "radix-ui";
import {
    createContext,
    useContext,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type PointerEvent,
    type ReactElement,
    type ReactNode,
} from "react";
import { cn } from "../../lib/cn";
import { shortcutLabel, useIsMobile } from "../../lib/media";
import { motionEase, motionMs } from "../../lib/motion";
import { useThemeLayer } from "../../lib/theme-scope";
import { reducedMotion } from "../model-picker/motion";
import { findMatch, matchLabel, typeaheadChar, useTypeahead } from "../../lib/typeahead";
import { useT } from "../../l10n/provider";
import { HighlightMatch } from "./highlight-match";
import { Sheet } from "./sheet";
import { TailedContent } from "./tailed-content";
import { TypeaheadChip } from "./typeahead-chip";

export type MenuEntry =
    | {
          type?: "item";
          label: string;
          icon?: ReactNode;
          shortcut?: string;
          danger?: boolean;
          disabled?: boolean;
          checked?: boolean;
          /** Keep the menu open after selecting (live settings such as theme mode). */
          keepOpen?: boolean;
          /**
           * Selection semantics: "radio" is one choice of a set (role menuitemradio), "checkbox" an independent
           * option (menuitemcheckbox). Both announce `checked` as aria-checked and show a check mark.
           */
          role?: "radio" | "checkbox";
          onSelect: () => void;
      }
    | { type: "separator" }
    | { type: "label"; label: string }
    | {
          type: "submenu";
          label: string;
          icon?: ReactNode;
          /** Current value shown before the chevron. */
          hint?: string;
          items: MenuEntry[];
      }
    | {
          type: "header";
          /** Accessible name. */
          label: string;
          content: ReactNode;
          onSelect?: () => void;
      }
    | {
          type: "toggle";
          label: string;
          icon?: ReactNode;
          checked: boolean;
          disabled?: boolean;
          onChange: (checked: boolean) => void;
      };

export const menuSurface =
    "z-50 min-w-52 overflow-y-auto rounded-2xl bg-menu p-1.5 shadow-dropdown outline-none";
export const menuItem =
    "flex min-h-[var(--menu-row-height)] cursor-default select-none items-center gap-2.5 rounded-xl px-2.5 py-1 text-sm leading-5 text-text outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40 [&_svg]:size-5 [&_svg]:shrink-0";

/** The item the buffer points at in this menu level, and the query that matched it. */
const TypeaheadContext = createContext<{ key: string | null; query: string }>({ key: null, query: "" });

/** Item label with the typed letters marked while it is the typeahead match. */
function ItemLabel({ id, label, className = "flex-1 truncate" }: { id: string; label: string; className?: string }) {
    const hit = useContext(TypeaheadContext);
    const ranges = hit.key === id ? matchLabel(label, hit.query)?.ranges : null;
    return (
        <span className={className}>
            <HighlightMatch text={label} ranges={ranges} />
        </span>
    );
}

/** Props for an element that type-to-jump can land on. */
const taProps = (id: string, label: string) => ({ "data-ta-key": id, "data-ta-label": label });

const NAV_KEYS = new Set([
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Escape",
    "Enter",
    " ",
    "Tab",
]);

/**
 * Type-to-jump for one menu level. Spread `scopeProps` on the level's container (desktop content, submenu
 * content or sheet body), wrap its items in `Provider`, and render `chip` inside it.
 */
function useMenuTypeahead() {
    const scope = useRef<HTMLDivElement | null>(null);
    const ta = useTypeahead({ timeoutMs: 1000 });
    const [hit, setHit] = useState<{ key: string; query: string } | null>(null);
    const [miss, setMiss] = useState(false);

    // The buffer timed out: drop the marks too.
    useEffect(() => {
        if (!ta.query) {
            setHit(null);
            setMiss(false);
        }
    }, [ta.query]);

    const candidates = () =>
        [...(scope.current?.querySelectorAll<HTMLElement>("[data-ta-key]") ?? [])].filter(
            (el) =>
                el.closest("[data-ta-scope]") === scope.current &&
                !el.hasAttribute("data-disabled") &&
                !el.hasAttribute("disabled"),
        );

    const jump = (buffer: string) => {
        const els = candidates();
        const labels = els.map((el) => el.dataset.taLabel ?? "");
        const found = findMatch(labels, buffer, els.indexOf(document.activeElement as HTMLElement));
        const el = found && els[found.index];
        if (!found || !el) {
            setHit(null);
            setMiss(true);
            return;
        }
        el.focus({ preventScroll: false });
        setHit({ key: el.dataset.taKey ?? "", query: found.query });
        setMiss(false);
    };

    const reset = () => {
        ta.clear();
        setHit(null);
        setMiss(false);
    };

    const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
        // Keys from a nested level (submenus are portalled but bubble through React) belong to that level.
        if ((e.target as HTMLElement).closest("[data-ta-scope]") !== scope.current) return;
        const ch = typeaheadChar(e);
        if (ch) {
            // preventDefault also skips Radix's own typeahead, which runs after this handler.
            e.preventDefault();
            e.stopPropagation();
            const els = candidates();
            const labels = els.map((el) => el.dataset.taLabel ?? "");
            const current = els.indexOf(document.activeElement as HTMLElement);
            jump(ta.push(ch, (buffer) => findMatch(labels, buffer, current) !== null));
            return;
        }
        if (e.key === "Backspace" && ta.query) {
            e.preventDefault();
            const next = ta.pop();
            if (next) jump(next);
            else reset();
            return;
        }
        if (NAV_KEYS.has(e.key)) reset();
    };

    const onPointerMove = (e: PointerEvent<HTMLElement>) => {
        if ((ta.query || hit) && (e.movementX || e.movementY)) reset();
    };

    return {
        scopeProps: { ref: scope, "data-ta-scope": "", onKeyDown, onPointerMove },
        value: { key: hit?.key ?? null, query: hit?.query ?? "" },
        reset,
        chip: (
            <div aria-hidden className="pointer-events-none sticky bottom-0 z-10 h-0">
                {/* bottom-1: the hidden chip sits 4px lower (it rises as it fades in); anchored at bottom-0 that
                    offset made every menu 4px taller than its content, so short menus showed a scrollbar. */}
                <TypeaheadChip query={ta.query} miss={miss} className="absolute end-0 bottom-1" />
            </div>
        ),
    };
}

/** Presentational switch for toggle rows (the row itself is the control). Also the composer's Auto effort row. */
export function SwitchMark({ on }: { on: boolean }) {
    return (
        <span
            aria-hidden
            className={cn(
                "ms-auto inline-flex h-[20px] w-[32px] shrink-0 items-center rounded-full transition-colors duration-150 ease-[cubic-bezier(0,0,0.2,1)]",
                on ? "bg-accent" : "bg-[color-mix(in_oklab,var(--text)_10%,transparent)]",
            )}
        >
            <span
                className={cn(
                    "size-[16px] rounded-full border border-default bg-toggle-thumb shadow-[0_1px_2px_-1px_rgb(0_0_0/0.08)] transition-transform duration-150 ease-[cubic-bezier(0,0,0.2,1)]",
                    on ? "translate-x-[14px]" : "translate-x-[2px]",
                )}
            />
        </span>
    );
}

function DesktopItems({ items }: { items: MenuEntry[] }) {
    const layer = useThemeLayer();
    return items.map((it, i) => {
        const id = String(i);
        if (it.type === "separator") return <M.Separator key={i} className="mx-2.5 my-1.5 h-px bg-default" />;
        if (it.type === "label")
            return (
                <M.Label key={i} className="px-2.5 pt-2 pb-1 text-sm text-tertiary">
                    {it.label}
                </M.Label>
            );
        if (it.type === "header") {
            if (!it.onSelect) {
                return (
                    <div key={i} aria-label={it.label} className="flex items-center gap-2.5 px-2.5 py-2">
                        {it.content}
                    </div>
                );
            }
            return (
                <M.Item
                    key={i}
                    aria-label={it.label}
                    textValue={it.label}
                    {...taProps(id, it.label)}
                    onSelect={it.onSelect}
                    className={cn(menuItem, "py-2 [&_svg]:size-auto")}
                >
                    {it.content}
                </M.Item>
            );
        }
        if (it.type === "toggle") {
            return (
                <M.CheckboxItem
                    key={i}
                    checked={it.checked}
                    disabled={it.disabled}
                    onCheckedChange={(v) => it.onChange(v === true)}
                    onSelect={(e) => e.preventDefault()}
                    textValue={it.label}
                    {...taProps(id, it.label)}
                    className={menuItem}
                >
                    {it.icon}
                    <ItemLabel id={id} label={it.label} />
                    <SwitchMark on={it.checked} />
                </M.CheckboxItem>
            );
        }
        if (it.type === "submenu") {
            return (
                <M.Sub key={i}>
                    <M.SubTrigger textValue={it.label} {...taProps(id, it.label)} className={menuItem}>
                        {it.icon}
                        <ItemLabel id={id} label={it.label} />
                        {it.hint && (
                            <span className="ms-auto max-w-32 truncate ps-3 text-xs text-tertiary">{it.hint}</span>
                        )}
                        <CaretRight className="text-tertiary" />
                    </M.SubTrigger>
                    <M.Portal container={layer}>
                        <DesktopSubContent items={it.items} />
                    </M.Portal>
                </M.Sub>
            );
        }
        if (it.role) {
            // Radix sets aria-checked and the state; its checkbox item takes the radio role as a prop.
            return (
                <M.CheckboxItem
                    key={i}
                    role={`menuitem${it.role}`}
                    checked={!!it.checked}
                    disabled={it.disabled}
                    textValue={it.label}
                    {...taProps(id, it.label)}
                    onSelect={(e) => {
                        if (it.keepOpen) e.preventDefault();
                    }}
                    onCheckedChange={() => it.onSelect()}
                    className={menuItem}
                >
                    {it.icon}
                    <ItemLabel id={id} label={it.label} />
                    {it.checked && <Check aria-hidden className="ms-auto text-text" />}
                </M.CheckboxItem>
            );
        }
        return (
            <M.Item
                key={i}
                disabled={it.disabled}
                textValue={it.label}
                {...taProps(id, it.label)}
                onSelect={(e) => {
                    if (it.keepOpen) e.preventDefault();
                    it.onSelect();
                }}
                className={cn(menuItem, it.danger && "text-danger")}
            >
                {it.icon}
                <ItemLabel id={id} label={it.label} />
                {it.checked && <Check aria-hidden className="ms-auto text-text" />}
                {it.shortcut && (
                    <span className="ms-auto ps-4 text-xs text-tertiary">{shortcutLabel(it.shortcut)}</span>
                )}
            </M.Item>
        );
    });
}

/** A submenu level: its own typeahead buffer, so letters typed in it search only its items. */
function DesktopSubContent({ items }: { items: MenuEntry[] }) {
    const ta = useMenuTypeahead();
    return (
        <M.SubContent
            {...ta.scopeProps}
            sideOffset={6}
            alignOffset={-6}
            collisionPadding={8}
            className={cn(menuSurface, "max-h-[var(--radix-dropdown-menu-content-available-height)]")}
        >
            <TypeaheadContext.Provider value={ta.value}>
                <DesktopItems items={items} />
            </TypeaheadContext.Provider>
            {ta.chip}
        </M.SubContent>
    );
}

/** A 44px row in a bottom sheet; shared with sheets that are not built from MenuEntry lists. */
export const sheetRow =
    "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-start text-md active:bg-hover disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring [&_svg]:size-5 [&_svg]:shrink-0";

type Sub = Extract<MenuEntry, { type: "submenu" }>;

function SheetItems({ items, close, open }: { items: MenuEntry[]; close: () => void; open: (sub: Sub) => void }) {
    return items.map((it, i) => {
        const id = String(i);
        if (it.type === "separator") return <div key={i} className="mx-3 my-1 h-px bg-default" />;
        if (it.type === "label")
            return (
                <div key={i} className="px-3 pt-2 pb-1 text-sm text-tertiary">
                    {it.label}
                </div>
            );
        if (it.type === "header") {
            if (!it.onSelect) {
                return (
                    <div key={i} aria-label={it.label} className="flex items-center gap-3 px-3 py-2">
                        {it.content}
                    </div>
                );
            }
            const select = it.onSelect;
            return (
                <button
                    key={i}
                    type="button"
                    aria-label={it.label}
                    {...taProps(id, it.label)}
                    onClick={() => {
                        close();
                        select();
                    }}
                    className={cn(sheetRow, "py-2 [&_svg]:size-auto")}
                >
                    {it.content}
                </button>
            );
        }
        if (it.type === "toggle") {
            return (
                <button
                    key={i}
                    type="button"
                    role="switch"
                    aria-checked={it.checked}
                    disabled={it.disabled}
                    {...taProps(id, it.label)}
                    onClick={() => it.onChange(!it.checked)}
                    className={sheetRow}
                >
                    {it.icon}
                    <ItemLabel id={id} label={it.label} />
                    <SwitchMark on={it.checked} />
                </button>
            );
        }
        if (it.type === "submenu") {
            return (
                <button
                    key={i}
                    type="button"
                    {...taProps(id, it.label)}
                    data-sub-label={it.label}
                    aria-haspopup="menu"
                    onClick={() => open(it)}
                    className={sheetRow}
                >
                    {it.icon}
                    <ItemLabel id={id} label={it.label} />
                    {it.hint && <span className="max-w-32 truncate text-sm text-tertiary">{it.hint}</span>}
                    <CaretRight className="text-tertiary" />
                </button>
            );
        }
        return (
            <button
                key={i}
                type="button"
                role={it.role ? `menuitem${it.role}` : undefined}
                aria-checked={it.role ? !!it.checked : undefined}
                disabled={it.disabled}
                {...taProps(id, it.label)}
                onClick={() => {
                    if (!it.keepOpen) close();
                    it.onSelect();
                }}
                className={cn(sheetRow, it.danger && "text-danger")}
            >
                {it.icon}
                <ItemLabel id={id} label={it.label} />
                {it.checked && <Check aria-hidden />}
            </button>
        );
    });
}

/**
 * Sheet body with drill-down submenus. The stack resets when the sheet closes (its content unmounts).
 *
 * Moving between levels is animated once here, so every menu sheet gets it:
 * - Height: a ResizeObserver watches the current page; when its height changes (a submenu, a live item), the
 *   frame animates from the old height to the new one before paint, then returns to `auto`, so there is no jump
 *   at the end. The sheet is anchored to the bottom, so its top edge (with the drag handle) moves and the
 *   safe-area padding at the bottom stays where it is.
 * - Slide (iOS navigation): forward, the new page comes in from the right while the old one moves a third to the
 *   left and fades; Back runs the reverse. The old page is an inert, hidden copy on top for the length of the
 *   slide only.
 * - Reduced motion: no slide and no height animation; the new page fades in briefly.
 * - Focus: entering a submenu focuses its title row (the Back button, which names the submenu); Back focuses
 *   the row that opened it.
 */
const PAGE_MS = 320;
const FADE_MS = 120;

interface PageTransition {
    id: number;
    /** 1 into a submenu, -1 back out. */
    dir: 1 | -1;
    /** The level that is leaving, drawn as an inert copy during the slide. */
    from: Sub[];
}

function SheetLevel({
    items,
    stack,
    close,
    push,
    pop,
}: {
    items: MenuEntry[];
    stack: Sub[];
    close: () => void;
    push: (sub: Sub) => void;
    pop: () => void;
}) {
    const t = useT();
    const current = stack[stack.length - 1];
    // Re-read the submenu from the live items so checks update while the page is open.
    const live = current
        ? (findSub(
              items,
              stack.map((s) => s.label),
          ) ?? current)
        : undefined;
    if (!current || !live) return <SheetItems items={items} close={close} open={push} />;
    return (
        <>
            <button
                type="button"
                data-sheet-back=""
                onClick={pop}
                className={cn(sheetRow, "font-medium")}
                aria-label={t("ui-menu-back", { name: current.label })}
            >
                <CaretLeft className="text-tertiary" />
                <span className="flex-1 truncate">{current.label}</span>
            </button>
            <div className="mx-3 my-1 h-px bg-default" />
            <SheetItems items={live.items} close={close} open={push} />
        </>
    );
}

function SheetMenu({ items, close }: { items: MenuEntry[]; close: () => void }) {
    const [stack, setStack] = useState<Sub[]>([]);
    const [transition, setTransition] = useState<PageTransition | null>(null);
    const ta = useMenuTypeahead();
    const frame = useRef<HTMLDivElement>(null);
    const page = useRef<HTMLDivElement>(null);
    const leaving = useRef<HTMLDivElement>(null);
    /** The submenu label to focus once its parent level is back (after Back). */
    const refocus = useRef<string | null>(null);
    const nextId = useRef(0);

    const go = (dir: 1 | -1, next: Sub[]) => {
        ta.reset();
        setTransition({ id: ++nextId.current, dir, from: stack });
        setStack(next);
    };
    const push = (sub: Sub) => go(1, [...stack, sub]);
    const pop = () => {
        refocus.current = stack[stack.length - 1]?.label ?? null;
        go(-1, stack.slice(0, -1));
    };

    // Height follows the current page.
    useLayoutEffect(() => {
        const el = page.current;
        const box = frame.current;
        if (!el || !box || typeof ResizeObserver === "undefined") return;
        let last = el.offsetHeight;
        let anim: Animation | undefined;
        const ro = new ResizeObserver(() => {
            const next = el.offsetHeight;
            if (Math.abs(next - last) < 1) return;
            const from = anim?.playState === "running" ? box.getBoundingClientRect().height : last;
            last = next;
            anim?.cancel();
            if (reducedMotion() || motionMs(PAGE_MS) <= 0) return;
            anim = box.animate([{ height: `${from}px` }, { height: `${next}px` }], {
                duration: motionMs(PAGE_MS),
                easing: motionEase("enter"),
            });
        });
        ro.observe(el);
        return () => {
            ro.disconnect();
            anim?.cancel();
        };
    }, []);

    // Slide (or fade) between levels, then move focus.
    useLayoutEffect(() => {
        if (!transition) return;
        const el = page.current;
        const old = leaving.current;
        const finish = () => {
            setTransition((t) => (t?.id === transition.id ? null : t));
        };
        const target = refocus.current;
        refocus.current = null;
        const focusTarget = target
            ? el?.querySelector<HTMLElement>(`[data-sub-label="${CSS.escape(target)}"]`)
            : el?.querySelector<HTMLElement>("[data-sheet-back]");
        focusTarget?.focus({ preventScroll: true });
        if (!el) return finish();
        const ms = motionMs(PAGE_MS);
        if (reducedMotion() || ms <= 0) {
            if (ms <= 0) return finish();
            const fade = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionMs(FADE_MS) });
            fade.onfinish = finish;
            return () => fade.cancel();
        }
        const ease = motionEase("enter");
        const d = transition.dir;
        const enter = el.animate(
            [
                { transform: `translateX(${d > 0 ? "100%" : "-33%"})`, opacity: d > 0 ? 1 : 0.4 },
                { transform: "none", opacity: 1 },
            ],
            { duration: ms, easing: ease },
        );
        const exit = old?.animate(
            [
                { transform: "none", opacity: 1 },
                { transform: `translateX(${d > 0 ? "-33%" : "100%"})`, opacity: d > 0 ? 0 : 1 },
            ],
            { duration: ms, easing: ease, fill: "forwards" },
        );
        enter.onfinish = finish;
        return () => {
            enter.cancel();
            exit?.cancel();
        };
    }, [transition]);

    return (
        <div {...ta.scopeProps} className="relative">
            <TypeaheadContext.Provider value={ta.value}>
                <div ref={frame} data-sheet-frame="" className="relative overflow-hidden">
                    <div ref={page} data-sheet-page={stack.length}>
                        <SheetLevel items={items} stack={stack} close={close} push={push} pop={pop} />
                    </div>
                    {transition && (
                        <div
                            ref={leaving}
                            aria-hidden
                            inert
                            data-sheet-leaving=""
                            className="pointer-events-none absolute inset-x-0 top-0 bg-menu"
                        >
                            <SheetLevel items={items} stack={transition.from} close={close} push={push} pop={pop} />
                        </div>
                    )}
                </div>
            </TypeaheadContext.Provider>
            {ta.chip}
        </div>
    );
}

function findSub(items: MenuEntry[], path: string[]): Sub | undefined {
    let level: MenuEntry[] = items;
    let found: Sub | undefined;
    for (const label of path) {
        found = level.find((e): e is Sub => e.type === "submenu" && e.label === label);
        if (!found) return undefined;
        level = found.items;
    }
    return found;
}

export function Menu({
    trigger,
    items,
    align = "start",
    side = "bottom",
    title,
    open: controlledOpen,
    onOpenChange,
    className,
    tail = false,
}: {
    trigger: ReactElement;
    items: MenuEntry[];
    align?: "start" | "center" | "end";
    side?: "top" | "bottom" | "left" | "right";
    title?: string;
    open?: boolean;
    onOpenChange?: (o: boolean) => void;
    /** Extra classes for the desktop surface (for example a wider min-width). */
    className?: string;
    /**
     * Desktop only: draw the menu as a tailed balloon pointing at its trigger (TailedContent), as the popovers are.
     * For a single trigger that opens a short list, such as a header switcher; full menus keep the plain surface.
     */
    tail?: boolean;
}) {
    const mobile = useIsMobile();
    const ta = useMenuTypeahead();
    // Opened from inside a theme scope, the menu belongs to it (lib/theme-scope.tsx).
    const layer = useThemeLayer();
    const [innerOpen, setInnerOpen] = useState(false);
    const open = controlledOpen ?? innerOpen;
    const setOpen = onOpenChange ?? setInnerOpen;
    const resetTypeahead = ta.reset;
    useEffect(() => {
        if (!open) resetTypeahead();
        // Only on open changes; `reset` is a new function each render.
    }, [open]);
    if (mobile) {
        return (
            <>
                <span className="contents" onClick={() => setOpen(true)}>
                    {trigger}
                </span>
                <Sheet open={open} onOpenChange={setOpen} title={title}>
                    <SheetMenu items={items} close={() => setOpen(false)} />
                </Sheet>
            </>
        );
    }
    if (tail) {
        return (
            <M.Root open={open} onOpenChange={setOpen} modal={false}>
                <M.Trigger asChild>{trigger}</M.Trigger>
                <M.Portal container={layer}>
                    <M.Content {...ta.scopeProps} side={side} align={align} sideOffset={2} collisionPadding={8} asChild>
                        <TailedContent
                            arrow={M.Arrow}
                            translucent
                            className={cn("z-50 min-w-52 outline-none", className)}
                            bodyClassName="max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto p-1.5"
                        >
                            <TypeaheadContext.Provider value={ta.value}>
                                <DesktopItems items={items} />
                            </TypeaheadContext.Provider>
                            {ta.chip}
                        </TailedContent>
                    </M.Content>
                </M.Portal>
            </M.Root>
        );
    }
    return (
        <M.Root open={open} onOpenChange={setOpen} modal={false}>
            <M.Trigger asChild>{trigger}</M.Trigger>
            <M.Portal container={layer}>
                <M.Content
                    {...ta.scopeProps}
                    side={side}
                    align={align}
                    sideOffset={4}
                    collisionPadding={8}
                    className={cn(
                        menuSurface,
                        "max-h-[var(--radix-dropdown-menu-content-available-height)]",
                        className,
                    )}
                >
                    <TypeaheadContext.Provider value={ta.value}>
                        <DesktopItems items={items} />
                    </TypeaheadContext.Provider>
                    {ta.chip}
                </M.Content>
            </M.Portal>
        </M.Root>
    );
}
