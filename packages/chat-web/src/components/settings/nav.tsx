/**
 * Settings navigation: the sidebar column of Chat's Settings (title, grouped section links) as primitives the host
 * draws its own pages' list with. Same rows as Chat's sidebar kit (ui.density, ui.roundness and the theme reach it
 * through the row tokens), minus what a short, fixed list does not need (windowed lists, filtering, marquees).
 *
 *     <SettingsNavFrame label="Settings" title="Settings">
 *         <SettingsNavSection id="target" title="Target">
 *             <SettingsNavList>
 *                 <SettingsNavItem icon={Link} label="Connection" active render={(p) => <a href="/connection" {...p} />} />
 *             </SettingsNavList>
 *         </SettingsNavSection>
 *     </SettingsNavFrame>
 *
 * - SettingsNavFrame: the column. The title row stays; the sections scroll under it (no edge fade: the installed app keeps masks off the top of the page).
 * - SettingsNavSection: a tertiary label row with the animated collapse (kept per browser) and a chevron that shows
 *   on hover, focus and touch.
 * - SettingsNavItem: a 36px row (40px on touch) with a 20px icon (filled when active) and a label. The host owns
 *   routing: `render` draws the link element with the row's classes and `aria-current` already set.
 */
import { CaretDown, type Icon } from "@pikvm/icons";
import { useCallback, useId, useState, type ReactElement, type ReactNode } from "react";
import { cn } from "../../lib/cn";

/** The row's box and colours (Chat's sidebar kit, measured against its web reference). */
const row = {
    shell: "flex h-[var(--row-height)] w-full items-center rounded-row text-base leading-5 font-normal text-sidebar-text outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring pointer-coarse:h-[max(40px,var(--row-height))]",
    base: "gap-1.5 ps-[var(--row-padding-x)] pe-1.5",
    interactive: "hover-device:hover:bg-hover active:bg-hover",
    selected: "bg-selected",
};

export function SettingsNavFrame({
    label,
    title,
    className,
    children,
}: {
    /** Accessible name of the navigation landmark. */
    label: string;
    /** The title row's heading ("Settings"). */
    title: string;
    className?: string;
    children: ReactNode;
}) {
    return (
        <nav aria-label={label} className={cn("relative flex h-full flex-col text-sidebar-text", className)}>
            <div className="shrink-0 px-1.5">
                <div className="flex h-[var(--header-height)] items-center ps-[var(--row-padding-x)] pe-0.5">
                    <h1 className="min-w-0 flex-1 truncate text-lg leading-6 font-semibold text-sidebar-text">
                        {title}
                    </h1>
                </div>
            </div>
            <div
                className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-1.5 pt-[var(--section-gap)] pb-2 outline-none"
            >
                <div className="flex flex-col gap-[var(--section-gap)]">{children}</div>
            </div>
        </nav>
    );
}

const COLLAPSED_KEY = "pikvm.settings.nav.collapsed";

function readCollapsed(): string[] {
    try {
        const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
        return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
    } catch {
        return [];
    }
}

/** Collapsed flag of one section, kept per browser. */
function useCollapsed(id: string): [boolean, (collapsed: boolean) => void] {
    const [collapsed, setState] = useState(() => readCollapsed().includes(id));
    const set = useCallback(
        (value: boolean) => {
            setState(value);
            const rest = readCollapsed().filter((other) => other !== id);
            try {
                localStorage.setItem(COLLAPSED_KEY, JSON.stringify(value ? [...rest, id] : rest));
            } catch {
                // Storage can be blocked; the state then lasts for this page only.
            }
        },
        [id],
    );
    return [collapsed, set];
}

const DISCLOSURE = "duration-200 ease-[var(--ease-standard)]";

/** Section label row at --row-height with the animated collapse of Chat's sidebar sections. */
export function SettingsNavSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
    const [collapsed, setCollapsed] = useCollapsed(id);
    const listId = useId();
    return (
        <section className="group/section flex flex-col" aria-label={title}>
            <div className="flex h-[var(--row-height)] items-center justify-between gap-2 ps-[var(--row-padding-x)] pe-1.5 pointer-coarse:h-[max(40px,var(--row-height))]">
                <button
                    type="button"
                    aria-expanded={!collapsed}
                    aria-controls={listId}
                    onClick={() => setCollapsed(!collapsed)}
                    className="group/toggle -ms-1 flex h-full min-w-0 flex-1 items-center gap-1 rounded-row px-1 text-start text-base leading-5 font-normal text-tertiary outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-1px] focus-visible:outline-ring"
                >
                    {title}
                    <CaretDown
                        aria-hidden
                        className={cn(
                            "size-3.5 opacity-0 transition-transform group-focus-visible/toggle:opacity-100 hover-device:group-hover/section:opacity-100 pointer-coarse:opacity-100",
                            DISCLOSURE,
                            collapsed && "-rotate-90",
                        )}
                    />
                </button>
            </div>
            <div
                id={listId}
                inert={collapsed}
                aria-hidden={collapsed}
                className={cn(
                    "grid pt-1 transition-[grid-template-rows,visibility]",
                    DISCLOSURE,
                    collapsed ? "invisible grid-rows-[0fr]" : "visible grid-rows-[1fr]",
                )}
            >
                <div className="min-h-0 overflow-hidden">
                    <div
                        className={cn(
                            "transition-[opacity,translate]",
                            DISCLOSURE,
                            collapsed ? "-translate-y-1 opacity-0" : "translate-y-0 opacity-100",
                        )}
                    >
                        {children}
                    </div>
                </div>
            </div>
        </section>
    );
}

export function SettingsNavList({ children }: { children: ReactNode }) {
    return <ul className="flex flex-col gap-[var(--row-gap)]">{children}</ul>;
}

/** What the host's link gets: the row's classes, its current-page mark and its content. */
export interface SettingsNavLinkProps {
    className: string;
    "aria-current"?: "page";
    children: ReactNode;
}

export function SettingsNavItem({
    icon: IconC,
    label,
    active = false,
    render,
}: {
    icon: Icon;
    label: string;
    /** The current page: selected background and a filled icon. */
    active?: boolean;
    render: (props: SettingsNavLinkProps) => ReactElement;
}) {
    return (
        <li className="group/row relative">
            {render({
                className: cn(
                    row.shell,
                    row.base,
                    "select-none [-webkit-touch-callout:none]",
                    row.interactive,
                    active && row.selected,
                ),
                ...(active ? { "aria-current": "page" as const } : {}),
                children: (
                    <>
                        <IconC aria-hidden className="size-5 shrink-0" weight={active ? "fill" : "regular"} />
                        <span className="text-fade min-w-0 flex-1">{label}</span>
                    </>
                ),
            })}
        </li>
    );
}
