/**
 * Inline citation chip (web notes A.7.5 "Citation chip", markdown-notes "Citations"): a 20px pill after
 * the sentence with the first source's favicon and site, and "+N" for the others.
 *
 * The popover is the card, one surface with the menu glass and a tail at the chip (ui/tailed-content.tsx):
 * a header row (favicon, domain, external-link icon), the title (two lines) and the snippet (three lines),
 * all one link to the page. Several sources page in place ("1 of 3" with arrows). A footer row opens the
 * conversation's Sources panel.
 *
 * Opening: hover with an intent delay (stays open while the pointer moves into the card), or click, Enter
 * or Space on the focused pill (focus moves into the card; Escape returns it to the pill).
 *
 * Phones: a tap on the pill opens a bottom sheet instead, with every source as a full-width card (the whole
 * card opens the page; "Open" says so) and "View all sources", which opens the Sources tab of the side panel.
 * No paging and no hover path: the list scrolls, and each card is a large tap target.
 */
import { ArrowUpRightIcon, CaretLeftIcon, CaretRightIcon } from "@pikvm/icons";
import { Popover } from "radix-ui";
import { memo, useEffect, useRef, useState, type PointerEvent } from "react";
import { cn } from "../../../lib/cn";
import { useIsMobile } from "../../../lib/media";
import { touchTarget } from "../../../lib/touch";
import { Button } from "../../ui/button";
import { Sheet } from "../../ui/sheet";
import { TailedContent } from "../../ui/tailed-content";
import { Favicon, hostOf, sourceKey, sourceTitle, useSourceLookup, type Source } from "../sources";
import type { CiteRef } from "./syntax";
import { useThemeLayer } from "../../../lib/theme-scope";

const OPEN_DELAY = 150;
const CLOSE_DELAY = 200;

function parseRefs(raw: unknown): CiteRef[] {
    if (typeof raw !== "string") return [];
    try {
        const list = JSON.parse(raw) as CiteRef[];
        if (!Array.isArray(list)) return [];
        const seen = new Set<string>();
        return list.filter((ref) => {
            if (typeof ref?.url !== "string" || !hostOf(ref.url)) return false;
            const key = sourceKey(ref.url);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    } catch {
        return [];
    }
}

export const Citation = memo(function Citation({ data }: { data: unknown }) {
    const layer = useThemeLayer();
    const { lookup } = useSourceLookup();
    const sources = parseRefs(data).map((r) => lookup(r.url));
    const [open, setOpen] = useState(false);
    const [index, setIndex] = useState(0);
    const viaHover = useRef(false);
    const focusHandoff = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const mobile = useIsMobile();
    useEffect(() => () => clearTimeout(timer.current), []);
    if (!sources.length) return null;

    const first = sources[0]!;
    const n = sources.length;
    const s = sources[Math.min(index, n - 1)]!;
    const label = n > 1 ? `Sources: ${first.host} and ${n - 1} more` : `Source: ${first.host}`;

    const schedule = (next: boolean, e: PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        clearTimeout(timer.current);
        timer.current = setTimeout(
            () => {
                if (next && !open) setIndex(0);
                if (next) {
                    viaHover.current = true;
                    focusHandoff.current = false;
                }
                setOpen(next);
            },
            next ? OPEN_DELAY : CLOSE_DELAY,
        );
    };
    const hover = {
        onPointerEnter: (e: PointerEvent) => {
            // Opened by click or keyboard: the pointer passing over does not schedule anything.
            if (open && !viaHover.current) return;
            schedule(true, e);
        },
        onPointerLeave: (e: PointerEvent) => {
            if (open && !viaHover.current) return;
            schedule(false, e);
        },
    };
    const go = (d: number) => setIndex((i) => (i + d + n) % n);
    const chip = (
        <>
            <Favicon host={first.host} size={14} className="rounded-full" />
            <span className="md-cite-label">{first.host}</span>
            {n > 1 && <span className="md-cite-more">+{n - 1}</span>}
        </>
    );

    if (mobile) {
        return (
            <>
                <button
                    type="button"
                    className={cn("md-cite relative", touchTarget)}
                    aria-label={label}
                    aria-haspopup="dialog"
                    data-open={open || undefined}
                    onClick={() => setOpen(true)}
                >
                    {chip}
                </button>
                <Sheet open={open} onOpenChange={setOpen} title={n > 1 ? `${n} sources` : "Source"}>
                    <ul className="flex flex-col gap-2 pb-2">
                        {sources.map((src) => (
                            <li key={src.url}>
                                <SourceCard source={src} />
                            </li>
                        ))}
                    </ul>
                </Sheet>
            </>
        );
    }

    return (
        <Popover.Root
            open={open}
            onOpenChange={(o) => {
                clearTimeout(timer.current);
                if (o) {
                    setIndex(0);
                    viaHover.current = false;
                    focusHandoff.current = false;
                }
                setOpen(o);
            }}
        >
            <Popover.Trigger asChild>
                <button type="button" className="md-cite" aria-label={label} data-open={open || undefined} {...hover}>
                    {chip}
                </button>
            </Popover.Trigger>
            <Popover.Portal container={layer}>
                <Popover.Content
                    side="bottom"
                    align="start"
                    sideOffset={2}
                    collisionPadding={12}
                    aria-label={n > 1 ? "Sources" : "Source"}
                    asChild
                    onOpenAutoFocus={(e) => {
                        // Hover never steals focus; click and keyboard land on the source link.
                        e.preventDefault();
                        if (!viaHover.current)
                            (e.currentTarget as HTMLElement).querySelector<HTMLElement>(".md-cite-source")?.focus();
                    }}
                    onCloseAutoFocus={(event) => {
                        if (viaHover.current || focusHandoff.current) event.preventDefault();
                    }}
                    onKeyDown={(e) => {
                        if (n < 2 || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
                        e.preventDefault();
                        go(e.key === "ArrowRight" ? 1 : -1);
                    }}
                    {...hover}
                >
                    {/* The menu glass with a tail at the chip; the body scrolls when the card meets max-height. */}
                    <TailedContent
                        arrow={Popover.Arrow}
                        translucent
                        className="md-cite-card"
                        bodyClassName="min-w-52 overflow-y-auto p-1.5"
                    >
                        <a
                            key={s.url}
                            className="md-cite-source"
                            href={s.url}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                        >
                            <span className="md-cite-site">
                                <Favicon host={s.host} size={16} className="rounded-full" />
                                <span className="min-w-0 truncate">{s.host}</span>
                                {s.published && <span className="shrink-0 text-tertiary">{s.published}</span>}
                                <ArrowUpRightIcon aria-hidden size={16} className="md-cite-out" />
                            </span>
                            <span className="md-cite-title">{sourceTitle(s)}</span>
                            {s.snippet && <span className="md-cite-snippet">{s.snippet}</span>}
                            <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                        {n > 1 && (
                            <div className="md-cite-pager">
                                <span aria-live="polite" className="tabular-nums">
                                    {index + 1} of {n}
                                </span>
                                <div className="flex gap-0.5">
                                    <Button
                                        size="md"
                                        uniform
                                        pill
                                        aria-label="Previous source"
                                        className="[--icon:16px]"
                                        onClick={() => go(-1)}
                                    >
                                        <CaretLeftIcon />
                                    </Button>
                                    <Button
                                        size="md"
                                        uniform
                                        pill
                                        aria-label="Next source"
                                        className="[--icon:16px]"
                                        onClick={() => go(1)}
                                    >
                                        <CaretRightIcon />
                                    </Button>
                                </div>
                            </div>
                        )}
                    </TailedContent>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
});

/** One source in the phone sheet: the whole card opens the page in a new tab. */
function SourceCard({ source: s }: { source: Source }) {
    return (
        <a
            href={s.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="flex min-h-11 flex-col gap-1 rounded-2xl bg-soft px-3.5 py-3 outline-none active:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
        >
            <span className="flex min-w-0 items-center gap-2 text-sm leading-5 text-secondary">
                <Favicon host={s.host} size={16} className="shrink-0 rounded-full" />
                <span className="min-w-0 flex-1 truncate">{s.host}</span>
                {s.published && <span className="shrink-0 text-tertiary">{s.published}</span>}
                <span className="inline-flex shrink-0 items-center gap-1 font-medium text-text">
                    Open
                    <ArrowUpRightIcon aria-hidden size={16} />
                </span>
            </span>
            <span className="line-clamp-2 text-md leading-6 font-medium text-text">{sourceTitle(s)}</span>
            {s.snippet && <span className="line-clamp-3 text-sm leading-5 text-secondary">{s.snippet}</span>}
            <span className="sr-only"> (opens in a new tab)</span>
        </a>
    );
}
