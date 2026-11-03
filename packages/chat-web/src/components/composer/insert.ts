/**
 * Add text to a conversation's composer from outside it (the thread's selection toolbar: Quote, Ask about this).
 *
 * The thread composer of that conversation listens (composer.tsx) and appends the text as a new block after what is
 * already typed, never replacing it, then focuses the editor with the caret at the end. This works in temporary
 * chats too, which keep no stored draft (lib/drafts.ts), and while the composer is focused. Nothing happens when no
 * composer for that conversation is mounted.
 */

const EVENT = "chat:composer-insert";

interface InsertDetail {
    conversationId: string;
    text: string;
}

export function insertIntoComposer(conversationId: string, text: string): void {
    window.dispatchEvent(new CustomEvent<InsertDetail>(EVENT, { detail: { conversationId, text } }));
}

/** Listen for inserts into one conversation's composer. Returns the unsubscribe function. */
export function onComposerInsert(conversationId: string | undefined, fn: (text: string) => void): () => void {
    if (!conversationId) return () => {};
    const listener = (e: Event) => {
        const d = (e as CustomEvent<InsertDetail>).detail;
        if (d?.conversationId === conversationId && d.text) fn(d.text);
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
}

/** `current` with `block` appended after one blank line (none when the composer is empty). */
export function appendBlock(current: string, block: string): string {
    const head = current.replace(/\s+$/, "");
    return head ? `${head}\n\n${block}` : block;
}

/** Text as a Markdown block quote, one `> ` per line (blank lines kept as `>`). */
export function quoteMarkdown(text: string): string {
    return text
        .replace(/\r\n?/g, "\n")
        .replace(/^\n+|\n+$/g, "")
        .split("\n")
        .map((line) => (line.trim() ? `> ${line}` : ">"))
        .join("\n");
}
