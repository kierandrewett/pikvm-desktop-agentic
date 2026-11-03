import { apiUrl } from "../../lib/config";
import { translate } from "../../l10n/runtime";

/**
 * Composer upload: one file to POST /api/uploads (the same route as the Files page), owned by the conversation when
 * it is known. The server checks size (`policy.uploads.maxFileBytes`), quota and ownership (storage/uploads.ts).
 */

export interface UploadedFile {
    id: string;
    name: string;
    size: number;
}

/** `retry` is false for failures that would repeat: a file over the limit or a full quota. */
export class UploadError extends Error {
    constructor(
        message: string,
        readonly code: string,
        readonly retry: boolean,
    ) {
        super(message);
    }
}

const FINAL_CODES = new Set(["file_too_large", "quota_exceeded", "not_found"]);

export async function uploadComposerFile(file: File, conversationId?: string): Promise<UploadedFile> {
    const body = new FormData();
    body.append("file", file);
    if (conversationId) body.append("conversationId", conversationId);
    let res: Response;
    try {
        res = await fetch(apiUrl("/uploads"), {
            method: "POST",
            body,
            credentials: "same-origin",
            headers: { "x-chat-request": "1" },
        });
    } catch {
        throw new UploadError(translate("composer-upload-no-server"), "network", true);
    }
    const json = (await res.json().catch(() => ({}))) as {
        upload?: UploadedFile;
        error?: { code?: string; message?: string };
        message?: string;
    };
    if (!res.ok || !json.upload) {
        const code = json.error?.code ?? "error";
        throw new UploadError(json.error?.message ?? json.message ?? res.statusText, code, !FINAL_CODES.has(code));
    }
    return json.upload;
}

/** Remove an upload that was never sent. Best effort: a failure only leaves a file in the Files page. */
export function discardComposerUpload(uploadId: string): void {
    void fetch(apiUrl(`/uploads/${encodeURIComponent(uploadId)}`), {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "x-chat-request": "1" },
    }).catch(() => {});
}
