import type { ReactNode } from "react";
import { cn } from "./lib/cn";

/**
 * A keyboard key cap. Three looks exist in the app, kept exactly:
 * - `tooltip`: inside a tooltip, on the tooltip surface (was ui/tooltip.tsx).
 * - `row`: in a list row or footer hint, soft fill (was search/search-rows.tsx).
 * - `outlined`: in settings prose, hairline border (was settings/pages/chat.tsx).
 */
export type KbdTone = "tooltip" | "row" | "outlined";

const tones: Record<KbdTone, string> = {
    tooltip:
        "inline-flex h-[18px] min-w-4 items-center justify-center rounded-lg bg-kbd px-1.5 font-sans text-sm leading-[18px] text-text",
    row: "inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-soft px-1.5 font-sans text-xs leading-none text-secondary [&_svg]:size-3.5",
    outlined:
        "inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-default bg-kbd px-1.5 font-sans text-xs leading-4 text-secondary",
};

export function Kbd({
    children,
    tone = "tooltip",
    className,
}: {
    children: ReactNode;
    tone?: KbdTone;
    className?: string;
}) {
    return <kbd className={cn(tones[tone], className)}>{children}</kbd>;
}
