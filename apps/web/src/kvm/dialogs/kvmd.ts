/**
 * The dialogs' calls to kvmd that are not the engine's: device-control POSTs and the two
 * clipboard/download helpers. Every call resolves to a result (a 4xx is data, like the engine's
 * HttpPort), never rejects, so a dialog cannot be left with a stranded busy flag.
 */

import { errorMessage } from "@pikvm/kvm-engine";
import type { KvmSession } from "../session";

export type KvmdResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly status: number | null; readonly message: string };

export async function kvmdPost(session: KvmSession, path: string): Promise<KvmdResult> {
    try {
        const res = await session.http.request({ method: "POST", path });
        return res.ok ? { ok: true } : { ok: false, status: res.status, message: `status ${res.status}` };
    } catch (e) {
        return { ok: false, status: null, message: errorMessage(e) };
    }
}

/** "Could not do X (409)" or "Could not do X: offline", for a toast or an inline error. */
export function failureLine(what: string, result: Extract<KvmdResult, { ok: false }>): string {
    return result.status !== null ? `Could not ${what} (${result.status})` : `Could not ${what}: ${result.message}`;
}

/** Copy text, falling back to a hidden textarea where the async API is refused. True when it copied. */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // fall through to the legacy route
    }
    try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        // execCommand reports a refusal by RETURNING FALSE, not by throwing: a blocked copy must not say "Copied".
        const copied = document.execCommand("copy");
        area.remove();
        return copied;
    } catch {
        return false;
    }
}
