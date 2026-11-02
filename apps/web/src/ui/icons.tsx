/**
 * The few glyphs the shell and Settings need, drawn on a 24px grid as 1.75px strokes in
 * currentColor so they take the surrounding text colour like the console's titlebar icons.
 */

import type { ReactNode, SVGProps } from "react";

function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
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
            {children}
        </svg>
    );
}

type IconProps = SVGProps<SVGSVGElement>;

export const MonitorIcon = (p: IconProps) => (
    <Icon {...p}>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
    </Icon>
);

export const ChatIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" />
    </Icon>
);

export const SettingsIcon = (p: IconProps) => (
    <Icon {...p}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </Icon>
);

export const ChevronRightIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="m9 6 6 6-6 6" />
    </Icon>
);

export const ChevronLeftIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="m15 6-6 6 6 6" />
    </Icon>
);

export const LinkIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
        <path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" />
    </Icon>
);

export const KeyboardIcon = (p: IconProps) => (
    <Icon {...p}>
        <rect x="2.5" y="6" width="19" height="12" rx="2" />
        <path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7 14h10" />
    </Icon>
);

export const PointerIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="M6 3.5 18 11l-5.2 1.3L10.5 18z" />
    </Icon>
);

export const SunMoonIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </Icon>
);

export const SpeakerIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="M4 10v4h3.5L12 18V6L7.5 10z" />
        <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </Icon>
);

export const BoltIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />
    </Icon>
);

export const EyeIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
        <circle cx="12" cy="12" r="2.8" />
    </Icon>
);

export const UserIcon = (p: IconProps) => (
    <Icon {...p}>
        <circle cx="12" cy="8.5" r="3.5" />
        <path d="M5 20c.6-3.6 3.4-5.5 7-5.5s6.4 1.9 7 5.5" />
    </Icon>
);

export const InfoIcon = (p: IconProps) => (
    <Icon {...p}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
    </Icon>
);

export const PinIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="m15 4 5 5-3 1-3.5 3.5.5 4-1.5 1.5-3-3L5 20l-0.5-0.5L8 14.5l-3-3L6.5 10l4 .5L14 7z" />
    </Icon>
);

export const MinimiseIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="M6 12h12" />
    </Icon>
);

export const MaximiseIcon = (p: IconProps) => (
    <Icon {...p}>
        <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </Icon>
);

export const RestoreIcon = (p: IconProps) => (
    <Icon {...p}>
        <rect x="5.5" y="9" width="9.5" height="9.5" rx="1.5" />
        <path d="M9 9V6.5A1.5 1.5 0 0 1 10.5 5h8A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5H15" />
    </Icon>
);

export const CloseIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    </Icon>
);
