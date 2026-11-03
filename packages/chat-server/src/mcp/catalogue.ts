/**
 * The MCP catalogue the settings page offers: the protocol's built-in entries that are remote servers. A server the
 * runtime would start itself (stdio) cannot run here, so it is not listed. There are no logos: the server never
 * contacts a logo service on the operator's behalf.
 */
import {
    customMcpPreset,
    defaultFeaturedMcp,
    mcpPresets,
    type McpCatalogItem,
    type McpCatalogResponse,
} from "@pikvm/chat-protocol";

export function catalogueFor(): McpCatalogResponse {
    const entries: McpCatalogItem[] = mcpPresets
        .filter((e) => e.server.type === "http")
        .map((e) => ({ ...e, source: "builtin", allowed: true }));
    const ids = new Set(entries.map((e) => e.id));
    return {
        entries,
        featured: defaultFeaturedMcp.filter((id) => ids.has(id)),
        custom: customMcpPreset,
        canAdd: true,
    };
}
