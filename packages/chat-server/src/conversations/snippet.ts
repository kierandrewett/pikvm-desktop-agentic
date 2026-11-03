/**
 * Sidebar row summary: the plain-text start of an assistant reply. It is free (the reply is already in memory when
 * a run ends), unlike a generated summary, which costs a model call and sends the chat to a provider. A generated
 * summary can replace this value later by writing the same `snippet` column (docs/spec/sidebar-views.md).
 */
import type { OutputItem } from "@pikvm/chat-protocol";

export const SNIPPET_MAX = 200;

/** Strip the Markdown that reads badly in two lines of plain text. */
function plain(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
        .replace(/[*_~]{1,3}/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** Snippet of the last assistant message with text in a response, or undefined when there is none. */
export function snippetOf(output: readonly OutputItem[]): string | undefined {
    for (let i = output.length - 1; i >= 0; i--) {
        const item = output[i]!;
        if (item.type !== "message" || item.role !== "assistant") continue;
        const text = item.content.map((p) => (p.type === "output_text" ? p.text : "")).join(" ");
        const out = plain(text);
        if (out) return out.length > SNIPPET_MAX ? `${out.slice(0, SNIPPET_MAX - 1).trimEnd()}...` : out;
    }
    return undefined;
}

/** Whether a prompt carried an attachment: an image, or the "Attached files" note ws.ts appends. */
export function hasAttachment(message: string, images: readonly unknown[]): boolean {
    return images.length > 0 || message.includes("\n\nAttached files:\n");
}
