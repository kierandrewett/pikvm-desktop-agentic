/**
 * The embedded Pi agent runner.
 *
 * Wires the Pi `Agent` loop to the PiKVM control core, the ChatGPT-subscription
 * auth, the operation reviewer, and the presence-DND gate. Exposes a small
 * control surface the UI bridge and slash commands drive.
 */

import {
    Agent,
    estimateContextTokens,
    estimateTokens,
    shouldCompact,
    generateSummary,
    DEFAULT_COMPACTION_SETTINGS,
    type AgentEvent,
    type AgentMessage,
    type AgentTool,
    type AgentToolResult,
    type AgentLoopTurnUpdate,
} from "@earendil-works/pi-agent-core";
import { getModel, getModels, registerBuiltInApiProviders, Type, type Model, type ImageContent } from "@earendil-works/pi-ai";
import { resolve, dirname } from "path";
import { PiKvmControl } from "../pikvm-control";
import { OperationReviewer, SUBMIT_KEYS, type Operation } from "../reviewer";
import { PresenceMonitor } from "../presence";
import { CodexAuth } from "./auth";
import { createTools } from "./tools";
import { createExtraTools } from "./extra-tools";
import { BackgroundTasks } from "./background";
import { ScreenshotHistory } from "./screenshot-history";
import { Scheduler, type Job } from "./scheduler";
import { MemoryStore, type Memory } from "./memory";
import { SkillStore } from "./skills";
import { LocalOcr } from "./local-ocr";
import { RegionSegmenter, type RegionsResult } from "./regions";
import type { InputTracker } from "../input-tracker";
import type { SecretsStore } from "../secrets";
import { SessionStore, agentMessagesToUi, type SessionMeta } from "./sessions";
import type { PiKvmUIMessage } from "./protocol";
import { decideModelTier, type ModelTier, type TurnSummary } from "./model-router";

registerBuiltInApiProviders();

const PROVIDER = "openai-codex";
/** Default model for the main chat loop — capable by default (the "reasoning" tier). */
const DEFAULT_MODEL = "gpt-5.5";
/**
 * Fast/cheap model for routine, mechanical tool-driving turns (the "fast" tier).
 *
 * NB: the brief asked for something like Kimi K2.6 here. Kimi IS in pi-ai's model
 * catalogue, but only under the `moonshot`/`moonshotai`/`workers-ai` providers —
 * it is NOT reachable through `openai-codex` (the ChatGPT-subscription auth this
 * app uses). The only models the Codex subscription exposes are
 * gpt-5.3-codex-spark (text-only — unusable here, the agent needs vision), gpt-5.4,
 * gpt-5.4-mini and gpt-5.5. So the cheapest AVAILABLE fast+vision model is
 * gpt-5.4-mini ($0.75/$4.5 vs gpt-5.5's $5/$30), which we use for the fast path.
 */
const FAST_MODEL = "gpt-5.4-mini";
/** Model sub-agents use for hard thinking / deep work. */
const SUBAGENT_MODEL = "gpt-5.5";
/** Cheap model for naming conversations (titles refresh as the chat shifts). */
const TITLE_MODEL = "gpt-5.4-mini";
/** Cheap model for recognising the foreground app + sensitive contexts. */
const CONTEXT_MODEL = "gpt-5.4-mini";
/** Cheap/low-latency vision model for segmenting the screen into labelled regions. */
const REGION_MODEL = "gpt-5.4-mini";
const CONTEXT_SYSTEM =
    'You identify the foreground application/window on a screen and whether the CURRENT focus is a SENSITIVE area - one where an accidental click or keypress could send/post something or be hard to undo: a chat or message compose box or its Send/Reply button (Microsoft Teams, Slack, Discord, WhatsApp, Outlook/Gmail compose), a social-media post box, a Submit/Post/Pay/Confirm button, a checkout/payment field, or a terminal/command prompt. Normal navigation, reading, menus, file browsers and form fields that only stage input are NOT sensitive. Reply with ONLY compact JSON: {"app":"<short app or window name>","sensitive":true|false,"reason":"<at most 8 words>"}.';
/** Optical read-back of a cropped text field for watched typing (independent of the
 *  intended text, so it can't be biased into "confirming" a match). */
const OPTICAL_READ_SYSTEM =
    "You are a precise OCR engine. The image is a cropped UI text field. Output ONLY the exact characters currently shown inside that field, verbatim — no quotes, no labels, no commentary. If the field appears empty, output nothing.";
/** Tools that actuate input on the target (gated harder in sensitive areas). */
const INPUT_ACTIONS = new Set(["click", "double_click", "drag", "type_text", "type_secret", "press_key", "hotkey"]);
/** How long a context assessment stays fresh before we re-look. */
const CONTEXT_TTL_MS = 12_000;
const TITLE_SYSTEM =
    "You name conversations. Given a transcript between a user and a computer-use agent driving a remote PC, reply with a SHORT title (3 to 6 words, Title Case, no quotes, no trailing punctuation) describing what the conversation is CURRENTLY about. If the focus has shifted, name the current focus. Output ONLY the title.";

/**
 * Tools the meeting copilot may use. READ-ONLY + cognitive ONLY — it observes
 * (screen/transcript), researches (web/memory), and notifies the user. It can
 * NEVER touch the mouse/keyboard or otherwise actuate the target machine. This is
 * enforced three ways: this allowlist, a beforeToolCall hard-block, and the prompt.
 */
const READ_ONLY_MEETING_TOOLS = new Set(["screenshot", "read_transcript", "web_search", "fetch_url", "recall", "remember", "search_conversations", "recall_meetings", "notify_user"]);

const MEETING_PROMPT = [
    "You are a live meeting copilot embedded on the user's screen during a real meeting happening RIGHT NOW.",
    "YOU ARE STRICTLY READ-ONLY. You can OBSERVE the screen (screenshot) and the live transcript (read_transcript), RESEARCH (web_search/fetch_url), and recall/remember notes (recall/remember/search_conversations). You CANNOT and MUST NOT control the mouse or keyboard, click, type, or take ANY action on the machine — you only watch and advise. If something needs doing, tell the user via `suggest`; never attempt it yourself.",
    "Your job: genuinely help the user in the moment. When something high-value comes up — a question you can answer, a claim worth verifying, a strong point to make, a number/fact to cite, or an action item — do any quick research first, then call `suggest` with a SHORT (1–2 line) nudge.",
    "Be a real assistant, not a narrator: USE your tools when they make the help materially better (e.g. web_search to check a figure, recall to pull prior context about a person/project). Don't ask permission — just do the research and suggest. But be efficient: speed matters in a live meeting — a single web_search is almost always enough for a fact; don't re-search the same thing or over-research the obvious.",
    "Most of the time, stay silent — only surface non-obvious, immediately useful help. Never call `suggest` with filler, summaries of the obvious, or 'you could say hello'. Quality over quantity.",
    "Keep every suggestion terse and immediately usable. When the user asks you something directly, always answer (after researching if useful).",
].join(" ");

function meetingActivityLabel(tool: string): string {
    switch (tool) {
        case "web_search":
        case "fetch_url":
            return "🔎 searching the web…";
        case "recall":
        case "search_conversations":
            return "📓 recalling context…";
        case "remember":
            return "📌 noting that down…";
        case "screenshot":
            return "👀 reading the screen…";
        case "read_transcript":
            return "🎧 reviewing the transcript…";
        case "notify_user":
            return "🔔 sending you a notification…";
        default:
            return `… ${tool}`;
    }
}

function systemPrompt(goal?: string, memoryCount = 0): string {
    return [
        "You operate a real computer through a PiKVM, as if you were a careful human at the keyboard and mouse.",
        "",
        "Loop: call `screenshot` to see the screen, decide ONE next action, perform it, then screenshot again to verify before continuing.",
        "Coordinates are in the pixels of the most recent screenshot. Re-screenshot after anything that changes the screen (scroll, navigation, window changes).",
        "KNOW WHERE YOU ARE: the screen is automatically segmented into labelled regions — call `get_regions` to see the windows, the host taskbar, an embedded emulator (e.g. an AVD), terminals, browsers and panels as boxes in full-frame pixels. Use it to tell, for instance, whether a coordinate is on the host taskbar versus inside the AVD versus a terminal, and to find a window's bounds before clicking or cropping. The map refreshes as the layout changes; if you just changed the screen, screenshot first.",
        "Type with `type_text` (it already feels human — do not add your own delays). Use `press_key`/`hotkey` for keys and shortcuts.",
        "HARD RULE — TYPING NEVER SUBMITS: `type_text` is for a SINGLE LINE of text and NEVER presses Enter (any newline you pass is collapsed to a space). Pressing Enter could send a chat message, run a command, or confirm a dialog before you have checked it — so submitting is ALWAYS a separate, deliberate `press_key('Enter')` AFTER you have OCR-verified the field. Do not put `\\n` in `type_text`. For multi-line content (a note, an email body, code), open a scratchpad like Notepad, type/build it there, then select-all and copy/paste into the target — never type raw newlines into the real field.",
        "KNOW WHERE THE CARET IS BEFORE TYPING: typing inserts at the current caret, which is NOT always where you think — a field may have existing text with the caret at the start, or text may be selected. Before typing into an existing field, look: `ocr`/zoomed `screenshot` to see the current contents and caret. To append, click at the end (or press End / Ctrl+End) first; to replace, select all (Ctrl+A) then type. If asked to \"finish\" or continue existing text, confirm the caret is at the END first — never assume.",
        "WATCH WHAT YOU TYPE: pass `verify_region` (a tight box around the field) to `type_text` — it reads the field back with fast local OCR after typing and SELF-CORRECTS once if needed, clearing the line the safe way (Home, then Delete) before retyping. Trust it: do NOT manually clear-and-retype on top of it. NEVER use Ctrl+A to clear in a terminal (Ctrl+A goes to line-start and you type over the existing text → duplicated commands like `git swgit switch`), and NEVER Ctrl+C to 'clear' a GUI field. If after a type something still looks wrong, take a tight `screenshot` to confirm, then clear with Home followed by Delete (or, in a shell, Ctrl+U) and retype once — don't loop.",
        "PROOFREAD AS YOU TYPE for anything longer than ~4-5 words: do NOT type a long string blind and only check at the end. Break it into chunks of a few words, type each chunk in the BACKGROUND (`type_text` background:true, then `wait_for_task`/`list_tasks` so you stay responsive), and between chunks glance up from the keyboard like a person would — `ocr` what you have written so far, check it matches, fix any mistake (backspace/clear and retype) before typing the next chunk. The longer the text, the more often you should stop and check.",
        "VERIFY BEFORE YOU COMMIT: before you press Enter, click Submit/Send/Save/Run, or otherwise confirm anything you typed into a field, FIRST `ocr` the field to read back exactly what is there (get close — take a cropped `screenshot` zoomed tight on just that field/line so the OCR is accurate, not the whole screen). Compare it character-for-character with what you intended. If it does not match (wrong characters, a mangled symbol from a keyboard-layout mismatch, autocomplete/autocorrect changing it, missing or extra text), fix it — clear the field or backspace and retype — and OCR again. Only press Enter/confirm once the read-back matches. This matters most for commands, paths, URLs, passwords and anything with symbols like ~, /, \\, \", @, #.",
        "DON'T FIGHT OCR GHOSTS: screenshots and OCR genuinely cannot tell apart look-alike glyphs — l/1/I/|, O/0, S/5, B/8, Z/2, g/9/q, rn/m. If your typed text and the read-back differ ONLY by such characters (e.g. you typed `oel9-linux-build` and it reads `oe19-linux-build`), that is almost certainly a READING artefact, not a typing error — the text on screen is right. Do NOT clear and retype, and do NOT keep re-reading; just proceed (press Enter / run it). Only correct when characters differ in a way OCR could NOT explain (extra/missing words, a wrong symbol from a layout slip, clearly different letters). When genuinely unsure between 'misread' and 'mistyped', zoom in tighter ONCE — never destroy the line on a hunch.",
        "If symbols keep coming out wrong (e.g. ~ types as ¬, \" types as @), the target's keyboard layout does not match what you send. You can fix the target itself: press Win+Space to cycle input layouts, or open the OS keyboard/language settings and set the layout — you are allowed to configure the target system's settings yourself. See the `fix-keyboard-layout` skill, and `remember` which layout this machine uses.",
        "CLICKING HAS SIDE EFFECTS — only click when you have confirmed exactly what is under the pointer (a specific button, link, menu item or field). If you merely want to hover, position, or reveal something, use `move_mouse`, not `click`. When unsure what an element is, screenshot/zoom to confirm before clicking.",
        "To focus or raise a window, click its TASKBAR/DOCK entry or its TITLEBAR — never click a random spot inside the window, which can trigger a control, move a caret, or deselect something. Only click inside a window's content when you are intentionally activating a specific element there.",
        "Never assume what an icon or button does. Reveal tooltips (hover and wait, or hold Alt), expand sidebars/menus, OCR labels, or `web_search` how the app works BEFORE interacting (see the `understand-ui` skill). Prefer reversible exploration; if you are genuinely unsure how an app works after doing your due diligence, ASK THE USER. When clicking, aim for a natural point within an element, not always its exact centre.",
        "Actively arrange the screen so you can SEE what you need: maximize/restore windows (titlebar button or double-click the titlebar), scroll within any scrollable area, resize windows/panes by dragging edges, switch tabs, and expand collapsed sections. If something is cut off or hard to read, change the view rather than guessing.",
        "For dense or small text where accuracy matters (calendars, tables, lists, code, dialog text), DO NOT guess from the full screenshot — `ocr` the relevant region and/or take a cropped `screenshot` to zoom in, and re-check before stating any facts. If unsure, zoom further rather than guessing.",
        "NEVER assume or approximate. Find absolute answers: exact dates, exact times (e.g. 13:15, not '~13:15'), exact names, numbers and statuses, read directly from the screen. If you need an exact value (e.g. when an event is), open/expand the item to read its real details rather than estimating from a calendar grid. If you genuinely cannot determine something precisely, say so explicitly — do not fabricate a plausible value.",
        "You can also `drag` (drag-and-drop, sliders, selections) and `scroll` (trackpad-like) — move the cursor over the right area before scrolling.",
        "Use `recent_activity` to see what's already been typed (including by the user) before continuing a field.",
        "PASSWORDS & SECRETS: never ask the user to tell you a password and never type a credential you somehow know. If a login/password/PIN field needs filling, call `list_secrets` to see what the user has saved — each comes with a usage hint telling you when/where it applies (e.g. 'Windows lock screen, PIN option') — pick the one whose hint matches the current screen, focus the field, then `type_secret` with that name — the value is entered for you and you never see it. If no suitable secret exists, tell the user to add one in Settings → Secrets rather than guessing.",
        "Only your most recent screenshots stay visible; older ones appear as placeholders with an id (e.g. s4). If you need to recover an earlier state, call `view_screenshot` with that id to see it again.",
        "Work in small, verifiable steps. If something looks wrong, stop and re-observe rather than guessing.",
        "LEAVE NO TRACE: when you finish, tidy up after yourself — close any windows, dialogs, terminals or apps you opened (e.g. winver/About, Run, command prompts, settings panes), discard scratch text you typed, and return the screen roughly to how you found it. Do not close windows the user already had open.",
        "APPROVAL: before ANY action that other people would see or experience, call `request_approval` with a short description and WAIT for the user's decision before doing it. This includes: sending an email, message, chat or DM; joining or starting a meeting/call; posting or commenting; submitting a form; replying or forwarding; sharing; editing or saving a shared/cloud document; accepting/declining invites; making a purchase; or anything with an outward side effect. Also pause before destructive/irreversible actions (deleting data, rebooting, privileged commands). Reading, navigating, searching and drafting (without sending) do NOT need approval. The app you are in is recognised automatically, and acting inside a SENSITIVE area (a chat/message compose box or Send button — Teams, Slack, email — a Post/Submit/Pay button, or a terminal) will require the user's approval even for a click or keypress; expect that and do not fight it. When you are in such a place, prefer to draft and then ask.",
        "",
        "You also have cognitive tools: `web_search`/`fetch_url` for the internet, `remember`/`recall` for long-term memory across sessions, `search_conversations` to look up past sessions, `list_skills`/`use_skill` for reusable playbooks, and `spawn_subagent` to delegate a focused side-task to a fresh sub-agent.",
        "PICK THE RIGHT RESEARCH TOOL — bias to the quick one. For anything you'd normally just KNOW or look up in a couple of seconds (a command's flags, a syntax detail, a definition, what an error means, a config key, 'how do I do X in app Y'), use the fast `web_search`/`fetch_url` tools DIRECTLY — don't open a browser for things off the top of your head; it's slower and wasteful. Only drive the browser ON THE KVM when the research is genuinely involved or needs a verifiable PAPER TRAIL: comparing multiple sources, reading long / logged-in / interactive pages, or gathering evidence you'll act on or be asked to justify ('show your working'). When you do need it, drive it like a person — open the browser, type the query, Enter, then `screenshot`/`ocr` the results and open the best one. Default to `web_search`; escalate to the KVM browser when the task actually warrants it. See the `web-research` skill.",
        "For questions about internal corporate processes/policies, use Neo (neo.capgemini.com) in the target's browser — see the `neo-corporate-help` skill.",
        "You can schedule yourself with `schedule_task` (one-shot atTime, or recurring everyMinutes, with an optional afterTime/beforeTime window) and manage with `list_schedules`/`cancel_schedule`. For idle detection, see the `detect-inactivity` skill.",
        "WRITE TO MEMORY CONSTANTLY — it is cheap, use it liberally, all the time, not just for big things. Whenever you notice or learn ANYTHING that could matter later, save it: how an app/process/workflow works, where things live, the exact steps that worked, quirks and gotchas, names/IDs/paths/URLs/window titles, the user's preferences and choices, who people are, what a button or screen does, what failed and why, small details you spotted in a screenshot. Save it the moment you learn it, in your own words, specific and self-contained. Before starting anything non-trivial, recall first to reuse what you already know. Err heavily towards over-remembering; a useless note costs nothing, a lost one costs a repeat mistake.",
        "YOUR MEMORY IS AN ATLAS VAULT (markdown). If `atlas_page`/`atlas_search`/`atlas_query` tools are present, that is your long-term memory — a git-backed vault of markdown pages. Read the `atlas-vault` skill (or the `atlas://skill` resource) ONCE first to learn how it works. To save: `atlas_page` action=create (path under `memory/`, e.g. `memory/<topic>.md`, with a title), then action=update/edit to write the body; group related notes on one page and append with `edit` rather than spawning many tiny pages. To recall: `atlas_search` (text=...) or `atlas_query` (read `atlas://index/schema` for tables/columns; if results look stale or empty, run `atlas_health` to reindex, then retry). NOTE: `remember` now write-throughs into this same vault automatically (it mirrors the fact to a quick-capture page under `memory/notes/` and reindexes), so anything you `remember` lands in Atlas — use it freely for fast capture. Reach for `atlas_page` directly when you want to curate a structured topic page instead of a one-off note.",
        memoryCount > 0 ? `You have ${memoryCount} saved memories — use \`recall\` when prior context might help.` : "",
        goal ? `\nStanding goal for this session:\n${goal}` : "",
    ]
        .filter(Boolean)
        .join("\n");
}

const SUBAGENT_PROMPT =
    "You are a focused sub-agent. Complete the given task using your tools, then reply with a concise result for the parent agent. Be thorough but brief.";

export interface RunnerDeps {
    control: PiKvmControl;
    reviewer: OperationReviewer;
    presence: PresenceMonitor;
    auth: CodexAuth;
    sessionsDir: string;
    inputTracker?: InputTracker;
    secrets?: SecretsStore;
    /** Push a notification to the user (ntfy), wired in main. */
    notify?: (message: string, opts: { title?: string; priority?: "default" | "high" | "urgent" }) => Promise<{ sent: boolean; reason?: string }>;
    /** Read the rolling local meeting transcript, wired in main. */
    getTranscript?: () => string;
    /** Recent meetings for the recall_meetings tool, wired in main. */
    getMeetings?: () => { title: string; startTs: number; endTs: number; suggestions: { text: string }[]; transcript: string }[];
}

export class AgentRunner {
    readonly agent: Agent;
    private goal: string | undefined;
    private model: Model<any>;
    private modelId = DEFAULT_MODEL;
    /* ----- per-turn model routing (reasoning vs cheap tool-calling) ----- */
    /** Whether to route each turn dynamically. When off, every turn uses `model`. */
    private routingEnabled = true;
    /** Model id used for the "reasoning" tier. Mirrors the main `modelId`. */
    private reasoningModelId = DEFAULT_MODEL;
    /** Model id used for the "fast" tier (routine tool-driving turns). */
    private fastModelId = FAST_MODEL;
    /** Resolved (auth-applied) model objects per tier, rebuilt when ids change. */
    private reasoningModel: Model<any> | undefined;
    private fastModel: Model<any> | undefined;
    /** The tier the most recent routed turn ran on — surfaced for observability. */
    private lastTier: ModelTier = "reasoning";
    private loopController: { stop: () => void } | undefined;
    private readonly sessions: SessionStore;
    private readonly memory: MemoryStore;
    private readonly skills: SkillStore;
    private readonly scheduler: Scheduler;
    private readonly background = new BackgroundTasks();
    private readonly screenshots = new ScreenshotHistory();
    /** In-process OCR for watched typing's fast read-back path. */
    private readonly localOcr = new LocalOcr();
    /** Change-gated, LLM-driven segmentation of the screen into labelled regions. */
    private readonly regions = new RegionSegmenter({
        segment: (image, instruction, system) => this.quickLook(image, instruction, { model: REGION_MODEL, thinking: "low", system }),
    });
    private readonly toolsForSub: AgentTool<any>[];
    private readonly subModel: Model<any>;
    private sessionId: string;

    constructor(private deps: RunnerDeps) {
        this.model = deps.auth.applyModel(getModel(PROVIDER as any, DEFAULT_MODEL as any));
        this.subModel = deps.auth.applyModel(getModel(PROVIDER as any, SUBAGENT_MODEL as any));
        // Warm the OCR worker so the first watched-type isn't blocked on a cold start.
        this.localOcr.warm();
        // The reasoning tier is the main model; resolve the fast tier up front.
        this.reasoningModel = this.model;
        this.fastModel = this.resolveModel(FAST_MODEL);
        const dataDir = dirname(deps.sessionsDir);
        this.sessions = new SessionStore(deps.sessionsDir);
        this.memory = new MemoryStore(resolve(dataDir, "agent-memory.json"));
        this.skills = new SkillStore(resolve(dataDir, "agent-skills"));
        this.scheduler = new Scheduler(resolve(dataDir, "agent-schedules.json"), (task, label) => this.runScheduled(task, label));
        this.scheduler.start();
        // Resume the most recent session on startup so context survives restarts.
        const recent = this.sessions.list();
        this.sessionId = recent.length ? recent[0]!.id : this.sessions.create();

        const toolDeps = {
            background: this.background,
            history: this.screenshots,
            ...(deps.inputTracker ? { tracker: deps.inputTracker } : {}),
            ...(deps.secrets ? { secrets: deps.secrets } : {}),
            // Watched typing reads a cropped field back: fast LOCAL OCR (tesseract.js,
            // in-process, ~300ms, no Pi load / no network) as the common path, and the
            // vision model only to confirm a suspected mismatch. Falls back to vision
            // if local OCR is unavailable (e.g. language data not fetched yet).
            opticalRead: async (image: { data: string; mimeType: string }) => {
                const local = await this.localOcr.read(image);
                if (local !== null) return local;
                return this.visionRead(image);
            },
            opticalReadStrong: (image: { data: string; mimeType: string }) => this.visionRead(image),
            // Spatial map of the screen (LLM-segmented, change-gated) so the agent
            // can reason about WHERE it is - host taskbar vs inside the AVD vs a
            // terminal. Returns the cached regions; never blocks on a model call.
            getRegions: () => this.regions.getRegions(),
            remember: (text: string) => {
                try {
                    this.memory.add(text, ["keyboard-layout"]);
                } catch {
                    /* best-effort */
                }
            },
        };

        // Tools a sub-agent gets: computer-use + cognitive, minus spawn (no recursion).
        const extra = createExtraTools({
            memory: this.memory,
            skills: this.skills,
            sessions: this.sessions,
            scheduler: this.scheduler,
            runSubagent: (task, signal) => this.runSubagent(task, signal),
            ...(deps.notify ? { notifyUser: deps.notify } : {}),
            ...(deps.getTranscript ? { getTranscript: deps.getTranscript } : {}),
            ...(deps.getMeetings ? { getMeetings: deps.getMeetings } : {}),
        });
        this.toolsForSub = [...createTools(deps.control, toolDeps), ...extra.filter((t) => t.name !== "spawn_subagent")];

        this.agent = new Agent({
            initialState: {
                systemPrompt: systemPrompt(undefined, this.memory.count()),
                model: this.model,
                thinkingLevel: "medium",
                tools: [...createTools(deps.control, toolDeps), ...extra],
            },
            getApiKey: async () => {
                try {
                    return await deps.auth.getToken();
                } catch {
                    return undefined;
                }
            },
            sessionId: "pikvm-agent",
            beforeToolCall: async (ctx, signal) => this.gate(ctx.toolCall.name, ctx.args, signal),
            prepareNextTurn: () => this.maybeCompact(),
            // Keep only the most recent screenshots in context — old frames are
            // stale and were the main token cost. The agent re-screenshots as needed.
            transformContext: async (messages) => this.pruneOldImages(messages),
        });

        // Restore the resumed session's transcript so the agent keeps its context.
        const restored = this.sessions.load(this.sessionId);
        if (restored.length) this.agent.state.messages = restored as any;

        // Auto-save the transcript whenever a run finishes.
        this.agent.subscribe((e) => {
            if (e.type === "agent_end") {
                this.persist();
                this.maybeRetitle();
            }
        });
    }

    /**
     * Add extra tools at runtime (the Atlas vault MCP tools connect asynchronously
     * after the agent is built). Available to the main agent and to sub-agents.
     */
    addTools(tools: AgentTool<any>[]): void {
        if (!tools.length) return;
        this.toolsForSub.push(...tools);
        this.agent.state.tools = [...this.agent.state.tools, ...tools];
    }

    /**
     * Write-through every `remember` (and internal memory save) into the Atlas
     * vault, so saving a fact and updating the knowledgebase are one action.
     */
    setMemoryMirror(mirror: (m: Memory) => void): void {
        this.memory.onAdd = mirror;
    }

    /* ----------------------------- scheduler ---------------------------- */

    /** Notified (by the server) whenever an autonomous run updates the UI transcript. */
    onUiChanged: (() => void) | undefined;

    /** Fired by the scheduler when a job is due. Skips if already busy. */
    private runScheduled(task: string, label: string): void {
        if (this.agent.state.isStreaming || this.pausedForUser) return;
        void this.runAutonomous(task, label);
    }

    /**
     * Run a task with no client stream attached (scheduled/autonomous), building
     * the UI transcript ourselves and persisting it so the sidebar can show the
     * full flow — screenshots, reasoning, tools — exactly like a normal turn.
     */
    private async runAutonomous(task: string, label: string, opts?: { trigger?: string; prompt?: string }): Promise<void> {
        const imageOf = (r: any) => {
            const c = r?.content;
            const img = Array.isArray(c) ? c.find((x: any) => x?.type === "image" && x.data) : undefined;
            return img ? { data: img.data, mimeType: img.mimeType ?? "image/jpeg" } : undefined;
        };
        const textOf = (r: any) =>
            Array.isArray(r?.content)
                ? r.content.filter((x: any) => x?.type === "text").map((x: any) => x.text).join(" ")
                : "";

        const base = this.sessions.loadUi(this.sessionId);
        const trigger: any = { id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text: opts?.trigger ?? `⏰ Scheduled: ${label}` }] };
        const assistant: any = { id: `a-${Date.now()}`, role: "assistant", parts: [] };
        let curText: any = null;
        let curThink: any = null;
        const persist = () => {
            this.sessions.saveUi(this.sessionId, [...base, trigger, assistant]);
            this.onUiChanged?.();
        };

        const unsub = this.agent.subscribe((e: any) => {
            if (e.type === "message_update") {
                const ev = e.assistantMessageEvent;
                if (!ev) return;
                if (ev.type === "text_delta") {
                    if (!curText) { curText = { type: "text", text: "" }; assistant.parts.push(curText); curThink = null; }
                    curText.text += ev.delta ?? "";
                    persist();
                } else if (ev.type === "text_end") curText = null;
                else if (ev.type === "thinking_delta") {
                    if (!curThink) {
                        curThink = { type: "data-thinking", data: { id: `t${assistant.parts.length}`, text: "" } };
                        assistant.parts.push(curThink);
                        curText = null;
                    }
                    curThink.data.text += ev.delta ?? "";
                    persist();
                } else if (ev.type === "thinking_end") {
                    if (curThink) curThink.data.done = true;
                    curThink = null;
                }
            } else if (e.type === "tool_execution_start") {
                assistant.parts.push({ type: "dynamic-tool", toolName: e.toolName, state: "input-available", input: e.args });
                curText = null;
                curThink = null;
                persist();
            } else if (e.type === "tool_execution_end") {
                const img = imageOf(e.result);
                if (img && e.toolName === "screenshot") {
                    assistant.parts.push({
                        type: "data-screenshot",
                        data: { toolCallId: e.toolCallId, src: `data:${img.mimeType};base64,${img.data}`, width: e.result?.details?.width ?? 0, height: e.result?.details?.height ?? 0 },
                    });
                }
                const tp = [...assistant.parts].reverse().find((p: any) => p.type === "dynamic-tool" && p.toolName === e.toolName && p.state === "input-available");
                if (tp) { tp.state = "output-available"; tp.output = { summary: textOf(e.result), isError: e.isError }; }
                persist();
            }
        });

        try {
            await this.agent.prompt(opts?.prompt ?? `[Scheduled task: ${label}] ${task}`);
        } catch {
            /* ignore */
        } finally {
            unsub();
            persist();
        }
    }

    listSchedules(): Job[] {
        return this.scheduler.list();
    }

    cancelSchedule(id: string): boolean {
        return this.scheduler.cancel(id);
    }

    /** The full UI transcript (with screenshots) for the current session. */
    currentUiMessages(): PiKvmUIMessage[] {
        return this.sessions.loadUi(this.sessionId);
    }

    /** Persist the sidebar's UI transcript (called by the renderer after turns). */
    saveUiMessages(messages: PiKvmUIMessage[]): void {
        this.sessions.saveUi(this.sessionId, messages);
    }

    /** Replace image data in all but the most recent few screenshots with a
     *  placeholder, so the model isn't re-sent the entire screen history. */
    private pruneOldImages(messages: AgentMessage[]): AgentMessage[] {
        try {
            const KEEP = 2;
            let kept = 0;
            const out = messages.slice();
            for (let i = out.length - 1; i >= 0; i--) {
                const m: any = out[i];
                if (!Array.isArray(m?.content) || !m.content.some((c: any) => c?.type === "image")) continue;
                if (kept < KEEP) {
                    kept++;
                    continue;
                }
                out[i] = {
                    ...m,
                    content: m.content.map((c: any) =>
                        c?.type === "image"
                            ? { type: "text", text: "[earlier screenshot omitted — call view_screenshot with the id shown to see it again]" }
                            : c,
                    ),
                };
            }
            return out;
        } catch {
            return messages;
        }
    }

    /* --------------------------- auto-compaction ------------------------- */

    /**
     * Per-turn hook: compact context if it's getting full, AND pick the model for
     * the next turn (reasoning vs fast). The low-level loop honours the returned
     * `model`, and keeps using it until we hand it another — so we set it EVERY
     * turn. The framework's `prepareNextTurn` wrapper hands us no turn context, so
     * we read the just-completed turn straight off the live transcript instead.
     */
    private async maybeCompact(): Promise<AgentLoopTurnUpdate | undefined> {
        const compaction = await this.compactContext(this.agent, this.model);
        const routedModel = this.routeNextTurnModel();
        if (!routedModel) return compaction;
        // Merge the routed model into whatever compaction returned (compaction may
        // also have replaced the context); never drop one for the other.
        return { ...(compaction ?? {}), model: routedModel };
    }

    /* --------------------------- model routing -------------------------- */

    /** Notified whenever a turn is routed, with the tier and model id chosen. */
    onModelRoute: ((info: { tier: ModelTier; modelId: string }) => void) | undefined;

    /**
     * Pick the model for the next turn from a summary of the turn that just
     * finished. Returns undefined when routing is off or the chosen model can't be
     * resolved (so the loop keeps its current model rather than breaking).
     */
    private routeNextTurnModel(): Model<any> | undefined {
        if (!this.routingEnabled) return undefined;
        const tier = decideModelTier(this.summariseLastTurn());
        this.lastTier = tier;
        const id = tier === "fast" ? this.fastModelId : this.reasoningModelId;
        const model = tier === "fast" ? this.fastModel : this.reasoningModel;
        if (!model) return undefined;
        try {
            this.onModelRoute?.({ tier, modelId: id });
        } catch {
            /* observer errors never affect the loop */
        }
        return model;
    }

    /**
     * Reduce the most recently completed assistant turn to the compact summary the
     * pure router consumes. Looks at the last assistant message (its text /
     * thinking / tool calls + stopReason) and the tool results that followed it.
     */
    private summariseLastTurn(): TurnSummary {
        const messages = this.agent.state.messages as any[];
        // Find the last assistant message — the turn that just completed.
        let ai = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]?.role === "assistant") {
                ai = i;
                break;
            }
        }
        if (ai < 0) return { isStart: true, hadError: false, assistantTextLength: 0, hadThinking: false, toolCallCount: 0 };

        const msg = messages[ai];
        const content = Array.isArray(msg?.content) ? msg.content : [];
        let assistantTextLength = 0;
        let hadThinking = false;
        let toolCallCount = 0;
        for (const c of content) {
            if (c?.type === "text") assistantTextLength += String(c.text ?? "").trim().length;
            else if (c?.type === "thinking") hadThinking = true;
            else if (c?.type === "toolCall") toolCallCount++;
        }
        // An error this turn = the assistant itself errored, or any tool result
        // after it failed (tool results sit after the assistant message).
        let hadError = msg?.stopReason === "error";
        for (let i = ai + 1; i < messages.length; i++) {
            const m = messages[i];
            if (m?.role === "toolResult" && m.isError === true) hadError = true;
        }
        return { isStart: false, hadError, assistantTextLength, hadThinking, toolCallCount };
    }

    /** Tool-pairing-safe context compaction for any agent (main, meeting, …). */
    private async compactContext(agent: Agent, model: Model<any>): Promise<AgentLoopTurnUpdate | undefined> {
        try {
            const messages = agent.state.messages;
            const { tokens } = estimateContextTokens(messages);
            const max = (model as any)?.contextWindow ?? 256_000;
            if (!shouldCompact(tokens, max, DEFAULT_COMPACTION_SETTINGS)) return undefined;

            // Keep the most recent messages; summarise everything before them.
            let acc = 0;
            let cut = messages.length;
            for (let i = messages.length - 1; i >= 0; i--) {
                acc += estimateTokens(messages[i]!);
                if (acc > DEFAULT_COMPACTION_SETTINGS.keepRecentTokens) {
                    cut = i + 1;
                    break;
                }
            }
            const older = messages.slice(0, cut);
            const keep = messages.slice(cut);
            if (older.length < 3) return undefined;

            const apiKey = await this.deps.auth.getToken();
            const res: any = await generateSummary(older as AgentMessage[], model, DEFAULT_COMPACTION_SETTINGS.reserveTokens, apiKey);
            const summary: string | null = res?.ok ? res.value : typeof res?.value === "string" ? res.value : null;
            if (!summary) return undefined;

            const summaryMsg: AgentMessage = {
                role: "user",
                content: `[Summary of earlier conversation]\n${summary}`,
                timestamp: Date.now(),
            } as AgentMessage;
            const compacted = [summaryMsg, ...keep];
            agent.state.messages = compacted;
            return {
                context: { systemPrompt: agent.state.systemPrompt, messages: compacted, tools: agent.state.tools },
            };
        } catch {
            return undefined;
        }
    }

    /* ------------------------------ subagents ---------------------------- */

    /** Run a focused sub-agent to completion and return its final answer. */
    private async runSubagent(task: string, signal?: AbortSignal): Promise<string> {
        const sub = new Agent({
            initialState: {
                systemPrompt: SUBAGENT_PROMPT,
                // Sub-agents use the stronger model + deeper thinking for hard work.
                model: this.subModel,
                thinkingLevel: "high",
                tools: this.toolsForSub,
            },
            getApiKey: async () => {
                try {
                    return await this.deps.auth.getToken();
                } catch {
                    return undefined;
                }
            },
            sessionId: `pikvm-subagent-${Date.now()}`,
            beforeToolCall: async (ctx, sig) => this.gate(ctx.toolCall.name, ctx.args, sig),
        });
        const onAbort = () => sub.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            await sub.prompt(task);
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }
        const last: any = [...sub.state.messages].reverse().find((m: any) => m.role === "assistant");
        const content = last?.content;
        if (typeof content === "string") return content;
        return (content ?? [])
            .filter((c: any) => c?.type === "text")
            .map((c: any) => c.text)
            .join("\n")
            .trim();
    }

    private persist(): void {
        const messages = this.agent.state.messages;
        if (messages.length) this.sessions.save(this.sessionId, messages as any);
    }

    /* --------------------------- session titles -------------------------- */

    private lastTitledCount = 0;
    private lastTitleAt = 0;
    private titling = false;

    /** Reset titling bookkeeping when the active session changes. */
    private resetTitleTracking(): void {
        this.lastTitledCount = 0;
        this.lastTitleAt = 0;
    }

    /** Regenerate the session title as the conversation grows/shifts: after the
     *  first exchange, then every few new messages, throttled so a multi-message
     *  turn coalesces into one cheap call. Best-effort and fully async. */
    private maybeRetitle(): void {
        const n = (this.agent.state.messages as any[]).filter((m) => m.role === "user" || m.role === "assistant").length;
        if (n < 2 || this.titling) return;
        const enoughNew = this.lastTitledCount === 0 || n - this.lastTitledCount >= 3;
        const enoughTime = Date.now() - this.lastTitleAt > 15_000;
        if (!enoughNew || !enoughTime) return;
        this.titling = true;
        this.lastTitledCount = n;
        this.lastTitleAt = Date.now();
        void this.summariseTitle().finally(() => {
            this.titling = false;
        });
    }

    /** Compact recent text transcript (no images/tools) for the titler. */
    private transcriptForTitle(): string {
        const lines: string[] = [];
        for (const m of this.agent.state.messages as any[]) {
            if (m.role !== "user" && m.role !== "assistant") continue;
            const text =
                typeof m.content === "string"
                    ? m.content
                    : (m.content ?? [])
                          .filter((c: any) => c?.type === "text")
                          .map((c: any) => c.text)
                          .join(" ");
            const t = String(text).replace(/\s+/g, " ").trim();
            if (t) lines.push(`${m.role === "user" ? "User" : "Agent"}: ${t.slice(0, 240)}`);
        }
        return lines.slice(-14).join("\n").slice(-2400);
    }

    private cleanTitle(s: string): string {
        let t = s
            .replace(/^\s*title\s*[:\-]\s*/i, "")
            .replace(/^["'`]+|["'`]+$/g, "")
            .replace(/\s+/g, " ")
            .replace(/[.\s]+$/, "")
            .trim();
        const words = t.split(" ");
        if (words.length > 7) t = words.slice(0, 7).join(" ");
        return t.slice(0, 60);
    }

    /** One cheap, tool-less Pi turn that names the conversation, then stores it. */
    private async summariseTitle(): Promise<void> {
        const sid = this.sessionId;
        const transcript = this.transcriptForTitle();
        if (!transcript) return;
        let model = this.subModel;
        try {
            model = this.deps.auth.applyModel(getModel(PROVIDER as any, TITLE_MODEL as any));
        } catch {
            model = this.subModel; // unknown id → fall back to a known model
        }
        try {
            const agent = new Agent({
                initialState: { systemPrompt: TITLE_SYSTEM, model, thinkingLevel: "low", tools: [] },
                getApiKey: async () => {
                    try {
                        return await this.deps.auth.getToken();
                    } catch {
                        return undefined;
                    }
                },
                sessionId: `pikvm-title-${Date.now()}`,
            });
            await agent.prompt(`Conversation so far:\n\n${transcript}\n\nReturn the title now.`);
            const last: any = [...agent.state.messages].reverse().find((m: any) => m.role === "assistant");
            const c = last?.content;
            const raw = typeof c === "string" ? c : (c ?? []).filter((x: any) => x?.type === "text").map((x: any) => x.text).join(" ");
            const title = this.cleanTitle(raw);
            if (title) {
                this.sessions.setTitle(sid, title);
                this.onUiChanged?.(); // nudge the UI to refetch the session list
            }
        } catch {
            /* best-effort: a missing title is harmless */
        }
    }

    /* ------------------------- ambient (one-shot) ------------------------ */

    /**
     * A single, tool-less harness turn over a frame with a chosen model — used by
     * the ambient monitor so all of its intelligence still flows through Pi
     * (cheap model for triage, a stronger one when it matters). Returns the
     * model's raw text. Never throws (returns "" on failure).
     */
    /** Read a cropped field with the vision model (watched typing's confirm path). */
    private visionRead(image: { data: string; mimeType: string }): Promise<string> {
        return this.quickLook(image, "Transcribe the text shown in this UI field exactly.", {
            model: "gpt-5.4-mini",
            thinking: "low",
            system: OPTICAL_READ_SYSTEM,
        });
    }

    async quickLook(
        image: { data: string; mimeType: string },
        instruction: string,
        opts: { model?: string; thinking?: "low" | "medium" | "high"; system?: string } = {},
    ): Promise<string> {
        let model = this.model;
        if (opts.model) {
            try {
                model = this.deps.auth.applyModel(getModel(PROVIDER as any, opts.model as any));
            } catch {
                model = this.model; // unknown model id → fall back to the default
            }
        }
        try {
            const agent = new Agent({
                initialState: {
                    systemPrompt: opts.system ?? "You are a fast, terse screen-watching assistant. Follow the instruction exactly and output only what is asked.",
                    model,
                    thinkingLevel: opts.thinking ?? "low",
                    tools: [],
                },
                getApiKey: async () => {
                    try {
                        return await this.deps.auth.getToken();
                    } catch {
                        return undefined;
                    }
                },
                sessionId: `pikvm-ambient-${Date.now()}`,
            });
            await agent.prompt(instruction, [{ type: "image", data: image.data, mimeType: image.mimeType }]);
            const last: any = [...agent.state.messages].reverse().find((m: any) => m.role === "assistant");
            const c = last?.content;
            if (typeof c === "string") return c;
            return (c ?? [])
                .filter((x: any) => x?.type === "text")
                .map((x: any) => x.text)
                .join("\n")
                .trim();
        } catch {
            return "";
        }
    }

    /* --------------------------- meeting copilot ------------------------- */

    private meetingAgent: Agent | undefined;
    private meetingQueue: Promise<void> = Promise.resolve();
    private lastObserveAt = 0;
    private pendingObs = "";
    private pendingTurns = 0;
    /** Wired in main → routes copilot output to the ambient stream/overlay. */
    onMeetingOutput: ((kind: "suggestion" | "activity", text: string) => void) | undefined;

    /** Spin up a real agent for the meeting: it watches, researches, and decides
     *  when to surface help via the `suggest` tool. Tools are read-only + cognitive
     *  (no clicking/typing during a call). */
    startMeeting(): void {
        this.stopMeeting();
        const emit = (kind: "suggestion" | "activity", text: string) => this.onMeetingOutput?.(kind, text);
        const suggestSchema = Type.Object({ text: Type.String({ description: "1–2 short lines, plain text — the actual nudge to show the user." }) });
        const suggest: AgentTool<typeof suggestSchema> = {
            name: "suggest",
            label: "Suggest",
            description:
                "Surface a SHORT, high-value nudge to the user, live in their meeting — a crisp answer to a question just asked, a sharp point to make, a fact/number to cite, or an action item. Call this ONLY when it's genuinely useful; staying silent is usually right.",
            parameters: suggestSchema,
            async execute(_id, p): Promise<AgentToolResult<null>> {
                emit("suggestion", p.text);
                return { content: [{ type: "text", text: "Surfaced to the user." }], details: null };
            },
        };
        // Read-only + cognitive tools only — never actuate the machine mid-meeting.
        const tools: AgentTool<any>[] = [...this.toolsForSub.filter((t) => READ_ONLY_MEETING_TOOLS.has(t.name)), suggest as AgentTool<any>];
        const agent: Agent = new Agent({
            initialState: { systemPrompt: MEETING_PROMPT, model: this.subModel, thinkingLevel: "low", tools },
            getApiKey: async () => {
                try {
                    return await this.deps.auth.getToken();
                } catch {
                    return undefined;
                }
            },
            sessionId: `pikvm-meeting-${Date.now()}`,
            // Keep a long meeting from blowing the context window (it re-feeds the
            // transcript tail every turn) — same tool-pairing-safe compaction as main.
            prepareNextTurn: () => this.compactContext(agent, this.subModel),
            // Hard guarantee: block anything that isn't a read-only/cognitive tool,
            // even if the tool list ever changes. The copilot can never act on the KVM.
            beforeToolCall: async (ctx: any) => {
                const name = ctx?.toolCall?.name;
                if (name === "suggest" || READ_ONLY_MEETING_TOOLS.has(name)) return undefined;
                return { block: true, reason: "The meeting copilot is read-only and cannot control the machine." };
            },
        });
        agent.subscribe((e: any) => {
            if (e.type === "tool_execution_start" && e.toolName && e.toolName !== "suggest") {
                emit("activity", meetingActivityLabel(e.toolName));
            }
        });
        this.meetingAgent = agent;
        this.lastObserveAt = 0;
        this.pendingObs = "";
        this.pendingTurns = 0;
        // Kick off an opening brief from the screen.
        this.meetingPrompt(
            "A meeting just started. Take a screenshot to see who/what it is, then `suggest` a one-line read of the meeting plus a natural opening line. Keep it tight.",
        );
    }

    stopMeeting(): void {
        if (this.meetingAgent) {
            try {
                this.meetingAgent.abort();
            } catch {
                /* ignore */
            }
            this.meetingAgent = undefined;
        }
    }

    /** Final recap turn (summary + action items saved to memory), then tear down. */
    endMeeting(): void {
        const agent = this.meetingAgent;
        if (!agent) return;
        this.meetingQueue = this.meetingQueue.then(async () => {
            if (this.meetingAgent !== agent) return;
            try {
                await agent.prompt(
                    "The meeting just ended. In ONE `suggest` call, give a tight recap (2–3 bullets) plus any action items for me. Then use `remember` to save each action item / key decision so I can recall it later.",
                );
            } catch {
                /* ignore */
            }
            if (this.meetingAgent === agent) {
                try {
                    agent.abort();
                } catch {
                    /* ignore */
                }
                this.meetingAgent = undefined;
            }
        });
    }

    /**
     * Feed a new transcript segment. We accumulate segments and, at most every
     * ~12s, hand the agent only the NEW speech (it keeps prior context in its own
     * history) — far less redundant than re-sending the whole transcript each turn.
     */
    meetingObserve(segment: string): void {
        if (!this.meetingAgent) return;
        const piece = segment.trim();
        if (piece) this.pendingObs = `${this.pendingObs} ${piece}`.trim();
        const now = Date.now();
        if (now - this.lastObserveAt < 12000) return;
        if (this.pendingObs.length < 30) return; // nothing materially new
        if (this.pendingTurns >= 2) return; // already backed up; keep accumulating speech
        this.lastObserveAt = now;
        const obs = this.pendingObs.slice(-2000);
        this.pendingObs = "";
        this.meetingPrompt(
            `New in the meeting (the live transcript continues): "${obs}"\n\nIf something genuinely useful just came up — a question you can answer, a fact worth verifying (use web_search/recall), a point to make, an action item — research it if needed and call \`suggest\`. Otherwise do nothing.`,
        );
    }

    /** A direct question from the user, or a tap of "Suggest now" (no question). */
    meetingAsk(question?: string): void {
        if (!this.meetingAgent) return;
        // Don't let rapid taps/questions queue unbounded serial turns.
        if (this.pendingTurns >= 2) {
            this.onMeetingOutput?.("activity", "…still working on the last request");
            return;
        }
        const q = question?.trim();
        this.meetingPrompt(
            q
                ? `The user asks you directly during the meeting: "${q}". Research if it helps (web_search/recall/read the screen), then ALWAYS answer concisely via the \`suggest\` tool.`
                : "The user tapped 'Suggest now'. Take a fresh look (screenshot + read_transcript), and if there's anything genuinely useful right now, `suggest` it. If truly nothing, a brief, specific observation is fine.",
        );
    }

    isInMeeting(): boolean {
        return !!this.meetingAgent;
    }

    private meetingPrompt(text: string): void {
        const agent = this.meetingAgent;
        if (!agent) return;
        this.pendingTurns++;
        this.meetingQueue = this.meetingQueue.then(async () => {
            try {
                if (this.meetingAgent !== agent) return; // meeting changed/ended
                await agent.prompt(text);
            } catch (e: any) {
                // Surface the failure (auth/model/etc.) instead of failing silently,
                // so it's visible in the monitor console + overlay during use.
                this.onMeetingOutput?.("activity", `⚠ copilot error: ${String(e?.message ?? e).slice(0, 140)}`);
            } finally {
                this.pendingTurns--;
            }
        });
    }

    /* ----------------------------- sessions ----------------------------- */

    listSessions(): SessionMeta[] {
        return this.sessions.list();
    }

    currentSessionId(): string {
        return this.sessionId;
    }

    newSession(): string {
        this.persist();
        this.stop();
        this.agent.state.messages = [];
        this.sessionId = this.sessions.create();
        this.resetTitleTracking();
        return this.sessionId;
    }

    /** Resume a saved session; returns its UI messages for the sidebar to render. */
    resumeSession(id: string): PiKvmUIMessage[] {
        this.persist();
        this.stop();
        const messages = this.sessions.load(id);
        this.agent.state.messages = messages as any;
        this.sessionId = id;
        this.resetTitleTracking();
        // Prefer the stored UI transcript (keeps screenshots); fall back to a
        // reconstruction from the agent messages.
        const ui = this.sessions.loadUi(id);
        return ui.length ? ui : agentMessagesToUi(messages);
    }

    deleteSession(id: string): void {
        this.sessions.delete(id);
        if (id === this.sessionId) this.newSession();
    }

    /* ------------------------------ models ------------------------------ */

    getModelId(): string {
        return this.modelId;
    }

    /** Approximate context-window usage for the header meter. */
    contextInfo(): { tokens: number; max: number } {
        const max = (this.model as any)?.contextWindow ?? 256_000;
        try {
            const est = estimateContextTokens(this.agent.state.messages as any);
            return { tokens: est.tokens, max };
        } catch {
            return { tokens: 0, max };
        }
    }

    availableModels(): string[] {
        try {
            return getModels(PROVIDER as any)
                .filter((m: any) => m.api === "openai-codex-responses")
                .map((m: any) => m.id);
        } catch {
            return [DEFAULT_MODEL];
        }
    }

    /* --------------------------- region segmentation -------------------- */

    /** Notified when the screen's labelled regions are (re)computed (for the overlay). */
    onRegions: ((result: RegionsResult) => void) | undefined;

    /** The current cached screen regions (or null if not yet computed). Never blocks. */
    currentRegions(): RegionsResult | null {
        return this.regions.getRegions();
    }

    /**
     * Opportunistically re-segment the screen into labelled regions, but ONLY when
     * the cheap grid diff says the layout shifted materially (a new window, an app
     * switch, a resize) - a stable screen costs ~zero model calls. Fire-and-forget:
     * the agent loop never waits on this. Broadcasts the result via `onRegions`.
     */
    maybeSegmentRegions(): void {
        void (async () => {
            try {
                const grid = this.deps.control.captureGrid ? await this.deps.control.captureGrid() : null;
                if (!this.regions.shouldRecompute(grid)) return;
                const shot = await this.deps.control.screenshot();
                const result = await this.regions.maybeRecompute(
                    { image: { data: shot.base64, mimeType: shot.mimeType }, width: shot.width, height: shot.height },
                    grid,
                );
                if (result) {
                    try {
                        this.onRegions?.(result);
                    } catch {
                        /* observer errors never affect the agent */
                    }
                }
            } catch {
                /* best-effort: segmentation never disturbs the run */
            }
        })();
    }

    /* ----------------------- sensitive-context watch -------------------- */

    private sensCtx: { app: string; sensitive: boolean; reason: string; at: number } | null = null;
    private sensInflight: Promise<void> | null = null;
    /** The most recently typed line — what a following Enter would submit. */
    private lastTypedLine = "";
    /** Notified when a fresh app/sensitivity assessment lands (for the overlay). */
    onContext: ((ctx: { app: string; sensitive: boolean; reason: string }) => void) | undefined;

    /** Cheap LLM look at the current frame: foreground app + whether the focus is
     *  a sensitive area. Cached for CONTEXT_TTL_MS; coalesces concurrent calls. */
    private async assessContext(): Promise<void> {
        if (this.sensInflight) return this.sensInflight;
        this.sensInflight = (async () => {
            try {
                const shot = await this.deps.control.screenshot();
                const raw = await this.quickLook(
                    { data: shot.base64, mimeType: shot.mimeType },
                    "Classify the current screen now. Output only the JSON.",
                    { model: CONTEXT_MODEL, system: CONTEXT_SYSTEM },
                );
                const parsed = this.parseContext(raw);
                if (parsed) {
                    this.sensCtx = { ...parsed, at: Date.now() };
                    try {
                        this.onContext?.(parsed);
                    } catch {
                        /* observer errors never affect gating */
                    }
                }
            } catch {
                /* keep the previous assessment */
            } finally {
                this.sensInflight = null;
            }
        })();
        return this.sensInflight;
    }

    private parseContext(raw: string): { app: string; sensitive: boolean; reason: string } | null {
        try {
            const m = raw.match(/\{[\s\S]*\}/);
            if (!m) return null;
            const j = JSON.parse(m[0]);
            return { app: String(j.app ?? "").slice(0, 40), sensitive: j.sensitive === true, reason: String(j.reason ?? "").slice(0, 60) };
        } catch {
            return null;
        }
    }

    /** Foreground/sensitivity for the current screen, refreshing if stale. */
    private async currentContext(): Promise<{ app: string; sensitive: boolean; reason: string } | null> {
        if (!this.sensCtx || Date.now() - this.sensCtx.at > CONTEXT_TTL_MS) await this.assessContext();
        return this.sensCtx;
    }

    /** Presence + reviewer gate for every agent tool call. */
    private async gate(tool: string, args: unknown, signal?: AbortSignal) {
        // 1. Yield while the user is present (mic/audio active).
        try {
            await this.deps.presence.waitUntilAllowed(signal);
        } catch {
            return { block: true, reason: "Aborted while paused for user presence." };
        }
        // The agent screenshots before acting, which is exactly when the screen
        // (and thus the context) likely changed - invalidate so the next input
        // action re-assesses against the fresh view.
        if (tool === "screenshot") this.sensCtx = null;
        // 2. Authorization.
        const argRec = (args as Record<string, unknown>) ?? {};
        const op: Operation = { tool, args: argRec, source: "agent" };
        // 2a. Track the most recently typed line so a following Enter can be
        // classified as the *command it submits* (e.g. `ls` vs `rm -rf`). The
        // dial then auto-runs safe commands without a prompt.
        if (tool === "type_text") {
            const t = String(argRec.text ?? "").trim();
            if (t) this.lastTypedLine = t;
        } else if (tool === "press_key") {
            const key = String(argRec.key ?? argRec.code ?? "");
            if (SUBMIT_KEYS.has(key) && this.lastTypedLine) op.commandText = this.lastTypedLine;
        }
        // 2b. For input actions, recognise the app and flag sensitive areas (chat
        // compose boxes, Send buttons, terminals) so they require approval.
        if (INPUT_ACTIONS.has(tool)) {
            try {
                const ctx = await this.currentContext();
                if (ctx?.sensitive) op.sensitive = { reason: ctx.reason || "sensitive area", ...(ctx.app ? { app: ctx.app } : {}) };
            } catch {
                /* detection is best-effort; never block input on it failing */
            }
        }
        const verdict = await this.deps.reviewer.review(op);
        if (verdict.decision === "allow") return undefined;
        if (verdict.decision === "redirect") {
            const note = verdict.text?.trim();
            if (note) this.agent.steer({ role: "user", content: note, timestamp: Date.now() });
            return { block: true, reason: `User redirected: ${note ?? "do something different"}` };
        }
        return { block: true, reason: verdict.reason ?? "Blocked by reviewer." };
    }

    subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>): () => void {
        return this.agent.subscribe(listener);
    }

    isStreaming(): boolean {
        return this.agent.state.isStreaming;
    }

    /** Start (or queue, if running) a task, optionally with attached images. */
    async run(task: string, images?: ImageContent[]): Promise<void> {
        this.pausedForUser = false;
        if (this.agent.state.isStreaming) {
            this.agent.followUp({ role: "user", content: task, timestamp: Date.now() });
            return;
        }
        await this.agent.prompt(task, images && images.length ? images : undefined);
    }

    /* --------------------------- pause / handoff ------------------------- */

    private pausedForUser = false;

    /** Temporarily hand control back to the user (stops the current run). */
    pauseForUser(): void {
        this.pausedForUser = true;
        this.agent.abort();
    }

    isPausedForUser(): boolean {
        return this.pausedForUser;
    }

    /**
     * Resume after a user pause. Pausing aborts the original /api/chat stream, so a
     * bare agent.prompt() here would run invisibly (no stream attached). Route it
     * through the autonomous-transcript path so the resumed flow — screenshots,
     * reasoning, tools — is persisted and shows up in the sidebar.
     */
    resumeFromUser(): void {
        if (!this.pausedForUser) return;
        this.pausedForUser = false;
        if (this.agent.state.messages.length) {
            void this.runAutonomous("", "Resumed", {
                trigger: "▶ Resumed control — re-evaluating",
                prompt: "[Control resumed] You paused and the user took manual control of the screen. The state may have changed — take a fresh screenshot and re-evaluate before continuing the task.",
            });
        }
    }

    /** Inject a non-disruptive side note mid-run (/btw). */
    note(text: string): void {
        this.agent.steer({ role: "user", content: text, timestamp: Date.now() });
    }

    /** Steer the running agent with a new user message, or start one if idle. */
    steer(text: string): void {
        if (this.agent.state.isStreaming) {
            this.agent.steer({ role: "user", content: text, timestamp: Date.now() });
        } else {
            void this.run(text);
        }
    }

    /** Set/replace the persistent goal (/goal); pinned into the system prompt. */
    setGoal(goal: string | undefined): void {
        this.goal = goal?.trim() || undefined;
        this.agent.state.systemPrompt = systemPrompt(this.goal, this.memory.count());
    }

    getGoal(): string | undefined {
        return this.goal;
    }

    stop(): void {
        this.loopController?.stop();
        this.loopController = undefined;
        this.agent.abort();
    }

    clear(): void {
        this.stop();
        this.agent.state.messages = [];
    }

    setModel(modelId: string): void {
        const m = getModel(PROVIDER as any, modelId as any);
        if (m) {
            this.model = this.deps.auth.applyModel(m);
            this.modelId = modelId;
            this.agent.state.model = this.model;
            // The header model picker selects the "reasoning" tier — keep the
            // router's reasoning model in step so routing escalates to the
            // model the user actually chose.
            this.reasoningModelId = modelId;
            this.reasoningModel = this.model;
        }
    }

    /** Resolve + auth-apply a provider model id; undefined if unknown/unreachable. */
    private resolveModel(modelId: string): Model<any> | undefined {
        try {
            const m = getModel(PROVIDER as any, modelId as any);
            return m ? this.deps.auth.applyModel(m) : undefined;
        } catch {
            return undefined;
        }
    }

    /* ------------------- per-turn model routing config ------------------ */

    /**
     * Configure dynamic per-turn model switching: a capable model for reasoning
     * turns and a cheap/fast one for routine tool-driving. Unknown/unreachable
     * model ids are ignored (the previous resolved model is kept), so a bad value
     * can never break the loop. The reasoning model also doubles as the agent's
     * base `state.model`, so it's what runs when routing is disabled.
     */
    setRouterModels(opts: { enabled?: boolean; reasoningModel?: string; fastModel?: string }): void {
        if (typeof opts.enabled === "boolean") this.routingEnabled = opts.enabled;
        if (opts.reasoningModel) {
            const m = this.resolveModel(opts.reasoningModel);
            if (m) {
                this.reasoningModelId = opts.reasoningModel;
                this.reasoningModel = m;
                // Reasoning is the base model: keep the main loop + header in sync.
                this.model = m;
                this.modelId = opts.reasoningModel;
                this.agent.state.model = m;
            }
        }
        if (opts.fastModel) {
            const m = this.resolveModel(opts.fastModel);
            if (m) {
                this.fastModelId = opts.fastModel;
                this.fastModel = m;
            }
        }
    }

    /** Current routing configuration (for the settings UI + observability). */
    getRouterConfig(): { enabled: boolean; reasoningModel: string; fastModel: string; lastTier: ModelTier } {
        return {
            enabled: this.routingEnabled,
            reasoningModel: this.reasoningModelId,
            fastModel: this.fastModelId,
            lastTier: this.lastTier,
        };
    }

    /** Repeat a task until stopped, or for `count` iterations, optionally with a gap. */
    loop(task: string, opts: { count?: number; intervalMs?: number } = {}): void {
        this.loopController?.stop();
        let stopped = false;
        let iterations = 0;
        this.loopController = {
            stop: () => {
                stopped = true;
            },
        };
        const tick = async () => {
            while (!stopped && (opts.count === undefined || iterations < opts.count)) {
                iterations++;
                try {
                    await this.agent.prompt(task);
                } catch {
                    break;
                }
                if (stopped) break;
                if (opts.intervalMs) await new Promise((r) => setTimeout(r, opts.intervalMs));
            }
        };
        void tick();
    }
}
