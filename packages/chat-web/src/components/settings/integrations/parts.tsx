/**
 * Shared view parts of the provider and MCP pages: one health vocabulary (dot plus short text), relative times,
 * and the preset gallery used by both catalogues. Data hooks and the check card live in common.tsx.
 */
import { MagnifyingGlass } from "@pikvm/icons";
import { useState, type ReactNode } from "react";
import { cn } from "../../../lib/cn";
import { msg } from "../../../l10n/runtime";
import { useLocale, useT } from "../../../l10n/provider";
import { Badge, fieldClass, SettingsSection, Spinner } from "../kit";

/** `ok` working, `error` needs attention, `warning` works with a caveat, `muted` off or unknown, `busy` checking. */
export type HealthTone = "ok" | "error" | "warning" | "muted" | "busy";
export interface Health {
    tone: HealthTone;
    text: string;
}

const dotClass: Record<Exclude<HealthTone, "busy">, string> = {
    ok: "bg-success",
    error: "bg-danger",
    warning: "bg-warning",
    muted: "bg-[color-mix(in_oklab,var(--text)_30%,transparent)]",
};

/** Status dot (a spinner while checking) and a short text. Problems colour the text as well as the dot. */
export function HealthLine({ health, className }: { health: Health; className?: string }) {
    return (
        <span
            data-health={health.tone}
            className={cn(
                "inline-flex max-w-full min-w-0 items-center gap-1.5",
                health.tone === "error" && "text-danger",
                health.tone === "warning" && "text-warning",
                className,
            )}
        >
            {health.tone === "busy" ? (
                <Spinner className="size-3.5 shrink-0" />
            ) : (
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotClass[health.tone])} />
            )}
            <span className="truncate">{health.text}</span>
        </span>
    );
}

/** "just now", "4 min ago", "3 h ago", else a date. Returns a function so the text follows the active locale. */
export function useAgo(): (ms: number | undefined) => string | undefined {
    const t = useT();
    const { locale } = useLocale();
    return (ms) => {
        if (!ms) return undefined;
        const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
        if (s < 45) return t("integrations-ago-now");
        if (s < 3600) return t("integrations-ago-minutes", { count: Math.round(s / 60) });
        if (s < 86_400) return t("integrations-ago-hours", { count: Math.round(s / 3600) });
        return new Intl.DateTimeFormat(locale).format(new Date(ms));
    };
}

const NOUN_LABEL = {
    providers: { search: msg("integrations-gallery-search-providers") },
} as const;

export interface GalleryItem {
    id: string;
    name: string;
    description: string;
    icon: ReactNode;
    /** Short fact before the description, for example "Remote" or "Runs in your sandbox". */
    tag?: string;
    added?: boolean;
    group: string;
}

/**
 * A catalogue: one search field and compact tiles (logo, name, one line) in titled groups, two columns from 640px.
 * Tiles are buttons in lists, so keyboard and screen-reader users get one stop and one item per preset.
 */
export function PresetGallery({
    items,
    groups,
    onPick,
    noun,
    footer,
}: {
    items: GalleryItem[];
    /** Group ids in display order with their titles. */
    groups: { id: string; title: string }[];
    onPick: (item: GalleryItem) => void;
    /** What the gallery lists. Picks the search label. */
    noun: keyof typeof NOUN_LABEL;
    /** Content after the groups (for example the custom entry). Always shown, also when nothing matches. */
    footer?: ReactNode;
}) {
    const t = useT();
    const [query, setQuery] = useState("");
    const q = query.trim().toLowerCase();
    const shown = q
        ? items.filter((i) => `${i.name} ${i.description} ${i.tag ?? ""}`.toLowerCase().includes(q))
        : items;
    return (
        <>
            <label className="relative block">
                <span className="sr-only">{t(NOUN_LABEL[noun].search)}</span>
                <MagnifyingGlass
                    aria-hidden
                    className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-tertiary"
                />
                <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t(NOUN_LABEL[noun].search)}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className={cn(fieldClass("md"), "w-full ps-9")}
                    data-gallery-search
                />
            </label>
            {shown.length === 0 && (
                <p role="status" className="px-1 text-sm text-secondary">
                    {t("integrations-gallery-empty", { query: query.trim() })}
                </p>
            )}
            {groups.map((g) => {
                const list = shown.filter((i) => i.group === g.id);
                if (!list.length) return null;
                return (
                    <SettingsSection key={g.id} title={g.title}>
                        <ul aria-label={g.title} className="grid gap-2 sm:grid-cols-2">
                            {list.map((item) => (
                                <li key={item.id} className="min-w-0">
                                    <GalleryTile item={item} onPick={() => onPick(item)} />
                                </li>
                            ))}
                        </ul>
                    </SettingsSection>
                );
            })}
            {footer}
        </>
    );
}

export function GalleryTile({ item, onPick }: { item: Omit<GalleryItem, "group">; onPick: () => void }) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={onPick}
            data-preset={item.id}
            className="flex h-full min-h-16 w-full items-center gap-3 rounded-2xl border border-default bg-control px-3 py-2.5 text-start outline-none focus-visible:outline-2 focus-visible:outline-ring hover-device:hover:bg-hover"
        >
            {item.icon}
            <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{item.name}</span>
                    {item.added && <Badge tone="success">{t("integrations-gallery-added")}</Badge>}
                </span>
                <span className="line-clamp-2 text-xs text-tertiary">
                    {item.tag
                        ? t("integrations-gallery-tagged", { tag: item.tag, description: item.description })
                        : item.description}
                </span>
            </span>
        </button>
    );
}
