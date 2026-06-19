// Validate the Atlas MCP server end-to-end (the exact client path the agent uses).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ATLAS = process.env.ATLAS ?? `${process.env.HOME}/dev/atlas-2/atlas-app-v16/target/release/atlas`;
const VAULT = process.env.VAULT ?? `${process.env.HOME}/Documents/Atlas/Capgemini`;

function props(tool: any): string {
    const p = tool?.inputSchema?.properties ?? {};
    const req: string[] = tool?.inputSchema?.required ?? [];
    return Object.keys(p)
        .map((k) => (req.includes(k) ? `${k}*` : k))
        .join(", ");
}

async function main(): Promise<void> {
    const transport = new StdioClientTransport({ command: ATLAS, args: ["mcp", VAULT] });
    const client = new Client({ name: "pikvm-agent", version: "1.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    console.log("TOOLS:", tools.map((t) => t.name).join(", "));
    console.log("atlas_page props:", props(tools.find((t) => t.name === "atlas_page")));
    console.log("atlas_search props:", props(tools.find((t) => t.name === "atlas_search")));

    // Create a markdown memory page (create takes path+title; body is a follow-up update).
    const created: any = await client.callTool({
        name: "atlas_page",
        arguments: { action: "create", path: "memory/keyboard-layout.md", title: "Target keyboard layout" },
    });
    console.log("\nCREATE isError:", created.isError ?? false, "-", (created.content?.[0]?.text ?? "").slice(0, 120).replace(/\n/g, " "));

    const updated: any = await client.callTool({
        name: "atlas_page",
        arguments: {
            action: "update",
            path: "memory/keyboard-layout.md",
            body: "---\ntitle: Target keyboard layout\ntags: [memory]\n---\n\n# Target keyboard layout\n\nThe Capgemini Windows target uses a UK keyboard layout. Press Win+Space to switch input layouts.\n",
        },
    });
    console.log("UPDATE isError:", updated.isError ?? false, "-", (updated.content?.[0]?.text ?? "").slice(0, 120).replace(/\n/g, " "));

    // Search for it.
    const found: any = await client.callTool({ name: "atlas_search", arguments: { text: "keyboard layout UK" } });
    const txt = (found.content ?? []).map((c: any) => c.text ?? "").join(" ");
    console.log("SEARCH isError:", found.isError ?? false);
    console.log("SEARCH hit page:", txt.includes("keyboard-layout") || txt.toLowerCase().includes("keyboard layout"));
    console.log("SEARCH text:", txt.slice(0, 240));

    await client.close();
    const ok = !created.isError && !updated.isError && !found.isError;
    console.log("\nRESULT:", ok ? "PASS" : "FAIL");
    process.exit(ok ? 0 : 1);
}

main().catch((e) => {
    console.error("ERR", e);
    process.exit(1);
});
