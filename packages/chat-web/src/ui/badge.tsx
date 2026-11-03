import type { ReactNode } from "react";
import { cn } from "./lib/cn";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

/**
 * Small label for a state or an owner, never for something the user can change (use a switch for that).
 * `neutral`: ownership and place ("From your administrator", "This device"); `accent`: role ("Admin");
 * `success`: working ("Connected"); `warning` and `danger`: problems.
 */
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
    return (
        <span
            className={cn(
                "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-xs leading-4 font-normal whitespace-nowrap [&_svg]:size-3.5",
                tone === "neutral" && "bg-soft text-secondary",
                tone === "accent" && "bg-accent-bg text-accent-text",
                tone === "success" && "bg-soft text-success",
                tone === "warning" && "bg-warning-bg text-warning",
                tone === "danger" && "bg-danger-bg text-danger",
            )}
        >
            {children}
        </span>
    );
}
