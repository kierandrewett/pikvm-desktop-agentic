/**
 * Uploads: files the operator attaches in the composer.
 *
 * Files live at users/<id>/uploads/<uploadId>/<name>. The computer profile has no tool that reads files, so the agent
 * only ever sees an image, which `ws.ts` sends inline with the prompt; an upload is never linked into its workspace.
 */
import { and, desc, eq } from "drizzle-orm";
import { mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db, newId, schema } from "../db/index.ts";
import { paths } from "../paths.ts";

const { uploads } = schema;
export type UploadRow = typeof uploads.$inferSelect;

/** The largest file the composer may attach. A constant: this is a safety limit, not a preference. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export class StorageError extends Error {
    constructor(
        message: string,
        readonly code: "file_too_large" | "not_found",
        readonly status: number,
    ) {
        super(message);
    }
}

/** Keep names readable but safe as a single path segment. */
export function safeName(name: string): string {
    const base = (name ?? "").split(/[\\/]/).at(-1) ?? "file";
    const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^\.+/, "_").trim().slice(0, 180);
    return cleaned || "file";
}

export function toDto(r: UploadRow) {
    return {
        id: r.id,
        name: r.name,
        mime: r.mime,
        size: r.size,
        url: `/api/uploads/${r.id}`,
        conversationId: r.conversationId,
        createdAt: r.createdAt,
    };
}

export async function saveUpload(userId: string, file: File, conversationId?: string): Promise<UploadRow> {
    if (conversationId !== undefined) {
        const conversation = db
            .select({ id: schema.conversations.id })
            .from(schema.conversations)
            .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.userId, userId)))
            .get();
        if (!conversation) throw new StorageError("Conversation not found", "not_found", 404);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
        throw new StorageError(
            `File is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`,
            "file_too_large",
            413,
        );
    }
    const id = newId().replaceAll("-", "");
    const name = safeName(file.name);
    const dir = paths.user(userId).upload(id);
    mkdirSync(dir, { recursive: true });
    await writeFile(join(dir, name), Buffer.from(await file.arrayBuffer()));
    db.insert(uploads)
        .values({
            id,
            userId,
            conversationId: conversationId ?? null,
            name,
            mime: file.type || "application/octet-stream",
            size: file.size,
        })
        .run();
    return getUpload(userId, id);
}

export function getUpload(userId: string, id: string): UploadRow {
    const r = db
        .select()
        .from(uploads)
        .where(and(eq(uploads.id, id), eq(uploads.userId, userId)))
        .get();
    if (!r) throw new StorageError("Upload not found", "not_found", 404);
    return r;
}

export function uploadFile(userId: string, r: UploadRow): string {
    return join(paths.user(userId).upload(r.id), r.name);
}

/** The user's uploads, newest first. */
export function listUploads(userId: string): UploadRow[] {
    return db.select().from(uploads).where(eq(uploads.userId, userId)).orderBy(desc(uploads.createdAt)).all();
}

export function deleteUpload(userId: string, id: string): void {
    getUpload(userId, id);
    db.delete(uploads).where(eq(uploads.id, id)).run();
    rmSync(paths.user(userId).upload(id), { recursive: true, force: true });
}
