/**
 * The one button primitive (reference spec 0.2), merged from the old ui/button and the settings kit Button and
 * IconButton. Size scale 3xs..4xl; variants ghost/transparent/solid/soft/outline/danger plus the settings looks
 * primary/secondary/danger-soft and the text-only `link`; uniform (square icon) and pill shapes. Background lives
 * on ::before so hover fades.
 *
 * Edge cases kept:
 * - Touch: on a coarse pointer, ::after grows the hit area to at least 44x44 px (lib/touch.ts) without changing
 *   the drawn size, so dense toolbars keep their look and still meet the touch target size. Where two small
 *   buttons sit closer than that, the later one in the DOM takes the shared strip; each button's centre stays
 *   its own. This replaces the settings kit's `pointer-coarse:h-11` / `size-11`, which changed the drawn size.
 * - `busy`: shows a spinner before the children, sets `disabled` and `aria-busy`, so clicks are blocked and
 *   assistive technology hears the state. With `asChild` there is no `disabled`, so the child gets `aria-busy`,
 *   `aria-disabled` and `pointer-events-none` instead.
 * - `asChild`: renders the single child element (for example a router Link) with the button's styling and merges
 *   the child's own className. Props are spread onto the child; `type` is not, because a link has none.
 * - `type` defaults to "button" so a button inside a form never submits by accident.
 * - Icons inside default to weight "regular" (IconContext): solid is applied per icon (sidebar toggles, active
 *   rail items), not to every button, which looked heavy.
 * - Settings sizes: the old `sm` and `md` (both 36 px, 13 and 14 px text) map onto `xl` (36 px, 14 px text).
 * - Variant names: the settings kit `danger` (soft fill, danger text) is `danger-soft` here. `danger` stays the
 *   solid danger button. `primary` is `solid` at font-medium, `secondary` is `soft`.
 * - `link`: text only, no height, padding or background. For the thread's "act-more" buttons (13 px, tertiary,
 *   text colour on hover or focus, 2 px ring offset by 2 px).
 * - IconButton: a thin wrapper, uniform at size xl (36 px, 20 px icon), ghost by default, `round` for a circle.
 */
import { CircleNotch, IconContext } from "@pikvm/icons";
import {
    cloneElement,
    forwardRef,
    isValidElement,
    type ButtonHTMLAttributes,
    type ReactElement,
    type ReactNode,
} from "react";
import { cn } from "./lib/cn";
import { touchTarget } from "./lib/touch";

export type ButtonSize = "3xs" | "2xs" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl";
export type ButtonVariant =
    | "ghost"
    | "transparent"
    | "solid"
    | "soft"
    | "outline"
    | "danger"
    | "primary"
    | "secondary"
    | "danger-soft"
    | "link";

const sizes: Record<ButtonSize, string> = {
    "3xs": "h-5 text-xs gap-[3px] rounded-sm [--icon:14px]",
    "2xs": "h-[22px] text-xs gap-[3px] rounded-sm [--icon:14px]",
    xs: "h-6 text-sm gap-1 rounded-sm [--icon:16px]",
    sm: "h-[26px] text-sm gap-1 rounded-sm [--icon:16px]",
    md: "h-7 text-sm gap-1 rounded-[calc(9.375px*var(--roundness))] [--icon:16px]",
    lg: "h-8 text-base gap-1.5 rounded-md [--icon:18px]",
    xl: "h-9 text-sm gap-1.5 rounded-lg [--icon:20px]",
    "2xl": "h-10 text-sm gap-1.5 rounded-lg [--icon:18px]",
    "3xl": "h-11 text-sm gap-1.5 rounded-xl [--icon:20px]",
    "4xl": "h-12 text-base gap-1.5 rounded-xl [--icon:20px]",
};
/** Horizontal padding (the reference "gutter"); not applied to uniform (square) buttons. */
const gutters: Record<ButtonSize, string> = {
    "3xs": "px-1.5",
    "2xs": "px-1.5",
    xs: "px-2",
    sm: "px-2",
    md: "px-2.5",
    lg: "px-3",
    xl: "px-3",
    "2xl": "px-3.5",
    "3xl": "px-3.5",
    "4xl": "px-4",
};
const square: Record<ButtonSize, string> = {
    "3xs": "w-5",
    "2xs": "w-[22px]",
    xs: "w-6",
    sm: "w-[26px]",
    md: "w-7",
    lg: "w-8",
    xl: "w-9",
    "2xl": "w-10",
    "3xl": "w-11",
    "4xl": "w-12",
};
const variants: Record<ButtonVariant, string> = {
    ghost: "font-normal text-tertiary hover-device:hover:text-text before:bg-hover before:opacity-0 hover-device:hover:before:opacity-100 active:before:bg-pressed active:before:opacity-100 data-[state=open]:before:opacity-60 aria-pressed:before:opacity-100 aria-pressed:text-text data-[selected=true]:before:opacity-100 data-[selected=true]:text-text",
    transparent: "font-normal text-tertiary hover-device:hover:text-text",
    solid: "font-normal text-on-primary-solid before:bg-primary-solid hover-device:hover:before:bg-primary-solid-hover active:scale-[0.98]",
    soft: "font-normal text-text before:bg-soft hover-device:hover:before:bg-hover active:before:bg-pressed",
    outline: "font-normal text-text before:border before:border-strong hover-device:hover:before:bg-hover",
    danger: "font-normal text-on-danger before:bg-danger-solid hover-device:hover:before:brightness-110",
    primary:
        "font-medium text-on-primary-solid before:bg-primary-solid hover-device:hover:before:bg-primary-solid-hover active:scale-[0.98]",
    secondary: "font-normal text-text before:bg-soft hover-device:hover:before:bg-hover active:before:bg-pressed",
    "danger-soft":
        "font-medium text-danger before:bg-danger-bg hover-device:hover:text-on-danger hover-device:hover:before:bg-danger-solid",
    link: "font-normal text-[13px] leading-5 gap-1.5 [--icon:14px] text-tertiary hover-device:hover:text-text focus-visible:text-text",
};

/**
 * Icon weight inside buttons. Regular by default: solid is applied deliberately per icon (sidebar
 * toggles, active rail items), not to every button, which looked heavy.
 */
const SOLID = { weight: "regular" } as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    size?: ButtonSize;
    variant?: ButtonVariant;
    uniform?: boolean;
    pill?: boolean;
    /** Render the single child element (for example a router Link) with the button's styling. */
    asChild?: boolean;
    /** Show a spinner, block clicks and set aria-busy. */
    busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    {
        size = "md",
        variant = "ghost",
        uniform,
        pill,
        asChild,
        busy,
        disabled,
        className,
        type = "button",
        children,
        ...rest
    },
    ref,
) {
    const link = variant === "link";
    const classes = cn(
        "relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap transition-[color,opacity,transform] duration-150",
        !link &&
            "before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:transition-[opacity,background-color] before:duration-150 before:content-['']",
        touchTarget,
        "disabled:pointer-events-none disabled:opacity-40",
        link
            ? "rounded-[calc(4px*var(--roundness))] focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            : "leading-none focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-1px]",
        "[&_svg]:size-[var(--icon)] [&_svg]:shrink-0",
        !link && sizes[size],
        !link && (uniform ? square[size] : gutters[size]),
        pill && "rounded-full",
        variants[variant],
        busy && asChild && "pointer-events-none opacity-40",
        className,
    );
    const inner = (content: ReactNode) => (
        <IconContext.Provider value={SOLID}>
            <span className="relative z-[1] inline-flex items-center justify-center gap-[inherit]">
                {busy && <CircleNotch className="animate-spin" aria-hidden />}
                {content}
            </span>
        </IconContext.Provider>
    );
    if (asChild && isValidElement(children)) {
        const child = children as ReactElement<{ className?: string; children?: ReactNode }>;
        return cloneElement(child, {
            ...(rest as object),
            ...(busy ? { "aria-busy": true, "aria-disabled": true } : {}),
            className: cn(classes, child.props.className),
            children: inner(child.props.children),
        });
    }
    return (
        <button
            ref={ref}
            type={type}
            disabled={disabled || busy}
            aria-busy={busy || undefined}
            className={classes}
            {...rest}
        >
            {inner(children)}
        </button>
    );
});

export interface IconButtonProps extends Omit<ButtonProps, "uniform" | "pill" | "asChild"> {
    /** Circle instead of the rounded square. */
    round?: boolean;
}

/** Icon-only button: a uniform Button at size xl (36 px, 20 px icon), ghost by default. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
    { size = "xl", round, ...rest },
    ref,
) {
    return <Button ref={ref} uniform size={size} pill={round} {...rest} />;
});
