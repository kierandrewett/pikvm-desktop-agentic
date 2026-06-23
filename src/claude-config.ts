/**
 * Generates the Claude Code project config inside the vault folder (its cwd), so the
 * embedded `claude` picks up: the PiKVM MCP server (.mcp.json), the guardrail PreToolUse
 * hook + read-only auto-allows (.claude/settings.json), and the operating instructions
 * (CLAUDE.md). Run on launch. Permission mode stays default — never bypass.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ClaudeConfigOpts {
    /** The vault folder = claude's cwd. */
    vaultPath: string;
    /** Local control server port (the MCP endpoint lives at /_agent/mcp). */
    port: number;
    /** Absolute path to the PreToolUse hook script (dist/claude-runtime/permission-hook.mjs). */
    hookPath: string;
    /** Node binary to run the hook with. */
    nodeBin?: string;
}

const CLAUDE_MD = `# Driving this computer (PiKVM)

You control a REAL computer through the **pikvm** MCP server (your eyes + hands). You are
running in the vault folder — use it for notes, context, and any files you produce.

## How to act
- **Always \`screenshot\` first**, and again after each action to verify. Coordinates for
  every tool are pixels of the FULL frame from the latest screenshot.
- Use **\`ocr\`** to read on-screen text cheaply, and **\`get_regions\`** to learn where the
  windows / taskbar / terminal / browser are before clicking or cropping.
- **\`type_text\`** is watched + self-correcting and **never presses Enter** — newlines become
  spaces. To submit/run something, call **\`press_key\` with "Enter"** explicitly.
- For passwords/credentials, **\`list_secrets\`** then **\`type_secret\`** (you never see the
  value). Focus the field first.
- Mouse: \`move_mouse\`, \`click\`, \`double_click\`, \`drag\`, \`scroll\`. Keys: \`press_key\`,
  \`hotkey\` (e.g. ["ControlLeft","KeyC"]).

## Safety
- Risky or sensitive actions (typing/clicking in a chat or Send button, a terminal, anything
  outward-facing or destructive) will ASK for approval in THIS terminal before they run —
  that's expected. Prefer to draft, then submit. Do not try to bypass it.
- OCR can't always tell look-alike glyphs apart (l/1/I, O/0, S/5). If a read-back differs from
  what you typed ONLY by such characters, it's a reading artefact — proceed, don't retype.
`;

export function writeClaudeConfig(opts: ClaudeConfigOpts): void {
    const { vaultPath, port, hookPath } = opts;
    const node = opts.nodeBin || process.execPath;
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(join(vaultPath, ".claude"), { recursive: true });

    // .mcp.json — the PiKVM MCP server over local HTTP.
    writeFileSync(
        join(vaultPath, ".mcp.json"),
        JSON.stringify({ mcpServers: { pikvm: { type: "http", url: `http://127.0.0.1:${port}/_agent/mcp` } } }, null, 2),
    );

    // .claude/settings.json — the guardrail hook (gates every pikvm tool) + read-only
    // auto-allows. We MERGE into any existing file so we don't clobber the user's settings.
    const settingsPath = join(vaultPath, ".claude", "settings.json");
    let settings: any = {};
    if (existsSync(settingsPath)) {
        try {
            settings = JSON.parse(readFileSync(settingsPath, "utf8")) || {};
        } catch {
            settings = {};
        }
    }
    settings.permissions = settings.permissions || {};
    const allow: string[] = settings.permissions.allow || [];
    for (const t of ["mcp__pikvm__screenshot", "mcp__pikvm__ocr", "mcp__pikvm__get_regions", "mcp__pikvm__list_secrets"]) {
        if (!allow.includes(t)) allow.push(t);
    }
    settings.permissions.allow = allow;
    settings.hooks = settings.hooks || {};
    // Run the hook with a real Node. In the Electron app process.execPath IS electron,
    // so use ELECTRON_RUN_AS_NODE=1 to run it as Node (no external node dependency);
    // under plain Node (headless) just use the binary directly.
    const runner = process.versions.electron
        ? `ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(node)}`
        : JSON.stringify(node);
    settings.hooks.PreToolUse = [
        { matcher: "mcp__pikvm__.*", hooks: [{ type: "command", command: `${runner} ${JSON.stringify(hookPath)}` }] },
    ];
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // CLAUDE.md — operating instructions in a MARKED section so we never clobber a user's
    // existing vault CLAUDE.md; we add or refresh just our block.
    const START = "<!-- PIKVM:START -->";
    const END = "<!-- PIKVM:END -->";
    const block = `${START}\n${CLAUDE_MD}${END}\n`;
    const mdPath = join(vaultPath, "CLAUDE.md");
    let md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
    if (md.includes(START) && md.includes(END)) {
        md = md.replace(new RegExp(`${START}[\\s\\S]*?${END}\\n?`), block);
    } else {
        md = md ? `${md.trimEnd()}\n\n${block}` : block;
    }
    writeFileSync(mdPath, md);
}
