/**
 * Toasts: short, non-blocking messages about something that happened away from where the user is looking (a
 * setting that failed to save, a chat that could not be archived, a copied path). Messages that confirm a change
 * at its control use the composer's pointing balloon instead, and form errors stay next to their fields.
 *
 * Undo offers are the exception: a change made anywhere offers its Undo in a toast (see undo.ts), so the way back
 * is always in the same place.
 *
 * API (callable from anywhere, no hook needed):
 *   toast.error(message, { description?, action?: { label, onClick, shortcut? }, id?, duration?, onClose? }) -> id
 *   toast.success(...), toast.info(...)
 *   toast.dismiss(id?)   (no id: dismiss all)
 * The same `id` updates a toast in place and restarts its timer. Without an id, a toast with the same kind and
 * message as a visible one reuses it, so a repeated failure does not pile up copies.
 * `onClose(reason)` runs once when the toast goes: "action" (its button), "dismiss" (close button, Escape, swipe,
 * toast.dismiss), "timeout", "evicted" (more than five on screen) or "replaced" (an update with another onClose).
 *
 * <Toaster /> is mounted once in the root route. Layout:
 * - bottom-right on desktop, bottom-centre on narrow screens above the docked composer and the safe area
 * - collapsed: the newest in front, up to two older ones peeking behind it (scaled down, offset upwards and
 *   clipped to the front toast's height)
 * - hovering or focusing the stack expands it into a list; leaving collapses it again
 * - timers pause while the stack is expanded, while a toast is being dragged and while the page is hidden;
 *   errors stay twice as long, and longer again when they offer an action
 * - swipe sideways (touch or mouse) to dismiss; Escape dismisses the focused toast; Alt+T focuses the stack
 * - errors are announced assertively (role alert), the rest politely (the list is a polite live region)
 *
 * Surface: the menu surface and dropdown shadow, so toasts read as the same family as menus and popovers.
 * Motion: enter rises from below with --ease-enter, reflow uses the same curve, exit fades with --ease-exit; all
 * durations scale with --motion-scale, and reduced motion is handled globally in app.css.
 */
import { CheckCircle, Info, WarningCircle, X } from "@pikvm/icons";
import { usePaneActive } from "../../lib/pane-active";
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type CSSProperties,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { useT } from "../../l10n/provider";
import { msg } from "../../l10n/runtime";
import { cn } from "../../lib/cn";
import { useIsMobile } from "../../lib/media";
import "./toast.css";

export type ToastKind = "error" | "success" | "info";

export interface ToastAction {
    label: string;
    onClick: () => void;
    /** Keyboard shortcut that does the same thing, as aria-keyshortcuts (for example "Control+Z"). */
    shortcut?: string;
}

export type ToastCloseReason = "action" | "dismiss" | "timeout" | "evicted" | "replaced";

export interface ToastOptions {
    description?: string | null;
    action?: ToastAction;
    id?: string;
    /** Milliseconds before it hides itself. Defaults by kind; `Infinity` keeps it until dismissed. */
    duration?: number;
    /** Runs once when this toast goes, with the reason. */
    onClose?: (reason: ToastCloseReason) => void;
}

interface ToastRecord {
    id: string;
    kind: ToastKind;
    message: string;
    description?: string | null;
    action?: ToastAction;
    duration: number;
    onClose?: (reason: ToastCloseReason) => void;
    /** Bumped on every update, which restarts the timer. */
    version: number;
    leaving: false | "fade" | "left" | "right";
}

const DURATION: Record<ToastKind, number> = { info: 4000, success: 4000, error: 8000 };
const ACTION_BONUS = 4000;
const MAX = 5;
const VISIBLE = 3;
const GAP = 8;
const PEEK = 14;
const SCALE_STEP = 0.05;
const ENTER_MS = 400;
const EXIT_MS = 200;

// Store

let list: ToastRecord[] = []; // newest first
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
    for (const fn of listeners) fn();
}

function motionScale(): number {
    if (typeof document === "undefined") return 1;
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--motion-scale"));
    return Number.isFinite(v) && v >= 0 ? v : 1;
}

function remove(id: string) {
    list = list.filter((t) => t.id !== id);
    emit();
}

function dismiss(id: string, how: ToastRecord["leaving"] = "fade", reason: ToastCloseReason = "dismiss") {
    const t = list.find((x) => x.id === id);
    if (!t || t.leaving) return;
    list = list.map((x) => (x.id === id ? { ...x, leaving: how } : x));
    emit();
    setTimeout(() => remove(id), EXIT_MS * motionScale() + 20);
    t.onClose?.(reason);
}

function show(kind: ToastKind, message: string, opts: ToastOptions = {}): string {
    const same = opts.id
        ? list.find((t) => t.id === opts.id && !t.leaving)
        : list.find((t) => !t.leaving && t.kind === kind && t.message === message);
    const id = same?.id ?? opts.id ?? `toast-${++seq}`;
    const rec: ToastRecord = {
        id,
        kind,
        message,
        description: opts.description,
        action: opts.action,
        duration: opts.duration ?? DURATION[kind] + (opts.action ? ACTION_BONUS : 0),
        onClose: opts.onClose,
        version: (same?.version ?? 0) + 1,
        leaving: false,
    };
    list = same ? list.map((t) => (t.id === id ? rec : t)) : [rec, ...list.filter((t) => t.id !== id)];
    emit();
    // The replaced record's owner (for example a pending delete) must still hear that its toast went.
    if (same?.onClose && same.onClose !== rec.onClose) same.onClose("replaced");
    for (const extra of list.filter((t) => !t.leaving).slice(MAX)) dismiss(extra.id, "fade", "evicted");
    return id;
}

export const toast = {
    error: (message: string, opts?: ToastOptions) => show("error", message, opts),
    success: (message: string, opts?: ToastOptions) => show("success", message, opts),
    info: (message: string, opts?: ToastOptions) => show("info", message, opts),
    dismiss: (id?: string) => {
        if (id) dismiss(id);
        else for (const t of list) dismiss(t.id);
    },
};

/** Message text for a caught error, for use as a toast description. */
export function errorDescription(e: unknown): string | undefined {
    if (!e) return undefined;
    if (e instanceof Error) return e.message || undefined;
    return String(e);
}

/**
 * Show an error toast whenever `error` changes to a new value (for example a mutation's `error`). One toast per
 * `id`, so a retried failure updates the same toast.
 */
export function useErrorToast(error: unknown, message: string, id?: string): void {
    useEffect(() => {
        if (error) toast.error(message, { id, description: errorDescription(error) });
        // Only a new error should toast; the message is static per call site.
    }, [error]);
}

function useToasts(): ToastRecord[] {
    return useSyncExternalStore(
        (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        () => list,
        () => list,
    );
}

// View

const ICON: Record<ToastKind, { el: typeof Info; className: string; weight: "fill" | "regular" }> = {
    error: { el: WarningCircle, className: "text-danger", weight: "fill" },
    success: { el: CheckCircle, className: "text-success", weight: "fill" },
    info: { el: Info, className: "text-secondary", weight: "regular" },
};

/** Bottom offset on narrow screens: above the docked composer when one is on screen, else above the safe area. */
function useMobileBottom(active: boolean, mobile: boolean): string {
    const [bottom, setBottom] = useState<string>("calc(12px + var(--safe-bottom))");
    useEffect(() => {
        if (!active || !mobile) return;
        const update = () => {
            const form = document.querySelector<HTMLElement>("form[data-layout]");
            const r = form?.getBoundingClientRect();
            const vh = visualViewport?.height ?? innerHeight;
            if (r && r.height > 0 && r.top < vh && r.top > vh / 2) setBottom(`${Math.round(vh - r.top + 8)}px`);
            else setBottom("calc(12px + var(--safe-bottom))");
        };
        update();
        const form = document.querySelector<HTMLElement>("form[data-layout]");
        const ro = new ResizeObserver(update);
        if (form) ro.observe(form);
        visualViewport?.addEventListener("resize", update);
        addEventListener("resize", update);
        return () => {
            ro.disconnect();
            visualViewport?.removeEventListener("resize", update);
            removeEventListener("resize", update);
        };
    }, [active, mobile]);
    return bottom;
}

export function Toaster() {
    const tr = useT();
    const toasts = useToasts();
    const mobile = useIsMobile();
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
    const [heights, setHeights] = useState<Record<string, number>>({});
    const listRef = useRef<HTMLOListElement>(null);

    const paneActive = usePaneActive();
    useEffect(() => {
        const onVis = () => setHidden(document.hidden);
        document.addEventListener("visibilitychange", onVis);
        // Alt+T is a page-wide key: only while the Chat pane is in front.
        const onKey = (e: KeyboardEvent) => {
            if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyT") {
                const first = listRef.current?.querySelector<HTMLElement>("li[data-toast]:not([data-leaving])");
                if (!first) return;
                e.preventDefault();
                first.focus();
            }
        };
        if (paneActive) addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("visibilitychange", onVis);
            removeEventListener("keydown", onKey);
        };
    }, [paneActive]);

    const live = toasts.filter((t) => !t.leaving);
    // Collapse once the last toast is gone, so the next one does not arrive expanded.
    useEffect(() => {
        if (!toasts.length) {
            setHovered(false);
            setFocused(false);
        }
    }, [toasts.length]);

    const onHeight = useCallback((id: string, h: number) => {
        setHeights((m) => (m[id] === h ? m : { ...m, [id]: h }));
    }, []);

    const bottom = useMobileBottom(toasts.length > 0, mobile);
    const expanded = (hovered || focused) && live.length > 0;
    const frontHeight = (live[0] && heights[live[0].id]) ?? 56;

    // Offsets for the expanded list, newest at the bottom.
    const offsets: Record<string, number> = {};
    let acc = 0;
    live.forEach((t, i) => {
        offsets[t.id] = acc;
        acc += (heights[t.id] ?? 56) + (i < live.length - 1 ? GAP : 0);
    });
    const listHeight = expanded ? acc : frontHeight + Math.min(live.length - 1, VISIBLE - 1) * PEEK;

    if (!toasts.length) return null;
    return (
        <section
            aria-label={tr(msg("ui-toast-region"), { shortcut: "Alt+T" })}
            data-toast-layout={mobile ? "mobile" : "desktop"}
            className={cn("toast-region pointer-events-none fixed z-[100]", mobile ? "inset-x-3" : "w-[360px]")}
            style={{ bottom: mobile ? bottom : "calc(var(--toast-edge) + var(--safe-bottom))" }}
        >
            <ol
                ref={listRef}
                aria-live="polite"
                onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(true)}
                onPointerLeave={(e) => e.pointerType === "mouse" && setHovered(false)}
                onFocus={() => setFocused(true)}
                onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
                }}
                className="pointer-events-auto relative transition-[height] duration-[400ms] ease-[var(--ease-enter)]"
                style={{ height: Math.max(listHeight, 0) }}
            >
                {toasts.map((t) => {
                    const index = live.indexOf(t);
                    return (
                        <ToastRow
                            key={t.id}
                            toast={t}
                            index={index}
                            count={live.length}
                            expanded={expanded}
                            offset={offsets[t.id] ?? 0}
                            frontHeight={frontHeight}
                            height={heights[t.id]}
                            paused={expanded || hidden}
                            onHeight={onHeight}
                        />
                    );
                })}
            </ol>
        </section>
    );
}

function ToastRow({
    toast: t,
    index,
    count,
    expanded,
    offset,
    frontHeight,
    height,
    paused,
    onHeight,
}: {
    toast: ToastRecord;
    /** Position among visible toasts, 0 = newest; -1 while leaving. */
    index: number;
    count: number;
    expanded: boolean;
    offset: number;
    frontHeight: number;
    height: number | undefined;
    paused: boolean;
    onHeight: (id: string, h: number) => void;
}) {
    const tr = useT();
    const inner = useRef<HTMLDivElement>(null);
    const [mounted, setMounted] = useState(false);
    const [drag, setDrag] = useState<number | null>(null);
    const dragStart = useRef<{ x: number; y: number; t: number; id: number; active: boolean } | null>(null);
    // Last resting transform, so a leaving toast fades where it stood instead of jumping.
    const rest = useRef("");

    useLayoutEffect(() => {
        const el = inner.current;
        if (!el) return;
        onHeight(t.id, el.offsetHeight);
        const ro = new ResizeObserver(() => onHeight(t.id, el.offsetHeight));
        ro.observe(el);
        return () => ro.disconnect();
    }, [t.id, onHeight]);

    // Two frames: the first paints the start state, the second starts the transition.
    useEffect(() => {
        let a = 0;
        let b = 0;
        a = requestAnimationFrame(() => {
            b = requestAnimationFrame(() => setMounted(true));
        });
        return () => {
            cancelAnimationFrame(a);
            cancelAnimationFrame(b);
        };
    }, []);

    // Auto-dismiss: the remaining time survives pauses; an update (new version) starts over.
    const remaining = useRef(t.duration);
    const version = useRef(t.version);
    if (version.current !== t.version) {
        version.current = t.version;
        remaining.current = t.duration;
    }
    const holding = paused || drag !== null || !!t.leaving;
    useEffect(() => {
        if (holding || !Number.isFinite(remaining.current)) return;
        const started = Date.now();
        const timer = setTimeout(() => dismiss(t.id, "fade", "timeout"), remaining.current);
        return () => {
            clearTimeout(timer);
            remaining.current = Math.max(0, remaining.current - (Date.now() - started));
        };
    }, [holding, t.id, t.version]);

    const front = index === 0;
    const hiddenBehind = !expanded && index >= VISIBLE;
    let transform: string;
    if (t.leaving === "left" || t.leaving === "right") {
        transform = `${rest.current} translateX(${t.leaving === "left" ? -110 : 110}%)`;
    } else if (t.leaving) {
        transform = `${rest.current} scale(0.96)`;
    } else if (!mounted) {
        transform = "translateY(100%)";
    } else if (expanded) {
        transform = `translateY(${-offset}px)`;
    } else {
        transform = `translateY(${-index * PEEK}px) scale(${1 - index * SCALE_STEP})`;
    }
    if (!t.leaving && mounted) rest.current = transform;
    if (drag !== null) transform = `${rest.current} translateX(${drag}px)`;

    const style: CSSProperties = {
        transform,
        zIndex: t.leaving ? 0 : count - index,
        opacity:
            t.leaving || !mounted || hiddenBehind ? 0 : drag !== null ? Math.max(0.3, 1 - Math.abs(drag) / 240) : 1,
        // Older toasts take the front toast's height while collapsed, so only their top edge peeks out.
        height: !expanded && !front && !t.leaving ? frontHeight : height,
        transitionProperty: drag !== null ? "none" : "transform, opacity, height",
        transitionDuration: `calc(${t.leaving ? EXIT_MS : ENTER_MS}ms * var(--motion-scale))`,
        transitionTimingFunction: t.leaving ? "var(--ease-exit)" : "var(--ease-enter)",
        pointerEvents: t.leaving || hiddenBehind ? "none" : undefined,
    };

    const onPointerDown = (e: ReactPointerEvent<HTMLLIElement>) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        dragStart.current = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, active: false };
    };
    const onPointerMove = (e: ReactPointerEvent<HTMLLIElement>) => {
        const s = dragStart.current;
        if (!s || s.id !== e.pointerId) return;
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        if (!s.active) {
            if (Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(dy)) return;
            s.active = true;
            e.currentTarget.setPointerCapture(e.pointerId);
        }
        setDrag(dx);
    };
    const endDrag = (e: ReactPointerEvent<HTMLLIElement>) => {
        const s = dragStart.current;
        dragStart.current = null;
        if (!s?.active || drag === null) return setDrag(null);
        const v = Math.abs(drag) / Math.max(1, performance.now() - s.t);
        if (Math.abs(drag) > 72 || v > 0.45) {
            dismiss(t.id, drag < 0 ? "left" : "right");
            rest.current = `${rest.current} translateX(${drag}px)`;
        }
        setDrag(null);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    };

    const Icon = ICON[t.kind];
    return (
        <li
            data-toast={t.kind}
            data-leaving={t.leaving || undefined}
            role={t.kind === "error" ? "alert" : "status"}
            aria-atomic
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    dismiss(t.id);
                }
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            style={style}
            className={cn(
                "absolute inset-x-0 bottom-0 origin-bottom touch-pan-y overflow-hidden rounded-[var(--toast-radius)] bg-menu text-text shadow-dropdown outline-none select-none",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            )}
        >
            <div ref={inner} className="flex items-start gap-2.5 py-3 ps-3.5 pe-2.5">
                <Icon.el aria-hidden weight={Icon.weight} className={cn("mt-px size-5 shrink-0", Icon.className)} />
                <div className="min-w-0 flex-1 py-px">
                    <div className="text-sm leading-5 font-medium break-words">{t.message}</div>
                    {t.description && (
                        <div className="mt-0.5 line-clamp-3 text-xs leading-4 break-words text-secondary">
                            {t.description}
                        </div>
                    )}
                </div>
                {t.action && (
                    <button
                        type="button"
                        data-toast-action
                        aria-keyshortcuts={t.action.shortcut}
                        onClick={() => {
                            t.action?.onClick();
                            dismiss(t.id, "fade", "action");
                        }}
                        className="-my-0.5 h-7 shrink-0 rounded-full bg-hover px-3 text-sm font-medium text-text outline-none hover-device:hover:bg-[color-mix(in_oklab,var(--text)_12%,transparent)] focus-visible:outline-2 focus-visible:outline-ring"
                    >
                        {t.action.label}
                    </button>
                )}
                <button
                    type="button"
                    aria-label={tr(msg("ui-toast-dismiss"))}
                    onClick={() => dismiss(t.id)}
                    className="relative -my-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-tertiary outline-none after:absolute after:-inset-1 after:content-[''] hover-device:hover:bg-hover hover-device:hover:text-text focus-visible:outline-2 focus-visible:outline-ring"
                >
                    <X aria-hidden className="size-4" />
                </button>
            </div>
        </li>
    );
}
