/**
 * Empty and error states: one family for every "nothing here yet", "no results" and "could not load" in the app.
 *
 * Sizes and where each one goes. Alignment follows the container, so a state never floats in the wrong place:
 * - page: a whole route or main column (a missing chat, an empty Files library). Centred horizontally and set
 *   slightly above the geometric centre (2:3 spacers), which reads as centred once a header sits above it.
 * - panel: a side panel, a popover list, a drawer section. Centred horizontally, top-aligned with the panel's
 *   own padding so it does not jump when the panel resizes. Pass `placement="optical"` for a fixed-height box.
 * - card: a row inside a settings card. Left-aligned on the card's 16px row padding, action at the end, so it
 *   lines up with the rows it replaces.
 * - inline: a sidebar section, a menu, a line in a list. No tile, left-aligned with the text column around it;
 *   the caller gives the horizontal padding that matches its rows.
 *
 * Copy rules (docs/spec/empty-error-states.md): say what belongs here in this context ("No chats in this
 * project yet", not "No data"), give one next action, never blame, keep it short.
 *
 * Usage:
 *   <EmptyState size="page" icon={FolderSimple} title="No files yet" description="..." action={{ label: "Upload", icon: UploadSimple, onClick }} />
 *   <ErrorState size="panel" title="Could not load these files" query={filesQuery} />
 *   <EmptyState size="inline" title="No chats yet" className="px-[var(--row-padding-x)]" />
 */
import { useT } from "../../l10n/provider";
import {
    ArrowClockwise,
    CaretRight,
    Check,
    CircleNotch,
    CloudSlash,
    Copy,
    WarningCircle,
    WifiSlash,
    type Icon,
} from "@pikvm/icons";
import {
    cloneElement,
    isValidElement,
    useEffect,
    useId,
    useRef,
    useState,
    type MouseEventHandler,
    type ReactElement,
    type ReactNode,
} from "react";
import { cn } from "../../lib/cn";
import { describeError, errorDetails, type DescribedError } from "../../lib/errors";
import { Button, type ButtonSize } from "./button";

export type StateSize = "page" | "panel" | "card" | "inline";
export type StateTone = "neutral" | "accent" | "warning" | "danger";
export type StatePlacement = "optical" | "top";

/** An action as data. `link` renders a router Link or an anchor as the button; the label becomes its content. */
export interface StateActionSpec {
    label: ReactNode;
    onClick?: () => void;
    icon?: Icon;
    link?: ReactElement;
    busy?: boolean;
    disabled?: boolean;
}

/** A spec, or any node (for example a settings kit Button) for callers that already render their own. */
export type StateAction = StateActionSpec | ReactNode;

export interface StateProps {
    icon?: Icon;
    tone?: StateTone;
    /** The message. `children` works too, for the settings kit's `<EmptyState>Loading...</EmptyState>` form. */
    title?: ReactNode;
    children?: ReactNode;
    description?: ReactNode;
    /** Primary action: solid at page size, soft elsewhere. */
    action?: StateAction;
    /** Secondary action: always quieter than the primary. */
    secondaryAction?: StateAction;
    size?: StateSize;
    /** Vertical placement for page and panel sizes. Defaults: page optical, panel top. */
    placement?: StatePlacement;
    /**
     * Spinner in place of the icon, `role="status"`. Card and inline sizes only (the settings kit's loading rows).
     * Page and panel sizes ignore it on purpose: no whole-page or whole-panel spinners. A slow load gets a
     * content-shaped skeleton after a delay, owned by the page.
     */
    loading?: boolean;
    /** Extra content under the description (the error Details disclosure). */
    extra?: ReactNode;
    className?: string;
    role?: "status" | "alert";
}

const toneTile: Record<StateTone, string> = {
    neutral: "bg-soft text-icon-secondary",
    accent: "bg-accent-bg text-accent-text",
    warning: "bg-warning-bg text-warning",
    danger: "bg-danger-bg text-danger",
};

const toneGlyph: Record<StateTone, string> = {
    neutral: "text-icon-tertiary",
    accent: "text-accent-text",
    warning: "text-warning",
    danger: "text-danger",
};

/** Per-size measurements. Tile and glyph sizes step down together so the icon keeps the same weight. */
const sizing = {
    page: {
        tile: "size-14 rounded-2xl [&_svg]:size-7",
        title: "text-lg font-medium",
        description: "mt-1.5 max-w-[50ch] text-base text-secondary",
        actions: "mt-6",
        button: "xl" as ButtonSize,
        width: "max-w-[26rem]",
    },
    panel: {
        tile: "size-11 rounded-xl [&_svg]:size-[22px]",
        title: "text-base font-medium",
        description: "mt-1 max-w-[42ch] text-sm text-secondary",
        actions: "mt-4",
        button: "lg" as ButtonSize,
        width: "max-w-[22rem]",
    },
} as const;

function isSpec(a: StateAction): a is StateActionSpec {
    return typeof a === "object" && a !== null && !isValidElement(a) && "label" in a;
}

function ActionButton({
    action,
    primary,
    size,
    pill,
}: {
    action: StateAction;
    primary: boolean;
    size: ButtonSize;
    pill: boolean;
}) {
    if (!isSpec(action)) return <>{action}</>;
    const { label, onClick, icon: IconC, link, busy, disabled } = action;
    const content = (
        <>
            {busy ? <CircleNotch className="animate-spin" aria-hidden /> : IconC && <IconC aria-hidden />}
            {label}
        </>
    );
    const common = {
        size,
        pill,
        variant: primary ? ("solid" as const) : ("soft" as const),
        className: cn(size === "xl" && "text-base"),
        disabled: disabled || busy,
        "aria-busy": busy || undefined,
    };
    if (link) {
        const child = link as ReactElement<{ children?: ReactNode; onClick?: MouseEventHandler<HTMLElement> }>;
        const { disabled: _disabled, ...linkProps } = common;
        if (disabled || busy) {
            // An inert link has no URL, so middle-click and the context menu cannot bypass the pending state.
            return (
                <Button asChild {...linkProps} className={cn(common.className, "opacity-40")}>
                    <span role="link" aria-disabled="true">
                        {content}
                    </span>
                </Button>
            );
        }
        return (
            <Button asChild {...linkProps}>
                {cloneElement(
                    child,
                    {
                        onClick: (event) => {
                            child.props.onClick?.(event);
                            if (!event.defaultPrevented) onClick?.();
                        },
                    },
                    content,
                )}
            </Button>
        );
    }
    return (
        <Button {...common} onClick={onClick}>
            {content}
        </Button>
    );
}

function Actions({
    action,
    secondaryAction,
    size,
    className,
    primarySolid,
}: {
    action?: StateAction;
    secondaryAction?: StateAction;
    size: ButtonSize;
    className?: string;
    primarySolid: boolean;
}) {
    if (!action && !secondaryAction) return null;
    const pill = size !== "md" && size !== "xs";
    return (
        <div className={cn("flex flex-wrap items-center gap-2", className)}>
            {action && <ActionButton action={action} primary={primarySolid} size={size} pill={pill} />}
            {secondaryAction && <ActionButton action={secondaryAction} primary={false} size={size} pill={pill} />}
        </div>
    );
}

/** The shared renderer. EmptyState and ErrorState are thin presets over it. */
export function StateView({
    icon: IconC,
    tone = "neutral",
    title,
    children,
    description,
    action,
    secondaryAction,
    size = "page",
    placement,
    loading,
    extra,
    className,
    role,
}: StateProps) {
    const heading = title ?? children;
    const liveRole = role ?? (loading ? "status" : undefined);

    if (size === "card") {
        return (
            <div role={liveRole} className={cn("flex min-h-11 flex-wrap items-center gap-3 px-4 py-3", className)}>
                {(loading || IconC) && (
                    <span
                        aria-hidden
                        className={cn(
                            "inline-flex size-8 shrink-0 items-center justify-center rounded-lg [&_svg]:size-[18px]",
                            toneTile[tone],
                        )}
                    >
                        {loading ? <CircleNotch className="animate-spin" /> : IconC && <IconC />}
                    </span>
                )}
                <div className="flex min-w-0 flex-[1_1_12rem] flex-col">
                    <span className={cn("text-sm text-pretty", description ? "text-text" : "text-secondary")}>
                        {heading}
                    </span>
                    {description && <span className="mt-0.5 text-xs text-pretty text-tertiary">{description}</span>}
                    {extra}
                </div>
                <Actions
                    action={action}
                    secondaryAction={secondaryAction}
                    size="md"
                    className="shrink-0"
                    primarySolid={false}
                />
            </div>
        );
    }

    if (size === "inline") {
        return (
            <div role={liveRole} className={cn("flex min-w-0 items-start gap-2 py-1 text-sm", className)}>
                {(loading || IconC) && (
                    <span aria-hidden className={cn("mt-px inline-flex shrink-0 [&_svg]:size-4", toneGlyph[tone])}>
                        {loading ? <CircleNotch className="animate-spin" /> : IconC && <IconC />}
                    </span>
                )}
                <div className="flex min-w-0 flex-1 flex-col items-start">
                    <span className={cn("text-pretty", tone === "danger" ? "text-text" : "text-tertiary")}>
                        {heading}
                    </span>
                    {description && <span className="mt-0.5 text-xs text-pretty text-tertiary">{description}</span>}
                    {extra}
                    <Actions
                        action={action}
                        secondaryAction={secondaryAction}
                        size="xs"
                        className="mt-1.5"
                        primarySolid={false}
                    />
                </div>
            </div>
        );
    }

    const s = sizing[size];
    const optical = (placement ?? (size === "page" ? "optical" : "top")) === "optical";
    return (
        <div
            role={liveRole}
            className={cn(
                "flex w-full flex-1 flex-col items-center px-6 text-center",
                optical ? "min-h-full py-8" : size === "page" ? "pt-16 pb-8" : "pt-8 pb-6",
                className,
            )}
        >
            {optical && <div aria-hidden className="min-h-0 flex-[2]" />}
            <div
                className={cn(
                    "flex w-full flex-col items-center motion-safe:animate-[fade-in_calc(180ms*var(--motion-scale))_var(--ease-enter)]",
                    s.width,
                )}
            >
                {IconC && (
                    <span
                        aria-hidden
                        className={cn("mb-4 inline-flex shrink-0 items-center justify-center", s.tile, toneTile[tone])}
                    >
                        <IconC />
                    </span>
                )}
                {heading && <h2 className={cn("max-w-full text-balance break-words text-text", s.title)}>{heading}</h2>}
                {description && <p className={cn("text-pretty", s.description)}>{description}</p>}
                <Actions
                    action={action}
                    secondaryAction={secondaryAction}
                    size={s.button}
                    className={cn("justify-center", s.actions)}
                    primarySolid={size === "page"}
                />
                {extra}
            </div>
            {optical && <div aria-hidden className="min-h-0 flex-[3]" />}
        </div>
    );
}

/** Nothing here yet, no results, a filter that matches nothing. Neutral tone unless the caller says otherwise. */
export function EmptyState(props: StateProps) {
    return <StateView {...props} />;
}

/** The parts of a TanStack Query result that ErrorState needs. */
export interface RetryableQuery {
    error: unknown;
    refetch: () => unknown;
    isRefetching?: boolean;
}

export interface ErrorStateProps extends Omit<StateProps, "loading" | "children"> {
    /** The thrown value. Read from `query` when that is given. */
    error?: unknown;
    /** A query result: supplies the error, the Retry action and its busy state in one prop. */
    query?: RetryableQuery;
    onRetry?: () => void;
    retrying?: boolean;
    retryLabel?: string;
    /** Show the Details disclosure (status, code, message). Default: on for page and panel, off for card and inline. */
    details?: boolean;
}

const kindIcon: Partial<Record<DescribedError["kind"], Icon>> = { offline: WifiSlash, unreachable: CloudSlash };

/**
 * Could not load, could not open, could not reach. The title names what failed in this context; the description
 * defaults to the friendly reason from `describeError`, and Retry is wired to the query's refetch.
 */
export function ErrorState({
    error: errorProp,
    query,
    onRetry,
    retrying,
    retryLabel,
    details,
    title,
    description,
    icon,
    tone,
    action,
    size = "page",
    ...rest
}: ErrorStateProps) {
    const t = useT();
    const error = errorProp ?? query?.error;
    const d = describeError(error);
    const network = d.kind === "offline" || d.kind === "unreachable";
    const retry = onRetry ?? (query ? () => void query.refetch() : undefined);
    const busy = retrying ?? query?.isRefetching ?? false;
    const showDetails = (details ?? (size === "page" || size === "panel")) && error !== undefined && error !== null;
    return (
        <StateView
            role="alert"
            size={size}
            icon={icon ?? kindIcon[d.kind] ?? WarningCircle}
            tone={tone ?? (network ? "warning" : "danger")}
            title={title ?? d.title}
            description={description ?? d.message}
            action={action ?? (retry ? { label: retryLabel ?? t("state-retry"), icon: ArrowClockwise, onClick: retry, busy } : undefined)}
            extra={
                showDetails ? (
                    <ErrorDetails error={error} align={size === "page" || size === "panel" ? "center" : "start"} />
                ) : undefined
            }
            {...rest}
        />
    );
}

/** "Details" disclosure: the status, code and raw message, with a copy button, for bug reports. */
export function ErrorDetails({ error, align = "center" }: { error: unknown; align?: "center" | "start" }) {
    const t = useT();
    const text = errorDetails(error);
    const id = useId();
    const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const live = useRef(true);
    useEffect(() => {
        live.current = true;
        return () => {
            live.current = false;
            clearTimeout(timer.current);
        };
    }, []);
    const copy = async () => {
        clearTimeout(timer.current);
        try {
            await navigator.clipboard.writeText(text);
            if (!live.current) return;
            setCopyState("copied");
            timer.current = setTimeout(() => setCopyState("idle"), 1500);
        } catch {
            if (live.current) setCopyState("failed");
        }
    };
    if (!text) return null;
    return (
        <details className={cn("group mt-4 w-full text-xs", align === "center" ? "text-center" : "text-start")}>
            <summary
                className={cn(
                    "inline-flex cursor-default list-none items-center gap-1 rounded-sm px-1 text-tertiary select-none",
                    "hover-device:hover:text-text focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden",
                )}
            >
                <CaretRight className="size-3.5 transition-transform duration-150 group-open:rotate-90" aria-hidden />
                {t("state-details")}
            </summary>
            <div className="mt-2 flex items-start gap-2 rounded-lg bg-soft p-2.5 text-start">
                <code
                    id={id}
                    className="min-w-0 flex-1 font-mono text-xs break-words whitespace-pre-wrap text-secondary"
                >
                    {text}
                </code>
                <Button
                    size="2xs"
                    uniform
                    aria-label={copyState === "copied" ? t("state-copied") : t("state-copy")}
                    aria-describedby={id}
                    className="-me-1 -mt-0.5"
                    onClick={() => void copy()}
                >
                    {copyState === "copied" ? <Check /> : <Copy />}
                </Button>
            </div>
            <p role="status" className={copyState === "failed" ? "mt-1.5 text-secondary" : "sr-only"}>
                {copyState === "failed"
                    ? t("state-copy-failed")
                    : copyState === "copied"
                      ? t("state-copy-done")
                      : ""}
            </p>
        </details>
    );
}
