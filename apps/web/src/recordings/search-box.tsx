/**
 * The search box at the top of the page.
 *
 * What is typed is local and goes to the address after a short pause (`onSettle`), so a search is not made per keystroke and the
 * address, which is where the query lives, can be shared and survives a reload. `/` from anywhere on the page puts the cursor here
 * (unless one is already in a field); Escape empties it, and Escape on an empty box leaves it. A query that arrives from outside
 * (a link, the back button) replaces what is shown, but never what the person is in the middle of typing.
 */

import { MagnifyingGlass, X } from "@pikvm/icons";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export const SETTLE_MS = 250;

/** True when a key press is going to a place that takes text, so a shortcut must not steal it. */
export function typingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

export interface SearchBoxHandle {
    focus(): void;
}

interface SearchBoxProps {
    /** The query in the address. */
    readonly value: string;
    readonly label: string;
    readonly placeholder: string;
    /** `/` focuses the box while this is true (the page is in front). */
    readonly shortcut: boolean;
    readonly onSettle: (value: string) => void;
    /** Every change of what the box shows, as it happens (the address only follows after the pause): for a page that reacts as the person types. */
    readonly onInput?: (value: string) => void;
    /** Enter was pressed (after the text was settled); with Shift for "the other way". */
    readonly onSubmit?: (backwards: boolean) => void;
    readonly id?: string;
}

export const SearchBox = forwardRef<SearchBoxHandle, SearchBoxProps>(function SearchBox({ value, label, placeholder, shortcut, onSettle, onInput, onSubmit, id }, ref) {
    const input = useRef<HTMLInputElement>(null);
    const [text, setText] = useState(value);
    const sent = useRef(value);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const settle = useRef(onSettle);
    settle.current = onSettle;
    const onInputRef = useRef(onInput);
    onInputRef.current = onInput;

    useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

    useEffect(() => {
        if (value !== sent.current) {
            sent.current = value;
            setText(value);
            onInputRef.current?.(value);
        }
    }, [value]);

    useEffect(() => () => clearTimeout(timer.current), []);

    const send = (next: string): void => {
        clearTimeout(timer.current);
        if (next === sent.current) return;
        sent.current = next;
        settle.current(next);
    };

    const change = (next: string): void => {
        setText(next);
        onInputRef.current?.(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => send(next), SETTLE_MS);
    };

    useEffect(() => {
        if (!shortcut) return;
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || typingTarget(event.target)) return;
            // Not while a dialog or a menu has the keys.
            if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
            event.preventDefault();
            input.current?.focus();
            input.current?.select();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [shortcut]);

    return (
        <div className="rl-search" data-filled={text !== "" || undefined}>
            <MagnifyingGlass aria-hidden="true" />
            <input
                ref={input}
                id={id}
                type="text"
                role="searchbox"
                className="rl-search-input"
                value={text}
                placeholder={placeholder}
                aria-label={label}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="search"
                onChange={(event) => change(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        send(text);
                        onSubmit?.(event.shiftKey);
                    } else if (event.key === "Escape") {
                        if (text !== "") {
                            event.preventDefault();
                            setText("");
                            onInputRef.current?.("");
                            send("");
                        } else input.current?.blur();
                    }
                }}
            />
            {text !== "" ? (
                <button
                    type="button"
                    className="rl-search-clear"
                    aria-label="Clear search"
                    onClick={() => {
                        setText("");
                        onInputRef.current?.("");
                        send("");
                        input.current?.focus();
                    }}
                >
                    <X aria-hidden="true" />
                </button>
            ) : (
                <kbd className="rl-kbd" aria-hidden="true">
                    /
                </kbd>
            )}
        </div>
    );
});
