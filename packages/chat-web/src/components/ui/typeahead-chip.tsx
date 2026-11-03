/**
 * The typed buffer of a type-to-jump list, as a small chip. It keeps showing the last buffer while it fades out,
 * so the text does not vanish before the fade. Decorative: the focused item already tells assistive technology
 * where the user is, so the chip is aria-hidden.
 *
 * Place it inside a positioned container (the menus use a sticky zero-height strip at the bottom).
 */
import { useRef } from "react";
import { cn } from "../../lib/cn";

export function TypeaheadChip({ query, miss, className }: { query: string; miss?: boolean; className?: string }) {
    // The last non-empty buffer, kept while the chip fades out.
    const last = useRef(query);
    if (query) last.current = query;
    const shown = last.current;
    return (
        <span
            aria-hidden
            data-visible={query ? "" : undefined}
            className={cn(
                "pointer-events-none inline-flex h-6 max-w-40 items-center gap-1 truncate rounded-full bg-elevated px-2 text-xs whitespace-pre text-text shadow-dropdown",
                "opacity-0 transition-[opacity,translate] duration-150 ease-[var(--ease-standard)] translate-y-1 data-[visible]:translate-y-0 data-[visible]:opacity-100",
                miss && "text-tertiary line-through decoration-[color-mix(in_oklab,var(--text)_40%,transparent)]",
                className,
            )}
        >
            {shown}
        </span>
    );
}
