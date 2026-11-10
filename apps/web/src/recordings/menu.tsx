/**
 * A button that opens a menu: the row's three dots, the sort, the download choices.
 *
 * The menu is drawn in a layer of its own at the end of <body>, placed from the button's box, so a table that scrolls or clips
 * cannot cut it off, and it opens upwards when there is no room below. Keyboard: Enter, Space or the Down arrow opens it on the
 * first item (Up on the last); Up, Down, Home and End move; Enter or Space picks; Escape closes and puts focus back on the button;
 * Tab closes it. A press outside, a scroll and a resize close it too. Items are `menuitem`s, or `menuitemradio`s when one carries
 * `checked` (a choice of one), and a disabled item is skipped by the arrows but still read out.
 */

import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
    | { readonly type: "separator" }
    | {
          readonly type?: "item";
          readonly id: string;
          readonly label: string;
          readonly icon?: ReactNode;
          readonly danger?: boolean;
          /** Present when the item is one of a set of choices: true for the one in force. */
          readonly checked?: boolean;
          readonly disabled?: boolean;
          /** Why it is disabled, shown as the item's tooltip. */
          readonly why?: string;
          readonly run: () => void;
      };

export interface MenuButtonProps {
    /** The button's accessible name. */
    readonly label: string;
    readonly items: ReadonlyArray<MenuItem>;
    /** What the button shows. */
    readonly children: ReactNode;
    readonly className?: string;
    readonly align?: "start" | "end";
    readonly disabled?: boolean;
    readonly testId?: string;
}

const GAP = 6;
const MARGIN = 8;

interface Placement {
    readonly left: number;
    readonly top: number;
    readonly maxHeight: number;
    readonly minWidth: number;
}

function place(button: HTMLElement, menu: HTMLElement, align: "start" | "end"): Placement {
    const box = button.getBoundingClientRect();
    const { innerWidth, innerHeight } = window;
    const width = menu.offsetWidth;
    const height = menu.scrollHeight;
    const below = innerHeight - box.bottom - GAP - MARGIN;
    const above = box.top - GAP - MARGIN;
    const up = height > below && above > below;
    const room = up ? above : below;
    const left = align === "end" ? box.right - width : box.left;
    return {
        left: Math.min(Math.max(MARGIN, left), Math.max(MARGIN, innerWidth - width - MARGIN)),
        top: up ? box.top - GAP - Math.min(height, room) : box.bottom + GAP,
        maxHeight: Math.max(120, room),
        minWidth: Math.max(box.width, 180),
    };
}

export function MenuButton({ label, items, children, className, align = "start", disabled, testId }: MenuButtonProps) {
    const [open, setOpen] = useState(false);
    const [placement, setPlacement] = useState<Placement | null>(null);
    const button = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    const firstFocus = useRef<"first" | "last">("first");
    const id = useId();

    const close = useCallback((restoreFocus: boolean): void => {
        setOpen(false);
        setPlacement(null);
        if (restoreFocus) button.current?.focus();
    }, []);

    const enabled = (): HTMLElement[] => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []);

    useLayoutEffect(() => {
        if (!open || !button.current || !menu.current) return;
        setPlacement(place(button.current, menu.current, align));
    }, [open, align, items.length]);

    useEffect(() => {
        if (!open || placement === null) return;
        const targets = enabled();
        const checked = targets.find((el) => el.getAttribute("aria-checked") === "true");
        (firstFocus.current === "last" ? targets[targets.length - 1] : (checked ?? targets[0]))?.focus({ preventScroll: true });
        // Placed once: the focus moves in when the menu has its position.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, placement === null]);

    useEffect(() => {
        if (!open) return;
        const away = (event: PointerEvent): void => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (menu.current?.contains(target) || button.current?.contains(target)) return;
            close(false);
        };
        const leave = (event: Event): void => {
            // The menu's own list scrolling is not the page moving from under it.
            if (event.target instanceof Node && menu.current?.contains(event.target)) return;
            close(false);
        };
        document.addEventListener("pointerdown", away, true);
        window.addEventListener("scroll", leave, true);
        window.addEventListener("resize", leave);
        return () => {
            document.removeEventListener("pointerdown", away, true);
            window.removeEventListener("scroll", leave, true);
            window.removeEventListener("resize", leave);
        };
    }, [open, close]);

    const openWith = (which: "first" | "last"): void => {
        firstFocus.current = which;
        setOpen(true);
    };

    const onButtonKey = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openWith(event.key === "ArrowUp" ? "last" : "first");
        }
    };

    const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
        const targets = enabled();
        const at = targets.findIndex((el) => el === document.activeElement);
        let next = -1;
        switch (event.key) {
            case "ArrowDown":
                next = at < 0 ? 0 : (at + 1) % targets.length;
                break;
            case "ArrowUp":
                next = at < 0 ? targets.length - 1 : (at - 1 + targets.length) % targets.length;
                break;
            case "Home":
                next = 0;
                break;
            case "End":
                next = targets.length - 1;
                break;
            case "Escape":
                event.preventDefault();
                event.stopPropagation();
                close(true);
                return;
            case "Tab":
                close(false);
                return;
            default:
                return;
        }
        event.preventDefault();
        targets[next]?.focus({ preventScroll: true });
    };

    return (
        <>
            <button
                ref={button}
                type="button"
                className={className ?? "rl-btn"}
                aria-label={label}
                title={label}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? id : undefined}
                disabled={disabled}
                data-testid={testId}
                onClick={() => (open ? close(false) : openWith("first"))}
                onKeyDown={onButtonKey}
            >
                {children}
            </button>
            {open
                ? createPortal(
                      <div
                          ref={menu}
                          id={id}
                          className="rl-menu"
                          role="menu"
                          aria-label={label}
                          onKeyDown={onMenuKey}
                          style={
                              placement
                                  ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight, minWidth: placement.minWidth }
                                  : { left: 0, top: 0, visibility: "hidden" }
                          }
                      >
                          {items.map((item, i) =>
                              item.type === "separator" ? (
                                  <div key={`sep-${i}`} className="rl-menu-sep" role="separator" />
                              ) : (
                                  <button
                                      key={item.id}
                                      type="button"
                                      role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                                      aria-checked={item.checked}
                                      aria-disabled={item.disabled ? true : undefined}
                                      title={item.disabled ? item.why : undefined}
                                      className={`rl-menu-item${item.danger ? " is-danger" : ""}`}
                                      tabIndex={-1}
                                      data-testid={`menu-${item.id}`}
                                      onClick={() => {
                                          if (item.disabled) return;
                                          close(true);
                                          item.run();
                                      }}
                                  >
                                      {item.icon ? <span className="rl-menu-icon">{item.icon}</span> : null}
                                      <span className="rl-menu-label">{item.label}</span>
                                      {item.checked ? <span className="rl-menu-check" aria-hidden="true">{"\u2713"}</span> : null}
                                  </button>
                              ),
                          )}
                      </div>,
                      document.body,
                  )
                : null}
        </>
    );
}
