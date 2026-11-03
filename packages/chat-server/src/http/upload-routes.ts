import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { deleteUpload, getUpload, listUploads, saveUpload, StorageError, toDto, uploadFile } from "../storage/uploads.ts";
import { requireUser, type Env } from "./context.ts";

/** Types safe to show inline; everything else downloads. */
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain|audio\/|video\/)/;

function storage<T>(fn: () => T): T {
    try {
        return fn();
    } catch (err) {
        if (err instanceof StorageError) throw new HTTPException(err.status as 404, { message: err.message });
        throw err;
    }
}

export const uploadRoutes = new Hono<Env>()
    .get("/uploads", (c) => {
        const user = requireUser(c);
        return c.json({ uploads: listUploads(user.id).map(toDto) });
    })
    .post("/uploads", async (c) => {
        const user = requireUser(c);
        const form = await c.req.formData().catch(() => undefined);
        const file = form?.get("file");
        if (!(file instanceof File)) throw new HTTPException(400, { message: "Expected a multipart field named file" });
        const conversationId = form?.get("conversationId");
        try {
            const row = await saveUpload(user.id, file, typeof conversationId === "string" ? conversationId : undefined);
            return c.json({ upload: toDto(row) }, 201);
        } catch (err) {
            if (err instanceof StorageError)
                return c.json({ error: { code: err.code, message: err.message } }, err.status as 413);
            throw err;
        }
    })
    .get("/uploads/:id", (c) => {
        const user = requireUser(c);
        const row = storage(() => getUpload(user.id, c.req.param("id")));
        const inline = INLINE.test(row.mime);
        const body =
            row.size === 0 ? new Uint8Array(0) : (Readable.toWeb(createReadStream(uploadFile(user.id, row))) as ReadableStream);
        return new Response(body, {
            headers: {
                "content-type": inline ? row.mime : "application/octet-stream",
                "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
                "x-content-type-options": "nosniff",
                "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
                "cache-control": "private, max-age=31536000, immutable",
            },
        });
    })
    .delete("/uploads/:id", (c) => {
        const user = requireUser(c);
        storage(() => deleteUpload(user.id, c.req.param("id")));
        return c.json({ ok: true });
    });
