/**
 * A toolbar button that opens a small menu under it. Closes on a pick, an outside press and
 * Escape, one layer at a time, and hands focus back to its button when it closes with focus inside.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useKvmActive } from "./active";

export type MenuEntry =
    | { readonly type: "separator" }
    | {
          readonly type?: "item";
          readonly id: string;
          readonly label: string;
          readonly disabled?: boolean;
          readonly checked?: boolean;
          readonly run: () => void;
      };

export interface MenuButtonProps {
    readonly label: string;
    readonly icon: ReactNode;
    readonly entries: readonly MenuEntry[];
    readonly className?: string;
    readonly disabled?: boolean;
    readonly testId?: string;
}

export function MenuButton({ label, icon, entries, className, disabled, testId }: MenuButtonProps) {
    const [open, setOpen] = useState(false);
    const button = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    const id = useId();
    // An Escape or a press on another tab is not for this menu, though it stays open for the return.
    const active = useKvmActive();

    const close = (restoreFocus: boolean): void => {
        if (restoreFocus && menu.current?.contains(document.activeElement)) button.current?.focus();
        setOpen(false);
    };

    useEffect(() => {
        if (!open || !active) return;
        const onDown = (e: PointerEvent): void => {
            const target = e.target;
            if (!(target instanceof Node)) return;
            if (menu.current?.contains(target) || button.current?.contains(target)) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            close(true);
        };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("pointerdown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open, active]);

    return (
        <span className="kvm-menu-host">
            <button
                ref={button}
                type="button"
                className={className ?? "kvm-tb-btn"}
                title={label}
                aria-label={label}
                aria-haspopup="true"
                aria-expanded={open}
                aria-controls={open ? id : undefined}
                disabled={disabled}
                data-testid={testId}
                onClick={() => setOpen(!open)}
            >
                {icon}
            </button>
            {open ? (
                <div ref={menu} id={id} className="kvm-menu" role="group" aria-label={label}>
                    {entries.map((entry, i) =>
                        entry.type === "separator" ? (
                            <div key={`sep-${i}`} className="kvm-sep" />
                        ) : (
                            <button
                                key={entry.id}
                                type="button"
                                className="kvm-item"
                                disabled={entry.disabled}
                                aria-pressed={entry.checked}
                                onClick={() => {
                                    close(false);
                                    entry.run();
                                }}
                            >
                                {entry.label}
                            </button>
                        ),
                    )}
                </div>
            ) : null}
        </span>
    );
}
