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
    type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { getModel, getModels, registerBuiltInApiProviders, Type, type Model, type ImageContent } from "@earendil-works/pi-ai";
import { resolve, dirname } from "path";
import { PiKvmControl } from "../pikvm-control";
import { OperationReviewer, SUBMIT_KEYS, type Operation } from "../reviewer";
import { PresenceMonitor } from "../presence";
import { CodexAuth, ProviderAuthRegistry } from "./auth";
import {
    parseSpecOrDefault,
    formatSpec,
    guardFastTier,
    PROVIDERS,
    DEFAULT_REASONING_SPEC,
    DEFAULT_FAST_SPEC,
    DEFAULT_SUBAGENT_SPEC,
    type ModelSpec,
} from "./providers";
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
import type { GoalLoopState, PiKvmUIMessage } from "./protocol";
import { decideModelTier, type ModelTier, type TurnSummary } from "./model-router";

registerBuiltInApiProviders();

/**
 * The pi-ai provider id for the ChatGPT-subscription auth. The AUXILIARY models
 * below (titles, context/region vision triage, ambient quick-looks) always run
 * on this provider — they must be cheap, vision-capable and always available, so
 * they are intentionally NOT user-routable. The user-facing ROLES (reasoning /
 * fast / sub-agent) are chosen as `provider/model` specs and may target any
 * authed provider (e.g. `moonshotai/kimi-k2.6`).
 */
const PROVIDER = "openai-codex";
/** Default reasoning model (legacy bare id, used for codex auxiliary lookups). */
const DEFAULT_MODEL = "gpt-5.5";
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

/**
 * Of the input actions, only those that can ENTER or SUBMIT text into the focused
 * field need the (slower) sensitive-focus vision check: typing, mouse actions that
 * might land on a Send button, and Enter / submit chords. Pure navigation or system
 * hotkeys (Win+L, Alt+Tab, Ctrl+Alt+Del, arrows, Esc, …) skip it entirely so they
 * fire instantly instead of waiting on a screen assessment.
 */
function needsSensitiveCheck(tool: string, args: Record<string, unknown>): boolean {
    switch (tool) {
        case "click":
        case "double_click":
        case "drag":
        case "type_text":
        case "type_secret":
            return true;
        case "press_key":
            return SUBMIT_KEYS.has(String(args.key ?? args.code ?? ""));
        case "hotkey": {
            const codes = Array.isArray(args.codes) ? (args.codes as unknown[]).map(String) : [];
            return codes.some((c) => SUBMIT_KEYS.has(c));
        }
        default:
            return false;
    }
}
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

function systemPrompt(goal?: string, memoryCount = 0, mcpSkills: string[] = []): string {
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
        mcpSkills.length
            ? `Some of your tools come from connected MCP servers; before using a server's tools, read its skill ONCE to learn how it works (\`use_skill\`): ${mcpSkills.join(", ")}.`
            : "",
        memoryCount > 0 ? `You have ${memoryCount} saved memories — use \`recall\` when prior context might help.` : "",
        goal ? `\nStanding goal for this session:\n${goal}` : "",
    ]
        .filter(Boolean)
        .join("\n");
}

const SUBAGENT_PROMPT =
    "You are a focused sub-agent. Complete the given task using your tools, then reply with a concise result for the parent agent. Be thorough but brief.";

/* --------------------------- goal-loop plumbing --------------------------- */

/** Default ceiling on self-verified iterations — never run forever. */
export const DEFAULT_GOAL_LOOP_CAP = 6;

/** Independent ("blind") verdict on whether a goal is met, judged from a fresh
 *  screenshot alone — never from the agent's own reasoning. */
export interface GoalVerdict {
    achieved: boolean;
    reason: string;
    /** When not achieved, the concrete gap to feed back to the agent. */
    whatsMissing?: string;
}

/** Cheap, terse system prompt for the blind verifier — it ONLY sees the goal and
 *  the current screen, and must rule pass/fail on the evidence in front of it. */
export const VERIFIER_SYSTEM =
    'You are an INDEPENDENT verifier. You are given a GOAL and a single screenshot of a computer screen, and NOTHING about how it was reached. Judge ONLY from what is visibly true on this screen whether the goal is actually achieved right now — do not assume, do not give the benefit of the doubt, do not trust any claim of success. If you cannot SEE clear evidence the goal is met, it is NOT met. Reply with ONLY compact JSON: {"achieved":true|false,"reason":"<at most 20 words, what you see>","whatsMissing":"<if not achieved: the concrete next thing needed, else omit>"}.';

/** Parse the verifier's JSON reply into a verdict. Defaults to NOT achieved when
 *  the reply is missing/unparseable — a blind verifier never passes on doubt. */
export function parseVerdict(raw: string): GoalVerdict {
    try {
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) return { achieved: false, reason: "Verifier returned no JSON." };
        const j = JSON.parse(m[0]);
        const achieved = j.achieved === true;
        const reason = String(j.reason ?? "").slice(0, 200).trim() || (achieved ? "Goal met." : "Goal not met.");
        const whatsMissing = String(j.whatsMissing ?? "").slice(0, 300).trim();
        return achieved ? { achieved, reason } : { achieved, reason, ...(whatsMissing ? { whatsMissing } : {}) };
    } catch {
        return { achieved: false, reason: "Verifier reply could not be parsed." };
    }
}

export type GoalLoopDecision =
    | { kind: "done"; verdict: GoalVerdict }
    | { kind: "continue"; feedback: string }
    | { kind: "capped" };

/**
 * Pure decision for the self-verifying loop: given the blind verdict, the
 * iteration just completed and the cap, decide whether to stop (achieved), feed
 * the gap back and iterate, or stop because the cap is reached. No I/O, fully
 * testable — this is the heart of the loop and must never spin forever.
 */
export function goalLoopStep(verdict: GoalVerdict, iteration: number, cap: number): GoalLoopDecision {
    if (verdict.achieved) return { kind: "done", verdict };
    if (iteration >= cap) return { kind: "capped" };
    const missing = verdict.whatsMissing?.trim() || verdict.reason.trim() || "the goal is not yet visibly met";
    return { kind: "continue", feedback: missing };
}

export interface RunnerDeps {
    control: PiKvmControl;
    reviewer: OperationReviewer;
    presence: PresenceMonitor;
    /** The ChatGPT-subscription OAuth provider (codex). Auxiliary models use it directly. */
    auth: CodexAuth;
    /**
     * Multi-provider auth registry. Optional: when omitted we build one wrapping
     * `auth` + `secrets`, so existing callers (and the codex-only path) keep
     * working unchanged. The user-facing roles resolve their credentials through it.
     */
    providerAuth?: ProviderAuthRegistry;
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
    /** Skills named by connected MCP servers (pointed at from the system prompt). */
    private mcpSkills: string[] = [];
    private goalLoop: GoalLoopState | undefined;
    private goalLoopAbort: AbortController | undefined;
    private model: Model<any>;
    /** Multi-provider auth: the codex OAuth provider plus API-key providers. */
    private readonly providerAuth: ProviderAuthRegistry;
    /** The reasoning role's spec — also the main loop's base model + header value. */
    private reasoningSpec: ModelSpec = parseSpecOrDefault(DEFAULT_REASONING_SPEC, DEFAULT_REASONING_SPEC);
    private get modelId(): string {
        return formatSpec(this.reasoningSpec);
    }
    /* ----- per-turn model routing (reasoning vs cheap tool-calling) ----- */
    /** Whether to route each turn dynamically. When off, every turn uses `model`. */
    private routingEnabled = true;
    /** The "fast" tier's spec (routine tool-driving turns). */
    private fastSpec: ModelSpec = parseSpecOrDefault(DEFAULT_FAST_SPEC, DEFAULT_FAST_SPEC);
    /** The sub-agent role's spec (focused side-tasks). */
    private subagentSpec: ModelSpec = parseSpecOrDefault(DEFAULT_SUBAGENT_SPEC, DEFAULT_SUBAGENT_SPEC);
    /** Resolved (auth-applied) model objects per tier, rebuilt when specs change. */
    private reasoningModel: Model<any> | undefined;
    private fastModel: Model<any> | undefined;
    /** The tier the most recent routed turn ran on — surfaced for observability. */
    private lastTier: ModelTier = "reasoning";
    /** Last fast-tier vision-guard warning (null when the fast model is fine). */
    private fastTierWarning: string | null = null;
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
    /** Resolved sub-agent model — rebuilt when the sub-agent spec changes. */
    private subModel: Model<any>;
    private sessionId: string;

    constructor(private deps: RunnerDeps) {
        // Build (or accept) the multi-provider auth registry. Falls back to a
        // codex-only registry so existing callers keep working unchanged.
        this.providerAuth = deps.providerAuth ?? new ProviderAuthRegistry(deps.auth, deps.secrets);
        // Resolve each role's model through the registry; defaults are codex/* so
        // a fresh install behaves exactly as before (reasoning gpt-5.5, fast 5.4-mini).
        this.reasoningModel = this.resolveSpec(this.reasoningSpec) ?? deps.auth.applyModel(getModel(PROVIDER as any, DEFAULT_MODEL as any));
        this.model = this.reasoningModel;
        this.fastModel = this.resolveSpec(this.fastSpec);
        this.subModel = this.resolveSpec(this.subagentSpec) ?? this.reasoningModel;
        // Warm the OCR worker so the first watched-type isn't blocked on a cold start.
        this.localOcr.warm();
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

        // The MAIN agent additionally gets pursue_goal (self-verified loop). Kept
        // off sub-agents so a sub-task can't kick off its own nested self-loop.
        const mainToolDeps = { ...toolDeps, pursueGoal: (goal: string, o: { criteria?: string; cap?: number }) => this.startPursuit(goal, o) };

        this.agent = new Agent({
            initialState: {
                systemPrompt: systemPrompt(undefined, this.memory.count(), this.mcpSkills),
                model: this.model,
                thinkingLevel: "medium",
                tools: [...createTools(deps.control, mainToolDeps), ...extra],
            },
            // Dispatch by the model's pi-ai provider id (codex OAuth bearer, or a
            // stored API key), so a tool turn can run on Kimi while reasoning runs
            // on codex within the same loop.
            getApiKey: (provider) => this.keyForProvider(provider),
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
                this.autoApproveRun = false; // pre-authorization is per-run only
                this.persist();
                this.maybeRetitle();
            }
        });
    }

    /** When set, the current run's tool calls skip the authorization gate (a
     *  user-tapped suggestion is explicit consent). Auto-cleared on agent_end. */
    private autoApproveRun = false;
    setAutoApproveRun(on: boolean): void {
        this.autoApproveRun = on;
    }

    /** Optional barrier the gate awaits before each tool call (e.g. the mouse-jiggler
     *  holding agent ops while it nudges the cursor). */
    gateBarrier: (() => Promise<void>) | undefined;

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
     * Write-through every `remember` (and internal memory save) into any connected
     * Atlas-style MCP vault, so saving a fact and updating the knowledgebase are
     * one action.
     */
    setMemoryMirror(mirror: (m: Memory) => void): void {
        this.memory.onAdd = mirror;
    }

    /**
     * Record the usage skills named by connected MCP servers and refresh the
     * system prompt to point the agent at them (e.g. Atlas → the `atlas-vault`
     * skill). Connected asynchronously after the agent is built.
     */
    setMcpSkills(skills: string[]): void {
        this.mcpSkills = [...new Set(skills.filter((s) => s.trim()))];
        this.agent.state.systemPrompt = systemPrompt(this.goal, this.memory.count(), this.mcpSkills);
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
        // The fast tier drives routine clicks/keys/screenshots — extended thinking
        // there is wasted latency, so run it at "low". Reasoning turns keep "medium".
        const thinkingLevel: ThinkingLevel = this.lastTier === "fast" ? "low" : "medium";
        // Merge the routed model into whatever compaction returned (compaction may
        // also have replaced the context); never drop one for the other.
        return { ...(compaction ?? {}), model: routedModel, thinkingLevel };
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
        const id = formatSpec(tier === "fast" ? this.fastSpec : this.reasoningSpec);
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
                // Sub-agents use the configured sub-agent role model + deeper thinking.
                model: this.subModel,
                thinkingLevel: "high",
                tools: this.toolsForSub,
            },
            getApiKey: (provider) => this.keyForProvider(provider),
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

    /** Codex model ids (bare) — what the existing header model picker shows. */
    availableModels(): string[] {
        try {
            return getModels(PROVIDER as any)
                .filter((m: any) => m.api === "openai-codex-responses")
                .map((m: any) => m.id);
        } catch {
            return [DEFAULT_MODEL];
        }
    }

    /**
     * Reachable models per provider, as `provider/model` specs, for the
     * Providers & Models pickers. Only providers that are authed AND have
     * vision-capable models are listed (the loop sends screenshots). Each entry
     * carries whether the provider is ready and its model specs.
     */
    availableProviderModels(): { id: string; label: string; kind: string; ready: boolean; keyHint?: string; desc?: string; models: string[] }[] {
        return PROVIDERS.map((p) => {
            let models: string[] = [];
            try {
                models = getModels(p.piProvider as any)
                    .filter((m: any) => Array.isArray(m.input) && m.input.includes("image"))
                    .map((m: any) => `${p.id}/${m.id}`);
            } catch {
                models = [];
            }
            return {
                id: p.id,
                label: p.label,
                kind: p.kind,
                ready: this.providerAuth.isReady(p.id),
                ...(p.keyHint ? { keyHint: p.keyHint } : {}),
                ...(p.desc ? { desc: p.desc } : {}),
                models,
            };
        });
    }

    /** Per-provider auth status (signed in / key stored), for the settings UI. */
    providerStatus() {
        return this.providerAuth.status();
    }

    /** Store/clear an API key for an API-key provider (vault-backed). */
    setProviderKey(providerId: string, key: string): boolean {
        const ok = this.providerAuth.setKey(providerId, key);
        if (ok) {
            // A newly-keyed provider may make a previously-unreachable role spec
            // resolvable — re-resolve the roles so they pick it up immediately.
            this.refreshRoleModels();
        }
        return ok;
    }

    /** Re-resolve all role models (after an auth change makes new providers reachable). */
    private refreshRoleModels(): void {
        const r = this.resolveSpec(this.reasoningSpec);
        if (r) {
            this.reasoningModel = r;
            this.model = r;
            this.agent.state.model = r;
        }
        const f = this.resolveSpec(this.fastSpec);
        if (f) this.fastModel = f;
        const s = this.resolveSpec(this.subagentSpec);
        if (s) this.subModel = s;
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
    /** Notified when the gate starts/stops a blocking internal step (e.g. a screen
     *  assessment), so the UI can show "checking the screen…" instead of stalling
     *  silently. Called with `text:null` to clear the indicator. */
    onActivity: ((a: { text: string | null; phase?: "screen" | "auth" | "reviewing" | "blocked" }) => void) | undefined;

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

    /**
     * Sensitivity of the current focus, for gating a text-entry / submit action.
     * Prefers a warm or in-flight assessment — the screen-watch (maybeAssessContext,
     * fired after each of the agent's screenshots) keeps it fresh, so this usually
     * returns instantly. It only pays a cold round-trip when there's no recent look
     * at all (the first action of a run, or the screen sat unchanged past the TTL).
     */
    private async sensitiveContext(): Promise<{ app: string; sensitive: boolean; reason: string } | null> {
        // A background assessment is already running (kicked after the agent's last
        // screenshot) — join it. Its latency overlaps the agent's own between-step
        // thinking, so the action rarely actually waits.
        if (this.sensInflight) {
            try {
                await this.sensInflight;
            } catch {
                /* keep whatever we had */
            }
            return this.sensCtx;
        }
        if (this.sensCtx && Date.now() - this.sensCtx.at <= CONTEXT_TTL_MS) return this.sensCtx;
        await this.assessContext();
        return this.sensCtx;
    }

    /**
     * Kick a background sensitivity assessment — call it right after a screenshot,
     * when the view has just settled and likely changed. Coalesced (a no-op while one
     * is in flight) and best-effort; never blocks the caller. This is what keeps the
     * gate's cache warm so text-entry actions don't pay a serial vision round-trip.
     */
    maybeAssessContext(): void {
        if (this.sensInflight) return;
        // Still fresh — don't re-spend a vision call every screenshot; the gate will
        // refresh once it ages past the TTL.
        if (this.sensCtx && Date.now() - this.sensCtx.at <= CONTEXT_TTL_MS) return;
        void this.assessContext();
    }

    /** Presence + reviewer gate for every agent tool call. */
    private async gate(tool: string, args: unknown, signal?: AbortSignal) {
        // 1. Yield while the user is present (mic/audio active).
        try {
            await this.deps.presence.waitUntilAllowed(signal);
        } catch {
            return { block: true, reason: "Aborted while paused for user presence." };
        }
        // Hold while the idle mouse-jiggler is nudging the cursor, so an agent move
        // can't race the jiggle (and the jiggle restores the exact pre-jiggle spot).
        if (this.gateBarrier) {
            try {
                await this.gateBarrier();
            } catch {
                /* never block an op on the barrier failing */
            }
        }
        // A user-tapped suggestion ("Log in") is explicit consent to run immediately —
        // don't stop it on per-action authorization prompts (which only surface in the
        // sidebar and would silently freeze the run). Presence is still honoured above.
        if (this.autoApproveRun) return undefined;
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
        // 2b. For text-entry / submit actions, recognise the app and flag sensitive
        // areas (chat compose boxes, Send buttons, terminals) so they require
        // approval. Pure hotkeys/navigation skip this — they can't submit text.
        if (INPUT_ACTIONS.has(tool) && needsSensitiveCheck(tool, argRec)) {
            // Only flag "checking the screen" when the look will actually block (no
            // warm cache and none already in flight) — otherwise it's instant.
            const willWait = this.sensInflight != null || !(this.sensCtx && Date.now() - this.sensCtx.at <= CONTEXT_TTL_MS);
            if (willWait) this.onActivity?.({ text: "Checking the screen…", phase: "screen" });
            try {
                const ctx = await this.sensitiveContext();
                if (ctx?.sensitive) op.sensitive = { reason: ctx.reason || "sensitive area", ...(ctx.app ? { app: ctx.app } : {}) };
            } catch {
                /* detection is best-effort; never block input on it failing */
            } finally {
                if (willWait) this.onActivity?.({ text: null });
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
        this.agent.state.systemPrompt = systemPrompt(this.goal, this.memory.count(), this.mcpSkills);
    }

    getGoal(): string | undefined {
        return this.goal;
    }

    /* ----------------------- self-verifying goal loop ------------------- */

    /** Current goal-loop state (for ServerState), or undefined when idle. */
    getGoalLoop(): GoalLoopState | undefined {
        return this.goalLoop;
    }

    isPursuing(): boolean {
        return !!this.goalLoop?.active;
    }

    /** Snapshot the loop state and nudge the UI to re-read it. */
    private emitGoalLoop(): void {
        this.onUiChanged?.();
    }

    /**
     * Run the BLIND verifier: an independent judgement given ONLY the goal (and
     * any criteria) plus a FRESH screenshot — never the agent's own reasoning or
     * transcript. Uses the cheap fast-vision path. Defaults to NOT achieved if it
     * can't see the screen or parse a verdict, so the loop can't declare victory.
     */
    async verifyGoal(goal: string, criteria?: string): Promise<GoalVerdict> {
        let shot: { base64: string; mimeType: string };
        try {
            shot = await this.deps.control.screenshot();
        } catch {
            return { achieved: false, reason: "Could not capture the screen to verify." };
        }
        const instruction = [
            `GOAL: ${goal}`,
            criteria ? `SUCCESS CRITERIA: ${criteria}` : "",
            "Judge the screenshot now. Output only the JSON verdict.",
        ]
            .filter(Boolean)
            .join("\n");
        const raw = await this.quickLook(
            { data: shot.base64, mimeType: shot.mimeType },
            instruction,
            { model: CONTEXT_MODEL, system: VERIFIER_SYSTEM, thinking: "low" },
        );
        return parseVerdict(raw);
    }

    /**
     * Public, fire-and-forget entry point. If called from inside a running turn
     * (e.g. the `pursue_goal` tool), defer the loop until that turn settles so we
     * never re-enter `agent.prompt`. Used by both the tool and the /pursue command.
     */
    startPursuit(goal: string, opts: { criteria?: string; cap?: number } = {}): void {
        const begin = () => void this.pursueGoal(goal, opts).catch(() => undefined);
        if (this.agent.state.isStreaming) {
            const unsub = this.agent.subscribe((e) => {
                if (e.type === "agent_end") {
                    unsub();
                    if (!this.agent.state.isStreaming) begin();
                }
            });
        } else {
            begin();
        }
    }

    /**
     * Pursue a self-set goal with blind self-verification: the agent works toward
     * the goal, then an INDEPENDENT verifier (fresh screenshot + goal only) rules
     * pass/fail. If not met, the gap is fed back and it iterates — until achieved
     * or the cap is hit (never infinite). All work flows through the SAME approval
     * /presence gates as a normal run (it just calls `agent.prompt`), and honours
     * stop()/abort. Observability via the event stream + getGoalLoop().
     */
    async pursueGoal(goal: string, opts: { criteria?: string; cap?: number } = {}): Promise<GoalLoopState> {
        const trimmed = goal.trim();
        if (!trimmed) throw new Error("A goal is required to pursue.");
        // One loop at a time; cancel any prior pursuit first.
        this.goalLoopAbort?.abort();
        const cap = Math.max(1, Math.floor(opts.cap ?? DEFAULT_GOAL_LOOP_CAP));
        const criteria = opts.criteria?.trim() || undefined;
        const abort = new AbortController();
        this.goalLoopAbort = abort;
        // Pin the goal into the system prompt too, so the agent keeps it in view.
        this.setGoal(criteria ? `${trimmed}\nSuccess criteria: ${criteria}` : trimmed);
        this.goalLoop = { goal: trimmed, ...(criteria ? { criteria } : {}), iteration: 0, cap, active: true };
        this.emitGoalLoop();

        const stepPrompt = (iteration: number, feedback?: string): string =>
            iteration === 1
                ? [
                      `Pursue this goal until it is genuinely achieved: ${trimmed}.`,
                      criteria ? `Success criteria: ${criteria}.` : "",
                      "Work toward it with your normal careful loop (screenshot, one action, verify). When you believe it is done, stop — an INDEPENDENT verifier will then check the screen blindly, so make sure the result is actually visible on screen, not just claimed.",
                  ]
                      .filter(Boolean)
                      .join(" ")
                : [
                      `An independent check of the goal "${trimmed}" found it is NOT done yet.`,
                      `What is still missing: ${feedback}.`,
                      "Continue from the current screen state — take a fresh screenshot first, then close that gap. Do not repeat steps that already worked.",
                  ].join(" ");

        try {
            for (let iteration = 1; !abort.signal.aborted; iteration++) {
                this.goalLoop = { ...this.goalLoop!, iteration, active: true };
                this.emitGoalLoop();

                // 1. Let the agent act toward the goal (gated normally).
                const feedback = this.goalLoop.lastVerdict?.whatsMissing ?? this.goalLoop.lastVerdict?.reason;
                try {
                    await this.runAutonomous("", `Goal iteration ${iteration}/${cap}`, {
                        trigger: `🎯 Pursuing goal (${iteration}/${cap}): ${trimmed}`,
                        prompt: stepPrompt(iteration, feedback),
                    });
                } catch {
                    /* a failed turn still gets verified — the screen may have progressed */
                }
                if (abort.signal.aborted) break;

                // 2. BLIND verification — independent of the agent's self-assessment.
                const verdict = await this.verifyGoal(trimmed, criteria);
                this.goalLoop = { ...this.goalLoop!, iteration, lastVerdict: verdict };
                this.emitGoalLoop();
                if (abort.signal.aborted) break;

                // 3. Pure decision: stop (done), iterate (feed gap back), or stop (capped).
                const decision = goalLoopStep(verdict, iteration, cap);
                if (decision.kind === "done") {
                    this.goalLoop = { ...this.goalLoop!, active: false };
                    this.emitGoalLoop();
                    break;
                }
                if (decision.kind === "capped") {
                    this.goalLoop = { ...this.goalLoop!, active: false };
                    this.emitGoalLoop();
                    break;
                }
                // continue → loop again with the gap as feedback (already on lastVerdict).
            }
        } finally {
            if (this.goalLoop?.active) {
                this.goalLoop = { ...this.goalLoop, active: false };
                this.emitGoalLoop();
            }
            if (this.goalLoopAbort === abort) this.goalLoopAbort = undefined;
        }
        return this.goalLoop!;
    }

    stop(): void {
        this.loopController?.stop();
        this.loopController = undefined;
        this.goalLoopAbort?.abort();
        if (this.goalLoop?.active) {
            this.goalLoop = { ...this.goalLoop, active: false };
            this.emitGoalLoop();
        }
        this.agent.abort();
    }

    clear(): void {
        this.stop();
        this.agent.state.messages = [];
    }

    /**
     * Set the reasoning-role model from the header picker. Accepts a full
     * `provider/model` spec, or a bare model id (treated as a `codex/` model so
     * the existing header keeps working). The reasoning model is also the loop's
     * base model, so this updates both.
     */
    setModel(modelSpec: string): void {
        const spec = parseSpecOrDefault(modelSpec.includes("/") ? modelSpec : `codex/${modelSpec}`, formatSpec(this.reasoningSpec));
        const m = this.resolveSpec(spec);
        if (m) {
            this.reasoningSpec = spec;
            this.reasoningModel = m;
            this.model = m;
            this.agent.state.model = m;
        }
    }

    /* ------------------------- provider resolution ---------------------- */

    /**
     * Resolve + auth-apply a `provider/model` spec to a concrete pi-ai model.
     * Returns undefined when the provider/model is unknown or unreachable, so a
     * bad value is ignored rather than breaking the loop.
     */
    private resolveSpec(spec: ModelSpec): Model<any> | undefined {
        try {
            const m = getModel(spec.piProvider as any, spec.model as any);
            return m ? this.providerAuth.applyModel(spec.piProvider, m) : undefined;
        } catch {
            return undefined;
        }
    }

    /** Whether a spec's model is vision-capable (accepts image input). */
    private specHasVision(spec: ModelSpec): boolean | undefined {
        try {
            const m: any = getModel(spec.piProvider as any, spec.model as any);
            if (!m) return undefined;
            return Array.isArray(m.input) ? m.input.includes("image") : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * The API key for a pi-ai provider id, dispatched through the auth registry:
     * the codex OAuth bearer (refreshed), or a stored API key for an API-key
     * provider. Returns undefined when the provider isn't configured.
     */
    private async keyForProvider(provider: string): Promise<string | undefined> {
        return this.providerAuth.keyForPiProvider(provider);
    }

    /* ------------------- per-turn model routing config ------------------ */

    /**
     * Configure the per-role models as `provider/model` specs. Unknown/unreachable
     * specs are ignored (the previous resolved model is kept), so a bad value can
     * never break the loop. The reasoning model also doubles as the agent's base
     * `state.model` (what runs when routing is disabled). The fast tier is guarded
     * for vision: the loop sends screenshots, so a text-only fast model is rejected
     * and the reasoning model is used for the fast tier instead.
     */
    setRouterModels(opts: { enabled?: boolean; reasoningModel?: string; fastModel?: string; subagentModel?: string }): void {
        if (typeof opts.enabled === "boolean") this.routingEnabled = opts.enabled;
        if (opts.reasoningModel) {
            const spec = parseSpecOrDefault(opts.reasoningModel, formatSpec(this.reasoningSpec));
            const m = this.resolveSpec(spec);
            if (m) {
                this.reasoningSpec = spec;
                this.reasoningModel = m;
                // Reasoning is the base model: keep the main loop + header in sync.
                this.model = m;
                this.agent.state.model = m;
            }
        }
        if (opts.fastModel) {
            const requested = parseSpecOrDefault(opts.fastModel, formatSpec(this.fastSpec));
            // Guard: the fast tier must take screenshots → must be vision-capable.
            const guard = guardFastTier(requested, { vision: this.specHasVision(requested) ?? false }, this.reasoningSpec, true);
            this.fastTierWarning = guard.warning;
            const m = this.resolveSpec(guard.spec);
            if (m) {
                this.fastSpec = guard.spec;
                this.fastModel = m;
            }
        }
        if (opts.subagentModel) {
            const spec = parseSpecOrDefault(opts.subagentModel, formatSpec(this.subagentSpec));
            const m = this.resolveSpec(spec);
            if (m) {
                this.subagentSpec = spec;
                this.subModel = m;
            }
        }
    }

    /** Current routing configuration (for the settings UI + observability). */
    getRouterConfig(): {
        enabled: boolean;
        reasoningModel: string;
        fastModel: string;
        subagentModel: string;
        lastTier: ModelTier;
        fastTierWarning: string | null;
    } {
        return {
            enabled: this.routingEnabled,
            reasoningModel: formatSpec(this.reasoningSpec),
            fastModel: formatSpec(this.fastSpec),
            subagentModel: formatSpec(this.subagentSpec),
            lastTier: this.lastTier,
            fastTierWarning: this.fastTierWarning,
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
