/**
 * Inline images: lazy loaded, an aspect-ratio skeleton while loading, a failed state, and a click to open
 * the lightbox. A paragraph of only images renders as a figure (one) or a grid (several); see the
 * `data-images` paragraphs from `remarkChat`.
 *
 * Only http(s), `data:image/*` and same-origin URLs load; anything else is blocked by `safeImageUrl` and
 * shows the failed state. Remote images get no referrer.
 */
import { ImageBrokenIcon } from "@pikvm/icons";
import { memo, useState, type MouseEvent } from "react";
import { cn } from "../../../lib/cn";
import { captureSessionEpoch, isSessionEpochCurrent } from "../../../lib/queries";
import { registerSessionReset } from "../../../lib/session-reset";

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml);base64,[a-z0-9+/=\s]+$/i;

/** URL transform for `img` sources. Returns "" for anything that must not load. */
export function safeImageUrl(url: string): string {
    const u = url.trim();
    if (/^https?:\/\//i.test(u)) return u;
    if (DATA_IMAGE.test(u)) return u;
    if (u.startsWith("/") && !u.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(u)) return u;
    return "";
}

/** Natural aspect ratios of images seen this session, so a re-mounted image paints at its final size. */
const ratios = new Map<string, number>();
registerSessionReset("markdown-image-ratios", () => ratios.clear());

function openLightbox(e: MouseEvent<HTMLElement>, src: string, sessionEpoch: number): void {
    if (!isSessionEpochCurrent(sessionEpoch)) return;
    const root = e.currentTarget.closest(".md");
    const imgs = [...(root?.querySelectorAll<HTMLImageElement>("img[data-md-img]") ?? [])].filter(
        (i) => i.dataset.state === "loaded",
    );
    const list = imgs.map((i) => ({ src: i.currentSrc || i.src, alt: i.alt }));
    const index = Math.max(
        0,
        imgs.findIndex((i) => i.getAttribute("src") === src),
    );
    const trigger = e.currentTarget;
    void import("./lightbox")
        .then((m) => {
            if (!isSessionEpochCurrent(sessionEpoch) || !trigger.isConnected) return;
            m.showLightbox(list.length ? list : [{ src, alt: "" }], index, trigger, sessionEpoch);
        })
        .catch((error: unknown) => {
            if (isSessionEpochCurrent(sessionEpoch)) console.error("[markdown] Lightbox could not load", error);
        });
}

/**
 * One image. With `href` (a linked image) the image is a link to that page instead of a lightbox button,
 * so interactive elements never nest.
 */
export const MdImage = memo(function MdImage({
    src,
    alt,
    title,
    href,
}: {
    src?: string;
    alt?: string;
    title?: string;
    href?: string;
}) {
    const url = src ?? "";
    const [sessionEpoch] = useState(captureSessionEpoch);
    const [state, setState] = useState<"loading" | "loaded" | "failed">(() => (url ? "loading" : "failed"));
    const ratio = ratios.get(url);
    if (state === "failed") {
        return (
            <span
                className="md-img md-img-failed"
                role="img"
                aria-label={alt ? `Image failed to load: ${alt}` : "Image failed to load"}
            >
                <ImageBrokenIcon aria-hidden size={20} />
                <span className="truncate">{alt || "Image unavailable"}</span>
            </span>
        );
    }
    const img = (
        <img
            data-md-img=""
            data-state={state}
            src={url}
            alt={alt ?? ""}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={(e) => {
                if (!isSessionEpochCurrent(sessionEpoch)) return;
                const i = e.currentTarget;
                if (i.naturalWidth && i.naturalHeight) ratios.set(url, i.naturalWidth / i.naturalHeight);
                setState("loaded");
            }}
            onError={() => {
                if (isSessionEpochCurrent(sessionEpoch)) setState("failed");
            }}
        />
    );
    const cls = cn("md-img", state === "loading" && "md-img-loading");
    const style = ratio ? { aspectRatio: String(ratio) } : undefined;
    if (href) {
        return (
            <a className={cls} style={style} href={href} target="_blank" rel="noopener noreferrer" title={title}>
                {img}
            </a>
        );
    }
    return (
        <button
            type="button"
            className={cls}
            style={style}
            aria-label={alt ? `Open image: ${alt}` : "Open image"}
            title={title}
            aria-disabled={state !== "loaded" || undefined}
            onClick={(e) => state === "loaded" && openLightbox(e, url, sessionEpoch)}
        >
            {img}
        </button>
    );
});
