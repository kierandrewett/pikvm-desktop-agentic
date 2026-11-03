/**
 * External link with a hover card: a pill on the menu surface with the site's favicon, the full address, an
 * open-in-new-tab button and a copy button. The card opens after a short hover intent or keyboard focus and
 * stays open while the pointer moves into it; the link itself still opens on click as before.
 *
 * Touch screens get the plain link: a tap opens it, and a long-press gives the browser's own link menu (open,
 * copy, share), which covers what the card offers. The card would otherwise open on the focus a tap gives.
 */
import { ArrowUpRightIcon, CheckIcon, CopyIcon } from "@pikvm/icons";
import { HoverCard } from "radix-ui";
import type { AnchorHTMLAttributes, CSSProperties, ReactNode } from "react";
import { useCoarsePointer } from "../../../lib/media";
import { TailedContent } from "../../ui/tailed-content";
import { Tooltip } from "../../ui/tooltip";
import { Favicon, hostOf } from "../sources";
import { useCopy } from "./env";
import { useThemeLayer } from "../../../lib/theme-scope";

const OPEN_DELAY = 400;
const CLOSE_DELAY = 150;
/** A pill: the outline clamps the radius to half the height, like CSS. */
const PILL = { "--tailed-surface-radius": "9999px" } as CSSProperties;

/** The address as people read it: no scheme, no trailing slash. */
const readable = (href: string) => href.replace(/^https?:\/\//, "").replace(/\/$/, "");

const cardButton =
    "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-tertiary outline-none transition-colors duration-150 hover-device:hover:bg-hover hover-device:hover:text-text focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4";

export function ExternalLink({
    href,
    children,
    ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) {
    const layer = useThemeLayer();
    const [copied, copy] = useCopy();
    const coarse = useCoarsePointer();
    const host = hostOf(href);
    const link = (
        <a {...rest} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {children}
            <ArrowUpRightIcon aria-hidden size={14} className="md-ext" />
            <span className="sr-only"> (opens in a new tab)</span>
        </a>
    );
    if (coarse) return link;
    return (
        <HoverCard.Root openDelay={OPEN_DELAY} closeDelay={CLOSE_DELAY}>
            <HoverCard.Trigger asChild>{link}</HoverCard.Trigger>
            <HoverCard.Portal container={layer}>
                <HoverCard.Content side="top" align="start" sideOffset={2} collisionPadding={12} asChild>
                    {/* A pill on the menu glass, with a tail at the link. */}
                    <TailedContent
                        arrow={HoverCard.Arrow}
                        translucent
                        className="md-link-card"
                        style={PILL}
                        bodyClassName="flex max-w-[min(420px,calc(100vw-24px))] min-w-52 items-center gap-1.5 py-1 ps-2.5 pe-1"
                    >
                        {host && <Favicon host={host} size={16} className="shrink-0 rounded-full" />}
                        <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-text" title={href}>
                            {readable(href)}
                        </span>
                        <Tooltip label="Open in new tab">
                            <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer nofollow"
                                aria-label="Open in new tab"
                                className={cardButton}
                            >
                                <ArrowUpRightIcon aria-hidden />
                            </a>
                        </Tooltip>
                        <Tooltip label={copied ? "Copied" : "Copy link"}>
                            <button
                                type="button"
                                aria-label={copied ? "Copied" : "Copy link"}
                                onClick={() => copy(href)}
                                className={cardButton}
                            >
                                {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
                            </button>
                        </Tooltip>
                    </TailedContent>
                </HoverCard.Content>
            </HoverCard.Portal>
        </HoverCard.Root>
    );
}
