/**
 * Server-side composer drafts (`/api/drafts`), the cross-device copy of what the browser keeps in localStorage.
 *
 * Scopes: `conv:<conversationId>`, `home` (the new-chat screen) and `home:<projectId>` (a project's new-chat
 * screen). Temporary chats are never stored. Clearing removes content after a successful send or manual empty;
 * the server retains an empty revision row so stale conditional writes cannot restore that content.
 */

/** Largest draft text accepted, in characters. */
export const DRAFT_TEXT_MAX = 200_000;
/** Largest attachments JSON accepted, in characters (inline image data URLs and uploaded file ids). */
export const DRAFT_ATTACHMENTS_MAX = 2_000_000;

export const DRAFT_SCOPE = /^(?:home|home:[A-Za-z0-9_-]{1,128}|conv:[A-Za-z0-9_-]{1,128})$/;

export interface DraftImageAttachment {
    id: string;
    kind: "image";
    name: string;
    url: string;
    /** The chip in the draft text that stands for this image, for example "[Image #2]". */
    marker?: string;
}

/** An uploaded file kept in a draft: the upload stays on the server, the draft keeps its id. */
export interface DraftFileAttachment {
    id: string;
    kind: "file";
    name: string;
    size: number;
    uploadId: string;
    /** The chip in the draft text that stands for this file, for example "[Pasted text #1]". */
    marker?: string;
}

export type DraftAttachment = DraftImageAttachment | DraftFileAttachment;

/** GET /api/drafts?scope=... (`null` when there is none) and the PUT response. */
export interface ServerDraft {
    scope: string;
    text: string;
    attachments: DraftAttachment[];
    /** Server time of the last write, in ms. */
    updatedAt: number;
}

/** PUT /api/drafts body. */
export interface DraftWrite {
    scope: string;
    text: string;
    attachments?: DraftAttachment[];
    /** Compare-and-set revision. Zero means no stored copy exists. */
    baseUpdatedAt?: number;
}

/** GET /api/drafts: the caller's non-empty drafts, without their content (sidebar "Draft" marker). */
export interface DraftList {
    drafts: { scope: string; conversationId: string | null; updatedAt: number }[];
}
