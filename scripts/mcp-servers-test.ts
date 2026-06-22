// Smoke test for the generic MCP server registry (src/agent/mcp-servers.ts) and
// the settings migration (src/settings.ts). Pure logic — no real MCP connection.
//   esbuild scripts/mcp-servers-test.ts --bundle --platform=node --format=cjs \
//     --outfile=dist/mcp-servers-test.cjs --alias:electron=./scripts/electron-stub.cjs \
//     && node dist/mcp-servers-test.cjs

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { namespaceTool, makeTransport, type McpServerConfig } from "../src/agent/mcp-servers";
import { SettingsStore, ATLAS_SERVER_ID } from "../src/settings";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
    if (cond) console.log(`  ok   ${name}`);
    else {
        failed++;
        console.log(`  FAIL ${name}`, extra ?? "");
    }
}

const cfg = (over: Partial<McpServerConfig>): McpServerConfig => ({
    id: "x",
    name: "X",
    enabled: true,
    transport: "stdio",
    ...over,
});

/* ----------------------------- namespacing ----------------------------- */
console.log("namespaceTool");
check("prefixes a plain tool with the server id", namespaceTool(cfg({ id: "github" }), "search") === "github_search");
check("rawToolNames keeps the tool verbatim", namespaceTool(cfg({ id: "atlas", rawToolNames: true }), "atlas_page") === "atlas_page");
check("does not double-prefix when tool already starts with id", namespaceTool(cfg({ id: "atlas" }), "atlas_page") === "atlas_page");
check("sanitises non-alnum chars in the id", namespaceTool(cfg({ id: "my server!" }), "run") === "my_server_run");

/* ----------------------------- transports ------------------------------ */
console.log("makeTransport");
check("stdio without a command -> null", makeTransport(cfg({ transport: "stdio", command: "" })) === null);
check("http without a url -> null", makeTransport(cfg({ transport: "http", url: "" })) === null);
check("http with an invalid url -> null", makeTransport(cfg({ transport: "http", url: "not a url" })) === null);
check("stdio with a command builds a transport", makeTransport(cfg({ transport: "stdio", command: "/bin/echo", args: ["hi"] })) !== null);
check("http with a valid url builds a transport", makeTransport(cfg({ transport: "http", url: "https://example.com/mcp" })) !== null);

/* ----------------------- settings migration ---------------------------- */
console.log("settings migration");
const dir = mkdtempSync(resolve(tmpdir(), "mcp-test-"));
try {
    // 1. Fresh install: a default Atlas server entry exists.
    const fresh = new SettingsStore(resolve(dir, "fresh.json")).get();
    const atlasFresh = fresh.mcpServers.find((m) => m.id === ATLAS_SERVER_ID);
    check("fresh install has an Atlas mcpServers entry", !!atlasFresh);
    check("Atlas entry is stdio + rawToolNames + atlas-vault skill",
        atlasFresh?.transport === "stdio" && atlasFresh?.rawToolNames === true && atlasFresh?.skill === "atlas-vault", atlasFresh);
    check("Atlas args carry the vault path", (atlasFresh?.args ?? []).includes(fresh.atlas.vaultPath));

    // 2. Legacy config (only `atlas`, no mcpServers) migrates into the registry.
    const legacyPath = resolve(dir, "legacy.json");
    writeFileSync(legacyPath, JSON.stringify({ atlas: { enabled: true, binPath: "/opt/atlas", vaultPath: "/vault" } }));
    const migrated = new SettingsStore(legacyPath).get();
    const atlasMig = migrated.mcpServers.find((m) => m.id === ATLAS_SERVER_ID);
    check("legacy atlas-only config gains an Atlas mcpServers entry", !!atlasMig);
    check("migrated Atlas uses the saved binPath/vaultPath",
        atlasMig?.command === "/opt/atlas" && (atlasMig?.args ?? []).join(" ") === "mcp /vault", atlasMig);

    // 3. Patching the legacy atlas block keeps the Atlas server entry in sync.
    const store = new SettingsStore(resolve(dir, "patch.json"));
    store.patch({ atlas: { enabled: false, binPath: "/new/atlas", vaultPath: "/new/vault" } });
    const after = store.get().mcpServers.find((m) => m.id === ATLAS_SERVER_ID);
    check("patching atlas updates the synced server entry",
        after?.enabled === false && after?.command === "/new/atlas" && (after?.args ?? []).join(" ") === "mcp /new/vault", after);

    // 4. Adding a custom server via mcpServers patch persists alongside Atlas.
    store.patch({
        mcpServers: [
            ...store.get().mcpServers,
            { id: "gh", name: "GitHub", enabled: true, transport: "http", url: "https://api.example/mcp" },
        ],
    });
    const list = store.get().mcpServers;
    check("custom http server persists", list.some((m) => m.id === "gh" && m.transport === "http"));
    check("Atlas still present after adding a custom server", list.some((m) => m.id === ATLAS_SERVER_ID));
} finally {
    rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
