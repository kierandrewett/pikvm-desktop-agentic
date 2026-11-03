/**
 * Thinking-effort control, copied from the reference web composer (notes A.2 and A.5, ui-spec 3.5):
 * - Trigger: 36px pill "High" + 16px chevron in tertiary; while open the label reads "Thinking effort" and the
 *   hover background stays.
 * - Popover (centred under the trigger on home, above it in a thread): view 1 is a centred header toggle
 *   ("High >") over a detent slider; view 2 (after clicking the header) lists the efforts as radio rows.
 *   The two views slide horizontally and the height animates.
 * - Slider: 24px track, accent fill, 4px detent dots, 28px thumb, Left/Right/Home/End, live "High, 3 of 3.".
 * Mobile opens the same content in a bottom sheet. Values come from ModelInfo.efforts.
 * - Auto (the runtime picks an effort for each message) is the first slider position, drawn as a MagicWand stop on
 *   the track. The thumb shows the wand while Auto is chosen. The list view has its own Auto row above the levels.
 */
import type { ThinkingEffort, ThinkingSelector } from "@pikvm/chat-protocol";
import { CaretDown, CaretRight, Check, Lightbulb, MagicWand } from "@pikvm/icons";
import { Popover } from "radix-ui";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useT } from "../../l10n/provider";
import { cn } from "../../lib/cn";
import { useIsMobile } from "../../lib/media";
import { touchTarget } from "../../lib/touch";
import { animateEnter, reducedMotion } from "../model-picker/motion";
import { Sheet } from "../ui/sheet";
import { TailedContent } from "../ui/tailed-content";
import { EFFORT_LABELS } from "./choice";
import { useThemeLayer } from "../../lib/theme-scope";

interface EffortProps {
    value: ThinkingSelector;
    efforts: ThinkingEffort[];
    onChange: (e: ThinkingSelector) => void;
    side: "top" | "bottom";
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Phones: a small pill in the row under the composer (icon, label, chevron) instead of the 36px control. */
    tray?: boolean;
    /** With `tray`: the icon only (the full-screen editor's footer on a phone); the accessible name keeps the level. */
    iconOnly?: boolean;
}

/**
 * Slider geometry, all from one set of numbers: the 28px thumb travels between centres inset by its radius, so
 * it sits flush with both rounded track ends. Dots sit on the same centres and the fill ends at the thumb centre.
 */
const THUMB = 28;
const THUMB_R = THUMB / 2;

/**
 * The slider's positions: Auto first (the runtime picks the effort per message), then the model's fixed levels. Auto is
 * an option like any other, drawn with the magic wand instead of a dot, so there is no separate switch.
 */
function positions(efforts: ThinkingEffort[]): ThinkingSelector[] {
    return ["auto", ...efforts];
}

function Slider({
    value,
    efforts,
    onChange,
}: {
    value: ThinkingSelector;
    efforts: ThinkingEffort[];
    onChange: (e: ThinkingSelector) => void;
}) {
    const t = useT();
    const track = useRef<HTMLSpanElement>(null);
    const [width, setWidth] = useState(225);
    const options = positions(efforts);
    const auto = value === "auto";
    const index = Math.max(0, options.indexOf(value));
    const n = options.length;
    const step = n > 1 ? (width - THUMB_R * 2) / (n - 1) : 0;
    const pos = (i: number) => (n > 1 ? THUMB_R + i * step : width / 2);
    const dragging = useRef<number | null>(null);

    useLayoutEffect(() => {
        const el = track.current;
        if (!el) return;
        setWidth(el.clientWidth);
        const ro = new ResizeObserver(() => setWidth(el.clientWidth));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const setIndex = (i: number) => {
        const next = options[Math.min(n - 1, Math.max(0, i))];
        if (next && next !== value) onChange(next);
    };
    const fromPointer = (clientX: number) => {
        const r = track.current?.getBoundingClientRect();
        if (!r || n < 2) return;
        setIndex(Math.round((clientX - r.left - THUMB_R) / step));
    };
    const onKeyDown = (e: KeyboardEvent) => {
        const map: Record<string, number> = {
            ArrowLeft: index - 1,
            ArrowDown: index - 1,
            ArrowRight: index + 1,
            ArrowUp: index + 1,
            Home: 0,
            End: n - 1,
        };
        const next = map[e.key];
        if (next === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        setIndex(next);
    };
    const endPointer = (e: PointerEvent<HTMLSpanElement>) => {
        if (dragging.current === e.pointerId) dragging.current = null;
    };
    const motion = "transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]";

    return (
        <div className="mx-0.5 px-1.5 py-0.5">
            <span className="sr-only" role="status">
                {auto
                    ? t("composer-effort-status-auto", { level: EFFORT_LABELS.auto })
                    : t("composer-effort-status", { level: EFFORT_LABELS[value], index: index + 1, total: n })}
            </span>
            <span
                role="slider"
                tabIndex={0}
                aria-label={t("composer-effort-label")}
                aria-valuemin={1}
                aria-valuemax={n}
                aria-valuenow={index + 1}
                aria-valuetext={
                    auto ? t("composer-effort-valuetext-auto", { level: EFFORT_LABELS.auto }) : EFFORT_LABELS[value]
                }
                data-auto={auto || undefined}
                onKeyDown={onKeyDown}
                onPointerDown={(e: PointerEvent<HTMLSpanElement>) => {
                    if (!e.isPrimary || e.button !== 0 || dragging.current !== null) return;
                    dragging.current = e.pointerId;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    fromPointer(e.clientX);
                }}
                onPointerMove={(e: PointerEvent<HTMLSpanElement>) => {
                    if (dragging.current === e.pointerId) fromPointer(e.clientX);
                }}
                onPointerUp={endPointer}
                onPointerCancel={endPointer}
                onLostPointerCapture={endPointer}
                className={cn("group/slider relative block h-7 touch-none outline-none select-none", touchTarget)}
            >
                <span
                    ref={track}
                    className="absolute inset-x-0 top-0.5 h-6 overflow-hidden rounded-xl bg-[color-mix(in_srgb,var(--text)_10%,transparent)] shadow-[inset_0_0_0_0.5px_var(--border)]"
                >
                    <span
                        className={cn("absolute inset-y-0 left-0 w-full origin-left rounded-l-xl bg-accent", motion)}
                        style={{ transform: `translateX(${pos(index) - width}px)` }}
                    />
                    {options.map((e, i) =>
                        e === "auto" ? (
                            <MagicWand
                                key={e}
                                aria-hidden
                                className={cn(
                                    "absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]",
                                    i <= index
                                        ? "text-[color-mix(in_srgb,var(--on-accent)_60%,transparent)]"
                                        : "text-tertiary",
                                    i === index && "opacity-0",
                                )}
                                style={{ left: pos(i) }}
                            />
                        ) : (
                            <span
                                key={e}
                                aria-hidden
                                className={cn(
                                    "absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[background-color,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]",
                                    i <= index
                                        ? "bg-[color-mix(in_srgb,var(--on-accent)_30%,transparent)]"
                                        : "bg-tertiary",
                                    i === index && "opacity-0",
                                )}
                                style={{ left: pos(i) }}
                            />
                        ),
                    )}
                </span>
                <span
                    aria-hidden
                    className={cn(
                        "absolute top-0 left-0 flex size-7 items-center justify-center rounded-full bg-on-accent text-accent shadow-prominent group-focus-visible/slider:outline-2 group-focus-visible/slider:outline-ring",
                        motion,
                    )}
                    style={{ transform: `translateX(${pos(index) - THUMB_R}px)`, width: THUMB, height: THUMB }}
                >
                    {/* On Auto the thumb carries the wand, so the choice reads without the label. */}
                    {auto && <MagicWand aria-hidden className="size-4" />}
                </span>
            </span>
        </div>
    );
}

function EffortList({
    value,
    efforts,
    onPick,
}: {
    value: ThinkingSelector;
    efforts: ThinkingEffort[];
    onPick: (e: ThinkingSelector) => void;
}) {
    const t = useT();
    return (
        <div
            role="radiogroup"
            aria-label={t("composer-effort-label")}
            onKeyDown={moveFocusByArrows}
            className="flex flex-col px-1 pb-1"
        >
            {["auto" as const, ...efforts].map((e) => (
                <button
                    key={e}
                    type="button"
                    role="radio"
                    aria-checked={e === value}
                    onClick={() => onPick(e)}
                    className="flex min-h-[35px] w-full items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-start text-base leading-5 font-[400] text-text outline-none hover-device:hover:not-active:bg-hover active:bg-pressed focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:min-h-11"
                >
                    <span className="min-w-0 flex-1 truncate">{EFFORT_LABELS[e]}</span>
                    {e === value && <Check aria-hidden className="size-4 shrink-0 opacity-75" />}
                </button>
            ))}
        </div>
    );
}

/** Up, Down, Home and End move focus between the list's rows (wrapping); Enter or Space picks. */
function moveFocusByArrows(e: KeyboardEvent<HTMLElement>) {
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const keys: Record<string, number> = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: rows.length - 1 };
    const next = keys[e.key];
    if (next === undefined || !rows.length) return;
    e.preventDefault();
    rows[(next + rows.length) % rows.length]?.focus();
}

/** Tab out of the popover: close it and go on from its trigger, as if the popover were not there. */
function tabOutOfPopover(e: KeyboardEvent<HTMLElement>, close: () => void): boolean {
    if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return false;
    const inside = [...e.currentTarget.querySelectorAll<HTMLElement>('button, [role="slider"]')].filter(
        (el) => !el.closest("[inert]"),
    );
    const edge = e.shiftKey ? inside[0] : inside.at(-1);
    if (document.activeElement !== edge) return false;
    const trigger = document.querySelector<HTMLElement>(`[aria-controls="${e.currentTarget.id}"]`);
    if (!trigger) return false;
    e.preventDefault();
    close();
    if (e.shiftKey) return (trigger.focus(), true);
    const order = [
        ...document.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]',
        ),
    ].filter((el) => el.tabIndex >= 0 && !el.closest("[inert]") && el.getClientRects().length > 0);
    const at = order.indexOf(trigger);
    (order.slice(at + 1).find((el) => !e.currentTarget.contains(el)) ?? trigger).focus();
    return true;
}

/** The two views in a clipped horizontal track; height follows the active view. */
function EffortPanel({
    value,
    efforts,
    onChange,
    onClose,
}: {
    value: ThinkingSelector;
    efforts: ThinkingEffort[];
    onChange: (e: ThinkingSelector) => void;
    onClose: () => void;
}) {
    const t = useT();
    const [view, setView] = useState<"slider" | "list">("slider");
    const box = useRef<HTMLDivElement>(null);
    const panes = useRef<(HTMLDivElement | null)[]>([]);
    const first = useRef(true);

    useLayoutEffect(() => {
        const el = box.current;
        const pane = panes.current[view === "slider" ? 0 : 1];
        if (!el || !pane) return;
        // The view that had focus is inert now, so the browser dropped focus: put it on the new view's control.
        const lost = document.activeElement === document.body || el.contains(document.activeElement);
        if (!first.current && lost)
            pane.querySelector<HTMLElement>(view === "list" ? '[aria-checked="true"]' : '[role="slider"]')?.focus();
        const h = pane.offsetHeight;
        if (first.current || reducedMotion()) el.style.height = `${h}px`;
        else
            el.animate([{ height: `${el.offsetHeight}px` }, { height: `${h}px` }], {
                duration: 320,
                easing: "cubic-bezier(0.19, 1, 0.22, 1)",
            }).onfinish = () => (el.style.height = `${h}px`);
        el.style.height = `${h}px`;
        first.current = false;
    }, [view]);

    return (
        <div ref={box} className="relative overflow-hidden">
            <div
                className="flex w-[200%] items-start transition-transform duration-[320ms] ease-[cubic-bezier(0.19,1,0.22,1)]"
                style={{ transform: `translateX(${view === "slider" ? 0 : -50}%)` }}
            >
                <div ref={(el) => void (panes.current[0] = el)} className="w-1/2 p-1" inert={view !== "slider"}>
                    <div className="flex min-h-[35px] items-center justify-center px-2">
                        <button
                            type="button"
                            aria-label={t("composer-effort-list")}
                            onClick={() => setView("list")}
                            className="group/toggle flex min-h-8 items-center rounded-lg p-1 text-md leading-[22.86px] font-medium text-text outline-none focus-visible:outline-2 focus-visible:outline-ring"
                        >
                            {/* The pill hugs the label and chevron; the chevron side is a touch tighter so it reads centred. */}
                            <span className="inline-flex items-center gap-1 rounded-md py-0.5 ps-2.5 pe-2 hover-device:group-hover/toggle:bg-hover">
                                <span>{EFFORT_LABELS[value]}</span>
                                <CaretRight aria-hidden className="size-3.5 shrink-0 text-tertiary" />
                            </span>
                        </button>
                    </div>
                    <div className="py-1">
                        <Slider value={value} efforts={efforts} onChange={onChange} />
                    </div>
                </div>
                <div ref={(el) => void (panes.current[1] = el)} className="w-1/2 pt-1" inert={view !== "list"}>
                    <EffortList
                        value={value}
                        efforts={efforts}
                        onPick={(e) => {
                            onChange(e);
                            onClose();
                        }}
                    />
                </div>
            </div>
        </div>
    );
}

/**
 * Trigger label: every label sits in one grid cell and cross-fades (opacity + 4px blur, ui-spec 3.2), while the
 * cell width animates between measured label widths, so the pill and the popover anchor never jump.
 */
function TriggerLabel({ labels, active }: { labels: string[]; active: string }) {
    const cell = useRef<HTMLSpanElement>(null);
    const [width, setWidth] = useState<number | undefined>(undefined);
    useLayoutEffect(() => {
        const el = cell.current?.querySelector<HTMLElement>(`[data-label="${CSS.escape(active)}"]`);
        if (el) setWidth(el.scrollWidth);
    }, [active, labels]);
    return (
        <span
            ref={cell}
            className="grid min-w-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
            style={{ width }}
        >
            {labels.map((l) => (
                <span
                    key={l}
                    data-label={l}
                    aria-hidden={l !== active}
                    className={cn(
                        "col-start-1 row-start-1 w-max transition-[opacity,filter] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]",
                        l === active ? "opacity-100 blur-0" : "pointer-events-none opacity-0 blur-[4px]",
                    )}
                >
                    {l}
                </span>
            ))}
        </span>
    );
}

const EXIT_MS = 150;

export function EffortControl({
    value,
    efforts,
    onChange,
    side,
    open,
    onOpenChange,
    tray = false,
    iconOnly = false,
}: EffortProps) {
    const layer = useThemeLayer();
    const t = useT();
    const mobile = useIsMobile();
    // Keep the popover mounted while it animates out; Radix would otherwise drop it on the same frame.
    const [mounted, setMounted] = useState(open);
    const content = useRef<HTMLDivElement | null>(null);
    const tabbedOut = useRef(false);
    useLayoutEffect(() => {
        if (open) {
            setMounted(true);
            return;
        }
        const el = content.current;
        if (!el || reducedMotion()) {
            setMounted(false);
            return;
        }
        const anim = el.animate(
            [
                { opacity: 1, transform: "scale(1)" },
                { opacity: 0, transform: "scale(0.98)" },
            ],
            { duration: EXIT_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" },
        );
        anim.onfinish = () => setMounted(false);
        return () => anim.cancel();
    }, [open]);

    const labels = useMemo(
        () => [t("composer-effort-label"), EFFORT_LABELS.auto, ...efforts.map((e) => EFFORT_LABELS[e])],
        [efforts, t],
    );
    const trigger = tray ? (
        <button
            type="button"
            aria-label={t("composer-effort-trigger-label", { level: EFFORT_LABELS[value] })}
            data-balloon-anchor="effort"
            data-state={open ? "open" : "closed"}
            onClick={() => onOpenChange(true)}
            className={cn(
                "relative inline-flex h-10 min-w-0 shrink items-center gap-1 rounded-full border-0 px-2.5 text-sm leading-[18px] whitespace-nowrap text-tertiary outline-none select-none",
                touchTarget,
                "hover-device:hover:not-active:bg-hover hover-device:hover:text-text active:bg-pressed active:text-text data-[state=open]:not-active:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
            )}
        >
            <Lightbulb aria-hidden className="size-4 shrink-0" />
            {/* 200% text: the label gives way to the icon before the row runs out of room. */}
            <span className={cn("truncate max-[320px]:sr-only", iconOnly && "sr-only")}>{EFFORT_LABELS[value]}</span>
            <CaretDown aria-hidden className="size-3.5 shrink-0" />
        </button>
    ) : (
        <button
            type="button"
            aria-label={t("composer-effort-trigger-label", { level: EFFORT_LABELS[value] })}
            data-balloon-anchor="effort"
            data-state={open ? "open" : "closed"}
            onClick={mobile ? () => onOpenChange(true) : undefined}
            className={cn(
                "relative flex h-9 min-w-0 shrink-0 items-center gap-1.5 rounded-full border-0 ps-3 pe-3.5 text-md leading-[26px] font-[400] whitespace-nowrap text-tertiary outline-none select-none max-[320px]:px-2",
                "hover-device:hover:not-active:bg-hover hover-device:hover:text-text active:bg-pressed active:text-text data-[state=open]:not-active:bg-hover focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring",
                "after:absolute after:-inset-1 after:content-['']",
            )}
        >
            {/* Very narrow screens (a phone at 200% zoom): an icon stands in for the label, which would not fit. */}
            <Lightbulb aria-hidden className="hidden size-5 shrink-0 max-[320px]:block" />
            <span className="contents max-[320px]:hidden">
                <TriggerLabel
                    labels={labels}
                    active={open && !mobile ? t("composer-effort-label") : EFFORT_LABELS[value]}
                />
            </span>
            <CaretDown aria-hidden className="size-4 shrink-0" />
        </button>
    );

    if (mobile) {
        return (
            <>
                {trigger}
                <Sheet open={open} onOpenChange={onOpenChange} title={t("composer-effort-label")}>
                    <div className="pb-2">
                        <div className="px-1 pt-3 pb-3">
                            <Slider value={value} efforts={efforts} onChange={onChange} />
                        </div>
                        <EffortList
                            value={value}
                            efforts={efforts}
                            onPick={(e) => {
                                onChange(e);
                                onOpenChange(false);
                            }}
                        />
                    </div>
                </Sheet>
            </>
        );
    }

    return (
        <Popover.Root open={open} onOpenChange={onOpenChange}>
            <Popover.Trigger asChild>{trigger}</Popover.Trigger>
            {(open || mounted) && (
                <Popover.Portal forceMount container={layer}>
                    <Popover.Content
                        forceMount
                        ref={(el) => {
                            content.current = el;
                            if (el && !el.dataset.entered) {
                                el.dataset.entered = "1";
                                animateEnter(el);
                            }
                        }}
                        side={side}
                        align="center"
                        sideOffset={2}
                        collisionPadding={8}
                        aria-label={t("composer-effort-label")}
                        onKeyDown={(e) => {
                            if (tabOutOfPopover(e, () => onOpenChange(false))) tabbedOut.current = true;
                        }}
                        onCloseAutoFocus={(e) => {
                            // Tab already moved focus on; returning it to the trigger would undo that.
                            if (!tabbedOut.current) return;
                            tabbedOut.current = false;
                            e.preventDefault();
                        }}
                        onOpenAutoFocus={(e) => {
                            e.preventDefault();
                            // Focus the slider for arrow keys, without a focus ring after a pointer open.
                            const slider = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
                                "[role=slider]",
                            );
                            slider?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
                        }}
                        asChild
                    >
                        {/* Tail tip 2px from the trigger; the enter and exit scales grow from the tip. */}
                        <TailedContent
                            arrow={Popover.Arrow}
                            className={cn(!open && "pointer-events-none")}
                            bodyClassName="w-[249px]"
                        >
                            <EffortPanel
                                value={value}
                                efforts={efforts}
                                onChange={onChange}
                                onClose={() => onOpenChange(false)}
                            />
                        </TailedContent>
                    </Popover.Content>
                </Popover.Portal>
            )}
        </Popover.Root>
    );
}
