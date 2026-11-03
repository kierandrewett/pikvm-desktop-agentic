/**
 * Image lightbox, loaded on the first image click. A modal dialog (focus trapped, Escape closes, focus
 * returns to the image that opened it) with the image fitted to the viewport, previous and next with the
 * arrow keys or buttons, a "2 / 5" counter, the alt text as a caption and a link to the original.
 *
 * It mounts its own React root on demand so no host component is needed in the thread tree; theme
 * tokens are CSS variables on the document, so it themes the same way.
 */
import { ArrowSquareOutIcon, CaretLeftIcon, CaretRightIcon, XIcon } from "@pikvm/icons";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { isSessionEpochCurrent } from "../../../lib/queries";
import { registerSessionReset } from "../../../lib/session-reset";
import { Button } from "../../ui/button";
import { useThemeLayer } from "../../../lib/theme-scope";

export interface LightboxImage {
    src: string;
    alt: string;
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let generation = 0;

registerSessionReset("markdown-lightbox", () => {
    const previousRoot = root;
    const previousHost = host;
    root = undefined;
    host = undefined;
    generation += 1;
    try {
        previousRoot?.unmount();
    } finally {
        previousHost?.remove();
    }
});

export function showLightbox(images: LightboxImage[], index: number, trigger: HTMLElement, sessionEpoch: number): void {
    if (!isSessionEpochCurrent(sessionEpoch) || !trigger.isConnected || !images.length) return;
    if (!host) {
        host = document.createElement("div");
        host.dataset.lightbox = "";
        document.body.append(host);
        root = createRoot(host);
    }
    const instance = ++generation;
    const currentRoot = root!;
    const release = () => {
        if (root !== currentRoot || generation !== instance) return;
        if (isSessionEpochCurrent(sessionEpoch) && trigger.isConnected) trigger.focus({ preventScroll: true });
        if (root !== currentRoot || generation !== instance) return;
        currentRoot.render(null);
    };
    currentRoot.render(
        <Lightbox
            key={instance}
            images={images}
            start={Math.max(0, Math.min(index, images.length - 1))}
            sessionEpoch={sessionEpoch}
            release={release}
        />,
    );
}

function Lightbox({
    images,
    start,
    sessionEpoch,
    release,
}: {
    images: LightboxImage[];
    start: number;
    sessionEpoch: number;
    release: () => void;
}) {
    const layer = useThemeLayer();
    const [open, setOpen] = useState(true);
    const [i, setI] = useState(start);
    const n = images.length;
    const img = images[i]!;
    const go = (d: number) => setI((v) => (v + d + n) % n);

    useEffect(() => {
        if (!open || !isSessionEpochCurrent(sessionEpoch)) return;
        // Load adjacent images without sending the conversation URL as a referrer.
        for (const d of [-1, 1]) {
            const next = images[(i + d + n) % n];
            if (!next) continue;
            const preload = new Image();
            preload.referrerPolicy = "no-referrer";
            preload.src = next.src;
        }
    }, [i, images, n, open, sessionEpoch]);

    return (
        <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Portal container={layer}>
                <Dialog.Overlay className="md-lightbox-scrim" />
                <Dialog.Content
                    className="md-lightbox"
                    aria-describedby={undefined}
                    onCloseAutoFocus={(e) => {
                        e.preventDefault();
                        if (!open) release();
                    }}
                    onKeyDown={(e) => {
                        if (n < 2) return;
                        if (e.key === "ArrowRight") go(1);
                        else if (e.key === "ArrowLeft") go(-1);
                        else return;
                        e.preventDefault();
                    }}
                >
                    <Dialog.Title className="sr-only">{img.alt || "Image"}</Dialog.Title>
                    <div className="md-lightbox-bar">
                        <span className="md-lightbox-count" aria-live="polite">
                            {n > 1 ? `${i + 1} / ${n}` : ""}
                        </span>
                        <div className="flex gap-1">
                            <Button
                                size="lg"
                                uniform
                                pill
                                aria-label="Open original"
                                className="[--icon:20px]"
                                onClick={() => window.open(img.src, "_blank", "noopener,noreferrer")}
                            >
                                <ArrowSquareOutIcon />
                            </Button>
                            <Dialog.Close asChild>
                                <Button size="lg" uniform pill aria-label="Close" className="[--icon:20px]">
                                    <XIcon />
                                </Button>
                            </Dialog.Close>
                        </div>
                    </div>
                    <figure
                        className="md-lightbox-stage"
                        onClick={(e) => e.target === e.currentTarget && setOpen(false)}
                    >
                        <img key={img.src} src={img.src} alt={img.alt} referrerPolicy="no-referrer" />
                        {img.alt && <figcaption>{img.alt}</figcaption>}
                    </figure>
                    {n > 1 && (
                        <>
                            <Button
                                size="xl"
                                uniform
                                pill
                                aria-label="Previous image"
                                className="md-lightbox-nav [--icon:20px]"
                                data-side="prev"
                                onClick={() => go(-1)}
                            >
                                <CaretLeftIcon />
                            </Button>
                            <Button
                                size="xl"
                                uniform
                                pill
                                aria-label="Next image"
                                className="md-lightbox-nav [--icon:20px]"
                                data-side="next"
                                onClick={() => go(1)}
                            >
                                <CaretRightIcon />
                            </Button>
                        </>
                    )}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
