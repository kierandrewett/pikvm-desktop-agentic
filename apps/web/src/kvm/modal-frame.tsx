/**
 * The frame every KVM dialog sits in: a scrim, a labelled dialog, focus kept inside it, Escape
 * to close. Open dialogs also own the keyboard and the pointer (the screen reads that from the
 * dialog store), so nothing typed here reaches the target.
 */

import { useEffect, useId, useRef, type ReactNode } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalFrameProps {
    readonly title: string;
    readonly onClose: () => void;
    readonly children: ReactNode;
    /** The buttons, right-aligned under the content. */
    readonly actions?: ReactNode;
    readonly wide?: boolean;
}

export function ModalFrame({ title, onClose, children, actions, wide }: ModalFrameProps) {
    const titleId = useId();
    const dialog = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const previous = document.activeElement;
        const root = dialog.current;
        const first = root?.querySelector<HTMLElement>("[data-autofocus]") ?? root?.querySelector<HTMLElement>(FOCUSABLE);
        first?.focus();
        return () => {
            // Not the hidden keyboard field: handing focus back to it would raise the soft keyboard unasked.
            if (previous instanceof HTMLElement && !previous.classList.contains("kvm-kbd") && previous.isConnected) previous.focus();
        };
    }, []);

    const onKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
            return;
        }
        if (e.key !== "Tab") return;
        const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };

    return (
        <div
            className="kvm-scrim"
            data-kvm-ui=""
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                ref={dialog}
                className={`kvm-dialog${wide ? " wide" : ""}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                onKeyDown={onKeyDown}
            >
                <h2 className="kvm-dialog-title" id={titleId}>
                    {title}
                </h2>
                {children}
                {actions ? <div className="kvm-dialog-actions">{actions}</div> : null}
            </div>
        </div>
    );
}
