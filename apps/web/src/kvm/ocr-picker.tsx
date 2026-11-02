/**
 * Drag a rectangle on the picture to say which part of the screen to read.
 *
 * The overlay sits over the picture and takes the pointer, so the pointer machine never sees
 * the drag (nothing is clicked on the target). The answer is in the picture's own pixels, mapped
 * back through the letterbox and the zoom, so it is the region kvmd's OCR needs whatever the
 * view looks like.
 */

import type { Box, NaturalSize } from "@pikvm/kvm-engine";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useKvmActive } from "./active";
import type { PictureController } from "./picture-controller";

export interface PicturePixelRect {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

export interface OcrPicker {
    /** Resolves with the region in picture pixels, or null when cancelled (Escape, a bare tap, no picture). */
    pick(): Promise<PicturePixelRect | null>;
    cancel(): void;
}

/** Below this the drag was a tap, not a selection. */
export const MIN_PICK_PX = 6;

interface ClientRect {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
}

/** A client-space drag, clipped to the picture and expressed in its natural pixels. Null when it misses or is too small. */
export function rectToPicturePixels(drag: ClientRect, box: Box | null, nat: NaturalSize): PicturePixelRect | null {
    if (!box || box.w <= 0 || box.h <= 0) return null;
    const clampX = (x: number): number => Math.max(box.left, Math.min(box.left + box.w, x));
    const clampY = (y: number): number => Math.max(box.top, Math.min(box.top + box.h, y));
    const x0 = clampX(Math.min(drag.x0, drag.x1));
    const x1 = clampX(Math.max(drag.x0, drag.x1));
    const y0 = clampY(Math.min(drag.y0, drag.y1));
    const y1 = clampY(Math.max(drag.y0, drag.y1));
    if (x1 - x0 < MIN_PICK_PX || y1 - y0 < MIN_PICK_PX) return null;
    const fx = nat.w / box.w;
    const fy = nat.h / box.h;
    return {
        left: Math.round((x0 - box.left) * fx),
        top: Math.round((y0 - box.top) * fy),
        right: Math.round((x1 - box.left) * fx),
        bottom: Math.round((y1 - box.top) * fy),
    };
}

const PickerContext = createContext<OcrPicker | null>(null);

/** For the OCR dialog: `const { pick } = useOcrPicker()`. */
export function useOcrPicker(): OcrPicker {
    const picker = useContext(PickerContext);
    if (!picker) throw new Error("useOcrPicker needs the KVM screen");
    return picker;
}

interface Pending {
    readonly resolve: (rect: PicturePixelRect | null) => void;
    /** Where the picture's pane is, so the overlay sits exactly over it. */
    readonly pane: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
}

export function OcrPickerProvider({ controller, children }: { controller: PictureController | null; children: ReactNode }) {
    const [pending, setPending] = useState<Pending | null>(null);
    const [drag, setDrag] = useState<ClientRect | null>(null);
    const pendingRef = useRef<Pending | null>(null);

    const settle = useCallback((rect: PicturePixelRect | null) => {
        const current = pendingRef.current;
        pendingRef.current = null;
        setPending(null);
        setDrag(null);
        current?.resolve(rect);
    }, []);

    const picker = useMemo<OcrPicker>(
        () => ({
            pick() {
                // A second request supersedes the first rather than leaving it hanging.
                settle(null);
                return new Promise<PicturePixelRect | null>((resolve) => {
                    controller?.remeasure();
                    const pane = controller?.pointer.machine.environment.pane ?? { left: 0, top: 0, width: 0, height: 0 };
                    const next: Pending = { resolve, pane };
                    pendingRef.current = next;
                    setPending(next);
                });
            },
            cancel: () => settle(null),
        }),
        [settle, controller],
    );

    const active = useKvmActive();
    useEffect(() => {
        if (!pending || !active) return;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === "Escape") settle(null);
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [pending, settle, active]);

    useEffect(() => () => settle(null), [settle]);

    const finish = (end: ClientRect): void => {
        const machine = controller?.pointer.machine;
        settle(machine ? rectToPicturePixels(end, machine.pictureBox, machine.environment.nat) : null);
    };

    const frame = drag
        ? { left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }
        : null;

    return (
        <PickerContext.Provider value={picker}>
            {children}
            {pending ? (
                <div
                    className="kvm-ocr-pick"
                    data-kvm-ui=""
                    // Over the picture's pane when it is known; the whole window rather than a sliver when not.
                    style={pending.pane.width > 0 && pending.pane.height > 0 ? pending.pane : undefined}
                    role="application"
                    aria-label="Drag over the part of the screen to read. Escape cancels."
                    onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setDrag({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
                    }}
                    onPointerMove={(e) => setDrag((d) => (d ? { ...d, x1: e.clientX, y1: e.clientY } : d))}
                    onPointerUp={(e) => {
                        if (drag) finish({ ...drag, x1: e.clientX, y1: e.clientY });
                        else settle(null);
                    }}
                    onPointerCancel={() => settle(null)}
                >
                    <span className="kvm-ocr-hint">Drag over the text to read</span>
                    {frame ? (
                        <div
                            className="kvm-ocr-rect"
                            style={{ left: frame.left - pending.pane.left, top: frame.top - pending.pane.top, width: frame.width, height: frame.height }}
                        />
                    ) : null}
                </div>
            ) : null}
        </PickerContext.Provider>
    );
}
