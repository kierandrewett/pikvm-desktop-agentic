// Validate the remember -> Atlas write-through: connectAtlas().remember() must
// create a markdown page in the vault and (after the debounced reindex) make it
// searchable — the exact path the `remember` tool now takes.
import { connectAtlas } from "../src/agent/atlas-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ATLAS = process.env.ATLAS ?? `${process.env.HOME}/dev/atlas-2/atlas-app-v16/target/release/atlas`;
const VAULT = process.env.VAULT ?? `${process.env.HOME}/Documents/Atlas/Capgemini`;
const MARKER = "zzqmirrorprobe";
const FACT = `Mirror probe fact ${MARKER}: the write-through hook saved this.`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
    const bridge = await connectAtlas({ atlasBin: ATLAS, vault: VAULT });
    if (!bridge) {
        console.log("RESULT: FAIL (could not connect Atlas bridge)");
        process.exit(1);
    }

    // Mirror a fact, exactly as MemoryStore.onAdd would.
    await bridge.remember(FACT, ["probe"], "probeid01");
    // Wait past the 800ms debounce so atlas_health rebuilds the index.
    await sleep(2000);

    // Search through a fresh raw client (a separate reader, like the frontend).
    const transport = new StdioClientTransport({ command: ATLAS, args: ["mcp", VAULT] });
    const reader = new Client({ name: "probe-reader", version: "1.0.0" });
    await reader.connect(transport);
    const found: any = await reader.callTool({ name: "atlas_search", arguments: { text: MARKER } });
    const txt = (found.content ?? []).map((c: any) => c.text ?? "").join(" ");
    const hit = txt.includes(MARKER) || txt.includes("memory/notes/");
    console.log("SEARCH hit mirrored page:", hit);
    console.log("SEARCH text:", txt.slice(0, 240).replace(/\n/g, " "));

    await reader.close();
    await bridge.close();
    console.log("\nRESULT:", hit ? "PASS" : "FAIL");
    process.exit(hit ? 0 : 1);
}

main().catch((e) => {
    console.error("ERR", e);
    process.exit(1);
});
