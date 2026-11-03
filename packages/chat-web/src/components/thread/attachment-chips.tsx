/**
 * Attachments above a user bubble: images as thumbnails, other files as chips.
 *
 * Interactive threads: a file chip is a button that opens the file in the side panel (the `upload` view,
 * served by the uploads API), because it belongs to this conversation. An image opens in the image
 * lightbox, the same viewer as images in replies, with previous and next across the message's images.
 * Previews (thread miniatures, hover cards) render the same shapes without any control.
 */
import { useT } from "../../l10n/provider";
import { translate } from "../../l10n/runtime";
import type { InputFile, InputImage } from "@pikvm/chat-protocol";
import { useState, type MouseEvent } from "react";
import { cn } from "../../lib/cn";
import { captureSessionEpoch, isSessionEpochCurrent } from "../../lib/queries";
import { FileTypeIcon } from "../file-icons/file-type-icon";

const thumbCls = "block overflow-hidden rounded-[calc(18px*var(--roundness))]";
const chipCls =
    "flex h-10 items-center gap-2 rounded-[calc(18px*var(--roundness))] border border-default px-3 text-[14px] text-text";

function openImages(e: MouseEvent<HTMLElement>, images: InputImage[], index: number, sessionEpoch: number): void {
    const trigger = e.currentTarget;
    const list = images.map((img) => ({ src: img.image_url, alt: translate("thread-attach-image") }));
    void import("./markdown/lightbox")
        .then((m) => {
            if (!isSessionEpochCurrent(sessionEpoch) || !trigger.isConnected) return;
            m.showLightbox(list, index, trigger, sessionEpoch);
        })
        .catch((error: unknown) => {
            if (isSessionEpochCurrent(sessionEpoch)) console.error("[thread] Lightbox could not load", error);
        });
}

export function AttachmentChips({
    images,
    files,
    interactive,
}: {
    images: InputImage[];
    files: InputFile[];
    /** False in previews: nothing is clickable or focusable. */
    interactive: boolean;
}) {
    const t = useT();
    const [sessionEpoch] = useState(captureSessionEpoch);
    if (!images.length && !files.length) return null;
    return (
        <div className="flex max-w-[70%] flex-wrap justify-end gap-2">
            {images.map((img, i) => {
                const thumb = (
                    <img
                        src={img.image_url}
                        alt={t("thread-attach-image")}
                        loading="lazy"
                        decoding="async"
                        className="block max-h-60 max-w-full object-cover"
                    />
                );
                return interactive ? (
                    <button
                        key={i}
                        type="button"
                        aria-label={t("thread-attach-open-image")}
                        className={cn(thumbCls, "cursor-zoom-in")}
                        onClick={(e) => openImages(e, images, i, sessionEpoch)}
                    >
                        {thumb}
                    </button>
                ) : (
                    <div key={i} className={thumbCls}>
                        {thumb}
                    </div>
                );
            })}
            {files.map((f, i) => {
                const body = (
                    <>
                        <FileTypeIcon name={f.filename} size={16} className="shrink-0" />
                        <span className="max-w-60 truncate">{f.filename}</span>
                    </>
                );
                return (
                    <div key={i} className={chipCls}>
                        {body}
                    </div>
                );
            })}
        </div>
    );
}
