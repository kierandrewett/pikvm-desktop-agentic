/**
 * Public contract of the file renderer. See file-renderer.tsx for the design notes.
 */

/** What a file is rendered as. One renderer module per kind (image and svg share one). */
export type RenderKind =
    | "pdf"
    | "sheet"
    | "markdown"
    | "docx"
    | "code"
    | "json"
    | "image"
    | "svg"
    | "audio"
    | "video"
    | "html"
    | "openui"
    | "archive"
    | "binary";

interface SourceBase {
    /** File name with extension. Drives detection and labels. */
    name: string;
    /** MIME type when the host knows it. `application/octet-stream` counts as unknown. */
    mimeType?: string;
    /** Where the download buttons point. Defaults to the source URL (or an object URL for blobs and text). */
    downloadUrl?: string;
}

/**
 * The file to render. A URL is a same-origin API path (for example `/api/files/raw?path=...`); it is
 * fetched with the session cookie and never navigated to. Blob and text sources are already loaded.
 */
export type FileSource =
    (SourceBase & { url: string; size?: number }) | (SourceBase & { blob: Blob }) | (SourceBase & { text: string });

/**
 * Where the renderer's controls go:
 * - "floating" (default): a small pill toolbar floats at the bottom of the content.
 * - "none": no controls (thumbnails, read-only embeds).
 * - `{ slot }`: the controls render into the host's element (for example a header) through a portal.
 *   While `slot` is still null (the host's ref has not attached yet) nothing renders, so the floating
 *   toolbar never flashes first.
 */
export type ToolbarPlacement = "floating" | "none" | { slot: HTMLElement | null };

export interface FileRendererProps {
    /** Account epoch from the committed source owner, before any suspension. */
    ownerEpoch: number;
    source: FileSource;
    toolbar?: ToolbarPlacement;
    /**
     * Short, plain-text facts about the rendered file for a host status bar, for example
     * "12 pages", "100,000 rows, 8 columns" or "1920 x 1080 px". Null while loading or on error.
     */
    onStatus?: (status: string | null) => void;
    /** The kind the renderer settled on (after sniffing when the name and MIME type were not enough). */
    onKind?: (kind: RenderKind) => void;
    className?: string;
}
