import type { SVGProps } from "react";

/** A key, drawn like the shared glyphs: 24px grid, 1.75px strokes in currentColor. */
export function KeyIcon(props: SVGProps<SVGSVGElement>) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            {...props}
        >
            <circle cx="8" cy="15" r="4" />
            <path d="m11 12 8-8M16 7l3 3M14 9l2 2" />
        </svg>
    );
}
