/**
 * Bottom sheet for touch layouts. Drag the handle or content down to dismiss; it follows the finger
 * and closes when pulled past a third of its height or flicked down. Escape and the scrim close it too.
 *
 * A drag only starts when the scroll area under the finger is at its top, so scrolling a long list (or a
 * nested scroller such as the emoji grid) never pulls the sheet. When the browser takes the gesture over
 * (pointercancel, for example a sideways pan), the sheet snaps back instead of closing.
 *
 * Focus: Radix moves focus into the sheet and traps it. `onOpenAutoFocus` and `onCloseAutoFocus` pass through,
 * so a sheet opened by a gesture (no focused trigger) can keep focus off the composer when it closes, which
 * would otherwise bring up the on-screen keyboard.
 *
 * Opened by a long-press: the finger is still down when the sheet appears, and Chrome turns its release into a
 * click at the release point, now over the sheet. The sheet ignores a click that no pointer pressed inside it
 * (keyboard activation keeps `detail` 0 and still works), so the release cannot pick a row or toggle a reaction.
 * The opener's own capture guard only covers the pressed element, not this portal.
 */
import { Dialog } from "radix-ui";
import { useEffect, useRef, type ReactNode } from "react";
import { useT } from "../../l10n/provider";
import { cn } from "../../lib/cn";
import { useThemeLayer } from "../../lib/theme-scope";

/** How long after opening a click without a pointer press inside counts as the opener's release. */
const RELEASE_WINDOW_MS = 700;

/** The nearest element between `el` and `stop` that scrolls vertically and is not at its top. */
function scrolledAncestor(el: Element | null, stop: Element): boolean {
    for (let n = el; n && n !== stop; n = n.parentElement) {
        if (!(n instanceof HTMLElement) || n.scrollHeight <= n.clientHeight + 1) continue;
        const oy = getComputedStyle(n).overflowY;
        if ((oy === "auto" || oy === "scroll") && n.scrollTop > 0) return true;
    }
    return false;
}

export function Sheet({
    open,
    onOpenChange,
    title,
    titleHidden = false,
    description,
    onOpenAutoFocus,
    onCloseAutoFocus,
    className,
    children,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title?: string;
    /** Keep the title for screen readers only. */
    titleHidden?: boolean;
    /** Screen-reader description of the sheet. */
    description?: string;
    onOpenAutoFocus?: (e: Event) => void;
    onCloseAutoFocus?: (e: Event) => void;
    className?: string;
    children: ReactNode;
}) {
    const layer = useThemeLayer();
    const panel = useRef<HTMLDivElement>(null);
    const drag = useRef<{ y: number; t: number; dy: number; id: number } | null>(null);
    // True once a pointer has pressed inside the open sheet; a click before that, within the first moments after
    // opening, is the opener's release. The time bound keeps assistive technology that clicks without a pointer
    // press working after that window.
    const pressedInside = useRef(false);
    const openedAt = useRef(0);
    if (!open) pressedInside.current = false;
    useEffect(() => {
        if (open) openedAt.current = performance.now();
    }, [open]);
    const isOpenerRelease = (e: React.MouseEvent) =>
        !pressedInside.current && e.detail !== 0 && performance.now() - openedAt.current < RELEASE_WINDOW_MS;

    const reset = () => {
        if (!panel.current) return;
        panel.current.style.transition = "transform 200ms var(--ease-standard)";
        panel.current.style.transform = "";
    };
    const onPointerDown = (e: React.PointerEvent) => {
        if (!e.isPrimary || !panel.current) return;
        const target = e.target as Element;
        if (target.closest("input, textarea, select, [contenteditable], [role=slider]")) return;
        if (scrolledAncestor(target, panel.current)) return;
        drag.current = { y: e.clientY, t: performance.now(), dy: 0, id: e.pointerId };
    };
    const onPointerMove = (e: React.PointerEvent) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId || !panel.current) return;
        d.dy = Math.max(0, e.clientY - d.y);
        panel.current.style.transition = "none";
        panel.current.style.transform = `translateY(${d.dy}px)`;
    };
    const onPointerUp = (e: React.PointerEvent) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        drag.current = null;
        if (!panel.current) return;
        const velocity = d.dy / Math.max(1, performance.now() - d.t);
        const h = panel.current.offsetHeight;
        if (d.dy > h / 3 || (d.dy > 24 && velocity > 0.6)) {
            panel.current.style.transition = "transform 200ms var(--ease-standard)";
            panel.current.style.transform = "translateY(100%)";
            setTimeout(() => onOpenChange(false), 180);
        } else reset();
    };
    const onPointerCancel = (e: React.PointerEvent) => {
        if (drag.current?.id !== e.pointerId) return;
        drag.current = null;
        reset();
    };

    const t = useT();
    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal container={layer}>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim animate-[fade-in_150ms]" />
                <Dialog.Content
                    ref={panel}
                    // Radix links Dialog.Description itself; without one, opt out of its missing-description warning.
                    {...(description ? {} : { "aria-describedby": undefined })}
                    onOpenAutoFocus={onOpenAutoFocus}
                    onCloseAutoFocus={onCloseAutoFocus}
                    onPointerDownCapture={() => {
                        pressedInside.current = true;
                    }}
                    onClickCapture={(e) => {
                        if (!isOpenerRelease(e)) return;
                        e.preventDefault();
                        e.stopPropagation();
                    }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerCancel}
                    className={cn(
                        "fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] touch-none flex-col rounded-t-3xl bg-menu pr-[var(--safe-right)] pb-[max(8px,var(--safe-bottom))] pl-[var(--safe-left)] shadow-menu animate-[slide-up_220ms_var(--ease-enter)] outline-none",
                        className,
                    )}
                >
                    <div aria-hidden className="flex justify-center pt-2 pb-1">
                        <div className="h-1 w-9 rounded-full bg-strong" />
                    </div>
                    <Dialog.Title
                        className={title && !titleHidden ? "px-5 pt-1 pb-2 text-sm text-tertiary" : "sr-only"}
                    >
                        {title ?? t("ui-sheet-default-title")}
                    </Dialog.Title>
                    {description && <Dialog.Description className="sr-only">{description}</Dialog.Description>}
                    <div data-sheet-scroll className="touch-pan-y overflow-y-auto overscroll-contain px-2">
                        {children}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
