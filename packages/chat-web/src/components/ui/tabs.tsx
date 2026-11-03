/**
 * Chip tabs: a row of pill tabs, styled like the section tabs on the Files page (36px pills, the
 * selected one on the hover tint). Heights and padding come from the spacing scale, so ui.density
 * applies. Keyboard: Left/Right (mirrored in right-to-left) move and select, Home/End jump; only the
 * selected tab is in the tab order (roving tabindex).
 */
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface ChipTab<T extends string> {
    id: T;
    label: ReactNode;
    /** Optional count shown after the label in the tertiary colour. */
    count?: number;
}

export function ChipTabs<T extends string>({
    items,
    value,
    onChange,
    label,
    size = "md",
    className,
}: {
    items: readonly ChipTab<T>[];
    value: T;
    onChange: (id: T) => void;
    /** Accessible name of the tab list. */
    label: string;
    /** "md" is the Files page size (36px); "sm" is 28px for tight headers. */
    size?: "sm" | "md";
    className?: string;
}) {
    const list = useRef<HTMLDivElement>(null);

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const i = items.findIndex((t) => t.id === value);
        const rtl = list.current ? getComputedStyle(list.current).direction === "rtl" : false;
        let next = -1;
        if (e.key === (rtl ? "ArrowLeft" : "ArrowRight")) next = (i + 1) % items.length;
        else if (e.key === (rtl ? "ArrowRight" : "ArrowLeft")) next = (i - 1 + items.length) % items.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = items.length - 1;
        if (next < 0) return;
        e.preventDefault();
        onChange(items[next]!.id);
        list.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
    };

    return (
        <div
            ref={list}
            role="tablist"
            aria-label={label}
            onKeyDown={onKeyDown}
            className={cn("flex min-w-0 items-center gap-0.5", className)}
        >
            {items.map((t) => {
                const selected = t.id === value;
                return (
                    <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => onChange(t.id)}
                        className={cn(
                            "flex shrink-0 items-center gap-1 rounded-full font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                            size === "md" ? "h-9 px-3.5 text-base" : "h-7 px-2.5 text-sm",
                            selected
                                ? "bg-hover text-text"
                                : "text-secondary hover:bg-[color-mix(in_srgb,var(--hover)_50%,transparent)] hover:text-text",
                        )}
                    >
                        {t.label}
                        {t.count ? <span className="font-normal text-tertiary tabular-nums">{t.count}</span> : null}
                    </button>
                );
            })}
        </div>
    );
}
