/**
 * Settings layout primitives: page, section, card and row.
 *
 * Type scale: page title 28px medium, section title 16px semibold, row label 14px medium, description 13px at ink
 * 65%, hints 12px tertiary. Gutters are 16px inside cards.
 *
 * Density: row padding, gutters and minimum heights scale with --density (ui.density).
 *
 * Row model (one for every page):
 * - a row without a description is 10px + 36px control + 10px (56px at default density);
 * - a row with a description is 14px + label + description + 14px (about 66px);
 * - `stack` puts a wide control (lists, editors) under the label; `split` gives label and control half each.
 * A row can carry an anchor `id` (deep links and search scroll to it), a `lock` (icon with a tooltip, controls
 * disabled by the caller), an inline `status` (saving, saved, error) and a `reset` action. Every control in a row
 * is 36px high and ends at the card's right gutter, so controls line up on one edge across all cards.
 *
 * Narrow columns (phones, narrow windows): the page column is the `settings` container and settings.css lays rows
 * out as in iOS and Material settings: compact controls stay at the end of the line, wide controls (marked
 * `data-wide`) go full width under the text, value pickers and switches take the whole row as their tap target,
 * and section notes become footers. The data attributes on the row parts below are that stylesheet's contract.
 */
import { ArrowCounterClockwise, CaretLeft, CaretRight, DotsThree, FileLock, LockSimple } from "@pikvm/icons";
import { useParams } from "../../../nav";
import {
    createContext,
    forwardRef,
    useContext,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type ButtonHTMLAttributes,
    type ReactNode,
} from "react";
import { useT } from "../../../l10n/provider";
import { msg } from "../../../l10n/runtime";
import { cn } from "../../../lib/cn";
import { Button as UiButton } from "../../ui/button";
import { Menu } from "../../ui/menu";
import { SectionNav } from "./section-nav";
import { Tooltip } from "../../ui/tooltip";
import { findCategory, settingsAnchor } from "../registry";
import { IconButton, InlineStatus, Spinner, type Status } from "./feedback";
import { RowLockContext } from "./lock";
import "./settings.css";
import {
    hideWithoutHits,
    markText,
    SearchMark,
    SectionReveal,
    useHideEmpty,
    useRowSearch,
    useSearchScope,
    useSectionSearch,
} from "./search";

/** Secondary text: ink at 65% (reference `--color-text-secondary`). */
export const secondaryText = "text-[color-mix(in_srgb,var(--text)_65%,transparent)]";

/** Set by the layout on mobile, where each page has a back button to the settings list. */
export const SettingsChrome = createContext<{ onBack?: () => void }>({});

/** Section anchor from its title: "Model picker" -> "model-picker". */
const slugify = (t: string) =>
    t
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

/** A page header action. The header shows icons only: one action is an icon button, more open a menu. */
export interface PageAction {
    /** Tooltip, accessible name and menu label. */
    label: string;
    icon: ReactNode;
    onSelect: () => void;
    busy?: boolean;
    disabled?: boolean;
    danger?: boolean;
}

/** Icon button with its label as a tooltip. Forwards props and ref, so a menu can use it as its trigger. */
const TooltipIconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(
    function TooltipIconButton({ label, ...rest }, ref) {
        return (
            <Tooltip label={label}>
                <IconButton ref={ref} round aria-label={label} {...rest} />
            </Tooltip>
        );
    },
);

/**
 * Header actions as icons, never text buttons (iOS and Material top bars): one action is an icon button with a
 * tooltip; two or more go in a "More actions" menu. Confirmations stay with the caller (`onSelect` opens them).
 * The menu trigger is an icon button, not a PickerTrigger: it opens actions, it does not show or pick a value.
 */
function PageActions({ actions }: { actions: PageAction[] }) {
    const t = useT();
    const [only] = actions;
    if (!only) return null;
    if (actions.length === 1) {
        return (
            <TooltipIconButton
                label={only.label}
                aria-busy={only.busy || undefined}
                disabled={only.disabled || only.busy}
                onClick={only.onSelect}
            >
                {only.busy ? <Spinner className="size-5" /> : only.icon}
            </TooltipIconButton>
        );
    }
    return (
        <Menu
            title={t("settings-page-actions")}
            align="end"
            trigger={
                <TooltipIconButton label={t("settings-more-actions")}>
                    <DotsThree weight="bold" />
                </TooltipIconButton>
            }
            items={actions.map((a) => ({
                label: a.label,
                icon: a.busy ? <Spinner className="size-5" /> : a.icon,
                danger: a.danger,
                disabled: a.disabled || a.busy,
                onSelect: a.onSelect,
            }))}
        />
    );
}

/** True where the host draws a page's title itself (the PiKVM app's Settings); a top-level page then leaves its own out. */
export const HostDrawsTitle = createContext(false);

/**
 * A settings page: a sticky header (title, page actions as icons), a one-line description of what the page
 * controls, then its sections 40px apart. The description defaults to the category's line in registry.ts.
 */
export function SettingsPage({
    title,
    description,
    actions,
    back,
    sectionNav,
    children,
}: {
    title: string;
    description?: ReactNode;
    /** Show chips that jump to each titled section. For long pages (three or more sections). */
    sectionNav?: boolean;
    /** Header actions; rendered as one icon button, or a menu when there are several. Falsy entries are skipped. */
    actions?: (PageAction | false | null | undefined)[];
    /** Sub-view of a section: a link back to the parent view (desktop) and the header back button (mobile). */
    back?: { label: string; onClick: () => void };
    children: ReactNode;
}) {
    const t = useT();
    const chrome = useContext(SettingsChrome);
    // A sub-view (`back`) still names itself: the host's title names the page it belongs to.
    const hostTitle = useContext(HostDrawsTitle) && !back;
    const params = useParams() as { section?: string };
    const onBack = back?.onClick ?? chrome.onBack;
    const mobile = !!chrome.onBack;
    const header = useRef<HTMLDivElement>(null);
    const [stuck, setStuck] = useState(false);
    const lead = description ?? (back ? undefined : findCategory(params.section ?? "")?.description);
    const searching = !!useSearchScope();
    const shownActions = (actions ?? []).filter((a): a is PageAction => !!a);

    // The header gets a hairline once content scrolls under it.
    useEffect(() => {
        const el = header.current;
        const scroller = el?.closest("[data-settings-scroll]");
        if (!el || !scroller) return;
        const onScroll = () => setStuck(scroller.scrollTop > 8);
        onScroll();
        scroller.addEventListener("scroll", onScroll, { passive: true });
        return () => scroller.removeEventListener("scroll", onScroll);
    }, []);

    // A new view starts at the top, like a new page (deep links scroll afterwards, see useRowAnchor).
    useEffect(() => {
        if (location.hash) return;
        header.current?.closest("[data-settings-scroll]")?.scrollTo({ top: 0 });
    }, [title]);

    // On the search results page the results page draws the page header; only the sections render here.
    if (searching) return <div className="flex flex-col gap-8">{children}</div>;

    return (
        <div
            data-settings-page=""
            className="@container/settings mx-auto w-full max-w-3xl px-4 pb-[calc(40px+var(--dock-safe-bottom))] md:px-5"
        >
            <div
                ref={header}
                className={cn(
                    "glass-bar sticky top-0 z-10 -mx-4 px-4 md:-top-4 md:-mx-5 md:px-5 md:pt-4",
                    mobile && "pt-safe",
                    stuck && "shadow-[0_1px_0_var(--border)]",
                )}
            >
                {back && !mobile && (
                    <button
                        type="button"
                        onClick={back.onClick}
                        className="-mb-2 inline-flex items-center gap-1 rounded-md pt-1 text-base leading-[21px] text-tertiary hover-device:hover:text-text"
                    >
                        <CaretLeft className="size-4" aria-hidden />
                        {back.label}
                    </button>
                )}
                {hostTitle ? (
                    shownActions.length > 0 && (
                        <div className="flex min-h-15 items-center justify-end py-3">
                            <PageActions actions={shownActions} />
                        </div>
                    )
                ) : (
                    <>
                        <div className={cn("flex min-h-15 items-center gap-2 py-3", mobile && "min-h-13 py-2")}>
                            {mobile && onBack && (
                                <UiButton
                                    uniform
                                    size="2xl"
                                    onClick={onBack}
                                    aria-label={
                                        back ? t("settings-back-to", { page: back.label }) : t("settings-back-to-settings")
                                    }
                                    className="-ms-2 text-text"
                                >
                                    <CaretLeft />
                                </UiButton>
                            )}
                            <h1
                                className={cn(
                                    "min-w-0 flex-1 truncate font-medium tracking-[-0.01em]",
                                    mobile ? "text-lg" : "text-2xl",
                                )}
                            >
                                {title}
                            </h1>
                            {shownActions.length > 0 && (
                                <div className="flex shrink-0 items-center">
                                    <PageActions actions={shownActions} />
                                </div>
                            )}
                        </div>
                    </>
                )}
                {sectionNav && <SectionNav label={t("settings-sections-nav")} />}
            </div>
            {lead && <p className={cn("-mt-1 max-w-[60ch] text-base", secondaryText)}>{lead}</p>}
            <div className="flex flex-col gap-10 pt-7">{children}</div>
        </div>
    );
}

/** Section: a heading row (title, optional help line, optional action), then its cards 12px apart. */
export function SettingsSection({
    title,
    description,
    action,
    id,
    tone,
    children,
}: {
    title?: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
    /** Anchor for deep links to the section. Defaults to the title as a slug. */
    id?: string;
    /** `danger`: the title in danger ink (see DangerZone). */
    tone?: "danger";
    children: ReactNode;
}) {
    const text = typeof title === "string" ? title : undefined;
    const anchor = id ?? (text ? `section-${slugify(text)}` : undefined);
    // On the search results page the page title is an h2, so section headings step down to h3.
    const search = useSectionSearch(title);
    const Heading = search ? "h3" : "h2";
    return (
        <section
            id={anchor}
            data-settings-section=""
            data-tone={tone}
            data-search-hit={search?.revealed ? "" : undefined}
            className={cn("flex scroll-mt-24 flex-col", search && !search.revealed && hideWithoutHits)}
        >
            {(title || action || description) && (
                <div data-section-head="" className="flex min-h-10 items-end justify-between gap-4 pb-3">
                    <div data-section-text="" className="flex min-w-0 flex-1 flex-col gap-1">
                        {title && (
                            <Heading
                                data-section-title=""
                                className={cn(
                                    "text-md leading-6 font-semibold tracking-[-0.01em]",
                                    tone === "danger" && "text-danger",
                                )}
                            >
                                {markText(title)}
                            </Heading>
                        )}
                        {description && (
                            <p data-section-note="" className={cn("text-sm leading-[18px]", secondaryText)}>
                                {markText(description)}
                            </p>
                        )}
                    </div>
                    {action && (
                        <div data-section-action="" className="flex shrink-0 items-center gap-2">
                            {action}
                        </div>
                    )}
                </div>
            )}
            <SectionReveal value={!!search?.revealed}>
                <div data-section-body="" className="flex flex-col gap-3">
                    {children}
                </div>
            </SectionReveal>
        </section>
    );
}

/**
 * Rounded group of rows. Every row after the first draws a 1px top divider inset 16px, except the row right after
 * a SettingsCardMedia block: media sits flush at the top of the card with no divider above or below. An interactive row
 * (`data-interactive`, see LinkRow) hides the divider above and below itself while hovered (hover devices only, so
 * taps never leave it stuck), keyboard-focused, pressed or while its menu is open, so its highlight reads as one
 * block. `overflow-hidden` clips that highlight to the card's rounded corners.
 */
const cardDividers = [
    "[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-4 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-default",
    "[&>[data-card-media]]:before:hidden [&>[data-card-media]+*]:before:hidden",
    "hover-device:[&>[data-interactive]:has(>button:hover)]:before:opacity-0 hover-device:[&>[data-interactive]:has(>button:hover)+*]:before:opacity-0",
    "[&>[data-interactive]:has(>button:focus-visible)]:before:opacity-0 [&>[data-interactive]:has(>button:focus-visible)+*]:before:opacity-0",
    "[&>[data-interactive]:has(>button:active)]:before:opacity-0 [&>[data-interactive]:has(>button:active)+*]:before:opacity-0",
].join(" ");

export function SettingsCard({
    children,
    className,
    tone,
    bare = false,
}: {
    children: ReactNode;
    className?: string;
    tone?: "danger";
    bare?: boolean;
}) {
    const hideEmpty = useHideEmpty();
    return (
        <div
            className={cn(
                "flex flex-col overflow-hidden",
                !bare && "rounded-2xl border bg-panel",
                !bare &&
                    (tone === "danger"
                        ? "border-[color-mix(in_oklab,var(--danger)_35%,var(--border))]"
                        : "border-default"),
                cardDividers,
                hideEmpty && hideWithoutHits,
                className,
            )}
        >
            {children}
        </div>
    );
}

/**
 * Preview or media block at the top of a SettingsCard (layout preview, message preview). Full-bleed, no border, no
 * radius of its own (the card clips it), on the recessed tone, and no divider above or below. Put it first.
 */
export function SettingsCardMedia({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div
            data-card-media
            aria-hidden
            className={cn("bg-[color-mix(in_srgb,var(--control-track)_50%,var(--panel))]", className)}
        >
            {children}
        </div>
    );
}

/** "Danger zone": destructive actions in their own card at the end of a page, title and border in danger ink. */
export function DangerZone({
    title,
    description,
    children,
}: {
    title?: string;
    description?: ReactNode;
    children: ReactNode;
}) {
    const t = useT();
    return (
        <SettingsSection title={title ?? t("settings-danger-zone")} description={description} tone="danger">
            <SettingsCard tone="danger">{children}</SettingsCard>
        </SettingsSection>
    );
}

export type Lock = "file" | "admin" | "policy";

const lockText: Record<Lock, string> = {
    file: msg("settings-lock-file"),
    admin: msg("settings-lock-admin"),
    policy: msg("settings-lock-policy"),
};

/** Lock icon next to a label, with the reason as a tooltip (and for screen readers). */
export function LockMark({ lock }: { lock: Lock }) {
    const t = useT();
    const Icon = lock === "file" ? FileLock : LockSimple;
    return (
        <Tooltip label={t(lockText[lock])}>
            <span
                tabIndex={0}
                role="img"
                aria-label={t(lockText[lock])}
                className="inline-flex shrink-0 rounded-sm text-tertiary outline-none focus-visible:outline-2 focus-visible:outline-ring"
            >
                <Icon className="size-3.5" aria-hidden />
            </span>
        </Tooltip>
    );
}

/** Briefly highlight a row when the URL hash points at it (search results and deep links): accent wash and ring. */
export function useRowAnchor(id: string | undefined) {
    const ref = useRef<HTMLDivElement>(null);
    const [flash, setFlash] = useState(false);
    useEffect(() => {
        if (!id) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const check = () => {
            if (settingsAnchor() !== id) return;
            const motion = document.documentElement.dataset.reducedMotion;
            const reduced =
                motion === "on" || (motion !== "off" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
            ref.current?.scrollIntoView({ block: "center", behavior: reduced ? "instant" : "smooth" });
            setFlash(true);
            clearTimeout(timer);
            timer = setTimeout(() => setFlash(false), 1600);
        };
        check();
        window.addEventListener("hashchange", check);
        window.addEventListener("settings:anchor", check);
        return () => {
            clearTimeout(timer);
            window.removeEventListener("hashchange", check);
            window.removeEventListener("settings:anchor", check);
        };
    }, [id]);
    return { ref, flash };
}

export function SettingRow({
    id,
    label,
    description,
    hint,
    control,
    lock,
    status,
    error,
    reset,
    stack,
    split,
    icon,
    children,
    className,
}: {
    /** Anchor for deep links (`/settings/<page>#<id>`) and search. */
    id?: string;
    label: ReactNode;
    description?: ReactNode;
    /** A short live note under the description (progress, last result). Tertiary text. */
    hint?: ReactNode;
    control?: ReactNode;
    lock?: Lock | null;
    status?: Status;
    error?: string | null;
    /** The value differs from its default: a reset button shows before the control on hover or focus (always on touch screens). */
    reset?: { label?: string; onReset: () => void };
    stack?: boolean;
    split?: boolean;
    icon?: ReactNode;
    children?: ReactNode;
    className?: string;
}) {
    const t = useT();
    const { ref, flash } = useRowAnchor(id);
    const labelId = useId();
    const search = useRowSearch(id);
    const tall = !!(description || hint);
    const resetLabel = reset?.label ?? t("settings-reset-default");
    if (search === "hidden") return null;
    return (
        <div
            ref={ref}
            id={id}
            data-setting-row={id}
            data-search-hit={search === "hit" ? "" : undefined}
            aria-labelledby={labelId}
            role="group"
            className={cn(
                "group/row @container/settings-row relative scroll-mt-28 px-[calc(16px*var(--density,1))] transition-[background-color,box-shadow] duration-300 ease-[var(--ease-standard)]",
                tall || stack ? "py-[calc(14px*var(--density,1))]" : "py-[calc(10px*var(--density,1))]",
                flash && "bg-accent-bg shadow-[inset_0_0_0_2px_var(--ring)]",
                className,
            )}
        >
            {/* The icon sits outside the text-and-control line, so a control that wraps lines up under the text. */}
            <div className={cn("flex gap-3", stack ? "items-start" : "items-center")}>
                {icon && <div className="flex shrink-0 items-center">{icon}</div>}
                <div
                    data-row-main=""
                    className={cn(
                        "flex min-w-0 flex-1",
                        stack
                            ? "flex-col gap-3"
                            : cn(
                                  "items-center justify-between",
                                  split
                                      ? "min-h-[calc(36px*var(--density,1))] gap-3"
                                      : tall
                                        ? "gap-6"
                                        : "min-h-[calc(36px*var(--density,1))] gap-4",
                                  // Rows outside a settings page (dialogs) still wrap on phones; inside one,
                                  // settings.css takes over from the column width.
                                  "max-sm:flex-wrap max-sm:gap-y-2.5",
                              ),
                    )}
                >
                    <div data-row-text="" className="flex min-w-0 flex-1 flex-col">
                        <div className="flex min-h-5 items-center gap-1.5">
                            <span id={labelId} data-row-label="" className="text-base leading-5 font-medium">
                                {markText(label)}
                            </span>
                            {lock && <LockMark lock={lock} />}
                            {status && status.state !== "idle" && <InlineStatus status={status} />}
                        </div>
                        {description && (
                            <div className={cn("mt-0.5 max-w-[62ch] text-sm leading-[18px]", secondaryText)}>
                                {markText(description)}
                            </div>
                        )}
                        {hint && <div className="mt-1 text-xs leading-4 text-tertiary">{hint}</div>}
                    </div>
                    {(control || reset) && (
                        <div
                            data-row-control=""
                            className={cn(
                                "flex max-w-full items-center gap-2",
                                stack
                                    ? "w-full"
                                    : split
                                      ? "min-w-0 flex-1 justify-end"
                                      : "min-w-[min(160px,40cqw)] shrink-0 justify-end empty:min-w-0 max-sm:ms-auto",
                            )}
                        >
                            {reset && (
                                <Tooltip label={resetLabel}>
                                    <IconButton
                                        aria-label={resetLabel}
                                        onClick={reset.onReset}
                                        className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                                    >
                                        <ArrowCounterClockwise />
                                    </IconButton>
                                </Tooltip>
                            )}
                            <RowLockContext.Provider value={!!lock}>{control}</RowLockContext.Provider>
                        </div>
                    )}
                </div>
            </div>
            {children}
            {error && (
                <div role="alert" className="mt-1.5 text-sm leading-[18px] text-danger">
                    {error}
                </div>
            )}
        </div>
    );
}

/** A whole row that opens something (catalogue entry, list item). Same padding as SettingRow; hover ink 7%. */
export function LinkRow({
    id,
    icon,
    label,
    description,
    trailing,
    onClick,
}: {
    id?: string;
    icon?: ReactNode;
    label: ReactNode;
    description?: ReactNode;
    /** Right side controls (outside the button, so a switch does not open the row). Without it, a chevron shows. */
    trailing?: ReactNode;
    onClick: () => void;
}) {
    const search = useRowSearch(id);
    if (search === "hidden") return null;
    return (
        <div
            id={id}
            data-interactive
            data-search-hit={search === "hit" ? "" : undefined}
            className="flex scroll-mt-24 items-center hover-device:has-[>button:hover]:bg-hover has-[>button:focus-visible]:bg-hover has-[>button:active]:bg-hover"
        >
            <button
                type="button"
                onClick={onClick}
                className={cn(
                    "flex min-w-0 flex-1 items-center gap-3 px-[calc(16px*var(--density,1))] text-start outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                    description
                        ? "py-[calc(14px*var(--density,1))]"
                        : "min-h-[calc(56px*var(--density,1))] py-[calc(10px*var(--density,1))]",
                )}
            >
                {icon && <span className="flex shrink-0 items-center">{icon}</span>}
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-base leading-5 font-medium">{markText(label)}</span>
                    {description && (
                        <span className={cn("mt-0.5 text-sm leading-[18px]", secondaryText)}>
                            {markText(description)}
                        </span>
                    )}
                </span>
                {!trailing && <CaretRight className="size-4 shrink-0 text-tertiary" aria-hidden />}
            </button>
            {trailing && <div className="flex shrink-0 items-center gap-2 pe-4">{trailing}</div>}
        </div>
    );
}

/** "Advanced >" disclosure: a section whose heading is the toggle, with an optional action on the right. */
export function AdvancedSection({
    label,
    children,
    aside,
    defaultOpen = false,
}: {
    label?: string;
    children: ReactNode;
    aside?: ReactNode;
    defaultOpen?: boolean;
}) {
    const t = useT();
    const shownLabel = label ?? t("settings-advanced");
    // Search results open it, so matched rows inside are visible; the person can still close it.
    const searching = !!useSearchScope();
    const [open, setOpen] = useState(defaultOpen || searching);
    // Open when a deep link targets a row inside.
    const body = useRef<HTMLDivElement>(null);
    const bodyId = useId();
    // What the closed section holds, as in Material's collapsed "Advanced" group (shown on narrow columns only).
    const [summary, setSummary] = useState("");
    useLayoutEffect(() => {
        const labels = [...(body.current?.querySelectorAll("[data-row-label]") ?? [])]
            .map((el) => el.textContent?.trim() ?? "")
            .filter(Boolean);
        const first = labels.slice(0, 3).join(", ");
        setSummary(labels.length > 3 ? t("settings-advanced-more", { first, count: labels.length - 3 }) : first);
    }, [children, t]);
    useEffect(() => {
        let frame: number | undefined;
        const check = () => {
            const id = settingsAnchor();
            if (!id || !body.current?.querySelector(`[id="${CSS.escape(id)}"]`)) return;
            setOpen(true);
            if (frame !== undefined) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => window.dispatchEvent(new Event("settings:anchor")));
        };
        check();
        window.addEventListener("hashchange", check);
        return () => {
            if (frame !== undefined) cancelAnimationFrame(frame);
            window.removeEventListener("hashchange", check);
        };
    }, []);
    return (
        <SettingsSection
            title={
                <button
                    type="button"
                    data-advanced-toggle=""
                    aria-expanded={open}
                    aria-controls={bodyId}
                    onClick={() => setOpen(!open)}
                    className="inline-flex items-center gap-1 rounded-md text-md leading-6 font-semibold tracking-[-0.01em] text-tertiary outline-none hover-device:hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-10"
                >
                    <span data-advanced-label="">{shownLabel}</span>
                    <CaretRight
                        className={cn(
                            "size-4 transition-transform duration-150 ease-[var(--ease-standard)]",
                            open && "rotate-90",
                        )}
                        aria-hidden
                    />
                    {summary && <span data-advanced-summary="">{summary}</span>}
                </button>
            }
            action={aside}
        >
            {/* Kept mounted (hidden) so deep links and search can find rows inside before it opens. */}
            <div ref={body} id={bodyId} hidden={!open} className="flex flex-col gap-4">
                {children}
            </div>
        </SettingsSection>
    );
}

/** Inline code spans for descriptions that come from the settings registry (`value`). */
export function Described({ text }: { text: string }) {
    const parts = text.split(/(`[^`]+`)/g);
    return (
        <>
            {parts.map((p, i) =>
                p.startsWith("`") && p.endsWith("`") ? (
                    <code key={i} className="rounded-sm bg-inline-code px-1 font-mono text-[0.95em]">
                        {p.slice(1, -1)}
                    </code>
                ) : (
                    <SearchMark key={i} text={p} />
                ),
            )}
        </>
    );
}

/** Labelled form field (setup pages and dialogs): label above, help or error below. */
export function FormField({
    label,
    help,
    error,
    optional,
    link,
    children,
}: {
    label: string;
    help?: ReactNode;
    error?: string | null;
    optional?: boolean;
    /** Right-aligned link next to the label ("Get a key"). */
    link?: ReactNode;
    children: (id: string) => ReactNode;
}) {
    const t = useT();
    const id = useId();
    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
                <label htmlFor={id} className="text-base leading-5 font-medium">
                    {label}
                    {optional && <span className="font-normal text-tertiary"> {t("settings-optional")}</span>}
                </label>
                {link}
            </div>
            {children(id)}
            {help && !error && <div className={cn("text-sm leading-[18px]", secondaryText)}>{help}</div>}
            {error && (
                <div role="alert" className="text-xs leading-4 text-danger">
                    {error}
                </div>
            )}
        </div>
    );
}
