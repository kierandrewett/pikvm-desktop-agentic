/**
 * The one avatar used everywhere a person shows (sidebar account button and menu, settings profile card and account
 * page, thread avatars, admin user list).
 *
 * With a picture (`image`, from the bootstrap user or null) it draws the picture. Without one, or when the picture
 * fails to load, it draws a monogram: white initials on a two-stop gradient whose hue comes from a hash of the name
 * (the email when there is no name). The same name always gets the same colours, different names usually get
 * different ones, and the accent colour is never used. The gradient formula is `.avatar-monogram` in
 * styles/tokens.css; this file only sets `--avatar-hue`.
 */
import { useState, type CSSProperties } from "react";
import { cn } from "../../lib/cn";

export function initials(name: string, email: string): string {
    const parts = (name || email.split("@")[0] || "?").trim().split(/\s+/);
    const first = parts[0]?.[0] ?? "?";
    const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
    return (first + last).toUpperCase();
}

/** Hue (0-359) for a person: FNV-1a over the trimmed, lower-case name, or the email when the name is empty. */
export function avatarHue(name: string, email: string): number {
    const text = (name.trim() || email.trim()).toLowerCase();
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) % 360;
}

export interface AvatarProps {
    name: string;
    email: string;
    /** Picture URL, or null for the monogram. */
    image: string | null;
    /** Edge in CSS pixels. */
    size?: number;
    className?: string;
}

export function Avatar({ name, email, image, size = 28, className }: AvatarProps) {
    // The URL that failed, so a new picture gets a fresh try.
    const [failed, setFailed] = useState<string | null>(null);
    const box = { width: size, height: size };
    if (image && failed !== image) {
        return (
            <img
                src={image}
                alt=""
                width={size}
                height={size}
                draggable={false}
                onError={() => setFailed(image)}
                style={box}
                data-avatar="image"
                className={cn("shrink-0 rounded-full object-cover", className)}
            />
        );
    }
    const style = {
        ...box,
        fontSize: Math.max(8, Math.round(size * 0.4)),
        "--avatar-hue": avatarHue(name, email),
    } as CSSProperties;
    return (
        <span
            aria-hidden
            data-avatar="monogram"
            style={style}
            className={cn(
                "avatar-monogram flex shrink-0 items-center justify-center rounded-full leading-none font-semibold tracking-[0.01em] select-none",
                className,
            )}
        >
            {initials(name, email)}
        </span>
    );
}
