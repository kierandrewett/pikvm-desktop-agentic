/**
 * Frames: the pictures a tool took (a PiKVM screenshot), kept per conversation so the thread can show what the agent
 * saw. `users/<id>/frames/<conversationId>/<frameId>.jpg`, written by a built-in MCP server through its context
 * (`mcp/builtin.ts`) and read by `GET /conversations/:id/frames/:frameId`.
 *
 * The directory is bounded: at most `MAX_FRAMES` files and `MAX_TOTAL_BYTES` bytes, oldest first out, so a long run of
 * screenshots cannot fill the disk. A frame that was pruned is a 404 and the thread shows the card without a picture.
 * Deleting a conversation removes its directory (`conversations/service.ts`); forking copies it.
 *
 * A frame id is time ordered (a strictly increasing base 36 stamp, then random letters), so pruning needs no index.
 */
import { FRAME_ID_RE, type FrameRef } from "@pikvm/chat-protocol";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../paths.ts";

export const MAX_FRAMES = 60;
export const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
/** One picture. A PiKVM screenshot at the default size is tens of kilobytes. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

const EXT = ".jpg";
const MAX_EDGE = 16_384;

export class FrameError extends Error {}

let lastStamp = 0;

function newFrameId(): string {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return lastStamp.toString(36).padStart(9, "0") + randomBytes(6).toString("hex");
}

/** Keep a JPEG for the conversation and return its reference. Throws FrameError for a picture that is not kept. */
export function saveFrame(
    userId: string,
    conversationId: string,
    jpeg: Uint8Array,
    size: { width: number; height: number },
): FrameRef {
    if (!(jpeg.length > 4 && jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[2] === 0xff)) throw new FrameError("not a JPEG");
    if (jpeg.length > MAX_FRAME_BYTES) throw new FrameError(`over ${MAX_FRAME_BYTES} bytes`);
    for (const edge of [size.width, size.height])
        if (!Number.isInteger(edge) || edge < 1 || edge > MAX_EDGE) throw new FrameError("bad size");
    const dir = paths.user(userId).frames(conversationId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = newFrameId();
    // Written under a name no frame has, then renamed, so a reader never sees half a picture.
    const tmp = join(dir, `.${id}.tmp`);
    writeFileSync(tmp, jpeg, { mode: 0o600 });
    renameSync(tmp, join(dir, id + EXT));
    prune(dir, id);
    return { id, width: size.width, height: size.height };
}

/** Oldest frames out until the directory is within its bounds. The frame just written always stays. */
function prune(dir: string, keep: string): void {
    const files = readdirSync(dir)
        .filter((name) => name.endsWith(EXT) && FRAME_ID_RE.test(name.slice(0, -EXT.length)))
        .sort()
        .map((name) => ({ name, size: statSync(join(dir, name)).size }));
    let count = files.length;
    let bytes = files.reduce((sum, f) => sum + f.size, 0);
    for (const f of files) {
        if (count <= MAX_FRAMES && bytes <= MAX_TOTAL_BYTES) return;
        if (f.name === keep + EXT) return;
        rmSync(join(dir, f.name), { force: true });
        count--;
        bytes -= f.size;
    }
}

/** The file of a frame of this conversation, or undefined when there is none (never made, pruned, another chat's). */
export function frameFile(userId: string, conversationId: string, frameId: string): string | undefined {
    if (!FRAME_ID_RE.test(frameId)) return undefined;
    const file = join(paths.user(userId).frames(conversationId), frameId + EXT);
    return existsSync(file) ? file : undefined;
}

/** Give a fork the frames of the chat it came from, so its history still shows them. */
export function copyFrames(userId: string, from: string, to: string): void {
    const src = paths.user(userId).frames(from);
    if (existsSync(src)) cpSync(src, paths.user(userId).frames(to), { recursive: true, force: false, errorOnExist: false });
}

export function removeFrames(userId: string, conversationId: string): void {
    rmSync(paths.user(userId).frames(conversationId), { recursive: true, force: true });
}
