/**
 * TailedContent: a Radix popout drawn as one TailedSurface, with a tail that points at its trigger.
 *
 * Usage: render it as the Content's element, so Radix positions the surface itself, and pass that primitive's Arrow.
 *
 *     <Popover.Content side="top" sideOffset={2} collisionPadding={8} asChild>
 *         <TailedContent arrow={Popover.Arrow} bodyClassName="w-60 p-3">...</TailedContent>
 *     </Popover.Content>
 *
 * Any Radix part built on its popper works the same way (Popover, HoverCard, DropdownMenu, Tooltip).
 *
 * - Tail: Radix places an invisible arrow (useRadixTail). Its collision logic keeps the arrow on the anchor centre
 *   when the popout shifts at a viewport edge or flips to the other side; the arrow position and the placed side
 *   are read back into the outline. There is no tail while Radix cannot reach the anchor centre.
 * - Offset: `sideOffset` is the gap between the anchor and the tail tip. Radix adds the tail length, so the body sits
 *   further out. 2px matches tooltips and balloons.
 * - Body: the children sit in a body clipped 1px inside the outline with the corner radius, so a scrolling list or a
 *   full-bleed background keeps the hairline and the rounded corners, and the tail is never clipped. The root paints
 *   no background or box-shadow, so the only shadow is the outline's drop-shadow.
 * - Surface: the menu surface (--menu, --shadow-dropdown, --radius-2xl). `translucent` gives the menu glass (90% over
 *   an 8px blur, clipped to the outline), solid under prefers-reduced-transparency.
 * - Motion: the root's transform-origin is the tail tip, so a scale animation on the Content grows from the tail.
 * - Classes: `className` styles the surface (size, max-height, animation, pointer-events); `bodyClassName` styles the
 *   body (layout, padding, scrolling). Put classes here, not on the Content.
 *
 * Phone sheets have no anchor: render the sheet instead of this component, not inside it.
 */
import {
    useCallback,
    useState,
    type ComponentPropsWithRef,
    type ComponentType,
    type ReactElement,
    type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { cn } from "./lib/cn";
import { TAIL_SIZE, TailedSurface, type TailSide, type TailSize } from "./tailed-surface";

/** A Radix Arrow part (Popover.Arrow, HoverCard.Arrow, Tooltip.Arrow, DropdownMenu.Arrow). */
export type RadixArrow = ComponentType<{ asChild?: boolean; children?: ReactNode }>;

/** Where Radix put the tail: the placed side and the tail centre along the tailed edge, in px. */
export type RadixTail = { side: TailSide; offset: number };

/**
 * The tail Radix computed, read from the DOM. Render `arrow` as a direct child of the Content element; it is never
 * painted, and Radix sizes the side offset from it and positions it at the anchor centre.
 *
 * `tail` comes from the arrow holder's left/top (set by Radix after each collision pass) and the content's data-side
 * (the side after any flip). It is null until placed, and while Radix hides the arrow because it cannot reach the
 * anchor centre. Radix writes these during its own synchronous position update, so the observer commits with
 * flushSync: the tail lands in the same frame as the position, with no frame of a stale or missing tail.
 */
export function useRadixTail(Arrow: RadixArrow, size: TailSize): { tail: RadixTail | null; arrow: ReactElement } {
    const { width, height } = TAIL_SIZE[size];
    const [tail, setTail] = useState<RadixTail | null>(null);
    const track = useCallback(
        (node: HTMLSpanElement | null) => {
            const holder = node?.parentElement;
            const content = node?.closest<HTMLElement>("[data-side]");
            if (!holder || !content) return;
            const read = (): RadixTail | null => {
                const placed = content.dataset.side as TailSide | undefined;
                if (!placed || holder.style.visibility === "hidden") return null;
                // Radix centres the arrow with its width on a horizontal edge and its height on a vertical one.
                const across = placed === "left" || placed === "right";
                const start = Number.parseFloat(across ? holder.style.top : holder.style.left);
                if (!Number.isFinite(start)) return null;
                return { side: placed, offset: start + (across ? height : width) / 2 };
            };
            const update = () => {
                const next = read();
                setTail((prev) => (prev?.side === next?.side && prev?.offset === next?.offset ? prev : next));
            };
            update();
            const observer = new MutationObserver(() => flushSync(update));
            observer.observe(holder, { attributes: true, attributeFilter: ["style"] });
            observer.observe(content, { attributes: true, attributeFilter: ["data-side"] });
            return () => observer.disconnect();
        },
        [width, height],
    );
    const arrow = (
        <Arrow asChild>
            <span ref={track} aria-hidden="true" className="pointer-events-none" style={{ width, height }} />
        </Arrow>
    );
    return { tail, arrow };
}

export type TailedContentProps = ComponentPropsWithRef<"div"> & {
    /** The Radix primitive's Arrow part. */
    arrow: RadixArrow;
    /** Tail size; "md" (the balloon tail) suits panels. */
    size?: TailSize;
    /** The menu glass instead of the solid menu surface. */
    translucent?: boolean;
    /** Classes for the clipped body that holds the children. */
    bodyClassName?: string;
};

export function TailedContent({
    arrow,
    size = "md",
    translucent,
    className,
    bodyClassName,
    children,
    ...rest
}: TailedContentProps) {
    const { tail, arrow: holder } = useRadixTail(arrow, size);
    // Radix passes data-side to its Content element: the side it is placing on, before the arrow is measured.
    const placing = (rest as { "data-side"?: TailSide })["data-side"] ?? "bottom";
    return (
        <TailedSurface
            {...rest}
            side={tail?.side ?? placing}
            tail={tail?.offset ?? null}
            size={size}
            data-translucent={translucent || undefined}
            className={cn("tailed-content", className)}
        >
            <div className={cn("tailed-content-body", bodyClassName)}>{children}</div>
            {holder}
        </TailedSurface>
    );
}
