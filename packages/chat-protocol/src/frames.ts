/**
 * Frames: the pictures a tool took (a PiKVM screenshot), kept by the server per conversation so the thread can show
 * them. The model still receives the image in the tool result; this is only how a person reviews it.
 *
 * A tool names a frame it asked the server to keep in its result's `_meta` under `FRAME_META_KEY`. The server turns
 * that into `FunctionCallOutputItem.frame` (live and from history alike), with the URL of the authenticated route.
 */

/** The `_meta` key of an MCP tool result that names a kept frame. */
export const FRAME_META_KEY = "chat/frame";

/** What a tool names: the server's id for the frame and its pixel size. */
export interface FrameRef {
    id: string;
    width: number;
    height: number;
}

/** A frame on a tool result item: the reference and where to load it (`/api/conversations/:id/frames/:frameId`). */
export interface ToolFrame extends FrameRef {
    url: string;
}

/** Lowercase letters and digits only, so an id is always one safe path segment. */
export const FRAME_ID_RE = /^[a-z0-9]{12,40}$/;

const MAX_EDGE = 16_384;

const edge = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_EDGE;

/** The `_meta` object that names `ref`. */
export function frameMeta(ref: FrameRef): Record<string, unknown> {
    return { [FRAME_META_KEY]: { id: ref.id, width: ref.width, height: ref.height } };
}

/** The frame a result's `_meta` names, or undefined when it names none or the value is not a well-formed reference. */
export function frameFromMeta(meta: unknown): FrameRef | undefined {
    if (!meta || typeof meta !== "object") return undefined;
    const v = (meta as Record<string, unknown>)[FRAME_META_KEY];
    if (!v || typeof v !== "object") return undefined;
    const { id, width, height } = v as Record<string, unknown>;
    if (typeof id !== "string" || !FRAME_ID_RE.test(id) || !edge(width) || !edge(height)) return undefined;
    return { id, width, height };
}

/** The server's URL for a conversation's frame, in the form every served URL has (`/api/...`). */
export const frameUrl = (conversationId: string, frameId: string): string =>
    `/api/conversations/${conversationId}/frames/${frameId}`;
