/**
 * Model picker (T3 Code replica, docs/spec/model-picker-spec.md). Desktop: a popover above the trigger.
 * Mobile: a bottom sheet. Mod+Shift+M toggles it from anywhere on the page that hosts a composer.
 */
import type { ModelInfo } from "@pikvm/chat-protocol";
import { CaretDown } from "@pikvm/icons";
import { Popover } from "radix-ui";
import {
    forwardRef,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ButtonHTMLAttributes,
    type RefObject,
} from "react";
import { useT } from "../../l10n/provider";
import { cn } from "../../lib/cn";
import { isMac, useIsMobile } from "../../lib/media";
import { touchTarget } from "../../lib/touch";
import { Sheet } from "../ui/sheet";
import { TailedContent } from "../ui/tailed-content";
import { Tooltip } from "../ui/tooltip";
import { animateEnter, reducedMotion } from "./motion";
import { PickerContent } from "./picker-content";
import { identityOf, recordRecent } from "./models";
import { ModelMark } from "./provider-logo";
import { useThemeLayer } from "../../lib/theme-scope";

export interface ModelPickerProps {
    models: ModelInfo[] | undefined;
    /** Selected model id (`provider/model`). */
    value: string | undefined;
    onChange: (id: string) => void;
    /** Return focus to the composer editor after the picker closes. */
    onRestoreFocus?: () => void;
    disabled?: boolean;
    /** Controlled open state (optional), so commands such as /model can open the picker. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Search text to start with when the picker opens. */
    initialQuery?: string;
    /**
     * The block the picker must not cover (the composer and its tray). The popup opens above it, or below it
     * when there is more room, left-aligned with the trigger.
     */
    avoidRef?: RefObject<HTMLElement | null>;
}

/** Tray button (ui-spec 2 tray buttons): 28px pill, 16px tertiary icon, 13px ink label, instant hover. */
const Trigger = forwardRef<
    HTMLButtonElement,
    ButtonHTMLAttributes<HTMLButtonElement> & { model: ModelInfo | undefined; label: string; mobile: boolean }
>(function Trigger({ model, label, mobile, className, ...rest }, ref) {
    return (
        <button
            ref={ref}
            type="button"
            data-balloon-anchor="model"
            aria-label={model ? identityOf(model).label : undefined}
            className={cn(
                "relative inline-flex max-w-56 min-w-0 shrink items-center gap-1.5 rounded-full border border-transparent px-2 text-sm leading-[18px] text-text outline-none select-none",
                "hover-device:hover:bg-hover data-[state=open]:bg-hover",
                "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40",
                mobile ? "h-10" : "h-7",
                touchTarget,
                className,
            )}
            {...rest}
        >
            <span className="flex size-4 shrink-0 items-center justify-center text-tertiary">
                {model ? <ModelMark model={model} size={16} /> : null}
            </span>
            <span className="min-w-0 flex-1 truncate text-start">{label}</span>
            <CaretDown aria-hidden className="size-4 shrink-0 text-tertiary" />
        </button>
    );
});

export function ModelPicker({
    models,
    value,
    onChange,
    onRestoreFocus,
    disabled,
    open: controlled,
    onOpenChange,
    initialQuery,
    avoidRef,
}: ModelPickerProps) {
    const layer = useThemeLayer();
    const t = useT();
    const mobile = useIsMobile();
    const [inner, setInner] = useState(false);
    const open = controlled ?? inner;
    const openRef = useRef(open);
    openRef.current = open;
    const setOpen = useCallback(
        (next: boolean | ((o: boolean) => boolean)) => {
            const v = typeof next === "function" ? next(openRef.current) : next;
            openRef.current = v;
            setInner(v);
            onOpenChange?.(v);
        },
        [onOpenChange],
    );
    const model = models?.find((m) => m.id === value);
    const label =
        model?.name ??
        value ??
        (models ? (models.length ? t("models-picker-select") : t("models-picker-add")) : t("models-picker-loading"));
    const ready = !!models?.length && !disabled;
    // A loaded, empty catalogue stays clickable: the picker shows the "Add a provider" state.
    const clickable = !!models && !disabled;

    useEffect(() => {
        if (!ready) return;
        const onKey = (e: KeyboardEvent) => {
            const mod = isMac ? e.metaKey : e.ctrlKey;
            if (mod && e.shiftKey && !e.altKey && e.code === "KeyM") {
                e.preventDefault();
                setOpen((o) => !o);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [ready, setOpen]);

    const select = useCallback(
        (id: string) => {
            recordRecent(id);
            onChange(id);
            setOpen(false);
        },
        [onChange, setOpen],
    );
    const close = useCallback(() => setOpen(false), [setOpen]);

    // Anchor: an invisible box at the trigger's x that spans the avoided block (the composer and its tray), so
    // the popup opens beside the composer instead of over it, on the side with more room.
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [anchorBox, setAnchorBox] = useState<{ left: number; top: number; width: number; height: number } | null>(
        null,
    );
    const [side, setSide] = useState<"top" | "bottom">("top");
    useLayoutEffect(() => {
        if (!open) return;
        const t = triggerRef.current?.getBoundingClientRect();
        const block = avoidRef?.current;
        if (!t || !block) return;
        const a = block.getBoundingClientRect();
        setAnchorBox({ left: t.left - a.left, top: 0, width: t.width, height: a.height });
        setSide(innerHeight - a.bottom > a.top ? "bottom" : "top");
    }, [open, avoidRef]);

    // Keep the popover mounted while it fades out (reference menus: 150ms), then unmount.
    const [mounted, setMounted] = useState(open);
    const content = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
        if (open) {
            setMounted(true);
            return;
        }
        const el = content.current;
        if (!el || reducedMotion()) {
            setMounted(false);
            return;
        }
        const anim = el.animate(
            [
                { opacity: 1, transform: "scale(1)" },
                { opacity: 0, transform: "scale(0.98)" },
            ],
            { duration: 150, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" },
        );
        anim.onfinish = () => {
            if (!openRef.current) setMounted(false);
        };
        return () => anim.cancel();
    }, [open]);

    if (mobile) {
        return (
            <>
                <Trigger
                    model={model}
                    label={label}
                    mobile
                    disabled={!clickable}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-label={t("models-picker-trigger-label", { label })}
                    data-state={open ? "open" : "closed"}
                    onClick={() => setOpen(true)}
                />
                <Sheet open={open} onOpenChange={setOpen} title={t("models-picker-sheet-title")}>
                    {models && (
                        <PickerContent
                            models={models}
                            value={value}
                            onSelect={select}
                            onClose={close}
                            mobile
                            initialQuery={initialQuery}
                        />
                    )}
                </Sheet>
            </>
        );
    }

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Tooltip label={label} shortcut="Mod+Shift+M">
                <Popover.Trigger asChild>
                    <Trigger
                        ref={triggerRef}
                        model={model}
                        label={label}
                        mobile={false}
                        disabled={!clickable}
                        aria-label={t("models-picker-trigger-label", { label })}
                    />
                </Popover.Trigger>
            </Tooltip>
            {anchorBox && (
                <Popover.Anchor aria-hidden className="pointer-events-none invisible absolute" style={anchorBox} />
            )}
            {(open || mounted) && (
                <Popover.Portal forceMount container={layer}>
                    <Popover.Content
                        forceMount
                        ref={(el) => {
                            content.current = el;
                            if (el && !el.dataset.entered) {
                                el.dataset.entered = "1";
                                animateEnter(el);
                            }
                        }}
                        side={side}
                        align="start"
                        sideOffset={2}
                        collisionPadding={8}
                        data-model-picker-surface
                        // Fixed size: the popup never resizes or moves while the rail tab, the query or the list
                        // length changes. Only the available space can make it shorter.
                        style={{ height: "min(452px, var(--radix-popover-content-available-height))" }}
                        aria-label={t("models-picker-select")}
                        onOpenAutoFocus={(e) => e.preventDefault()}
                        onCloseAutoFocus={(e) => {
                            e.preventDefault();
                            onRestoreFocus?.();
                        }}
                        asChild
                    >
                        {/* Opaque on purpose (no backdrop blur). The anchor spans the composer at the trigger's x,
                            so the tail points at the composer edge above (or below) the trigger, 2px away. */}
                        <TailedContent
                            arrow={Popover.Arrow}
                            className={cn("max-w-[calc(100vw-16px)]", !open && "pointer-events-none")}
                            bodyClassName="flex"
                        >
                            {models && (
                                <PickerContent
                                    models={models}
                                    value={value}
                                    onSelect={select}
                                    onClose={close}
                                    mobile={false}
                                    initialQuery={initialQuery}
                                />
                            )}
                        </TailedContent>
                    </Popover.Content>
                </Popover.Portal>
            )}
        </Popover.Root>
    );
}
