/**
 * Centred dialog on desktop, bottom sheet on mobile. `resizable` makes the desktop dialog resizable around its centre
 * (see dialog-resize.tsx) and the mobile sheet full screen.
 */
import { X } from "@pikvm/icons";
import { Dialog as D } from "radix-ui";
import type { ReactNode } from "react";
import { useIsMobile } from "../../lib/media";
import { useThemeLayer } from "../../lib/theme-scope";
import { Button } from "./button";
import { ResizableContent, type ResizeSpec } from "./dialog-resize";
import { Sheet } from "./sheet";

export function Dialog({
    open,
    onOpenChange,
    title,
    description,
    children,
    footer,
    width = 440,
    resizable,
}: {
    open: boolean;
    onOpenChange: (o: boolean) => void;
    title: string;
    description?: ReactNode;
    children?: ReactNode;
    footer?: ReactNode;
    width?: number;
    /** Opt in: drag handles and arrow keys resize the dialog; the size is remembered per `resizable.id`. */
    resizable?: ResizeSpec;
}) {
    const mobile = useIsMobile();
    const layer = useThemeLayer();
    const body = (
        <>
            {description && <div className="text-base text-secondary">{description}</div>}
            {children}
            {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
        </>
    );
    if (mobile) {
        return (
            <Sheet
                open={open}
                onOpenChange={onOpenChange}
                title={title}
                className={resizable ? "h-[var(--app-height,100dvh)] max-h-[var(--app-height,100dvh)] rounded-none pt-[var(--safe-top)]" : undefined}
            >
                <div className="px-3 pb-3">{body}</div>
            </Sheet>
        );
    }
    const header = (
        <div className="mb-3 flex shrink-0 items-start justify-between gap-4">
            <D.Title className="text-lg font-semibold">{title}</D.Title>
            <D.Close asChild>
                <Button uniform size="md" aria-label="Close" className="-me-2 -mt-1">
                    <X />
                </Button>
            </D.Close>
        </div>
    );
    return (
        <D.Root open={open} onOpenChange={onOpenChange}>
            <D.Portal container={layer}>
                <D.Overlay className="fixed inset-0 z-50 bg-scrim animate-[fade-in_150ms]" />
                {resizable ? (
                    <ResizableContent spec={resizable}>
                        {header}
                        <div className="flex min-h-0 flex-1 flex-col">{body}</div>
                    </ResizableContent>
                ) : (
                    <D.Content
                        aria-describedby={undefined}
                        style={{ width: `min(${width}px, 92vw)` }}
                        className="fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-default bg-control p-5 shadow-dialog animate-[pop-in_150ms_var(--ease-enter)] outline-none"
                    >
                        {header}
                        {body}
                    </D.Content>
                )}
            </D.Portal>
        </D.Root>
    );
}

export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmLabel,
    danger,
    onConfirm,
}: {
    open: boolean;
    onOpenChange: (o: boolean) => void;
    title: string;
    description: ReactNode;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
}) {
    return (
        <Dialog
            open={open}
            onOpenChange={onOpenChange}
            title={title}
            description={description}
            footer={
                <>
                    <Button size="2xl" variant="soft" pill onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        size="2xl"
                        variant={danger ? "danger" : "solid"}
                        pill
                        onClick={() => {
                            onConfirm();
                            onOpenChange(false);
                        }}
                    >
                        {confirmLabel}
                    </Button>
                </>
            }
        />
    );
}
