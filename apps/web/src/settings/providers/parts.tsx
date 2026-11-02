/** Small pieces the provider rows share: a write-only field, copy, open and confirm. */

import { type ReactNode, useEffect, useRef, useState } from "react";

const FIELD =
    "h-9 min-w-0 flex-1 rounded-[var(--radius-field)] border border-border bg-secondary px-3 text-sm " +
    "outline-none placeholder:text-muted-foreground focus-visible:border-primary " +
    "[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-base";

export const fieldClass = FIELD;

interface SecretFieldProps {
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
}

/**
 * A field that only ever takes a value. It has no `name` or `id` a form or password manager
 * could latch on to, starts empty, and the owner clears it after sending; nothing from the
 * server is ever put in it.
 */
export function SecretField({ label, value, onChange, placeholder, disabled }: SecretFieldProps) {
    return (
        <input
            type="password"
            className={FIELD}
            aria-label={label}
            placeholder={placeholder ?? ""}
            value={value}
            disabled={disabled ?? false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            onChange={(event) => onChange(event.target.value)}
        />
    );
}

/** Copy to the clipboard, with the old-fashioned route for hosts that refuse the async one. */
async function writeClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        try {
            return document.execCommand("copy");
        } catch {
            return false;
        } finally {
            area.remove();
        }
    }
}

export function CopyButton({ text, label }: { text: string; label: string }) {
    const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
    const timer = useRef<number | undefined>(undefined);
    useEffect(() => () => window.clearTimeout(timer.current), []);

    const copy = async () => {
        setState((await writeClipboard(text)) ? "copied" : "failed");
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setState("idle"), 1800);
    };

    return (
        <button type="button" className="btn" aria-label={label} onClick={() => void copy()}>
            {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
        </button>
    );
}

/** Only web links are offered as links; anything else a CLI prints stays plain text. */
export const isWebUrl = (value: string): boolean => /^https?:\/\//i.test(value);

export function OpenLink({ url, label }: { url: string; label: string }) {
    if (!isWebUrl(url)) return null;
    return (
        <a className="btn" href={url} target="_blank" rel="noopener noreferrer" aria-label={label}>
            Open
        </a>
    );
}

interface ConfirmBarProps {
    message: ReactNode;
    confirmLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
    busy?: boolean;
    danger?: boolean;
}

/** Asks before something that cannot be undone from this page. */
export function ConfirmBar({ message, confirmLabel, onConfirm, onCancel, busy, danger }: ConfirmBarProps) {
    return (
        <div role="group" aria-label="Confirm" className="mt-3 flex flex-col gap-2 rounded-[var(--radius-field)] bg-secondary p-3">
            <p className="row-hint m-0">{message}</p>
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    className={danger ? "btn" : "btn btn-primary"}
                    style={danger ? { color: "var(--danger)" } : undefined}
                    disabled={busy ?? false}
                    onClick={onConfirm}
                >
                    {confirmLabel}
                </button>
                <button type="button" className="btn" disabled={busy ?? false} onClick={onCancel}>
                    Cancel
                </button>
            </div>
        </div>
    );
}

export function formatWhen(iso: string | null): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** What to show for any failure: the harness's own words, never an error object. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "Something went wrong.");
