/**
 * Tooltip (reference spec 5.1): 200ms open delay, instant close, no animation, collision padding 8px.
 *
 * The surface is a TailedSurface: body and tail are one outline, so the hairline and shadow run round the tail.
 * The tail tip sits 2px from the trigger (the spec's offset); the body moves out by the tail length. Radix places
 * the tail: an invisible Radix arrow is measured by its collision logic, and its position (which follows the
 * trigger centre when the tooltip is shifted or flipped) is read back into the outline.
 *
 * The portal container comes from PortalLayerContext (portal-layer.ts), which the app provides.
 */
import { Tooltip as T } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import { shortcutLabel, useCoarsePointer } from "./lib/media";
import { usePortalLayer } from "./portal-layer";
import { Kbd } from "./kbd";
import { useRadixTail } from "./tailed-content";
import { TailedSurface, type TailSide } from "./tailed-surface";
import "./tooltip.css";

export function TooltipProvider({ children }: { children: ReactNode }) {
    return (
        <T.Provider delayDuration={200} skipDelayDuration={300}>
            {children}
        </T.Provider>
    );
}

export function Tooltip({
    label,
    shortcut,
    side = "top",
    children,
}: {
    label: ReactNode;
    shortcut?: string;
    side?: "top" | "bottom" | "left" | "right";
    children: ReactElement;
}) {
    const layer = usePortalLayer();
    // Touch devices get no hover tooltips; long-press is reserved for context actions.
    if (useCoarsePointer()) return children;
    return (
        <T.Root>
            <T.Trigger asChild>{children}</T.Trigger>
            <T.Portal container={layer}>
                <TooltipContent label={label} shortcut={shortcut} side={side} />
            </T.Portal>
        </T.Root>
    );
}

function TooltipContent({ label, shortcut, side }: { label: ReactNode; shortcut?: string; side: TailSide }) {
    // Never painted: Radix sizes the offset from the arrow and positions it at the trigger centre.
    const { tail, arrow } = useRadixTail(T.Arrow, "sm");
    return (
        <T.Content data-chat-tooltip side={side} sideOffset={2} collisionPadding={8} asChild>
            <TailedSurface
                side={tail?.side ?? side}
                tail={tail?.offset ?? null}
                size="sm"
                className="pointer-events-none z-50 flex max-w-80 select-none items-center gap-2 px-3 py-[5px] text-center text-sm leading-[18px] tracking-[-0.15px] text-text"
            >
                <span>{label}</span>
                {shortcut && (
                    <Kbd tone="tooltip" className="-me-[7px]">
                        {shortcutLabel(shortcut)}
                    </Kbd>
                )}
                {arrow}
            </TailedSurface>
        </T.Content>
    );
}
