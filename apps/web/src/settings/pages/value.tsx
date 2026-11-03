import type { ReactNode } from "react";

/** A row's value on its right edge, as iOS and Chat's settings draw it: secondary ink, selectable. */
export function Value({ children }: { children: ReactNode }) {
    return <span className="max-w-full min-w-0 text-base break-words text-secondary select-text">{children}</span>;
}

const TONE = {
    ok: "bg-success",
    warn: "bg-warning",
    danger: "bg-danger",
    idle: "bg-tertiary",
} as const;

/** A small coloured dot before a status word. The word carries the meaning; the dot is only colour. */
export function StatusDot({ tone }: { tone: keyof typeof TONE }) {
    return <span aria-hidden="true" className={`me-2 inline-block size-2 rounded-full align-middle ${TONE[tone]}`} />;
}
