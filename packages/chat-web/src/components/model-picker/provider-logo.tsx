/**
 * Provider logo. models.dev logos are monochrome SVGs, so they are drawn as a CSS mask filled with
 * currentColor and follow the theme. A hidden <img> probes the URL; on error a lettermark replaces the mask.
 * Results are cached per URL so rows do not flicker when they re-mount.
 */
import type { ModelInfo } from "@pikvm/chat-protocol";
import { memo, useState } from "react";
import { cn } from "../../lib/cn";
import { serverUrl } from "../../lib/config";
import { identityOf } from "./models";
import "./provider-logo.css";

const failed = new Set<string>();

const Mark = memo(function Mark({
    src: given,
    name,
    size = 16,
    className,
}: {
    src: string | undefined;
    name: string;
    size?: number;
    className?: string;
}) {
    const src = given ? serverUrl(given) : undefined;
    const [broken, setBroken] = useState(() => !src || failed.has(src));
    const box = { width: size, height: size };
    if (broken || !src) {
        return (
            <span
                aria-hidden
                style={{ ...box, fontSize: Math.max(8, Math.round(size * 0.62)) }}
                className={cn(
                    "inline-flex shrink-0 select-none items-center justify-center rounded-[25%] bg-[color-mix(in_srgb,currentColor_18%,transparent)] font-semibold leading-none uppercase",
                    className,
                )}
            >
                {name.trim().charAt(0) || "?"}
            </span>
        );
    }
    return (
        <span aria-hidden style={box} className={cn("relative inline-block shrink-0", className)}>
            <span
                className="provider-logo-fill absolute inset-0 bg-current"
                style={{
                    maskImage: `url("${src}")`,
                    maskSize: "contain",
                    maskRepeat: "no-repeat",
                    maskPosition: "center",
                }}
            />
            <img
                src={src}
                alt=""
                hidden
                onError={() => {
                    failed.add(src);
                    setBroken(true);
                }}
            />
        </span>
    );
});

/** Badge box for a mark of the given size: about half, never below 10px so the logo stays readable. */
const badgeBox = (size: number) => Math.max(10, Math.round(size * 0.55));

/**
 * Logo with an optional corner badge. The badge sits on the bottom-end corner on a disc that follows the
 * radius tokens (round at the default roundness, square at 0). Both marks are decorative: callers give the
 * text equivalent (see `identityOf`).
 */
export const ProviderLogo = memo(function ProviderLogo({
    src,
    name,
    size = 16,
    className,
    badge,
}: {
    src: string | undefined;
    name: string;
    size?: number;
    className?: string;
    badge?: { src: string | undefined; name: string };
}) {
    if (!badge) return <Mark src={src} name={name} size={size} className={className} />;
    const box = badgeBox(size);
    return (
        <span aria-hidden style={{ width: size, height: size }} className="relative inline-block shrink-0">
            <Mark src={src} name={name} size={size} className={className} />
            <span
                data-provider-badge
                style={{ width: box, height: box }}
                className="provider-logo-badge absolute -end-[3px] -bottom-[3px] flex items-center justify-center rounded-sm bg-elevated text-secondary shadow-[0_0_0_1px_var(--border-strong)]"
            >
                <Mark src={badge.src} name={badge.name} size={box - 3} />
            </span>
        </span>
    );
});

/** The vendor mark with the provider as corner badge, from the model's identity. */
export function ModelMark({ model, size = 16, className }: { model: ModelInfo; size?: number; className?: string }) {
    const id = identityOf(model);
    return (
        <ProviderLogo
            src={id.vendor.logo}
            name={id.vendor.name}
            size={size}
            className={className}
            badge={id.badge ? { src: id.provider.logo, name: id.provider.name } : undefined}
        />
    );
}
