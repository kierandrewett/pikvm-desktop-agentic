/**
 * Composer controls: the 36px round control (web notes A.2), the send/stop button and the permission
 * pill with its menu (ui-spec 3.4: shared menu surface, two-line rows, check on the selected row, no animation).
 */
import { ArrowUp, CaretDown, Check, CircleNotch, Hand, Stop, WarningCircle } from "@pikvm/icons";
import { DropdownMenu as M } from "radix-ui";
import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useT } from "../../l10n/provider";
import type { Translate } from "../../l10n/runtime";
import { cn } from "../../lib/cn";
import { useIsMobile } from "../../lib/media";
import { touchTarget } from "../../lib/touch";
import { menuSurface } from "../ui/menu";
import { Sheet } from "../ui/sheet";
import { Tooltip } from "../ui/tooltip";
import type { Permission } from "./choice";
import { useThemeLayer } from "../../lib/theme-scope";

/**
 * Round composer control: 36px, transparent, tertiary text, hover and open bg ink 7% with no transition,
 * focus-visible 2px ring, disabled opacity .4. A pseudo element widens the hit area on touch.
 * `phone`: a 40px square inside the phone pill, 48px to the touch. A prop rather than a class, because `cn` does
 * not merge classes and `h-9` would win over `size-10`.
 */
export const ComposerButton = forwardRef<
    HTMLButtonElement,
    ButtonHTMLAttributes<HTMLButtonElement> & { phone?: boolean }
>(function ComposerButton({ className, type = "button", phone = false, ...rest }, ref) {
    return (
        <button
            ref={ref}
            type={type}
            className={cn(
                "relative flex shrink-0 items-center justify-center gap-1 rounded-full border border-transparent text-sm leading-[18px] whitespace-nowrap text-tertiary outline-none select-none",
                phone ? "size-10" : "h-9",
                "hover-device:hover:bg-hover data-[state=open]:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:pointer-events-none disabled:opacity-40",
                "after:absolute after:-inset-1 after:content-['']",
                className,
            )}
            {...rest}
        />
    );
});

/**
 * Send, stop and the dictation confirm share one look: the accent of the sent message bubble (`--sent-bubble`,
 * which follows the theme preset and the temporary-chat tint), the icon in `--on-sent-bubble`. The focus ring is
 * the same accent, offset 2px from the disc, so it stands against the composer surface rather than the disc.
 */
export const primaryLook =
    "bg-sent-bubble text-on-sent-bubble hover-device:hover:opacity-90 active:opacity-80 focus-visible:outline-2 focus-visible:outline-sent-bubble focus-visible:outline-offset-2";

const primaryBase =
    "relative flex shrink-0 items-center justify-center rounded-full p-0.5 outline-none transition-[opacity,background-color,color] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)] after:absolute after:inset-0 after:-start-1 after:content-[''] pointer-coarse:after:-inset-1";

export function SendButton({
    running,
    stopping = false,
    disabled,
    onStop,
    onSend,
    phone = false,
    hint,
}: {
    running: boolean;
    /** A stop was asked for and the server has not ended the response yet. */
    stopping?: boolean;
    disabled: boolean;
    onStop: () => void;
    /** Outside a form (the full-screen editor): send on click instead of submitting. */
    onSend?: () => void;
    /** Phone pill: 40px drawn, 48px to the touch (the ::after grows it by 4px on every side). */
    phone?: boolean;
    /** Why sending is off (for example no models), shown as the button's tooltip. */
    hint?: string;
}) {
    const t = useT();
    const primary = cn(primaryBase, phone ? "size-10" : "size-9");
    if (running) {
        // While stopping the button stays clickable: a second click asks again, in case the first was lost.
        return (
            <Tooltip label={stopping ? t("composer-stopping") : t("composer-stop")}>
                <button
                    type="button"
                    aria-label={stopping ? t("composer-stopping-label") : t("composer-stop-label")}
                    aria-busy={stopping || undefined}
                    data-stopping={stopping || undefined}
                    onClick={onStop}
                    className={cn(primary, primaryLook, stopping && "opacity-60")}
                >
                    {stopping ? (
                        <CircleNotch aria-hidden className="size-4 animate-spin" />
                    ) : (
                        <Stop aria-hidden weight="fill" className="size-4" />
                    )}
                </button>
            </Tooltip>
        );
    }
    // Empty composer: still focusable, on a neutral fill, so only a message that can go out shows the accent.
    const send = (
        <button
            type={onSend ? "button" : "submit"}
            onClick={onSend && !disabled ? onSend : undefined}
            aria-label={t("composer-send")}
            aria-disabled={disabled || undefined}
            aria-description={hint}
            className={cn(
                primary,
                disabled
                    ? "bg-hover text-tertiary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    : primaryLook,
            )}
        >
            <ArrowUp weight="bold" className="size-5" />
        </button>
    );
    return hint ? <Tooltip label={hint}>{send}</Tooltip> : send;
}

interface PermissionRow {
    id: Permission;
    title: string;
    description: string;
    icon: ReactNode;
    warning?: boolean;
}

function permissionRows(t: Translate): PermissionRow[] {
    return [
        {
            id: "default",
            title: t("composer-permission-default"),
            description: t("composer-permission-default-description"),
            icon: <Hand />,
        },
        {
            id: "full",
            title: t("composer-permission-full"),
            description: t("composer-permission-full-description"),
            icon: <WarningCircle />,
            warning: true,
        },
    ];
}

function RowBody({ row, checked, mobile }: { row: PermissionRow; checked: boolean; mobile: boolean }) {
    return (
        <>
            <span
                className={cn(
                    "flex shrink-0 justify-center opacity-75 group-data-[highlighted]/item:opacity-100 [&_svg]:size-[18px]",
                    mobile ? "mt-0.5 w-5" : "mt-px w-4",
                )}
            >
                {row.icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className={cn("block", mobile ? "text-md leading-6" : "text-sm leading-[18.57px]")}>
                    {row.title}
                </span>
                <span
                    className={cn(
                        "block text-xs leading-[14px]",
                        mobile && "mt-0.5 text-sm leading-[18px]",
                        !row.warning && "text-tertiary",
                    )}
                >
                    {row.description}
                </span>
            </span>
            {checked && <Check className="size-4 shrink-0 self-center opacity-75" />}
        </>
    );
}

export function PermissionMenu({
    value,
    onChange,
    side,
    label = "full",
}: {
    value: Permission;
    onChange: (p: Permission) => void;
    side: "top" | "bottom";
    /**
     * Phones: "short" reads "Default" instead of "Default permissions" (the composer tray row), and "icon" keeps
     * only the icon (the full-screen editor's footer). The accessible name always has the full text.
     */
    label?: "full" | "short" | "icon";
}) {
    const layer = useThemeLayer();
    const t = useT();
    const rows = permissionRows(t);
    const mobile = useIsMobile();
    const [open, setOpen] = useState(false);
    const full = value === "full";
    const text = full
        ? t("composer-permission-full")
        : label === "full"
          ? t("composer-permission-default")
          : t("composer-permission-default-short");
    const trigger = (
        <button
            type="button"
            aria-label={t("composer-permission-label", {
                name: full ? t("composer-permission-full") : t("composer-permission-default"),
            })}
            data-balloon-anchor="permission"
            onClick={mobile ? () => setOpen(true) : undefined}
            className={cn(
                "relative inline-flex h-7 min-w-0 shrink items-center gap-1 rounded-full border border-transparent px-1.5 text-sm leading-[18px] outline-none select-none max-md:h-10",
                touchTarget,
                "hover-device:hover:bg-hover data-[state=open]:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
                full ? "text-warning" : "text-tertiary",
                label !== "full" && "max-md:px-2.5",
            )}
        >
            {full ? <WarningCircle className="size-4 shrink-0" /> : <Hand className="size-4 shrink-0" />}
            {/* 200% text: the label gives way to the icon before the row runs out of room. */}
            <span className={cn("truncate", label === "icon" && "sr-only", label === "short" && "max-[320px]:sr-only")}>
                {text}
            </span>
            <CaretDown className="size-3.5 shrink-0" />
        </button>
    );
    const header = t("composer-permission-header");

    if (mobile) {
        return (
            <>
                {trigger}
                <Sheet open={open} onOpenChange={setOpen} title={header}>
                    <div role="menu" aria-label={t("composer-permission-change")} className="flex flex-col pb-2">
                        {rows.map((row) => (
                            <button
                                key={row.id}
                                type="button"
                                role="menuitemradio"
                                aria-checked={row.id === value}
                                onClick={() => {
                                    setOpen(false);
                                    onChange(row.id);
                                }}
                                className={cn(
                                    "group/item flex min-h-12 w-full items-start gap-3 rounded-xl px-3 py-2.5 text-start active:bg-hover",
                                    row.warning ? "text-warning" : "text-text",
                                )}
                            >
                                <RowBody row={row} checked={row.id === value} mobile />
                            </button>
                        ))}
                    </div>
                </Sheet>
            </>
        );
    }

    return (
        <M.Root open={open} onOpenChange={setOpen} modal={false}>
            <M.Trigger asChild>{trigger}</M.Trigger>
            <M.Portal container={layer}>
                <M.Content
                    side={side}
                    align="end"
                    sideOffset={2}
                    collisionPadding={8}
                    aria-label={t("composer-permission-change")}
                    className={cn(menuSurface, "m-px max-w-[calc(100vw-16px)]")}
                >
                    <M.Label className="flex min-h-6 items-center px-2 py-[5px] text-sm leading-4 text-tertiary">
                        {header}
                    </M.Label>
                    {rows.map((row) => (
                        <M.Item
                            key={row.id}
                            onSelect={() => onChange(row.id)}
                            className={cn(
                                "group/item flex cursor-default items-start gap-1.5 rounded-xl px-2 py-[5px] outline-none select-none data-[highlighted]:bg-hover",
                                row.warning ? "text-warning" : "text-text",
                            )}
                        >
                            <RowBody row={row} checked={row.id === value} mobile={false} />
                        </M.Item>
                    ))}
                </M.Content>
            </M.Portal>
        </M.Root>
    );
}
