/**
 * Items for the "Chat actions" menu (reference spec 5.2). The same list backs the row ellipsis
 * button, the right-click / long-press menu and the conversation header menu.
 */
import type { ConversationSummary } from "@pikvm/chat-protocol";
import { Archive, Copy, DownloadSimple, GitFork, PencilSimple, PushPin, PushPinSlash, Trash } from "@pikvm/icons";
import { apiUrl } from "../../lib/config";
import { translate, type Translate } from "../../l10n/runtime";
import type { MenuEntry } from "../ui/menu";
import { errorDescription, toast } from "../ui/toast";
import type { ChatActions } from "./actions";
/** Start the browser's download of a chat as Markdown. The response names the file. */
function downloadMarkdown(conversationId: string): void {
    const a = document.createElement("a");
    a.href = apiUrl(`/conversations/${encodeURIComponent(conversationId)}/export.md`);
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
}

/**
 * Copy a chat as Markdown: the same file as the download. The clipboard item gets the pending text, so the copy
 * keeps the menu click's user activation while the request runs (Safari drops it after an await).
 */
function copyMarkdown(conversationId: string): void {
    const text = fetch(apiUrl(`/conversations/${encodeURIComponent(conversationId)}/export.md`), {
        credentials: "same-origin",
    }).then((r) => {
        if (!r.ok) throw new Error(translate("sidebar-menu-server-answered", { status: r.status }));
        return r.text();
    });
    const write =
        typeof ClipboardItem === "undefined"
            ? text.then((t) => navigator.clipboard.writeText(t))
            : navigator.clipboard.write([
                  new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) }),
              ]);
    write.then(
        () => toast.success(translate("sidebar-menu-copied"), { id: "chat-copy-md" }),
        (e: unknown) =>
            toast.error(translate("sidebar-menu-copy-failed"), {
                id: "chat-copy-md",
                description: errorDescription(e),
            }),
    );
}

export function chatMenuItems(
    c: ConversationSummary,
    actions: ChatActions,
    onRename: () => void,
    onDelete: () => void,
    t: Translate = translate,
): MenuEntry[] {
    const pinned = c.pinnedAt !== null;
    return [
        { label: t("sidebar-menu-rename"), icon: <PencilSimple />, onSelect: onRename },
        {
            label: pinned ? t("sidebar-menu-unpin") : t("sidebar-menu-pin"),
            icon: pinned ? <PushPinSlash /> : <PushPin />,
            onSelect: () => void actions.setPinned(c.id, !pinned),
        },
        { label: t("sidebar-menu-fork"), icon: <GitFork />, onSelect: () => void actions.fork(c.id) },
        // The server builds the file from history (GET <api>/conversations/:id/export.md), so this works while a
        // response is running and needs no client state.
        {
            label: t("sidebar-menu-download-markdown"),
            icon: <DownloadSimple />,
            onSelect: () => downloadMarkdown(c.id),
        },
        { label: t("sidebar-menu-copy-markdown"), icon: <Copy />, onSelect: () => copyMarkdown(c.id) },
        { type: "separator" },
        { label: t("sidebar-menu-archive"), icon: <Archive />, onSelect: () => void actions.archive(c.id) },
        { label: t("sidebar-menu-delete"), icon: <Trash />, danger: true, onSelect: onDelete },
    ];
}
