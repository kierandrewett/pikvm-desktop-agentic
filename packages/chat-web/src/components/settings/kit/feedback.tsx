/**
 * Settings buttons and feedback: Button, IconButton, Badge, Notice, EmptyState, InlineStatus and Spinner.
 *
 * Buttons are 36px like every other row control. `sm` (13px text, rows and section headings) and `md` (14px text,
 * form and page actions, dialog footers) differ in text size and padding only. Variants: `secondary` (soft fill, the default), `primary` (solid ink, one per view), `danger`
 * (soft fill, danger text; destructive actions always confirm first) and `ghost` (text only).
 * Hover and press backgrounds are instant, like the reference.
 */
import { Check, CheckCircle, Info, WarningCircle, type Icon } from "@pikvm/icons";
import {
    Button as UiButton,
    IconButton as UiIconButton,
    Spinner,
    type ButtonVariant as UiButtonVariant,
} from "../../../ui/index";
import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useT } from "../../../l10n/provider";
import { cn } from "../../../lib/cn";
import { EmptyState as SharedEmptyState, type StateProps } from "../../ui/state";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

/** Settings variants onto the package variants (see packages/ui/src/button.tsx). */
const variantMap = {
    primary: "primary",
    secondary: "secondary",
    danger: "danger-soft",
    ghost: "ghost",
} as const satisfies Record<ButtonVariant, UiButtonVariant>;

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
    variant?: ButtonVariant;
    /** Both sizes are 36 px in the package (`xl`); kept so call sites do not change. */
    size?: ButtonSize;
    /** Show a spinner and block clicks. */
    busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { variant = "secondary", size: _size = "sm", ...rest },
    ref,
) {
    return <UiButton ref={ref} size="xl" variant={variantMap[variant]} {...rest} />;
});

/** Icon-only button: 36px ghost (round or rounded square), 20px icon. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { round?: boolean }>(
    function IconButton(props, ref) {
        return <UiIconButton ref={ref} {...props} />;
    },
);

export { Badge, Spinner, type BadgeTone } from "../../../ui/index";

export type NoticeTone = "neutral" | "warning" | "danger" | "success";

const noticeIcon: Record<NoticeTone, Icon> = {
    neutral: Info,
    warning: WarningCircle,
    danger: WarningCircle,
    success: CheckCircle,
};

/** Page-level message above a card: a policy, a warning or an error that affects the whole section. */
export function Notice({
    tone = "neutral",
    children,
    action,
}: {
    tone?: NoticeTone;
    children: ReactNode;
    action?: ReactNode;
}) {
    const IconC = noticeIcon[tone];
    return (
        <div
            role={tone === "neutral" || tone === "success" ? "status" : "alert"}
            className={cn(
                "flex items-start gap-2.5 rounded-2xl px-4 py-3 text-sm leading-[18.5714px]",
                tone === "neutral" && "bg-soft text-secondary",
                tone === "success" && "bg-soft text-text",
                tone === "warning" && "bg-warning-bg text-warning",
                tone === "danger" && "bg-danger-bg text-danger",
            )}
        >
            <IconC
                className={cn("mt-px size-4 shrink-0", tone === "success" && "text-success")}
                weight="fill"
                aria-hidden
            />
            <div className="min-w-0 flex-1">{children}</div>
            {action && <div className="shrink-0">{action}</div>}
        </div>
    );
}

/**
 * Empty, loading or error content inside a card. `row` (default): one line of text with an optional icon and
 * action, for short notes in a list. `block`: centred icon tile, title, a line that says what to do, and the
 * action that does it, for a list that has nothing in it yet.
 *
 * One implementation for the whole app lives in components/ui/state.tsx; this keeps the kit's props. `row` is the
 * shared `card` size and `block` the shared `panel` size. For a failed load use `ErrorState` from the same module
 * (`<ErrorState size="card" title="Could not load passkeys" query={list} />`), which wires Retry to the query.
 */
export function EmptyState({
    size = "row",
    loading,
    ...rest
}: Omit<StateProps, "size" | "placement"> & { size?: "row" | "block" }) {
    // A loading block keeps the row form: the shared panel size has no spinner (no panel-wide spinners).
    return <SharedEmptyState {...rest} loading={loading} size={size === "block" && !loading ? "panel" : "card"} />;
}

export type Status = { state: "idle" } | { state: "saving" } | { state: "saved" } | { state: "error"; message: string };

/**
 * Small status next to a row label. Saving: a spinner (no text). Saved: a check that fades out within 1.2s.
 * Errors: the message, which stays until the next change.
 */
export function InlineStatus({ status }: { status: Status }) {
    const t = useT();
    if (status.state === "idle") return null;
    if (status.state === "saving") {
        return (
            <span role="status" aria-label={t("settings-status-saving")} className="inline-flex">
                <Spinner className="size-3.5" />
            </span>
        );
    }
    if (status.state === "saved") {
        return (
            <span
                role="status"
                aria-label={t("settings-status-saved")}
                className="inline-flex animate-[settings-saved_1.2s_var(--ease-standard)_forwards]"
            >
                <Check className="size-3.5 text-success" weight="bold" aria-hidden />
            </span>
        );
    }
    return (
        <span role="alert" className="inline-flex min-w-0 items-center gap-1 text-xs leading-4 text-danger">
            <WarningCircle className="size-3.5 shrink-0" weight="fill" aria-hidden />
            <span className="truncate">{status.message}</span>
        </span>
    );
}

/** Status for a binding: saving while pending, a check for 1.2s after it settles, the error if it failed. */
export function useSaveStatus(pending: boolean, error: string | null): Status {
    const [saved, setSaved] = useState(false);
    const wasPending = useRef(pending);
    useEffect(() => {
        const completed = wasPending.current && !pending && !error;
        wasPending.current = pending;
        if (!completed) {
            setSaved(false);
            return;
        }
        setSaved(true);
        const timer = window.setTimeout(() => setSaved(false), 1200);
        return () => window.clearTimeout(timer);
    }, [pending, error]);
    if (pending) return { state: "saving" };
    if (error) return { state: "error", message: error };
    if (saved) return { state: "saved" };
    return { state: "idle" };
}

/** Square tile for a logo or icon at the start of a row: 36px in lists, 40px in a detail page header. */
export function IconTile({ children, size = "md" }: { children: ReactNode; size?: "md" | "lg" }) {
    return (
        <span
            aria-hidden
            className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-lg bg-soft text-icon [&_svg]:size-5",
                size === "md" ? "size-9" : "size-10",
            )}
        >
            {children}
        </span>
    );
}
