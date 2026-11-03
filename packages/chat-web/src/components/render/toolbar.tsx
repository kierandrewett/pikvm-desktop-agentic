/**
 * Renderer controls. A renderer declares its controls once inside <Toolbar>; the host's placement
 * (see types.ts ToolbarPlacement) decides where they appear:
 * - floating: a pill on the menu surface (blurred menu colour, dropdown shadow) centred at the bottom
 *   of the content. Content reserves room for it through `--rv-toolbar-space`.
 * - slot: a portal into the host's header, with the header's 36px pill buttons.
 * - none: nothing.
 * The building blocks (ToolButton, ToolSegmented, ZoomControl, PageControl, ToolMenu) only read the
 * placement through context, so a renderer never branches on where it is shown.
 */
import { CaretDown, DotsThree, Minus, Plus } from "@pikvm/icons";
import { createContext, useContext, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useLocale, useT } from "../../l10n/provider";
import { Button, type ButtonSize } from "../ui/button";
import { Menu, type MenuEntry } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import type { RenderKind, ToolbarPlacement } from "./types";

export interface RenderHost {
    placement: ToolbarPlacement;
    name: string;
    kind: RenderKind;
    downloadUrl: string;
    setStatus: (status: string | null) => void;
}

export const HostContext = createContext<RenderHost>({
    placement: "none",
    name: "",
    kind: "binary",
    downloadUrl: "",
    setStatus: () => {},
});

export const useHost = () => useContext(HostContext);

/** Publish a status line for the host while this renderer shows `status`. */
export function useStatus(status: string | null): void {
    const { setStatus } = useHost();
    useEffect(() => {
        setStatus(status);
    }, [status, setStatus]);
}

interface ToolLook {
    size: ButtonSize;
    menuSide: "top" | "bottom";
    floating: boolean;
}

const ToolContext = createContext<ToolLook>({ size: "lg", menuSide: "top", floating: true });

/**
 * Gives tool buttons outside a renderer the look of a header row (36px buttons, menus below), for example the
 * Wrap and Copy buttons in a chat code block's header.
 */
export function ToolScope({ children }: { children: ReactNode }) {
    return <ToolContext.Provider value={{ size: "xl", menuSide: "bottom", floating: false }}>{children}</ToolContext.Provider>;
}

/** Height the floating pill needs, so scrolled content can clear it. */
export const FLOATING_SPACE = "64px";

export function toolbarSpace(placement: ToolbarPlacement): string {
    return placement === "floating" ? FLOATING_SPACE : "0px";
}

export function Toolbar({ children, label: given }: { children: ReactNode; label?: string }) {
    const t = useT();
    const label = given ?? t("render-toolbar-files");
    const { placement } = useHost();
    if (placement === "none") return null;
    if (placement === "floating") {
        return (
            <ToolContext.Provider value={{ size: "lg", menuSide: "top", floating: true }}>
                <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
                    <div
                        role="toolbar"
                        aria-label={label}
                        data-rv-toolbar=""
                        className={cn(
                            "pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full p-1 no-scrollbar",
                            "bg-[color-mix(in_srgb,var(--menu)_90%,transparent)] shadow-dropdown backdrop-blur-sm",
                            "animate-[fade-in_var(--duration-basic)_var(--ease-enter)]",
                        )}
                    >
                        {children}
                    </div>
                </div>
            </ToolContext.Provider>
        );
    }
    if (!placement.slot) return null;
    return createPortal(
        <ToolContext.Provider value={{ size: "xl", menuSide: "bottom", floating: false }}>
            <div role="toolbar" aria-label={label} data-rv-toolbar="" className="flex min-w-0 items-center gap-0.5">
                {children}
            </div>
        </ToolContext.Provider>,
        placement.slot,
    );
}

export function ToolButton({
    label,
    shortcut,
    pressed,
    disabled,
    onClick,
    className,
    children,
}: {
    label: string;
    shortcut?: string;
    pressed?: boolean;
    disabled?: boolean;
    onClick: () => void;
    className?: string;
    children: ReactNode;
}) {
    const { size } = useContext(ToolContext);
    return (
        <Tooltip label={label} shortcut={shortcut}>
            <Button
                size={size}
                uniform
                pill
                aria-label={label}
                aria-pressed={pressed}
                disabled={disabled}
                onClick={onClick}
                className={cn("text-secondary", className)}
            >
                {children}
            </Button>
        </Tooltip>
    );
}

export function ToolDivider() {
    return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-default" />;
}

/** Two or three mutually exclusive views ("Preview" / "Source"). Arrow keys move the choice. */
export function ToolSegmented<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: T;
    options: { id: T; label: string }[];
    onChange: (v: T) => void;
}) {
    const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
        const i = options.findIndex((o) => o.id === value);
        const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = options[(i + step + options.length) % options.length]!;
        onChange(next.id);
        (e.currentTarget.querySelector(`[data-id="${next.id}"]`) as HTMLElement | null)?.focus();
    };
    return (
        <div
            role="radiogroup"
            aria-label={label}
            onKeyDown={onKey}
            className="flex h-8 shrink-0 items-center rounded-full bg-soft p-0.5"
        >
            {options.map((o) => (
                <button
                    key={o.id}
                    type="button"
                    role="radio"
                    data-id={o.id}
                    aria-checked={value === o.id}
                    tabIndex={value === o.id ? 0 : -1}
                    onClick={() => onChange(o.id)}
                    className={cn(
                        "h-7 rounded-full px-3 text-sm whitespace-nowrap outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                        value === o.id
                            ? "bg-surface text-text shadow-card"
                            : "text-secondary hover-device:hover:text-text",
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

export function ToolMenu({ label, items, icon }: { label: string; items: MenuEntry[]; icon?: ReactNode }) {
    const { size, menuSide } = useContext(ToolContext);
    return (
        <Menu
            side={menuSide}
            align="end"
            title={label}
            items={items}
            trigger={
                <Button size={size} uniform pill aria-label={label} className="text-secondary">
                    {icon ?? <DotsThree />}
                </Button>
            }
        />
    );
}

/** Zoom out, the current zoom (a menu of presets), zoom in. */
export function ZoomControl({
    scale,
    label,
    onZoomIn,
    onZoomOut,
    presets,
    min = 0.1,
    max = 8,
}: {
    scale: number;
    /** Text on the zoom button; defaults to the percentage. */
    label?: string;
    onZoomIn: () => void;
    onZoomOut: () => void;
    presets: MenuEntry[];
    min?: number;
    max?: number;
}) {
    const t = useT();
    const { locale } = useLocale();
    const { size, menuSide } = useContext(ToolContext);
    const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(scale);
    return (
        <div className="flex shrink-0 items-center">
            <ToolButton
                label={t("render-zoom-out")}
                shortcut="Mod+-"
                disabled={scale <= min + 1e-6}
                onClick={onZoomOut}
            >
                <Minus />
            </ToolButton>
            <Menu
                side={menuSide}
                align="center"
                title={t("render-zoom")}
                items={presets}
                trigger={
                    <Button
                        size={size}
                        pill
                        aria-label={t("render-zoom-level", { percent })}
                        className="min-w-16 gap-0.5 px-2 text-sm text-text tabular-nums"
                    >
                        {label ?? percent}
                        <CaretDown className="text-tertiary [--icon:14px]" />
                    </Button>
                }
            />
            <ToolButton label={t("render-zoom-in")} shortcut="Mod+=" disabled={scale >= max - 1e-6} onClick={onZoomIn}>
                <Plus />
            </ToolButton>
        </div>
    );
}

/** "12 / 200": a page number field (Enter to jump) and the page count. */
export function PageControl({ page, count, onGo }: { page: number; count: number; onGo: (page: number) => void }) {
    const t = useT();
    const { locale } = useLocale();
    const [draft, setDraft] = useState<string | null>(null);
    const digits = String(count).length;
    const commit = () => {
        if (draft === null) return;
        const n = Number.parseInt(draft, 10);
        if (Number.isFinite(n)) onGo(Math.min(count, Math.max(1, n)));
        setDraft(null);
    };
    return (
        <label className="flex shrink-0 items-center gap-1.5 px-1.5 text-sm text-secondary tabular-nums">
            <span className="sr-only">{t("render-page")}</span>
            <input
                inputMode="numeric"
                aria-label={t("render-page-number", { count })}
                value={draft ?? String(page)}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setDraft(e.currentTarget.value.replace(/\D/g, ""))}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        commit();
                        e.currentTarget.blur();
                    } else if (e.key === "Escape") {
                        setDraft(null);
                        e.currentTarget.blur();
                    }
                }}
                style={{ width: `calc(${Math.max(2, digits)}ch + 16px)` }}
                className="h-7 rounded-md bg-soft px-1 text-center text-text tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span aria-hidden>/</span>
            <span>{new Intl.NumberFormat(locale).format(count)}</span>
        </label>
    );
}

export function useToolLook(): ToolLook {
    return useContext(ToolContext);
}
