/**
 * Swipe gestures for edge panels on touch layouts (PLAN.md "Gestures on touch devices"): the sidebar drawer on
 * the start side, and the side panel on the end side (ui/side-panel.tsx, thread/conversation-page.tsx).
 *
 * `attachPanGesture` is the shared engine. A horizontal pan drags a panel that lives on `side`: towards the
 * middle of the screen opens it, back towards its edge closes it. The gesture only engages once the pan is
 * clearly horizontal, so vertical scrolling is never hijacked, and it ignores pans that start inside a
 * horizontal scroller (code blocks, tables, tab strips), in a text field, under `[data-no-drawer-gesture]`, or
 * while text is selected. While dragging it reports progress (0 closed .. 1 open) through `onProgress`, so the
 * caller can move the panel with the finger without a React render; on release it snaps by velocity first,
 * then by position.
 *
 * `attachDrawerGesture` is the sidebar drawer: it writes `--drawer-progress` on the shell root and marks the root
 * `data-dragging` while a drag runs. The shell attaches the end side the same way (`--end-progress`), so the two
 * sides share easing, thresholds and clamping and cannot drift apart.
 */
export interface PanGestureOptions {
    /** Element that receives the pointer events. */
    root: HTMLElement;
    /** The screen edge the panel lives on. */
    side: "start" | "end";
    width: () => number;
    isOpen: () => boolean;
    setOpen: (open: boolean) => void;
    enabled: () => boolean;
    /** A closed panel opens only from a pan that starts within this many px of its edge (default: anywhere). */
    edge?: number;
    /** Whether a closed panel can be opened, and an open one closed, by this gesture (default both). */
    canOpen?: boolean;
    canClose?: boolean;
    /** Progress while dragging, 0 (closed) to 1 (open); null when the drag ends. */
    onProgress?: (progress: number | null) => void;
    /** The pan has engaged as this gesture (once per drag), after writing the first progress. */
    onEngage?: () => void;
}

const ENGAGE_PX = 10;
const HORIZONTAL_RATIO = 1.4;
const FLICK_VELOCITY = 0.35; // px per ms
/** A pan that starts this close to the screen's own edge is the OS back gesture's, not ours. */
const SCREEN_EDGE_PX = 16;

/** Pans that start here belong to something else: a horizontal scroller, a field or a marked element. */
function ownedElsewhere(el: Element | null, root: HTMLElement): boolean {
    if (el?.closest("input, textarea, select, [contenteditable], [role=slider]")) return true;
    for (let n = el; n && n !== root; n = n.parentElement) {
        if (n instanceof HTMLElement && n.dataset.noDrawerGesture !== undefined) return true;
        if (!(n instanceof HTMLElement) || n.scrollWidth <= n.clientWidth + 1) continue;
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll") return true;
    }
    return false;
}

export function attachPanGesture(o: PanGestureOptions): () => void {
    // +1 when opening means moving right (start side), -1 when it means moving left (end side).
    const opens = o.side === "start" ? 1 : -1;
    let start: { x: number; y: number; t: number; open: boolean; id: number } | null = null;
    let engaged = false;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0;
    let suppressClick = false;

    const finish = (open: boolean) => {
        const pointer = start;
        const wasEngaged = engaged;
        start = null;
        engaged = false;
        if (!pointer || !wasEngaged) return;
        suppressClick = true;
        o.onProgress?.(null);
        o.setOpen(open);
        if (o.root.hasPointerCapture(pointer.id)) o.root.releasePointerCapture(pointer.id);
    };

    const cancel = () => {
        if (start) finish(start.open);
    };

    const progress = (x: number) => {
        const base = start?.open ? 1 : 0;
        return Math.min(1, Math.max(0, base + (opens * (x - (start?.x ?? x))) / Math.max(1, o.width())));
    };

    const down = (e: PointerEvent) => {
        if (start && e.pointerId !== start.id) {
            cancel();
            return;
        }
        suppressClick = false;
        if (e.pointerType === "mouse" || !e.isPrimary || !o.enabled() || start) return;
        const open = o.isOpen();
        if ((open && o.canClose === false) || (!open && o.canOpen === false)) return;
        if (e.clientX < SCREEN_EDGE_PX || e.clientX > window.innerWidth - SCREEN_EDGE_PX) return;
        if (ownedElsewhere(e.target as Element, o.root)) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) return;
        if (!open && o.edge !== undefined) {
            const box = o.root.getBoundingClientRect();
            const fromEdge = o.side === "start" ? e.clientX - box.left : box.right - e.clientX;
            if (fromEdge > o.edge) return;
        }
        start = { x: e.clientX, y: e.clientY, t: performance.now(), open, id: e.pointerId };
        engaged = false;
        lastX = e.clientX;
        lastT = start.t;
        velocity = 0;
    };

    const move = (e: PointerEvent) => {
        if (!start || e.pointerId !== start.id) return;
        if (!o.enabled()) {
            cancel();
            return;
        }
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!engaged) {
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed && selection.toString().trim()) {
                cancel();
                return;
            }
            if (Math.abs(dy) > ENGAGE_PX && Math.abs(dy) > Math.abs(dx)) {
                start = null;
                return;
            }
            if (Math.abs(dx) < ENGAGE_PX || Math.abs(dx) < Math.abs(dy) * HORIZONTAL_RATIO) return;
            // A closed panel only opens on a pan towards the middle; an open one only closes on a pan back.
            const towardsOpen = Math.sign(dx) === opens;
            if ((!start.open && !towardsOpen) || (start.open && towardsOpen)) {
                start = null;
                return;
            }
            engaged = true;
            o.root.setPointerCapture(e.pointerId);
            // Progress must precede a callback that mounts the panel or makes the original target inert.
            o.onProgress?.(progress(e.clientX));
            o.onEngage?.();
        }
        const now = performance.now();
        // Velocity in the opening direction.
        velocity = (opens * (e.clientX - lastX)) / Math.max(1, now - lastT);
        lastX = e.clientX;
        lastT = now;
        o.onProgress?.(progress(e.clientX));
        e.preventDefault();
    };

    const up = (e: PointerEvent) => {
        if (!start || e.pointerId !== start.id) return;
        const open =
            e.type === "pointercancel" || !o.enabled()
                ? start.open
                : velocity > FLICK_VELOCITY
                  ? true
                  : velocity < -FLICK_VELOCITY
                    ? false
                    : progress(e.clientX) > 0.5;
        finish(open);
    };

    const lostCapture = (e: PointerEvent) => {
        if (e.target === o.root && start?.id === e.pointerId) cancel();
    };
    const click = (e: MouseEvent) => {
        if (!suppressClick || e.detail === 0) return;
        suppressClick = false;
        e.preventDefault();
        e.stopImmediatePropagation();
    };

    const opts = { passive: false } as const;
    o.root.addEventListener("pointerdown", down, true);
    o.root.addEventListener("pointermove", move, opts);
    o.root.addEventListener("pointerup", up);
    o.root.addEventListener("pointercancel", up);
    o.root.addEventListener("lostpointercapture", lostCapture);
    o.root.addEventListener("click", click, true);
    return () => {
        cancel();
        o.root.removeEventListener("pointerdown", down, true);
        o.root.removeEventListener("pointermove", move);
        o.root.removeEventListener("pointerup", up);
        o.root.removeEventListener("pointercancel", up);
        o.root.removeEventListener("lostpointercapture", lostCapture);
        o.root.removeEventListener("click", click, true);
    };
}

export interface DrawerGestureOptions {
    root: HTMLElement;
    width: () => number;
    isOpen: () => boolean;
    setOpen: (open: boolean) => void;
    enabled: () => boolean;
}

/**
 * Progress writer for the shell: the drag's progress in a CSS variable on the root, and `data-dragging` while it
 * runs (transitions are off then, so the panel and the page follow the finger).
 */
export function progressVariable(root: HTMLElement, name: string): (p: number | null) => void {
    return (p) => {
        if (p === null) {
            delete root.dataset.dragging;
            root.style.removeProperty(name);
            return;
        }
        root.dataset.dragging = "true";
        root.style.setProperty(name, String(p));
    };
}

/** The sidebar drawer: a pan anywhere on the shell, progress in `--drawer-progress` on the root. */
export function attachDrawerGesture(o: DrawerGestureOptions): () => void {
    return attachPanGesture({ ...o, side: "start", onProgress: progressVariable(o.root, "--drawer-progress") });
}
