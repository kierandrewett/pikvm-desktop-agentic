/**
 * Per-chat MCP server switches: a compact menu in the composer footer for an existing conversation. It lists the
 * remote (http) servers and lets the user turn each one off for this chat only. Nothing loads until the menu
 * opens (TODO.md: MCP data loads on a relevant action). A server that is not in the chat's list is on.
 *
 * The server list uses the same cache key and shape as the settings page (`["mcp"]`, GET /api/mcp). It is defined
 * here, so the composer does not pull the whole settings page into its bundle.
 */
import type { McpServerStatus } from "@pikvm/chat-protocol";
import { PlugsConnected } from "@pikvm/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useT } from "../../l10n/provider";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { touchTarget } from "../../lib/touch";
import { Menu, type MenuEntry } from "../ui/menu";

type ChatServers = Record<string, boolean>;

const serversQuery = {
    queryKey: ["mcp"] as const,
    queryFn: async () => (await api.get<{ servers: McpServerStatus[] }>("/mcp")).servers,
    staleTime: 30_000,
    retry: false,
};

const chatKey = (conversationId: string) => ["conversation-mcp", conversationId] as const;

export function McpServersMenu({ conversationId, side }: { conversationId: string; side: "top" | "bottom" }) {
    const [open, setOpen] = useState(false);
    const qc = useQueryClient();
    const servers = useQuery({ ...serversQuery, enabled: open });
    const chat = useQuery({
        queryKey: chatKey(conversationId),
        queryFn: async () => (await api.get<{ servers: ChatServers }>(`/conversations/${conversationId}/mcp`)).servers,
        enabled: open,
        staleTime: 10_000,
        retry: false,
    });
    const flip = useMutation({
        mutationFn: async (v: { server: string; enabled: boolean }) =>
            (await api.put<{ servers: ChatServers }>(`/conversations/${conversationId}/mcp`, v)).servers,
        onMutate: async (v) => {
            await qc.cancelQueries({ queryKey: chatKey(conversationId) });
            const before = qc.getQueryData<ChatServers>(chatKey(conversationId));
            qc.setQueryData<ChatServers>(chatKey(conversationId), { ...before, [v.server]: v.enabled });
            return { before };
        },
        onError: (_e, _v, ctx) => qc.setQueryData(chatKey(conversationId), ctx?.before),
        onSuccess: (next) => qc.setQueryData(chatKey(conversationId), next),
    });

    const t = useT();
    const remote = (servers.data ?? []).filter((s) => s.type === "http");
    const isOn = (name: string) => chat.data?.[name] !== false;
    const items: MenuEntry[] = [{ type: "label", label: t("composer-mcp-title") }];
    if (servers.isPending || chat.isPending) items.push({ type: "label", label: t("composer-mcp-loading") });
    else if (servers.isError || chat.isError) items.push({ type: "label", label: t("composer-mcp-error") });
    else if (!remote.length) items.push({ type: "label", label: t("composer-mcp-none") });
    else {
        for (const s of remote) {
            const on = isOn(s.name);
            items.push({
                type: "toggle",
                label: s.name,
                checked: on,
                icon: <PlugsConnected weight={on ? "fill" : "regular"} />,
                onChange: (enabled) => flip.mutate({ server: s.name, enabled }),
            });
        }
    }
    const off = remote.filter((s) => !isOn(s.name)).length;
    return (
        <Menu
            open={open}
            onOpenChange={setOpen}
            side={side}
            align="end"
            title={t("composer-mcp-title")}
            items={items}
            trigger={
                <button
                    type="button"
                    aria-label={off ? t("composer-mcp-off", { count: off }) : t("composer-mcp-title")}
                    className={cn(
                        "relative inline-flex h-7 shrink-0 items-center justify-center rounded-full border border-transparent px-1.5 text-tertiary outline-none select-none max-md:h-10 max-md:min-w-11 max-md:px-2.5 pointer-coarse:min-w-11",
                        touchTarget,
                        "hover-device:hover:bg-hover data-[state=open]:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                >
                    <PlugsConnected aria-hidden className="size-4" />
                </button>
            }
        />
    );
}
