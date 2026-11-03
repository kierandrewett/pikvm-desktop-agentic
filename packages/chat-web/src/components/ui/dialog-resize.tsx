/**
 * Resizing for centred dialogs (`<Dialog resizable={...}>`). The dialog stays centred, so dragging one edge moves
 * both opposite edges: the size changes by twice the pointer movement and the centre never moves.
 *
 * - Pointer: every edge and corner is a handle. Double-click a handle to go back to the default size.
 * - Keyboard: three handles take focus (right edge for width, bottom edge for height, bottom-right corner for both).
 *   Arrow keys move the focused edge by 16px, Shift+arrow by 64px, Home resets. Eight tab stops would bury the
 *   dialog's content, and these three cover both axes.
 * - Limits: the spec's min and max, and never larger than the viewport minus a 16px margin on each side.
 * - Memory: the size is a per-viewer convenience kept in localStorage under `chat.dialog-size.<id>`. Storage can be
 *   missing or blocked (private windows), so every access is wrapped and the default size is the fallback.
 */
import { Dialog as D } from "radix-ui";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface ResizeSpec {
    /** Storage key for the remembered size. One per kind of dialog, for example "model-select". */
    id: string;
    width: number;
    height: number;
    minWidth?: number;
    minHeight?: number;
    maxWidth?: number;
    maxHeight?: number;
}

interface Size {
    w: number;
    h: number;
}

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const MARGIN = 16;
const STEP = 16;
const BIG_STEP = 64;
const storageKey = (id: string) => `chat.dialog-size.${id}`;

function read(id: string): Size | undefined {
    try {
        const raw = window.localStorage.getItem(storageKey(id));
        if (!raw) return undefined;
        const v = JSON.parse(raw) as Partial<Size>;
        return typeof v.w === "number" && typeof v.h === "number" ? { w: v.w, h: v.h } : undefined;
    } catch {
        return undefined;
    }
}

function write(id: string, size: Size | undefined): void {
    try {
        if (size) window.localStorage.setItem(storageKey(id), JSON.stringify(size));
        else window.localStorage.removeItem(storageKey(id));
    } catch {
        // Storage blocked: the size is kept for this dialog only.
    }
}

function useViewport(): Size {
    const get = () => ({ w: window.innerWidth, h: window.innerHeight });
    const [v, setV] = useState(get);
    useEffect(() => {
        const on = () => setV(get());
        window.addEventListener("resize", on);
        return () => window.removeEventListener("resize", on);
    }, []);
    return v;
}

/** Size, limits and handles for one resizable dialog. */
export function useDialogResize(spec: ResizeSpec) {
    const viewport = useViewport();
    const limits = {
        minW: Math.min(spec.minWidth ?? 360, viewport.w - 2 * MARGIN),
        minH: Math.min(spec.minHeight ?? 280, viewport.h - 2 * MARGIN),
        maxW: Math.min(spec.maxWidth ?? 1400, viewport.w - 2 * MARGIN),
        maxH: Math.min(spec.maxHeight ?? 1200, viewport.h - 2 * MARGIN),
    };
    const clamp = (s: Size): Size => ({
        w: Math.round(Math.max(limits.minW, Math.min(limits.maxW, s.w))),
        h: Math.round(Math.max(limits.minH, Math.min(limits.maxH, s.h))),
    });
    const [stored, setStored] = useState<Size | undefined>(() => read(spec.id));
    const size = clamp(stored ?? { w: spec.width, h: spec.height });
    const sizeRef = useRef(size);
    sizeRef.current = size;

    const commit = useCallback(
        (next: Size | undefined, persist: boolean) => {
            setStored(next);
            if (persist) write(spec.id, next);
        },
        [spec.id],
    );

    const drag = useRef<{ x: number; y: number; start: Size; edge: Edge; id: number } | null>(null);
    const onPointerDown = (edge: Edge) => (e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, start: sizeRef.current, edge, id: e.pointerId };
    };
    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const dx = (e.clientX - d.x) * 2;
        const dy = (e.clientY - d.y) * 2;
        const w = d.edge.includes("e") ? d.start.w + dx : d.edge.includes("w") ? d.start.w - dx : d.start.w;
        const h = d.edge.includes("s") ? d.start.h + dy : d.edge.includes("n") ? d.start.h - dy : d.start.h;
        commit(clamp({ w, h }), false);
    };
    const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
        if (!drag.current || drag.current.id !== e.pointerId) return;
        drag.current = null;
        write(spec.id, sizeRef.current);
    };
    const reset = () => commit(undefined, true);

    const onKeyDown = (edge: Edge) => (e: KeyboardEvent<HTMLDivElement>) => {
        const step = e.shiftKey ? BIG_STEP : STEP;
        const s = sizeRef.current;
        let next: Size | undefined;
        if (e.key === "Home") {
            e.preventDefault();
            return reset();
        }
        if (edge.includes("e") && (e.key === "ArrowRight" || e.key === "ArrowLeft"))
            next = { ...s, w: s.w + (e.key === "ArrowRight" ? step : -step) };
        if (edge.includes("s") && (e.key === "ArrowDown" || e.key === "ArrowUp"))
            next = { ...s, h: s.h + (e.key === "ArrowDown" ? step : -step) };
        if (!next) return;
        e.preventDefault();
        e.stopPropagation();
        commit(clamp(next), true);
    };

    const handle = (edge: Edge, focusable: boolean, label: string, className: string) => {
        const axis = edge === "e" || edge === "w" ? "w" : edge === "n" || edge === "s" ? "h" : undefined;
        return (
            <div
                key={edge}
                data-dialog-resize={edge}
                role={focusable ? "separator" : undefined}
                aria-hidden={focusable ? undefined : true}
                aria-label={focusable ? label : undefined}
                aria-orientation={focusable ? (axis === "h" ? "horizontal" : "vertical") : undefined}
                aria-valuenow={focusable ? (axis === "h" ? size.h : size.w) : undefined}
                aria-valuemin={focusable ? (axis === "h" ? limits.minH : limits.minW) : undefined}
                aria-valuemax={focusable ? (axis === "h" ? limits.maxH : limits.maxW) : undefined}
                aria-valuetext={focusable ? `${size.w} by ${size.h} pixels` : undefined}
                tabIndex={focusable ? 0 : undefined}
                onPointerDown={onPointerDown(edge)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerEnd}
                onPointerCancel={onPointerEnd}
                onDoubleClick={reset}
                onKeyDown={focusable ? onKeyDown(edge) : undefined}
                className={cn(
                    "absolute z-10 touch-none outline-none select-none",
                    // A thin accent line shows which edge has keyboard focus.
                    "after:pointer-events-none after:absolute after:rounded-full after:bg-ring after:opacity-0 focus-visible:after:opacity-100",
                    className,
                )}
            />
        );
    };

    const handles = [
        handle("n", false, "", "inset-x-4 -top-1 h-2 cursor-ns-resize"),
        handle(
            "s",
            true,
            "Resize dialog height",
            "inset-x-4 -bottom-1 h-2 cursor-ns-resize after:inset-x-6 after:top-[3px] after:h-0.5",
        ),
        handle("w", false, "", "inset-y-4 -left-1 w-2 cursor-ew-resize"),
        handle(
            "e",
            true,
            "Resize dialog width",
            "inset-y-4 -right-1 w-2 cursor-ew-resize after:inset-y-6 after:left-[3px] after:w-0.5",
        ),
        handle("nw", false, "", "-top-1 -left-1 size-4 cursor-nwse-resize"),
        handle("ne", false, "", "-top-1 -right-1 size-4 cursor-nesw-resize"),
        handle("sw", false, "", "-bottom-1 -left-1 size-4 cursor-nesw-resize"),
        handle(
            "se",
            true,
            "Resize dialog",
            "-right-1 -bottom-1 size-4 cursor-nwse-resize after:inset-1 after:rounded-sm",
        ),
    ];

    return { size, handles, reset };
}

/**
 * The dialog panel with a resizable size. Children fill the height: give the part that should grow
 * `flex-1 min-h-0`.
 */
export function ResizableContent({ spec, children }: { spec: ResizeSpec; children: ReactNode }) {
    const { size, handles } = useDialogResize(spec);
    return (
        <D.Content
            aria-describedby={undefined}
            data-dialog-resizable={spec.id}
            style={{ width: size.w, height: size.h }}
            className="fixed top-1/2 left-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-default bg-control p-5 shadow-dialog animate-[pop-in_150ms_var(--ease-enter)] outline-none"
        >
            {children}
            {handles}
        </D.Content>
    );
}
