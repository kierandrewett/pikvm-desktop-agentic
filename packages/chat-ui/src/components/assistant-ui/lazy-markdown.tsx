import { MessagePartPrimitive } from "@assistant-ui/react";
import { lazy, Suspense } from "react";

/**
 * Markdown rendering, loaded after the first paint.
 *
 * react-markdown, remark-gfm and micromark are a sizeable share of the entry bundle and
 * nothing on the first screen needs them: until the chunk arrives the part's plain text is
 * shown, so a message is readable (and a test or a slow link sees content) immediately and
 * simply gains its formatting a moment later.
 */
const Markdown = lazy(async () => {
    const module = await import("./markdown-text");
    return { default: module.MarkdownText };
});

export function MarkdownText() {
    return (
        <Suspense fallback={<MessagePartPrimitive.Text className="aui-md whitespace-pre-wrap" />}>
            <Markdown />
        </Suspense>
    );
}
