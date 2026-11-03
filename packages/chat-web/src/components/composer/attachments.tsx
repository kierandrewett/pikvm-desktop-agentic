/**
 * Composer attachments.
 *
 * - Images are read into data URLs and sent as `input_image` parts. That keeps them in the stored draft.
 * - Other files, and long pasted text, are uploaded to the conversation (upload.ts) and sent as `input_file`.
 * - An attachment that came from a paste has a `marker` ("[Pasted text #1]"), the chip in the message text that
 *   stands for it (chips.tsx). Removing either one removes the other.
 * - States: `uploading`, `failed` (with a reason, and a Retry button unless the failure would repeat). No state means ready.
 */
import type { DraftAttachment } from "@pikvm/chat-protocol";
import { ArrowClockwise, CircleNotch, UploadSimple, Warning, X } from "@pikvm/icons";
import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useT } from "../../l10n/provider";
import { translate } from "../../l10n/runtime";
import { FileTypeIcon } from "../file-icons/file-type-icon";
import { Tooltip } from "../ui/tooltip";
import { Chip, markerKindOf, markerLabel } from "./chips";
import { useThemeLayer } from "../../lib/theme-scope";
import { usePaneActive } from "../../lib/pane-active";

interface AttachmentBase {
    id: string;
    name: string;
    /** The chip in the text that stands for this attachment, for example "[Image #2]". */
    marker?: string;
    status?: "uploading" | "failed";
    error?: string;
    /** False when a retry would fail the same way (too large, quota exceeded). */
    canRetry?: boolean;
}

export type ImageAttachment = AttachmentBase & { kind: "image"; url: string };
export type FileAttachment = AttachmentBase & { kind: "file"; size: number; uploadId?: string };
export type Attachment = ImageAttachment | FileAttachment;

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function readDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error ?? new Error(translate("composer-read-failed")));
        r.readAsDataURL(file);
    });
}

/** The data URL of an image file. Throws with a user-facing message when it is too large or unreadable. */
export async function readImageUrl(file: File): Promise<string> {
    if (file.size > MAX_IMAGE_BYTES)
        throw new Error(
            translate("composer-image-too-large", { name: file.name || translate("composer-image-fallback") }),
        );
    return readDataUrl(file);
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const tileCls = "rounded-[calc(16px*var(--roundness))] border border-default";

export const AttachmentRow = memo(function AttachmentRow({
    items,
    onRemove,
    onRetry,
}: {
    items: Attachment[];
    onRemove: (id: string) => void;
    onRetry?: (id: string) => void;
}) {
    const t = useT();
    return (
        // Touch: wider gaps and a taller top edge, so each remove button's 44px hit area fits inside the row.
        <ul
            aria-label={t("composer-attachments")}
            className="no-scrollbar flex gap-2 overflow-x-auto px-3 pt-3 pointer-coarse:gap-4 pointer-coarse:px-4 pointer-coarse:pt-4"
        >
            {items.map((a) => {
                const ready = !a.status;
                return (
                    <li key={a.id} className="group/att relative shrink-0">
                        {a.kind === "image" && ready ? (
                            <div className="relative">
                                <img src={a.url} alt={a.name} className={cn(tileCls, "size-14 object-cover")} />
                                {a.marker && (
                                    <span className="absolute inset-x-1 bottom-1 flex">
                                        <Chip kind="image" label={markerLabel(a.marker)} className="px-1 text-xs" />
                                    </span>
                                )}
                            </div>
                        ) : (
                            <div
                                role="group"
                                aria-label={
                                    a.status
                                        ? a.status === "failed"
                                            ? t("composer-attachment-label-failed", { name: a.name })
                                            : t("composer-attachment-label-uploading", { name: a.name })
                                        : a.name
                                }
                                className={cn(
                                    tileCls,
                                    "flex h-14 w-56 items-center gap-2 bg-soft px-3",
                                    a.status === "failed" && "border-danger",
                                )}
                            >
                                {a.status === "uploading" ? (
                                    <CircleNotch aria-hidden className="size-5 shrink-0 animate-spin text-secondary" />
                                ) : a.status === "failed" ? (
                                    <Warning aria-hidden className="size-5 shrink-0 text-danger" />
                                ) : (
                                    <FileTypeIcon name={a.name} className="size-5 shrink-0" />
                                )}
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-base text-text">{a.name}</span>
                                    <span className="flex items-center gap-1.5 text-xs text-tertiary">
                                        {a.marker && (
                                            <Chip
                                                kind={markerKindOf(a.marker)}
                                                label={markerLabel(a.marker)}
                                                className="px-1 text-xs"
                                            />
                                        )}
                                        <span className={cn("truncate", a.status === "failed" && "text-danger")}>
                                            {a.status === "uploading"
                                                ? t("composer-attachment-uploading")
                                                : a.status === "failed"
                                                  ? (a.error ?? t("composer-upload-failed"))
                                                  : a.kind === "file"
                                                    ? formatSize(a.size)
                                                    : ""}
                                        </span>
                                    </span>
                                </span>
                                {a.status === "failed" && a.canRetry !== false && onRetry && (
                                    <Tooltip label={t("composer-retry")}>
                                        <button
                                            type="button"
                                            aria-label={t("composer-retry-named", { name: a.name })}
                                            onClick={() => onRetry(a.id)}
                                            className="flex size-7 shrink-0 items-center justify-center rounded-full text-text outline-none hover-device:hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            <ArrowClockwise aria-hidden className="size-4" />
                                        </button>
                                    </Tooltip>
                                )}
                            </div>
                        )}
                        <button
                            type="button"
                            aria-label={
                                a.marker
                                    ? t("composer-remove-chip", { label: markerLabel(a.marker), name: a.name })
                                    : t("composer-remove", { name: a.name })
                            }
                            onClick={() => onRemove(a.id)}
                            className="absolute -top-1.5 -right-1.5 flex size-6 items-center justify-center rounded-full border border-default bg-elevated text-text shadow-menu after:absolute after:-inset-2 after:content-[''] pointer-coarse:-top-1 pointer-coarse:-right-1 pointer-coarse:after:-inset-3"
                        >
                            <X weight="bold" aria-hidden className="size-3.5" />
                        </button>
                    </li>
                );
            })}
        </ul>
    );
});

/** Full-window overlay while files are dragged over the page; drops are passed to onFiles. */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true): boolean {
    const [active, setActive] = useState(false);
    const depth = useRef(0);
    const cb = useRef(onFiles);
    cb.current = onFiles;
    const paneActive = usePaneActive();
    useEffect(() => {
        if (!enabled || !paneActive) return;
        const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
        const enter = (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth.current++;
            setActive(true);
        };
        const over = (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        };
        const leave = (e: DragEvent) => {
            if (!hasFiles(e)) return;
            depth.current = Math.max(0, depth.current - 1);
            if (!depth.current) setActive(false);
        };
        const drop = (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth.current = 0;
            setActive(false);
            const files = [...(e.dataTransfer?.files ?? [])];
            if (files.length) cb.current(files);
        };
        window.addEventListener("dragenter", enter);
        window.addEventListener("dragover", over);
        window.addEventListener("dragleave", leave);
        window.addEventListener("drop", drop);
        return () => {
            window.removeEventListener("dragenter", enter);
            window.removeEventListener("dragover", over);
            window.removeEventListener("dragleave", leave);
            window.removeEventListener("drop", drop);
        };
    }, [enabled, paneActive]);
    return active;
}

export function DropOverlay({ active }: { active: boolean }) {
    const layer = useThemeLayer();
    if (!active) return null;
    return createPortal(
        <div
            aria-hidden
            className={cn(
                "pointer-events-none fixed inset-0 z-[200] flex items-center justify-center bg-[color-mix(in_srgb,var(--surface)_80%,transparent)]",
                "animate-[fade-in_120ms]",
            )}
        >
            <div className="flex flex-col items-center gap-3 text-center">
                <span className="flex size-14 items-center justify-center rounded-full bg-accent-bg text-accent-text">
                    <UploadSimple className="size-6" />
                </span>
                <span className="text-lg font-medium text-text">Add anything</span>
                <span className="text-base text-secondary">Drop any file here to add it to the conversation</span>
            </div>
        </div>,
        layer ?? document.body,
    );
}

/** The ready attachments as the stored draft keeps them (lib/drafts.ts): plain fields only, never a pending state. */
export function draftAttachments(attachments: readonly Attachment[]): DraftAttachment[] {
    return attachments.flatMap((a): DraftAttachment[] => {
        if (a.status) return [];
        const marker = a.marker ? { marker: a.marker } : {};
        if (a.kind === "image") return a.url ? [{ id: a.id, kind: "image", name: a.name, url: a.url, ...marker }] : [];
        return a.uploadId
            ? [{ id: a.id, kind: "file", name: a.name, size: a.size, uploadId: a.uploadId, ...marker }]
            : [];
    });
}
