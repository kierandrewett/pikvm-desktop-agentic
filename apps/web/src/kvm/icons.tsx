/**
 * The glyphs the KVM screen draws, the console's own (Lucide geometry, MIT) so the dock and the
 * toolbar look the way they did. 24px grid, 2px strokes in currentColor.
 */

import { macroGlyph } from "@pikvm/kvm-engine";
import type { ReactNode, SVGProps } from "react";

function Glyph({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            {...props}
        >
            {children}
        </svg>
    );
}

type IconProps = SVGProps<SVGSVGElement>;

export const SpeakerIcon = (p: IconProps) => (
    <Glyph {...p}>
        <path d="M11 5 6 9H2v6h4l5 4V5z" />
        <path className="wave" d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
    </Glyph>
);

export const MicIcon = (p: IconProps) => (
    <Glyph {...p}>
        <rect x="9" y="2" width="6" height="11" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0M12 17v4" />
    </Glyph>
);

export const ZoomOutIcon = (p: IconProps) => (
    <Glyph {...p}>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5M8 11h6" />
    </Glyph>
);

export const PasteIcon = (p: IconProps) => (
    <Glyph {...p}>
        <rect x="8" y="2" width="8" height="4" rx="1" />
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </Glyph>
);

export const KeyboardIcon = (p: IconProps) => (
    <Glyph {...p}>
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12" />
    </Glyph>
);

export const MoreIcon = (p: IconProps) => (
    <Glyph strokeWidth={2.5} {...p}>
        <circle cx="5" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
    </Glyph>
);

export const ChevronDownIcon = (p: IconProps) => (
    <Glyph {...p}>
        <path d="m6 9 6 6 6-6" />
    </Glyph>
);

export const PowerIcon = (p: IconProps) => (
    <Glyph {...p}>
        <path d="M12 2v10" />
        <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
    </Glyph>
);

export const FullscreenIcon = (p: IconProps) => (
    <Glyph {...p}>
        <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
    </Glyph>
);

/** The macro icons the editor offers, by name. */
const MACRO_ICONS: Readonly<Record<string, readonly string[]>> = {
    camera: [
        "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z",
        "M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    ],
    monitor: ["M3 4h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M8 21h8M12 17v4"],
    terminal: ["m4 17 6-6-6-6", "M12 19h8"],
    power: ["M12 2v10", "M18.4 6.6a9 9 0 1 1-12.8 0"],
    lock: ["M4 11h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z", "M7 11V7a5 5 0 0 1 10 0v4"],
    refresh: [
        "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
        "M21 3v5h-5",
        "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
        "M8 16H3v5",
    ],
    folder: [
        "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z",
    ],
    search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "m21 21-4.3-4.3"],
    clipboard: ["M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2", "M9 2h6a1 1 0 0 1 1 1v3H8V3a1 1 0 0 1 1-1z"],
    play: ["m6 3 14 9-14 9V3z"],
    save: [
        "M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
        "M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7",
        "M7 3v4a1 1 0 0 0 1 1h7",
    ],
    keyboard: ["M2 6h20a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z", "M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"],
    download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"],
    upload: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m17 8-5-5-5 5", "M12 3v12"],
    star: ["M11.5 2.8a.6.6 0 0 1 1 0l2.4 5 5.4.8a.6.6 0 0 1 .3 1l-3.9 3.8.9 5.4a.6.6 0 0 1-.9.6L12 16.9l-4.8 2.5a.6.6 0 0 1-.9-.6l.9-5.4L3.3 9.6a.6.6 0 0 1 .3-1l5.4-.8z"],
    bell: ["M10.3 21a1.94 1.94 0 0 0 3.4 0", "M21 19H3l1.6-2.4A6 6 0 0 0 6 13V9a6 6 0 0 1 12 0v4a6 6 0 0 0 1.4 3.6z"],
    copy: ["M10 9h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
    zap: ["M4 14a1 1 0 0 1-.8-1.6l9.4-11a1 1 0 0 1 1.7.9L13 10h6a1 1 0 0 1 .8 1.6l-9.4 11a1 1 0 0 1-1.7-.9L11 14z"],
    maximize: ["M8 3H5a2 2 0 0 0-2 2v3", "M21 8V5a2 2 0 0 0-2-2h-3", "M3 16v3a2 2 0 0 0 2 2h3", "M16 21h3a2 2 0 0 0 2-2v-3"],
    command: ["M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"],
    trash: ["M3 6h18", "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2", "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"],
    settings: [
        "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
        "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
    ],
};

/**
 * A macro's icon: the named drawing, or its glyph (a literal one or two characters written
 * before the picker existed) or the label's initials when the name did not resolve.
 */
/** The names the macro editor offers, in order. */
export const MACRO_ICON_NAMES: readonly string[] = Object.keys(MACRO_ICONS);

export function MacroIcon({ macro }: { macro: { readonly icon?: string; readonly label: string } }) {
    const paths = macro.icon ? MACRO_ICONS[macro.icon] : undefined;
    if (!paths) return <span aria-hidden="true">{macroGlyph(macro)}</span>;
    return (
        <Glyph>
            {paths.map((d) => (
                <path key={d} d={d} />
            ))}
        </Glyph>
    );
}
