/**
 * Generates the Claude Code project config inside the vault folder (its cwd), so the
 * embedded `claude` picks up: the PiKVM MCP server (.mcp.json), the guardrail PreToolUse
 * hook + read-only auto-allows (.claude/settings.json), and the operating instructions
 * (CLAUDE.md). Run on launch. Permission mode stays default — never bypass.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServerSettings } from "./settings";

export interface ClaudeConfigOpts {
    /** The vault folder = claude's cwd. */
    vaultPath: string;
    /** Local control server port (the MCP endpoint lives at /_agent/mcp). */
    port: number;
    /** Per-app-session MCP token. Written only into this project-local environment. */
    mcpToken?: string;
    /** Extra MCP servers from Settings. PiKVM is injected separately with its private token. */
    mcpServers?: McpServerSettings[];
    /** Absolute path to the PreToolUse hook script (dist/claude-runtime/permission-hook.mjs). */
    hookPath: string;
    /** Node binary to run the hook with. */
    nodeBin?: string;
}

const CLAUDE_MD = `# Driving this computer (PiKVM)

You control a REAL computer through the **pikvm** MCP server (your eyes + hands). You are
running in the vault folder — use it for notes, context, and any files you produce.
This PiKVM MCP access is intentionally project-local to this terminal workspace; do not copy
the endpoint into global agent settings.
- The project \`.mcp.json\` is generated from this app's Settings -> MCP list, plus the
  private project-local \`pikvm\` server. If a server is missing, check Settings first.

## Memory / Atlas
- If the **atlas** MCP server is available, use it as durable project memory for notes,
  preferences, and context that should survive this terminal session.
- Search Atlas before assuming something is unknown. When you learn stable context that will
  help future sessions, write it to the Atlas vault instead of leaving it only in chat.
- For briefings, recurring workplace preferences, and environment facts, prefer Atlas memory
  over ad hoc local files.

## Workplace context
- The user's work email is **Microsoft Outlook / Microsoft 365**, not Gmail.
- The user's work chat/messages are **Microsoft Teams**.
- If the user says "email", "mail", "messages", "Teams", or asks for a briefing, assume
  Outlook + Teams unless they explicitly name another product.
- Do **not** use Gmail, Google Mail, or a Gmail connector unless the user explicitly says
  Gmail. Choosing Gmail for work email is wrong in this environment.
- For email and Teams tasks, inspect the actual PiKVM screen and use Outlook/Teams on the
  target machine (desktop apps or Microsoft 365 web apps such as Outlook/Teams), verifying
  what is open with \`screenshot\`, \`ocr\`, and \`get_regions\`.
- Do not invent connector availability. If a Microsoft connector is not available, use the
  PiKVM screen instead of substituting Gmail.

## How to act
- **Always \`screenshot\` first**, and again after each action to verify. Coordinates for
  every tool are pixels of the FULL frame from the latest screenshot.
- Use **\`ocr\`** to read on-screen text cheaply, and **\`get_regions\`** to learn where the
  windows / taskbar / terminal / browser are before clicking or cropping.
- **\`type_text\`** is watched + self-correcting and **never presses Enter** — newlines become
  spaces. To submit/run something, call **\`press_key\` with "Enter"** explicitly.
- Before **\`type_text\`** or **\`type_secret\`**, look at the current screen with
  screenshot/get_regions. Confirm the target text box, text area, password field, or terminal
  input line is visible on screen, click/focus it, then pass its tight full-frame box as
  \`verify_region\`. If the field is off-screen, hidden, covered, or you cannot identify its box,
  do not type yet.
- If \`type_text\` says the field is not focused or the screen did not change, **do not retry
  \`type_text\` yet**. First screenshot/get_regions, click inside the target field or otherwise
  focus it, verify the caret/focus, then call \`type_text\` once.
- For passwords/credentials, **\`list_secrets\`** then **\`type_secret\`** (you never see the
  value). Focus the visible field first and pass its \`verify_region\`.
- Mouse: \`move_mouse\`, \`click\`, \`double_click\`, \`drag\`, \`scroll\`. Keys: \`press_key\`,
  \`hotkey\` (e.g. ["ControlLeft","KeyC"]).

## Working in a terminal — DISABLE PAGERS (important)
- Many commands open a PAGER that takes over the terminal (\`git log\`/\`diff\`/\`branch\`/\`show\`,
  \`man\`, \`systemctl\`, \`journalctl\`, \`less\`, \`more\`). If a pager is open and you type your
  next command, it goes INTO THE PAGER, not the shell — it breaks the session. (Tell-tale signs:
  a bottom status line, a lone \`:\`, \`(END)\`, reverse-video, or no normal \`$\`/\`>\` prompt.)
- FIRST thing when you start using a shell on the target, disable pagers for the session:
  \`export GIT_PAGER=cat PAGER=cat MANPAGER=cat LESS=FRX\` (bash/zsh, incl. Git Bash/MINGW). Then
  git, man, etc. print inline. (On Windows \`cmd\`/PowerShell use the per-command flags below.)
- Per command, prefer non-paging forms: \`git --no-pager log --oneline -n 20\`, \`git status -s\`,
  \`git --no-pager diff\`, \`systemctl --no-pager\`, \`journalctl --no-pager\`, or append \` | cat\`
  to anything that might page. Keep output BOUNDED (\`-n\`, \`head\`, \`tail\`, \`grep -n\`).
- If a pager / full-screen app (less, vim, nano, htop, a REPL) IS already open, do NOT type a
  command into it. Quit back to the shell FIRST — \`q\` for pagers, \`Esc\` then \`:q!\` for vim,
  \`Ctrl+C\`/\`Ctrl+D\` for REPLs — then SCREENSHOT to confirm you're back at the \`$\`/\`>\` prompt
  before typing the next command.
- To READ a file, prefer opening it in the editor/IDE over \`cat\`/\`less\` in the terminal (see
  above) — it avoids the pager problem entirely.

## Entering long / multi-line text FAST
- For a LONG or MULTI-LINE block (a composed message, an email body, a paragraph), use
  **\`paste_text\`** — focus the field first and pass its \`verify_region\`. It types the text
  server-side via the keymap (far faster + more reliable than char-by-char) and inserts line
  breaks deliberately: **Shift+Enter** by default (never submits) or a real Enter
  (\`line_break:"enter"\`, ONLY where Enter is a newline — an editor, or a chat box you've put
  into "Enter = new line" mode; a real Enter in a normal chat box SENDS). It never presses a
  trailing Enter, so it can't send.
- \`type_text\` also auto-uses the fast server-side path for long plain prose; the slow,
  humanized keystroke path is reserved for short fields, exact commands, and passwords.

## Microsoft Teams — composing a message (the compose box is fiddly)
- Teams applies live markdown autoformat AS YOU TYPE, inconsistently: a Shift+Enter soft break
  keeps lines in one paragraph, so a list of \`- \` lines often gets only the FIRST line bulleted
  and the rest left as literal dashes. Single-backtick \`code\` spans do render.
- SAFEST consistent result: compose with \`paste_text\` (Shift+Enter breaks — never sends) and
  keep a bullet-like list as LITERAL, uniform dashes (e.g. lead each line with a space so Teams
  doesn't auto-bullet just the first one), rather than letting Teams bullet some lines and not
  others. Inline \`code\` via single backticks renders fine and consistently.
- For PROPER Teams bullets on every line: first open the EXPANDED composer
  (\`hotkey(["ControlLeft","ShiftLeft","KeyX"])\`), then **screenshot to CONFIRM the expanded
  box actually opened** — only THEN use \`paste_text\` with \`line_break:"enter"\` so each \`- \`
  line becomes its own bullet. If the expanded box did not open, a real Enter would SEND, so
  never use \`line_break:"enter"\` in Teams until you've confirmed Enter is a newline there.
- For guaranteed-consistent monospace (no autoformat at all): type \`/code\` then \`press_key("Enter")\`
  to open a code block, then paste the lines into it.
- Emphasis: do NOT rely on markdown (\`*\`/\`**\` are inconsistent in new Teams). Type the text,
  select it (Shift+Home / Shift+Arrow), then \`Ctrl+B\` / \`Ctrl+I\`; inline code via \`Ctrl+Shift+C\`.
- ALWAYS screenshot the compose box and verify it reads cleanly BEFORE sending. **Send with
  \`hotkey(["ControlLeft","Enter"])\` (Ctrl+Enter)** — it sends in the compact box, the expanded
  box, and when Enter is set to "new line"; never assume a bare Enter will or won't send.
- Do NOT compose via a Notepad/clipboard copy-paste hack: Teams autoformats pasted \`- \` and
  backticks too, can strip newlines on paste, and \`Ctrl+V\` is flaky in the Teams web view — it
  doesn't fix the formatting and adds failure modes. Compose IN Teams and verify by screenshot.

## Composing in the user's VOICE
- When you DRAFT a message, email, or note on the user's behalf, write it in THEIR voice — not
  a generic assistant tone. FIRST read their voice profile at \`voice/style-card.md\` in the
  vault (and any \`voice/<recipient>.md\` examples), and search Atlas for past messages to the
  same person. Match their register: terse, their casing/spelling (British), their formatting
  (\`-\` bullets, backtick \`code spans\` for identifiers/values like \`grp_serviceowner\`).
- Follow the style card's hard NOs: **no em-dashes, no "Certainly/Sure/Here's", no
  over-hedging, no corporate scaffolding the user doesn't use, don't "correct" their deliberate
  casualness.**
- ALWAYS show the draft for approval before sending; the user may edit it. Concrete examples of
  the user's OWN past writing matter far more than the abstract rubric — when the user
  hand-writes or corrects a draft, SAVE it as a voice example (append to \`voice/style-card.md\`
  or \`voice/<recipient>.md\`, or \`remember\` it tagged "voice") so the profile improves.

## Safety
- Risky or sensitive actions (typing/clicking in a chat or Send button, a terminal, anything
  outward-facing or destructive) will ASK for approval in THIS terminal before they run —
  that's expected. Prefer to draft, then submit. Do not try to bypass it.
- OCR can't always tell look-alike glyphs apart (l/1/I, O/0, S/5). If a read-back differs from
  what you typed ONLY by such characters, it's a reading artefact — proceed, don't retype.

## Sharing the machine with other local clients
- Other Claude/Codex sessions may be open from this terminal workspace. Only ONE may DRIVE (mouse/keyboard)
  at a time — a control lease. Looking (\`screenshot\`/\`ocr\`/\`get_regions\`) is always free.
- Your first hands action takes the lease and you keep it while you work. If a tool is denied
  with "another session is controlling the KVM", another agent holds it — wait, or have the
  user close that tab. Don't fight it.

## Goal
- You have FULL agency over this machine. Plan, verify with screenshots, and complete the
  user's task end-to-end. When unsure what's on screen, screenshot + get_regions before acting.
`;

/** Seeded ONCE into <vault>/voice/style-card.md (never overwritten) — a starting voice
 *  profile the user + agent fill with the user's REAL writing. The compose step reads it. */
const STYLE_CARD_TEMPLATE = `# Writing voice — how I write

Use this voice when composing messages, emails, or notes ON MY BEHALF (Teams, Outlook, …).
Match it; do not impose a generic assistant tone. Real examples (below) matter most — keep
adding them.

## Voice
- Terse and direct. Say the thing; cut throat-clearing and filler.
- Lowercase-leaning, casual register. Contractions, often without apostrophes (dont, wont, youre).
- British spelling (organise, colour, behaviour, -ise not -ize).
- \`-\` bullet lists; inline \`code spans\` (backticks) for identifiers/values/commands
  (e.g. \`where\`, \`manage database-family\`, \`grp_serviceowner\`, \`read all-resources\`).
- No greetings/sign-offs unless my real messages have them ("Hi team," / "Thanks!" — usually no).
- Leave minor informalities; don't over-polish.

## Hard NOs (AI tells to avoid)
- NO em-dashes. NO "Certainly / Sure / Here's / I'd be happy to / Let me…". NO over-hedging.
- NO uniform bullet headers or corporate scaffolding I don't use.
- Do NOT auto-correct my deliberate casualness (dont → don't).

## Real examples (FILL THIS IN — this matters more than the rubric)
Paste 5–15 of my ACTUAL messages here, grouped by recipient/app where useful
(or keep per-recipient files at \`voice/<recipient>.md\`). The agent should ALSO append a
new example here whenever I hand-write or correct a draft.

<!-- paste real examples below this line -->
`;

type ClaudeMcpServerConfig =
    | {
          type: "http";
          url: string;
          headers?: Record<string, string>;
      }
    | {
          command: string;
          args?: string[];
          env?: Record<string, string>;
      };

function nonEmptyRecord(rec: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!rec) return undefined;
    const entries = Object.entries(rec).filter(([k, v]) => k.trim() && v.trim());
    return entries.length ? Object.fromEntries(entries) : undefined;
}

function nonEmptyArgs(args: string[] | undefined): string[] | undefined {
    const cleaned = (args ?? []).map((a) => a.trim()).filter(Boolean);
    return cleaned.length ? cleaned : undefined;
}

function toClaudeMcpServerConfig(server: McpServerSettings): ClaudeMcpServerConfig | null {
    if (!server.enabled) return null;
    if (server.transport === "http") {
        const url = server.url?.trim();
        if (!url) return null;
        const headers = nonEmptyRecord(server.headers);
        return { type: "http", url, ...(headers ? { headers } : {}) };
    }

    const command = server.command?.trim();
    if (!command) return null;
    const args = nonEmptyArgs(server.args);
    const env = nonEmptyRecord(server.env);
    return { command, ...(args ? { args } : {}), ...(env ? { env } : {}) };
}

function mcpServerKey(id: string, used: Set<string>): string {
    const base =
        id
            .trim()
            .replace(/[^a-z0-9_-]+/gi, "-")
            .replace(/^-+|-+$/g, "") || "server";
    let key = base;
    let n = 2;
    while (used.has(key)) key = `${base}-${n++}`;
    used.add(key);
    return key;
}

export function buildClaudeMcpServers(extraServers: McpServerSettings[] | undefined, mcpUrl: string): Record<string, ClaudeMcpServerConfig> {
    const out: Record<string, ClaudeMcpServerConfig> = {
        pikvm: { type: "http", url: mcpUrl },
    };
    const used = new Set(Object.keys(out));
    for (const server of extraServers ?? []) {
        const cfg = toClaudeMcpServerConfig(server);
        if (!cfg) continue;
        out[mcpServerKey(server.id || server.name, used)] = cfg;
    }
    return out;
}

export function writeClaudeConfig(opts: ClaudeConfigOpts): void {
    const { vaultPath, port, hookPath } = opts;
    const node = opts.nodeBin || process.execPath;
    const mcpUrl = `http://127.0.0.1:${port}/_agent/mcp${opts.mcpToken ? `?pikvm_mcp_token=${encodeURIComponent(opts.mcpToken)}` : ""}`;
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(join(vaultPath, ".claude"), { recursive: true });

    // .mcp.json — PiKVM plus the enabled MCP servers from Settings. This is a
    // Claude project config, so app-only fields (rawToolNames/skill/etc.) are not written.
    writeFileSync(
        join(vaultPath, ".mcp.json"),
        JSON.stringify({ mcpServers: buildClaudeMcpServers(opts.mcpServers, mcpUrl) }, null, 2),
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
    const deny: string[] = settings.permissions.deny || [];
    for (const t of ["mcp__claude_ai_Gmail__*"]) {
        if (!deny.includes(t)) deny.push(t);
    }
    settings.permissions.deny = deny;
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
    // existing vault CLAUDE.md; we add or refresh just our block. (Claude Code reads CLAUDE.md.)
    writeMarkedDoc(join(vaultPath, "CLAUDE.md"), CLAUDE_MD);

    // Seed a voice style-card the agent reads when composing in the user's voice. Created
    // ONCE and never overwritten — the user + agent fill it with real examples over time.
    const styleCard = join(vaultPath, "voice", "style-card.md");
    if (!existsSync(styleCard)) {
        mkdirSync(join(vaultPath, "voice"), { recursive: true });
        writeFileSync(styleCard, STYLE_CARD_TEMPLATE);
    }
}

/** Add/refresh OUR block inside a markdown doc without clobbering the user's content. */
function writeMarkedDoc(path: string, body: string): void {
    const START = "<!-- PIKVM:START -->";
    const END = "<!-- PIKVM:END -->";
    const block = `${START}\n${body}${END}\n`;
    let md = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (md.includes(START) && md.includes(END)) {
        md = md.replace(new RegExp(`${START}[\\s\\S]*?${END}\\n?`), block);
    } else {
        md = md ? `${md.trimEnd()}\n\n${block}` : block;
    }
    writeFileSync(path, md);
}

/**
 * Codex and opencode read AGENTS.md from the project root (the vault) for project
 * instructions. Give them the SAME operating manual Claude gets via CLAUDE.md, so every
 * agent drives the KVM the same way. The pikvm MCP itself is wired per-agent elsewhere
 * (codex via -c launch arg, opencode via opencode.json).
 */
export function writeAgentsMd(vaultPath: string): void {
    mkdirSync(vaultPath, { recursive: true });
    writeMarkedDoc(join(vaultPath, "AGENTS.md"), CLAUDE_MD);
}
