/**
 * Agent sidebar — built with the Vercel AI SDK + AI Elements components.
 *
 * Chat surface (conversation, reasoning, tool calls, suggestions, loader,
 * markdown) uses AI Elements; computer-use specifics (screenshots with action
 * markers, three-way authorization, sessions, settings, presence) are custom
 * components styled with the same shadcn tokens.
 */

import { createRoot } from "react-dom/client";
import { type ReactNode, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Streamdown } from "streamdown";
import {
    Activity,
    ArrowUp,
    AlertTriangle,
    Bell,
    Camera,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Copy,
    Download,
    Eye,
    EyeOff,
    Pencil,
    History,
    Clock,
    Globe,
    Keyboard,
    Mic,
    Volume2,
    Lock,
    MousePointerClick,
    Move,
    Paperclip,
    Pause,
    Plug,
    Plus,
    Radar,
    RotateCcw,
    Settings2,
    Sparkles,
    Square,
    Trash2,
    X,
} from "lucide-react";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/ai-elements/conversation";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/ai-elements/reasoning";
import { Loader } from "@/ai-elements/loader";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { completions, type CommandSpec } from "../commands";
import type { AuthRequest } from "../reviewer";
import { pickPendingAuth, pruneDecided } from "../agent/auth-ui";
import type { ServerState, MarkerData, GoalLoopState } from "../agent/protocol";

// Our API + assets live under `/_agent`. The desktop sidebar (loaded from a
// file:// page) gets the origin from its preload; a browser uses same-origin.
const AGENT_ORIGIN = (window as unknown as { __AGENT_ORIGIN__?: string }).__AGENT_ORIGIN__ ?? location.origin;
const BASE = `${AGENT_ORIGIN}/_agent`;
// Stable per-tab id so the live broadcast can tell our own run's echo from runs
// started by other clients (web/desktop) or autonomously.
const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
// Date helpers that never render "Invalid Date" — a missing/zero/NaN timestamp
// (e.g. a segment or meeting record that hasn't been stamped yet) falls back to "—".
const fmtTime = (t: number, opts?: Intl.DateTimeFormatOptions) =>
    Number.isFinite(t) && t > 0 ? new Date(t).toLocaleTimeString([], opts ?? { hour: "2-digit", minute: "2-digit" }) : "—";
const fmtDateTime = (t: number, opts?: Intl.DateTimeFormatOptions) =>
    Number.isFinite(t) && t > 0 ? new Date(t).toLocaleString([], opts ?? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
// The desktop shell injects __AGENT_ORIGIN__ via its preload and is loopback-
// exempt (never gated), so "Sign out" is meaningless there - only web clients
// hold a session cookie to clear.
const IS_DESKTOP = !!(window as unknown as { __AGENT_ORIGIN__?: string }).__AGENT_ORIGIN__;
// Embedded as the chat pane of a console. Two flavours:
//   ?embed=1        → the web/mobile console: trim ALL chrome (the console's single
//                     merged bar drives new-chat/history/copy via postMessage).
//   ?embed=desktop  → the native desktop console: same page-level trims, but KEEP
//                     this header visible (new-chat / history / copy / monitor /
//                     settings live here, in the right panel) and DON'T ask the
//                     console to full-screen the chat when a panel opens — the panel
//                     renders inside the right column, not over the live screen.
const EMBED_MODE = (() => {
    try {
        return new URLSearchParams(location.search).get("embed");
    } catch {
        return null;
    }
})();
const IS_EMBED = EMBED_MODE === "1" || EMBED_MODE === "desktop";
const IS_EMBED_DESKTOP = EMBED_MODE === "desktop";

// Browser/PWA notifications (Web Notification API) — opt-in, persisted per-device.
const WEB_NOTIFS_KEY = "pikvm-web-notifs";
function webNotifsOn(): boolean {
    try {
        return localStorage.getItem(WEB_NOTIFS_KEY) === "1";
    } catch {
        return false;
    }
}
/**
 * Fire a browser notification for an agent event — but only when enabled, permitted,
 * and the user isn't already looking at this window (no point pinging the screen
 * they're staring at). Tags collapse repeats of the same kind.
 */
function notify(title: string, body: string, tag?: string): void {
    try {
        if (typeof Notification === "undefined" || !webNotifsOn() || Notification.permission !== "granted") return;
        if (typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()) return;
        const opts: NotificationOptions = { body, icon: "/_agent/icon.png", ...(tag ? { tag } : {}) };
        const n = new Notification(title, opts);
        n.onclick = () => {
            try {
                window.focus();
            } catch {
                /* ignore */
            }
            try {
                (window.parent as Window | null)?.focus();
            } catch {
                /* ignore */
            }
            n.close();
        };
    } catch {
        /* notifications are best-effort */
    }
}

function post(path: string, body: unknown = {}) {
    return fetch(BASE + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

const SUGGESTIONS = [
    "Take a screenshot and describe what's on screen",
    "Open a terminal",
    "Check what operating system this is",
];

function timeAgo(ts: number): string {
    const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

function PillSelect({
    value,
    onChange,
    title,
    children,
    className,
}: {
    value: string;
    onChange: (v: string) => void;
    title: string;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("relative min-w-0", className)}>
            <select
                value={value}
                title={title}
                onChange={(e) => onChange(e.target.value)}
                className="w-full cursor-pointer appearance-none truncate rounded-full border bg-secondary py-1 pl-2.5 pr-6 text-xs text-foreground outline-none transition-colors hover:bg-accent"
            >
                {children}
            </select>
            <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        </div>
    );
}

/* ------------------------------- custom parts ----------------------------- */

/** The image + its markers, sized to its natural dimensions (never stretched). */
// Keep only the most recent N screenshots' pixels in renderer memory — each base64
// JPEG is ~100-500KB, so an unbounded transcript balloons the renderer to GBs. Older
// ones keep their metadata (size, markers) but drop `data.src`; they render as a light
// placeholder and the disk transcript stays small too. Returns the SAME array when
// there's nothing to free (so the driving effect can't loop).
const KEEP_UI_SHOTS = 8;
function pruneUiScreens(msgs: any[]): any[] {
    const shots: Array<[number, number]> = [];
    for (let mi = 0; mi < msgs.length; mi++) {
        const parts = (msgs[mi] as { parts?: any[] })?.parts;
        if (!Array.isArray(parts)) continue;
        for (let pi = 0; pi < parts.length; pi++) {
            const p = parts[pi];
            if (p?.type === "data-screenshot" && p.data?.src) shots.push([mi, pi]);
        }
    }
    if (shots.length <= KEEP_UI_SHOTS) return msgs;
    const drop = shots.slice(0, shots.length - KEEP_UI_SHOTS);
    const next = msgs.slice();
    const cloned = new Set<number>();
    for (const [mi, pi] of drop) {
        if (!cloned.has(mi)) {
            next[mi] = { ...next[mi], parts: (next[mi] as { parts: any[] }).parts.slice() };
            cloned.add(mi);
        }
        const p = (next[mi] as { parts: any[] }).parts[pi];
        (next[mi] as { parts: any[] }).parts[pi] = { ...p, data: { ...p.data, src: "" } };
    }
    return next;
}

function ShotImage({ src, w, h, markers, onOpen }: { src: string; w: number; h: number; markers: MarkerData[]; onOpen: (s: string) => void }) {
    // Older screenshots have their pixels freed (src cleared) to keep renderer memory
    // bounded — show a light placeholder instead of a broken image.
    if (!src) {
        return (
            <div className="flex h-[120px] w-full items-center justify-center rounded-md border border-dashed text-[11px] text-muted-foreground">
                <Camera className="mr-1.5 size-3.5" /> {w}×{h} · image freed
            </div>
        );
    }
    return (
        <div className="relative inline-block cursor-zoom-in" onClick={() => onOpen(src)}>
            <img src={src} alt="screen" className="block max-h-[440px] max-w-full rounded-md" />
            {markers.map((mk, i) => (
                <span
                    key={i}
                    className={cn(
                        "pointer-events-none absolute -ml-2 -mt-2 size-4 rounded-full",
                        mk.kind === "move"
                            ? "size-2.5 -ml-[5px] -mt-[5px] border-2 border-primary bg-primary/25"
                            : "border-2 border-destructive shadow-[0_0_0_2px_rgba(255,77,77,0.35)]",
                    )}
                    style={{ left: `${(mk.x / (w || 1)) * 100}%`, top: `${(mk.y / (h || 1)) * 100}%` }}
                    title={`${mk.kind} (${mk.x}, ${mk.y})`}
                />
            ))}
            <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 text-[11px] text-white">
                {w}×{h}
            </span>
        </div>
    );
}

/** A screenshot (or a run of adjacent ones) that collapses once superseded —
 *  only the most recent stays expanded, like the reasoning block. */
const ScreenshotBlock = memo(function ScreenshotBlock({
    shots,
    markerMap,
    isLatest,
    onOpen,
}: {
    shots: any[];
    markerMap: Record<string, MarkerData[]>;
    isLatest: boolean;
    onOpen: (s: string) => void;
}) {
    const [open, setOpen] = useState(isLatest);
    useEffect(() => setOpen(isLatest), [isLatest]);
    const last = shots[shots.length - 1].data;
    const label = shots.length > 1 ? `${shots.length} screenshots` : `Screenshot ${last.width}×${last.height}`;

    if (!open) {
        return (
            <button
                onClick={() => setOpen(true)}
                className="flex items-center gap-2 self-start rounded-lg border bg-card/60 py-1 pl-1 pr-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/50"
            >
                {last.src ? <img src={last.src} alt="" className="size-8 rounded object-cover" /> : <span className="flex size-8 items-center justify-center rounded bg-muted/40"><Camera className="size-3.5" /></span>}
                <Camera className="size-3.5" />
                <span>{label}</span>
                <ChevronRight className="size-3.5" />
            </button>
        );
    }
    return (
        <div className="flex flex-col gap-1">
            <button onClick={() => setOpen(false)} className="flex items-center gap-1.5 self-start text-[11px] text-muted-foreground hover:text-foreground">
                <Camera className="size-3" /> {label} <ChevronDown className="size-3" />
            </button>
            {shots.length > 1 ? (
                <ScreenshotCarousel shots={shots} markerMap={markerMap} onOpen={onOpen} />
            ) : (
                <div className="flex min-h-[150px] w-full items-center justify-center overflow-hidden rounded-xl border bg-muted/20 p-3">
                    <ShotImage src={last.src} w={last.width} h={last.height} markers={markerMap[last.toolCallId] ?? []} onOpen={onOpen} />
                </div>
            )}
        </div>
    );
});

function ScreenshotCarousel({ shots, markerMap, onOpen }: { shots: any[]; markerMap: Record<string, MarkerData[]>; onOpen: (s: string) => void }) {
    const [idx, setIdx] = useState(shots.length - 1);
    // Follow the newest as screenshots stream in (only if already at the end).
    const prevLen = useRef(shots.length);
    useEffect(() => {
        if (idx >= prevLen.current - 1) setIdx(shots.length - 1);
        prevLen.current = shots.length;
    }, [shots.length]);

    const cur = shots[Math.min(idx, shots.length - 1)].data;
    const many = shots.length > 1;
    const stop = (e: React.MouseEvent) => e.stopPropagation();
    return (
        // Consistent framed box; the image is centered inside (handles tiny crops).
        <div className="relative flex min-h-[150px] w-full items-center justify-center overflow-hidden rounded-xl border bg-muted/20 p-3">
            <ShotImage src={cur.src} w={cur.width} h={cur.height} markers={markerMap[cur.toolCallId] ?? []} onOpen={onOpen} />
            {many && (
                <>
                    <button
                        className="absolute left-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80 disabled:opacity-0"
                        disabled={idx <= 0}
                        onClick={(e) => { stop(e); setIdx((i) => Math.max(0, i - 1)); }}
                    >
                        <ChevronLeft className="size-4" />
                    </button>
                    <button
                        className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80 disabled:opacity-0"
                        disabled={idx >= shots.length - 1}
                        onClick={(e) => { stop(e); setIdx((i) => Math.min(shots.length - 1, i + 1)); }}
                    >
                        <ChevronRight className="size-4" />
                    </button>
                    <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">
                        {idx + 1}/{shots.length}
                    </span>
                    {shots.length <= 14 && (
                        <div className="absolute bottom-2 left-1/2 flex max-w-[80%] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-full bg-black/60 px-2 py-1">
                            {shots.map((_, i) => (
                                <button
                                    key={i}
                                    onClick={(e) => { stop(e); setIdx(i); }}
                                    className={cn("size-1.5 rounded-full transition-colors", i === idx ? "bg-white" : "bg-white/40")}
                                />
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

const TOOL_ICONS: Record<string, any> = {
    screenshot: Camera,
    move_mouse: Move,
    click: MousePointerClick,
    double_click: MousePointerClick,
    type_text: Keyboard,
    press_key: Keyboard,
    hotkey: Keyboard,
    scroll: Move,
};

function toolLabel(name: string, input: any): string {
    const i = input ?? {};
    const clip = (s: any, n = 60) => `${String(s ?? "").slice(0, n)}${String(s ?? "").length > n ? "…" : ""}`;
    switch (name) {
        case "screenshot":
            return "Took a screenshot";
        case "move_mouse":
            return `Moved to (${i.x}, ${i.y})`;
        case "click":
            return typeof i.x === "number" ? `Clicked (${i.x}, ${i.y})` : "Clicked";
        case "double_click":
            return typeof i.x === "number" ? `Double-clicked (${i.x}, ${i.y})` : "Double-clicked";
        case "type_text":
            return `Typed “${clip(i.text, 32)}”`;
        case "press_key":
            return `Pressed ${i.key}`;
        case "hotkey":
            return `Pressed ${(i.codes ?? []).join("+")}`;
        case "scroll":
            return "Scrolled";
        case "request_approval":
            return i.action ? `Approval: ${clip(i.action, 80)}` : "Requested your approval";
        case "ocr":
            return "Read on-screen text";
        case "drag":
            return "Dragged";
        case "get_regions":
            return "Mapped the screen";
        default:
            return name.replace(/_/g, " ");
    }
}

/** Present-tense "what's happening right now" line for a tool still in flight — so the
 *  in-progress card explains itself instead of a blank "Working…". Crucially, an
 *  approval gate says it's waiting on YOU (not the agent), since that's the hold-up. */
function toolRunningHint(name: string, input: any): string {
    const i = input ?? {};
    switch (name) {
        case "request_approval":
            return i.action ? `Waiting for you to approve: ${String(i.action).slice(0, 56)}${String(i.action).length > 56 ? "…" : ""}` : "Waiting for your approval";
        case "screenshot":
            return "Capturing the screen…";
        case "ocr":
            return "Reading on-screen text…";
        case "click":
        case "double_click":
            return "Clicking…";
        case "move_mouse":
            return "Moving the mouse…";
        case "drag":
            return "Dragging…";
        case "type_text":
            return "Typing…";
        case "press_key":
        case "hotkey":
            return "Pressing keys…";
        case "scroll":
            return "Scrolling…";
        case "get_regions":
            return "Mapping the screen…";
        default:
            return `Running ${name.replace(/_/g, " ")}…`;
    }
}

/** Markdown answer, memoised on its text so the 2-3s state poll (and streaming of
 *  OTHER messages) doesn't re-run Shiki highlighting on every block every time. */
const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
    return <Streamdown className="chat-md text-[14px] leading-relaxed">{text}</Streamdown>;
});

/** A readable string from a tool's result — never a raw JSON dump. */
function formatToolOutput(output: any): string {
    if (output == null) return "";
    if (typeof output === "string") return output.trim();
    if (Array.isArray(output)) {
        const t = output.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).filter(Boolean).join("\n");
        if (t) return t.trim();
    }
    if (typeof output === "object") {
        for (const k of ["text", "message", "result", "summary", "content", "value", "reason"]) {
            if (typeof output[k] === "string" && output[k]) return output[k].trim();
        }
        return Object.entries(output)
            .filter(([, v]) => v != null && typeof v !== "object")
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ");
    }
    return String(output);
}

const ToolCall = memo(function ToolCall({ name, state, input, output }: { name: string; state?: string; input?: any; output?: any }) {
    const [open, setOpen] = useState(false);
    const running = state && state !== "output-available" && state !== "output-error";
    const isErr = state === "output-error" || (output && typeof output === "object" && output.isError);
    const Icon = TOOL_ICONS[name] ?? Activity;
    const label = toolLabel(name, input);

    // In progress: prominent, raised — front and centre. An approval gate is styled
    // amber ("waiting on YOU"), everything else primary ("agent working"), and the
    // subtitle says exactly what's happening rather than a generic "Working…".
    if (running) {
        const waitingOnUser = name === "request_approval";
        const hint = toolRunningHint(name, input);
        return (
            <div
                className={cn(
                    "flex items-center gap-2.5 rounded-xl border px-3 py-2.5 shadow-sm ring-1",
                    waitingOnUser
                        ? "border-amber-500/50 bg-amber-500/[0.08] shadow-amber-500/10 ring-amber-500/15"
                        : "border-primary/40 bg-primary/[0.06] shadow-primary/10 ring-primary/10",
                )}
            >
                <div className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", waitingOnUser ? "bg-amber-500/15 text-amber-500" : "bg-primary/15 text-primary")}>
                    <Icon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium leading-tight text-foreground">{label}</div>
                    <div className={cn("text-[11px]", waitingOnUser ? "text-amber-500" : "text-primary")}>{hint}</div>
                </div>
                <Loader size={15} className={cn("shrink-0", waitingOnUser ? "text-amber-500" : "text-primary")} />
            </div>
        );
    }

    // Done: minimised to a single quiet line, but still visible + expandable.
    const detail = formatToolOutput(output);
    return (
        <div className="text-[12px]">
            <button
                onClick={() => setOpen((o) => !o)}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-muted-foreground transition-colors hover:bg-accent/40"
            >
                <Icon className="size-3 shrink-0 opacity-60" />
                <span className="truncate">{label}</span>
                {isErr ? (
                    <X className="ml-auto size-3 shrink-0 text-destructive" />
                ) : (
                    <Check className="ml-auto size-3 shrink-0 text-emerald-500/70" />
                )}
                {detail && <ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />}
            </button>
            {open && detail && (
                <div
                    className={cn(
                        "ml-[26px] mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg px-2.5 py-1.5 text-[11.5px] leading-snug",
                        isErr ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground/80",
                    )}
                >
                    {detail}
                </div>
            )}
        </div>
    );
});

/** A plain-English "what is about to happen" line from a tool + its args, so the
 *  approval card shows the concrete action — not just the agent's free-text reason. */
function describeOp(op: { tool: string; args?: any }): string {
    const a = op.args ?? {};
    const at = typeof a.x === "number" && typeof a.y === "number" ? ` at (${a.x}, ${a.y})` : "";
    const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);
    switch (op.tool) {
        case "type_text":
            return `Type “${clip(String(a.text ?? ""))}”`;
        case "type_secret":
            return `Type the secret “${a.name ?? ""}”`;
        case "press_key":
            return `Press ${a.key ?? "a key"}`;
        case "hotkey":
            return `Press ${Array.isArray(a.keys) ? a.keys.join(" + ") : a.keys ?? "a chord"}`;
        case "click":
            return `Click${at}`;
        case "double_click":
            return `Double-click${at}`;
        case "move_mouse":
            return `Move the mouse${at}`;
        case "drag":
            return `Drag${at}`;
        case "scroll":
            return `Scroll${at}`;
        default: {
            const keys = Object.keys(a);
            return keys.length ? `${op.tool} (${clip(keys.map((k) => `${k}: ${JSON.stringify(a[k])}`).join(", "))})` : op.tool;
        }
    }
}

function AuthCard({ req, onDecide }: { req: AuthRequest; onDecide: (v: any) => void }) {
    const [redirect, setRedirect] = useState(false);
    const [text, setText] = useState("");
    const [remember, setRemember] = useState(false);
    const [showArgs, setShowArgs] = useState(false);
    return (
        <div
            className={cn(
                "overflow-hidden rounded-2xl border bg-card/95 shadow-2xl shadow-black/40 backdrop-blur",
                req.risky ? "border-destructive/50 ring-1 ring-destructive/25" : "border-primary/40 ring-1 ring-primary/20",
            )}
        >
            <div className="flex items-center gap-2.5 px-3.5 pt-3.5">
                <div
                    className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-lg",
                        req.risky ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary",
                    )}
                >
                    <AlertTriangle className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold leading-tight">Authorize action</div>
                    <div className="text-[11px] text-muted-foreground">The agent is waiting for your go-ahead</div>
                </div>
                <code className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{req.op.tool}</code>
            </div>

            <div className="px-3.5 pt-2.5">
                {/* The concrete action (the "what") — always visible so you can see
                    exactly what's about to happen without expanding Details. */}
                <div className={cn("rounded-lg px-2.5 py-1.5 text-[13px] font-semibold", req.risky ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary")}>
                    {describeOp(req.op)}
                </div>
                {req.reason && <div className="mt-1.5 px-0.5 text-[12px] leading-snug text-muted-foreground">{req.reason}</div>}
                {req.op.args != null && JSON.stringify(req.op.args) !== "{}" && (
                    <div className="mt-1.5">
                        <button onClick={() => setShowArgs((v) => !v)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
                            <ChevronRight className={cn("size-3 transition-transform", showArgs && "rotate-90")} /> Details
                        </button>
                        {showArgs && (
                            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/70 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                                {JSON.stringify(req.op.args, null, 2)}
                            </pre>
                        )}
                    </div>
                )}
            </div>

            <div className="px-3.5 pb-3.5 pt-2.5">
                {redirect ? (
                    <div>
                        <textarea
                            autoFocus
                            className="mb-2 min-h-[54px] w-full resize-y rounded-lg border bg-background p-2 text-sm outline-none focus:border-ring/60"
                            placeholder="Tell the agent what to do instead…"
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                        />
                        <div className="flex gap-1.5">
                            <Button size="sm" className="flex-1" disabled={!text.trim()} onClick={() => onDecide({ decision: "redirect", text })}>
                                Send redirect
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => setRedirect(false)}>
                                Back
                            </Button>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="flex gap-1.5">
                            <Button size="sm" className="h-8 flex-1 bg-emerald-600 text-white hover:bg-emerald-500" onClick={() => onDecide({ decision: "allow", rememberKind: remember })}>
                                <Check className="mr-1 size-3.5" /> Allow
                            </Button>
                            <Button size="sm" variant="destructive" className="h-8" onClick={() => onDecide({ decision: "deny" })}>
                                Deny
                            </Button>
                            <Button size="sm" variant="secondary" className="h-8" onClick={() => setRedirect(true)}>
                                Something else
                            </Button>
                        </div>
                        <label className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-primary" /> Always allow this kind of action
                        </label>
                    </>
                )}
            </div>
        </div>
    );
}

function StatusPill({ state }: { state: ServerState | null }) {
    const label = !state ? "connecting" : state.presence.paused ? "paused" : state.acting ? "working" : "idle";
    const cls =
        label === "working"
            ? "bg-primary/20 text-primary"
            : label === "paused"
              ? "bg-destructive/20 text-destructive"
              : "bg-muted text-muted-foreground";
    return <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", cls)}>{label}</span>;
}

/**
 * Banner for the self-verifying goal loop: shows the goal, the current iteration
 * out of the cap, and the last blind verdict ("iterating (2/6): <whats missing>"
 * while running; the pass/fail verdict once finished).
 */
function GoalLoopBanner({ loop }: { loop: GoalLoopState }) {
    const v = loop.lastVerdict;
    const done = !loop.active;
    const passed = done && v?.achieved === true;
    const cls = passed
        ? "bg-emerald-500/15 text-emerald-300"
        : done
          ? "bg-amber-500/15 text-amber-300"
          : "bg-primary/10 text-foreground";
    const detail = loop.active
        ? v
            ? `iterating (${loop.iteration}/${loop.cap}): ${v.whatsMissing ?? v.reason}`
            : `working (${loop.iteration}/${loop.cap})…`
        : passed
          ? `verified done (${loop.iteration}/${loop.cap}): ${v?.reason ?? ""}`
          : v?.achieved
            ? `done: ${v.reason}`
            : `stopped (${loop.iteration}/${loop.cap}): ${v?.whatsMissing ?? v?.reason ?? "cap reached"}`;
    return (
        <div className={cn("border-b px-3 py-1.5 text-xs", cls)}>
            <span className="font-semibold">{passed ? "✅" : done ? "⏹" : "🔁"} Goal:</span> {loop.goal}
            <div className="mt-0.5 opacity-90">{detail}</div>
        </div>
    );
}

function ContextMeter({ ctx }: { ctx: { tokens: number; max: number } | undefined }) {
    if (!ctx || !ctx.max) return null;
    const pct = Math.min(100, Math.round((ctx.tokens / ctx.max) * 100));
    const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
    return (
        <div className="flex items-center gap-1.5" title={`${ctx.tokens} / ${ctx.max} context tokens`}>
            <div className="h-1.5 w-11 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full transition-all", pct > 85 ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[10px] text-muted-foreground">
                {k(ctx.tokens)}/{k(ctx.max)}
            </span>
        </div>
    );
}

function Modal({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
    return (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
            <div
                className={cn("relative flex flex-col bg-card", IS_EMBED || wide ? "w-full" : "w-72 border-l")}
                onClick={(e) => e.stopPropagation()}
            >
                {children}
            </div>
        </div>
    );
}

const AMBIENT_ICON: Record<string, string> = {
    notification: "🔔",
    email: "📧",
    message: "💬",
    "meeting-start": "📞",
    "meeting-end": "🔚",
    "app-change": "🪟",
    "content-change": "📝",
    info: "•",
};

const TRACE_COLOR: Record<string, string> = {
    change: "text-sky-400",
    triage: "text-violet-400",
    meeting: "text-emerald-400",
    activity: "text-emerald-300",
    notify: "text-amber-400",
    transcript: "text-foreground",
    event: "text-primary",
    info: "text-muted-foreground",
};

function AmbientPanel({ state, onClose, onRefresh }: { state: ServerState | null; onClose: () => void; onRefresh: () => void }) {
    const amb = state?.ambient;
    const events = amb?.events ?? [];
    const fmt = (t: number) => fmtTime(t);
    // Live trace of the monitor's decisions (SSE).
    const [trace, setTrace] = useState<{ ts: number; level: string; text: string }[]>([]);
    const traceRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const es = new EventSource(BASE + "/api/ambient/stream");
        es.onmessage = (e) => {
            try {
                const d = JSON.parse(e.data);
                setTrace((t) => [...t.slice(-300), d]);
            } catch {
                /* ignore keep-alives */
            }
        };
        return () => es.close();
    }, []);
    useEffect(() => {
        const el = traceRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [trace]);
    const fmtSec = (t: number) => fmtTime(t, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    // Past meetings log.
    const [meetings, setMeetings] = useState<any[]>([]);
    const [openMeeting, setOpenMeeting] = useState<any | null>(null);
    const loadMeetings = () =>
        fetch(BASE + "/api/meetings").then((r) => r.json()).then((d) => setMeetings(d.meetings ?? [])).catch(() => {});
    useEffect(() => {
        void loadMeetings();
    }, [amb?.inMeeting]); // refresh when a meeting ends
    // Live transcript: status + timestamped segments, with copy/export + manual toggle.
    const ts = amb?.transcriptStatus;
    const segs = amb?.transcriptSegments ?? [];
    const transcriptRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = transcriptRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [segs.length]);
    const transcriptActive = !!amb?.transcriptActive;
    const relTime = (t: number) => {
        const base = ts?.startedAt && ts.startedAt > 0 ? ts.startedAt : segs[0]?.ts ?? t;
        const s = Math.max(0, Math.floor((t - base) / 1000));
        return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    };
    const copyTranscript = () => {
        const txt = segs.map((s) => s.text).join("\n");
        if (txt) void navigator.clipboard?.writeText(txt).catch(() => {});
    };
    const exportTranscript = () => {
        const txt = segs.map((s) => `[${relTime(s.ts)}] ${s.text}`).join("\n");
        if (!txt) return;
        const blob = new Blob([txt], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `transcript-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const sttWarn = ts && (ts.state === "no-whisper" || ts.state === "no-ffmpeg" || ts.state === "no-audio");
    const sttTone: Record<string, string> = {
        "no-whisper": "text-destructive",
        "no-ffmpeg": "text-destructive",
        "no-audio": "text-amber-500",
        "downloading-model": "text-sky-500",
        listening: "text-muted-foreground",
        transcribing: "text-emerald-500",
        idle: "text-muted-foreground",
    };
    return (
        <Modal onClose={onClose} wide>
            <div className="flex items-center justify-between border-b p-3 font-semibold">
                <span className="flex items-center gap-2">
                    <Radar className={cn("size-4", amb?.enabled && "text-primary")} /> Ambient monitor
                    {amb?.inMeeting && <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-500">in meeting</span>}
                </span>
                <button onClick={onClose} className="text-muted-foreground"><X className="size-4" /></button>
            </div>
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
                <span>{amb?.enabled ? "Watching the screen in the background." : "Off — enable it in Settings → Ambient."}</span>
                {events.length > 0 && (
                    <button className="shrink-0 hover:text-foreground" onClick={() => post("/api/ambient/clear")}>Clear</button>
                )}
            </div>
            {/* Test / diagnostics */}
            <div className="border-b bg-muted/10 px-3 py-2">
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                    <Button size="sm" variant="secondary" className="h-7" onClick={() => post("/api/ambient/check")} title="Triage the current screen now">
                        Check screen now
                    </Button>
                    <Button size="sm" variant="secondary" className="h-7" onClick={() => post(amb?.inMeeting ? "/api/ambient/meeting" : "/api/ambient/meeting", { on: !amb?.inMeeting })}>
                        {amb?.inMeeting ? "End test meeting" : "Simulate meeting"}
                    </Button>
                    <Button size="sm" variant="secondary" className="h-7" onClick={() => post("/api/ambient/test")}>Test push</Button>
                </div>
                {amb?.debug && (
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                        <span>on KVM: <b className={amb.debug.onKVM ? "text-emerald-500" : "text-amber-500"}>{String(amb.debug.onKVM)}</b></span>
                        <span>enabled: <b className={amb.debug.enabled ? "text-emerald-500" : "text-amber-500"}>{String(amb.debug.enabled)}</b></span>
                        <span>in hours: <b className={amb.debug.withinHours ? "text-emerald-500" : "text-amber-500"}>{String(amb.debug.withinHours)}</b></span>
                        <span>capture: <b className={amb.debug.hasFingerprint ? "text-emerald-500" : "text-amber-500"}>{String(amb.debug.hasFingerprint)}</b></span>
                        <span>Δstep: <b>{amb.debug.lastStepDiff}</b></span>
                        <span>Δbase: <b>{amb.debug.lastBaseDiff}</b></span>
                        <span className="col-span-2">triage model: <b>{amb.debug.triageModel}</b></span>
                    </div>
                )}
            </div>
            {(amb?.transcribe || transcriptActive) && (
                <div className="border-b bg-muted/20 px-3 py-2">
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium">
                        <span className={cn("size-1.5 rounded-full bg-red-500", ts?.state === "transcribing" && "animate-pulse")} />
                        <span className="text-muted-foreground">Live transcript</span>
                        {ts?.mic && (
                            <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-muted px-1 text-[9px] text-muted-foreground">
                                <Mic className="size-2.5" /> mic
                            </span>
                        )}
                        {ts?.remote && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1 text-[9px] text-muted-foreground">
                                <Volume2 className="size-2.5" /> remote
                            </span>
                        )}
                        <div className="ml-auto flex items-center gap-1">
                            <button title="Copy transcript" onClick={copyTranscript} disabled={!segs.length} className="text-muted-foreground hover:text-foreground disabled:opacity-40">
                                <Copy className="size-3" />
                            </button>
                            <button title="Export as .txt" onClick={exportTranscript} disabled={!segs.length} className="text-muted-foreground hover:text-foreground disabled:opacity-40">
                                <Download className="size-3" />
                            </button>
                            <button
                                title={transcriptActive ? "Stop listening" : "Start listening"}
                                onClick={() => post("/api/ambient/transcribe", { on: !transcriptActive }).then(onRefresh)}
                                className={cn("ml-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium", transcriptActive ? "bg-red-500/15 text-red-500 hover:bg-red-500/25" : "bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25")}
                            >
                                {transcriptActive ? "Stop" : "Start"}
                            </button>
                        </div>
                    </div>
                    {ts && ts.state !== "listening" && ts.state !== "transcribing" && (
                        <div className={cn("mb-1.5 flex items-start gap-1.5 rounded-md border px-2 py-1 text-[11px] leading-snug", sttWarn ? "border-amber-500/30 bg-amber-500/10" : "border-border bg-muted/40", sttTone[ts.state])}>
                            {sttWarn ? <AlertTriangle className="mt-0.5 size-3 shrink-0" /> : <Clock className="mt-0.5 size-3 shrink-0" />}
                            <span>{ts.detail}</span>
                        </div>
                    )}
                    <div ref={transcriptRef} className="max-h-48 overflow-auto text-[12px] leading-snug">
                        {segs.length === 0 ? (
                            <span className="text-muted-foreground">{ts?.detail ?? "Listening…"}</span>
                        ) : (
                            segs.map((s, i) => (
                                <div key={i} className="flex gap-2">
                                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60">{relTime(s.ts)}</span>
                                    <span className="min-w-0 break-words">{s.text}</span>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
            {/* Live monitor console (SSE) */}
            <div className="border-b bg-black/30 px-3 py-2">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> Live monitor
                    <span className="ml-auto cursor-pointer hover:text-foreground" onClick={() => setTrace([])}>clear</span>
                </div>
                <div ref={traceRef} className="max-h-44 overflow-auto font-mono text-[11px] leading-relaxed">
                    {trace.length === 0 ? (
                        <span className="text-muted-foreground">Waiting for the monitor… (change the screen, or use the buttons above)</span>
                    ) : (
                        trace.map((l, i) => (
                            <div key={i} className="flex gap-2">
                                <span className="shrink-0 text-muted-foreground/60">{fmtSec(l.ts)}</span>
                                <span className={cn("min-w-0 break-words", TRACE_COLOR[l.level] ?? "text-foreground")}>{l.text}</span>
                            </div>
                        ))
                    )}
                </div>
            </div>
            <div className="flex-1 overflow-auto">
                {events.length === 0 && <div className="p-4 text-sm text-muted-foreground">Nothing notable yet.</div>}
                {events.map((e) => (
                    <div key={e.id} className="flex gap-2.5 border-b px-3 py-2">
                        <span className="mt-0.5 text-base leading-none">{AMBIENT_ICON[e.kind] ?? "•"}</span>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                                <span className="truncate text-[13px] font-medium">{e.title}</span>
                                {e.notified && <Bell className="size-3 shrink-0 text-muted-foreground" />}
                                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{fmt(e.ts)}</span>
                            </div>
                            {e.detail && <div className="mt-0.5 whitespace-pre-wrap text-[12px] leading-snug text-muted-foreground">{e.detail}</div>}
                        </div>
                        {e.thumb && <img src={e.thumb} alt="" className="h-10 w-16 shrink-0 rounded border object-cover" />}
                    </div>
                ))}
                {meetings.length > 0 && (
                    <div className="border-t">
                        <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Past meetings</div>
                        {meetings.map((m) => (
                            <button
                                key={m.id}
                                className="flex w-full items-center gap-2 border-b px-3 py-2 text-left hover:bg-accent/40"
                                onClick={() => fetch(BASE + "/api/meetings/get", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: m.id }) }).then((r) => r.json()).then((d) => setOpenMeeting(d.meeting)).catch(() => {})}
                            >
                                <span className="text-base leading-none">📞</span>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-[13px]">{m.title}</div>
                                    <div className="text-[10px] text-muted-foreground">
                                        {fmtDateTime(m.startTs)} · {m.suggestionCount} note{m.suggestionCount === 1 ? "" : "s"}
                                        {m.hasTranscript ? " · transcript" : ""}
                                    </div>
                                </div>
                                <ChevronRight className="size-3.5 text-muted-foreground" />
                            </button>
                        ))}
                    </div>
                )}
            </div>
            {openMeeting && (
                <div className="absolute inset-0 z-10 flex flex-col bg-card" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2 border-b p-3">
                        <button onClick={() => setOpenMeeting(null)} className="text-muted-foreground hover:text-foreground">
                            <ChevronLeft className="size-4" />
                        </button>
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{openMeeting.title}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                            {fmtDateTime(openMeeting.startTs)}
                        </span>
                    </div>
                    <div className="flex-1 space-y-3 overflow-auto p-3">
                        <div>
                            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Copilot suggestions</div>
                            {(openMeeting.suggestions ?? []).length === 0 ? (
                                <div className="text-[12px] text-muted-foreground">None.</div>
                            ) : (
                                <div className="space-y-1.5">
                                    {openMeeting.suggestions.map((s: any, i: number) => (
                                        <div key={i} className="whitespace-pre-wrap rounded-lg border bg-muted/30 px-2.5 py-1.5 text-[12px] leading-snug">{s.text}</div>
                                    ))}
                                </div>
                            )}
                        </div>
                        {openMeeting.transcript?.trim() && (
                            <div>
                                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Transcript</div>
                                <div className="whitespace-pre-wrap rounded-lg border bg-muted/20 p-2.5 text-[12px] leading-relaxed text-muted-foreground">{openMeeting.transcript}</div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </Modal>
    );
}

function ActivityPanel({ state, onClose }: { state: ServerState | null; onClose: () => void }) {
    const log = (state?.log ?? []).slice().reverse();
    const fmt = (t: number) => fmtTime(t, {});
    return (
        <Modal onClose={onClose}>
            <div className="flex items-center justify-between border-b p-3 font-semibold">
                Activity
                <button onClick={onClose} className="text-muted-foreground">
                    <X className="size-4" />
                </button>
            </div>
            <div className="flex-1 overflow-auto">
                {log.length === 0 && <div className="p-4 text-sm text-muted-foreground">No operations yet.</div>}
                {log.map((e) => (
                    <div key={e.id} className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
                        <span className={cn("w-3.5 text-center", e.decision === "deny" ? "text-destructive" : e.decision === "redirect" ? "text-primary" : "text-emerald-500")}>
                            {e.decision === "auto-allow" ? "✓" : e.decision === "deny" ? "✕" : e.decision === "redirect" ? "↦" : "✓"}
                        </span>
                        <span className="font-semibold">{e.op.tool}</span>
                        {e.risky && <span className="rounded border border-destructive px-1 text-[10px] text-destructive">risky</span>}
                        <span className="ml-auto text-[10px] text-muted-foreground">{fmt(e.at)}</span>
                    </div>
                ))}
            </div>
        </Modal>
    );
}

/** A polished on/off toggle (real switch, not a raw checkbox). */
function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => !disabled && onChange(!checked)}
            className={cn(
                "box-border inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer appearance-none items-center rounded-full border-0 p-0 transition-colors",
                checked ? "bg-primary" : "bg-muted-foreground/30",
                disabled && "cursor-not-allowed opacity-40",
            )}
        >
            <span className={cn("pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform", checked ? "translate-x-[19px]" : "translate-x-[3px]")} />
        </button>
    );
}

/** label (+ optional description) on the left, a control on the right. */
function Row({ label, desc, control, htmlFor }: { label: string; desc?: string; control: ReactNode; htmlFor?: string }) {
    return (
        <div className="flex items-center justify-between gap-3 py-0.5">
            <label htmlFor={htmlFor} className="min-w-0 select-none">
                <div className="text-[13px] leading-tight">{label}</div>
                {desc && <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{desc}</div>}
            </label>
            <div className="shrink-0">{control}</div>
        </div>
    );
}

/** Browser-notification toggle (client-local: localStorage + Notification permission).
 *  Turning it on requests permission; reflects a blocked/unsupported state. */
function WebNotifyRow() {
    const supported = typeof Notification !== "undefined";
    const [on, setOn] = useState(webNotifsOn);
    const [perm, setPerm] = useState<NotificationPermission>(supported ? Notification.permission : "denied");
    const toggle = async (v: boolean) => {
        if (v && supported && Notification.permission !== "granted") {
            let p: NotificationPermission = "denied";
            try {
                p = await Notification.requestPermission();
            } catch {
                /* ignore */
            }
            setPerm(p);
            if (p !== "granted") {
                setOn(false);
                try {
                    localStorage.setItem(WEB_NOTIFS_KEY, "0");
                } catch {
                    /* ignore */
                }
                return;
            }
        }
        setOn(v);
        try {
            localStorage.setItem(WEB_NOTIFS_KEY, v ? "1" : "0");
        } catch {
            /* ignore */
        }
    };
    const desc = !supported
        ? "Not supported in this browser"
        : perm === "denied"
          ? "Blocked — allow notifications for this site in your browser settings"
          : "Alerts on this device when a task finishes, needs approval, errors, or a suggestion appears";
    return <Row label="Browser notifications" desc={desc} control={<Switch checked={on && perm === "granted"} disabled={!supported || perm === "denied"} onChange={toggle} />} />;
}

/** One saved secret: reveal/hide the value, edit the value + note inline, or delete.
 *  The value is fetched on demand from /api/secrets/reveal (never in the state poll). */
function SecretRow({ name, hint, onChanged }: { name: string; hint?: string; onChanged: () => void }) {
    const [shown, setShown] = useState(false);
    const [editing, setEditing] = useState(false);
    const [val, setVal] = useState("");
    const [note, setNote] = useState(hint ?? "");
    const [busy, setBusy] = useState(false);

    const fetchValue = async (): Promise<string> => {
        try {
            const r = await fetch(BASE + "/api/secrets/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
            const j = await r.json();
            return typeof j.value === "string" ? j.value : "";
        } catch {
            return "";
        }
    };
    const toggleReveal = async () => {
        if (shown) {
            setShown(false);
            return;
        }
        setBusy(true);
        setVal(await fetchValue());
        setBusy(false);
        setShown(true);
    };
    const startEdit = async () => {
        setBusy(true);
        setVal(await fetchValue()); // reveal so the value can be edited
        setNote(hint ?? "");
        setBusy(false);
        setShown(true);
        setEditing(true);
    };
    const save = async () => {
        await post("/api/secrets", { name, value: val, hint: note });
        setEditing(false);
        onChanged();
    };

    if (editing) {
        return (
            <div className="space-y-1.5 rounded-lg border bg-card/60 px-2.5 py-2 text-xs">
                <div className="flex items-center gap-1.5 text-[12px] font-medium">
                    <Lock className="size-3.5 shrink-0 text-muted-foreground" /> {name}
                </div>
                <input value={val} onChange={(e) => setVal(e.target.value)} placeholder="Value" className="w-full rounded-md border bg-background px-2 py-1 font-mono text-[12px] outline-none focus:border-ring/50" />
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note — when to use it" className="w-full rounded-md border bg-background px-2 py-1 text-[12px] outline-none focus:border-ring/50" onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
                <div className="flex items-center justify-between pt-0.5">
                    <button className="text-[11px] text-muted-foreground hover:text-destructive" onClick={() => void post("/api/secrets/delete", { name }).then(onChanged)}>Delete</button>
                    <div className="flex gap-1.5">
                        <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setEditing(false)}>Cancel</button>
                        <Button size="sm" className="h-7" onClick={() => void save()}>Save</Button>
                    </div>
                </div>
            </div>
        );
    }
    return (
        <div className="flex items-center gap-2 rounded-lg border bg-card/60 px-2.5 py-2 text-xs">
            <Lock className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">{name}</div>
                {hint && <div className="truncate text-[10px] text-muted-foreground">{hint}</div>}
            </div>
            <span className="max-w-[110px] truncate font-mono text-muted-foreground">{busy ? "…" : shown ? val || "(empty)" : "••••••"}</span>
            <button className="text-muted-foreground hover:text-foreground" title={shown ? "Hide" : "Reveal value"} onClick={() => void toggleReveal()}>
                {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
            <button className="text-muted-foreground hover:text-foreground" title="Edit secret" onClick={() => void startEdit()}>
                <Pencil className="size-3.5" />
            </button>
            <button className="text-muted-foreground hover:text-destructive" title="Delete secret" onClick={() => void post("/api/secrets/delete", { name }).then(onChanged)}>
                <X className="size-3.5" />
            </button>
        </div>
    );
}

/* =============================== MCP servers ============================== */
/* NEW SECTION. A generic editor for the agent's MCP-server registry. Each entry
   is a stdio process (command/args/env) or an http endpoint (url/headers); the
   whole edited list is sent back via onPatch({ mcpServers }). Tools connect at
   the next restart, so changes are advisory until then. */

type McpServer = NonNullable<ServerState["settings"]>["mcpServers"][number];

/** Parse a textarea of "KEY=value" lines into a record (skips blanks/comments). */
function parseKeyVals(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq <= 0) continue;
        out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return out;
}

/** Render a record back to "KEY=value" lines for editing. */
function stringifyKeyVals(rec: Record<string, string> | undefined): string {
    return Object.entries(rec ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
}

function McpServersTab({ servers, inputCls, onPatch }: { servers: McpServer[]; inputCls: string; onPatch: (p: any) => void }) {
    // Edit the list locally, then push the whole array on every change so the
    // server persists it. The list re-renders from server state after each patch.
    const save = (next: McpServer[]) => onPatch({ mcpServers: next });
    const update = (id: string, patch: Partial<McpServer>) => save(servers.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    const remove = (id: string) => save(servers.filter((m) => m.id !== id));
    const add = () => {
        const base = "server";
        let n = 1;
        const ids = new Set(servers.map((m) => m.id));
        while (ids.has(`${base}-${n}`)) n++;
        const id = `${base}-${n}`;
        save([...servers, { id, name: `New server ${n}`, enabled: false, transport: "stdio", command: "", args: [] }]);
    };
    return (
        <div className="space-y-3">
            <p className="text-[12px] leading-snug text-muted-foreground">
                Connect MCP servers to give the agent extra tools. Each server is a local process (stdio) or a URL (http). Atlas (the
                memory vault) is just one server here. Changes connect on the next restart.
            </p>
            {servers.length === 0 && (
                <p className="rounded-xl border border-dashed p-4 text-center text-[12px] leading-relaxed text-muted-foreground">
                    No MCP servers configured. Add one to extend the agent's tools.
                </p>
            )}
            {servers.map((m) => (
                <div key={m.id} className="space-y-2 rounded-xl border bg-card/40 p-3">
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                            <Plug className={cn("size-3.5 shrink-0", m.enabled ? "text-primary" : "text-muted-foreground")} />
                            <input
                                defaultValue={m.name}
                                onBlur={(e) => e.target.value.trim() !== m.name && update(m.id, { name: e.target.value.trim() || m.id })}
                                className={cn(inputCls, "h-7 flex-1 text-[12px] font-medium")}
                            />
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            <Switch checked={m.enabled} onChange={(v) => update(m.id, { enabled: v })} />
                            <button className="text-muted-foreground hover:text-destructive" title="Remove" onClick={() => remove(m.id)}>
                                <Trash2 className="size-3.5" />
                            </button>
                        </div>
                    </div>

                    {/* transport toggle */}
                    <div className="flex gap-0.5 rounded-lg bg-muted/60 p-0.5">
                        {(["stdio", "http"] as const).map((tr) => (
                            <button
                                key={tr}
                                onClick={() => update(m.id, { transport: tr })}
                                className={cn(
                                    "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                                    m.transport === tr ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                                )}
                            >
                                {tr}
                            </button>
                        ))}
                    </div>

                    {m.transport === "stdio" ? (
                        <div className="space-y-1.5">
                            <label className="block text-[11px] text-muted-foreground">
                                Command
                                <input
                                    defaultValue={m.command ?? ""}
                                    onBlur={(e) => e.target.value !== (m.command ?? "") && update(m.id, { command: e.target.value.trim() })}
                                    placeholder="/path/to/server-binary"
                                    className={cn(inputCls, "mt-1 font-mono text-[11px]")}
                                />
                            </label>
                            <label className="block text-[11px] text-muted-foreground">
                                Arguments (one per line)
                                <textarea
                                    defaultValue={(m.args ?? []).join("\n")}
                                    onBlur={(e) => {
                                        const args = e.target.value.split("\n").map((a) => a.trim()).filter(Boolean);
                                        update(m.id, { args });
                                    }}
                                    rows={2}
                                    placeholder={"mcp\n/path/to/vault"}
                                    className={cn(inputCls, "mt-1 resize-y font-mono text-[11px]")}
                                />
                            </label>
                            <label className="block text-[11px] text-muted-foreground">
                                Environment (KEY=value per line)
                                <textarea
                                    defaultValue={stringifyKeyVals(m.env)}
                                    onBlur={(e) => update(m.id, { env: parseKeyVals(e.target.value) })}
                                    rows={2}
                                    placeholder="API_TOKEN=…"
                                    className={cn(inputCls, "mt-1 resize-y font-mono text-[11px]")}
                                />
                            </label>
                        </div>
                    ) : (
                        <div className="space-y-1.5">
                            <label className="block text-[11px] text-muted-foreground">
                                URL
                                <input
                                    defaultValue={m.url ?? ""}
                                    onBlur={(e) => e.target.value !== (m.url ?? "") && update(m.id, { url: e.target.value.trim() })}
                                    placeholder="https://host/mcp"
                                    className={cn(inputCls, "mt-1 font-mono text-[11px]")}
                                />
                            </label>
                            <label className="block text-[11px] text-muted-foreground">
                                Headers (KEY=value per line)
                                <textarea
                                    defaultValue={stringifyKeyVals(m.headers)}
                                    onBlur={(e) => update(m.id, { headers: parseKeyVals(e.target.value) })}
                                    rows={2}
                                    placeholder="Authorization=Bearer …"
                                    className={cn(inputCls, "mt-1 resize-y font-mono text-[11px]")}
                                />
                            </label>
                        </div>
                    )}

                    <label className="block text-[11px] text-muted-foreground">
                        Usage skill (optional)
                        <input
                            defaultValue={m.skill ?? ""}
                            onBlur={(e) => e.target.value !== (m.skill ?? "") && update(m.id, { skill: e.target.value.trim() })}
                            placeholder="e.g. atlas-vault"
                            className={cn(inputCls, "mt-1 text-[11px]")}
                        />
                    </label>
                </div>
            ))}
            <Button size="sm" variant="secondary" className="h-8 w-full" onClick={add}>
                <Plus className="size-3.5" /> Add MCP server
            </Button>
            <p className="text-center text-[10px] text-muted-foreground">Servers connect at startup — restart to apply changes.</p>
        </div>
    );
}

/**
 * Providers & Models settings: sign in / enter an API key per provider (keys go
 * to the secrets vault via /api/provider-key), and pick the `provider/model` for
 * each role — reasoning, fast/tool, sub-agent. Only authed providers' models are
 * offered. Non-OpenAI models like Kimi become reachable once their provider has
 * a key (e.g. Moonshot → `moonshotai/kimi-k2.6`).
 */
function ModelsTab({ state, inputCls, onPatch }: { state: ServerState | null; inputCls: string; onPatch: (p: any) => void }) {
    const providers = state?.providers ?? [];
    const mr = state?.settings?.modelRouting;
    const routingOn = mr?.enabled ?? true;
    const [keys, setKeys] = useState<Record<string, string>>({});
    const [openProvider, setOpenProvider] = useState<string | null>(null);

    // A role picker: optgroups per authed provider, listing `provider/model` specs.
    const RolePicker = ({ label, value, field, desc }: { label: string; value: string | undefined; field: "reasoningModel" | "fastModel" | "subagentModel"; desc?: string }) => {
        const authed = providers.filter((p) => p.ready && p.models.length);
        // Keep the current value selectable even if its provider is now un-authed.
        const known = authed.some((p) => p.models.includes(value ?? ""));
        return (
            <label className="block text-[11px] text-muted-foreground">
                {label}
                <select
                    value={value ?? ""}
                    onChange={(e) => post("/api/settings", { modelRouting: { [field]: e.target.value } }).then(() => onPatch({}))}
                    className={cn(inputCls, "mt-1 text-[12px]")}
                >
                    {!known && value ? <option value={value}>{value} (provider not signed in)</option> : null}
                    {authed.map((p) => (
                        <optgroup key={p.id} label={p.label}>
                            {p.models.map((m) => (
                                <option key={m} value={m}>
                                    {m}
                                </option>
                            ))}
                        </optgroup>
                    ))}
                    {authed.length === 0 ? <option value="">Sign in / add a key below</option> : null}
                </select>
                {desc ? <span className="mt-0.5 block text-[10px] text-muted-foreground/80">{desc}</span> : null}
            </label>
        );
    };

    return (
        <div className="flex flex-col gap-3 text-sm">
            {/* ---- providers: sign-in / API keys ---- */}
            <div>
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <Sparkles className="size-3" /> Providers
                </div>
                <div className="overflow-hidden rounded-xl border divide-y">
                    {providers.map((p) => {
                        const isOpen = openProvider === p.id;
                        return (
                            <div key={p.id} className="bg-card/40">
                                <button
                                    type="button"
                                    onClick={() => setOpenProvider(isOpen ? null : p.id)}
                                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
                                >
                                    <span className={cn("size-2 shrink-0 rounded-full", p.ready ? "bg-emerald-500" : "bg-muted-foreground/30")} />
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1.5">
                                            <span className="truncate text-[13px] font-medium">{p.label}</span>
                                            {p.ready ? <Check className="size-3 shrink-0 text-emerald-600" /> : null}
                                        </div>
                                        {p.desc ? <div className="truncate text-[10.5px] text-muted-foreground">{p.desc}</div> : null}
                                    </div>
                                    <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                                        {p.ready ? "Connected" : p.kind === "oauth" ? "Sign in" : "Add key"}
                                    </span>
                                    <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
                                </button>
                                {isOpen ? (
                                    <div className="px-3 pb-3 pt-0.5">
                                        {p.kind === "oauth" ? (
                                            p.ready ? (
                                                <p className="text-[11px] text-muted-foreground">Signed in with your ChatGPT subscription.</p>
                                            ) : (
                                                <Button size="sm" className="h-8 w-full" onClick={() => post("/api/login").then(() => onPatch({}))}>
                                                    Sign in
                                                </Button>
                                            )
                                        ) : (
                                            <>
                                                <div className="flex gap-1.5">
                                                    <input
                                                        type="password"
                                                        placeholder={p.ready ? "Replace key…" : "Paste API key"}
                                                        value={keys[p.id] ?? ""}
                                                        onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))}
                                                        className={cn(inputCls, "text-[12px]")}
                                                    />
                                                    <Button
                                                        size="sm"
                                                        className="h-8 shrink-0"
                                                        disabled={!(keys[p.id] ?? "").trim()}
                                                        onClick={() =>
                                                            post("/api/provider-key", { provider: p.id, key: (keys[p.id] ?? "").trim() }).then(() => {
                                                                setKeys((k) => ({ ...k, [p.id]: "" }));
                                                                onPatch({});
                                                            })
                                                        }
                                                    >
                                                        Save
                                                    </Button>
                                                    {p.ready ? (
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            className="h-8 shrink-0 text-destructive"
                                                            title="Remove key"
                                                            onClick={() => post("/api/provider-key", { provider: p.id, key: "" }).then(() => onPatch({}))}
                                                        >
                                                            <Trash2 className="size-3.5" />
                                                        </Button>
                                                    ) : null}
                                                </div>
                                                {p.keyHint ? <p className="mt-1 text-[10px] text-muted-foreground">{p.keyHint}</p> : null}
                                            </>
                                        )}
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                    Keys live in your encrypted vault, never in settings. Kimi unlocks once Moonshot, OpenRouter or opencode has a key.
                </p>
            </div>

            {/* ---- per-role model selection ---- */}
            <div className="border-t pt-3">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Roles
                </div>
                <div className="flex flex-col gap-2">
                    <RolePicker label="Reasoning model" field="reasoningModel" value={mr?.reasoningModel} desc="Thinking / planning / error-recovery turns." />
                    {routingOn ? (
                        <RolePicker label="Fast / tool model" field="fastModel" value={mr?.fastModel} desc="Routine tool-driving turns — must be vision-capable." />
                    ) : (
                        <p className="text-[10px] text-muted-foreground">Smart routing is off — every turn uses the reasoning model. Enable it in the Behaviour tab.</p>
                    )}
                    <RolePicker label="Sub-agent model" field="subagentModel" value={mr?.subagentModel} desc="Focused side-tasks spawned via spawn_subagent." />
                </div>
                {mr?.fastTierWarning ? (
                    <p className="mt-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[10px] text-amber-700">{mr.fastTierWarning}</p>
                ) : null}
                <p className="mt-2 text-[10px] text-muted-foreground">
                    Last turn ran on <b>{mr?.lastTier ?? "reasoning"}</b>. Models are named <code>provider/model</code>; only signed-in providers are listed.
                </p>
            </div>
        </div>
    );
}

function SettingsPanel({ state, onClose, onPatch }: { state: ServerState | null; onClose: () => void; onPatch: (p: any) => void }) {
    const s = state?.settings;
    const hv = s?.humanize ?? 1;
    const autonomy = Math.max(0, Math.min(5, state?.autonomy ?? 3)) as 0 | 1 | 2 | 3 | 4 | 5;
    // British-English copy for each rung of the autonomy dial (kept in sync with
    // AUTONOMY_LABELS in reviewer.ts; defined locally so the server-only reviewer
    // module is never pulled into the browser bundle).
    const AUTONOMY_LABELS: Record<0 | 1 | 2 | 3 | 4 | 5, { label: string; description: string }> = {
        0: { label: "Ask first", description: "Prompt before almost every action — maximum caution." },
        1: { label: "Cautious", description: "Auto-run only plainly safe, read-only commands." },
        2: { label: "Measured", description: "Auto-run safe commands; pause on anything unfamiliar." },
        3: { label: "Balanced", description: "Auto-run safe and routine actions; prompt for risky or outward-facing ones." },
        4: { label: "Trusting", description: "Auto-run most things; prompt only for risky or outward-facing actions." },
        5: { label: "Hands-off", description: "Prompt only for genuinely dangerous or outward-facing actions." },
    };
    const secretItems = state?.secrets?.items ?? [];
    const [secName, setSecName] = useState("");
    const [secVal, setSecVal] = useState("");
    const [secHint, setSecHint] = useState("");
    const addSecret = () => {
        if (!secName.trim() || !secVal) return;
        void post("/api/secrets", { name: secName.trim(), value: secVal, hint: secHint.trim() }).then(() => {
            setSecName("");
            setSecVal("");
            setSecHint("");
            onPatch({}); // refresh state to pick up the new name
        });
    };
    const amb = state?.ambient;
    const [tab, setTab] = useState<"behaviour" | "models" | "mcp" | "ambient" | "secrets" | "server">("behaviour");
    // Desktop-only: where THIS desktop app loads the console from (asked of the parent
    // console window over postMessage, since the desktop config lives in the shell).
    const [desktopOrigin, setDesktopOrigin] = useState<{ origin: string; isLocal: boolean; envLocked: boolean; pikvmOrigin: string } | null>(null);
    const [originInput, setOriginInput] = useState("");
    const [pikvmInput, setPikvmInput] = useState("");
    useEffect(() => {
        if (!IS_EMBED_DESKTOP) return;
        const onMsg = (e: MessageEvent) => {
            const cfg = (e.data as any)?.type === "desktop-origin" ? (e.data as any).config : null;
            if (cfg) {
                setDesktopOrigin(cfg);
                setOriginInput(cfg.isLocal ? "" : cfg.origin);
                setPikvmInput(cfg.pikvmOrigin ?? "");
            }
        };
        window.addEventListener("message", onMsg);
        try {
            window.parent.postMessage({ type: "desktop-origin-request" }, "*");
        } catch {
            /* not embedded */
        }
        return () => window.removeEventListener("message", onMsg);
    }, []);
    const [accessToken, setAccessToken] = useState("");
    const [ntfyTopic, setNtfyTopic] = useState(amb?.ntfyTopic ?? "claude");
    const [ntfyBaseUrl, setNtfyBaseUrl] = useState(amb?.ntfyBaseUrl ?? "https://ntfy.sh");
    const [ntfyToken, setNtfyToken] = useState("");
    const saveNtfy = () => {
        const ntfy: any = { topic: ntfyTopic.trim() || "claude" };
        if (ntfyBaseUrl.trim()) ntfy.baseUrl = ntfyBaseUrl.trim().replace(/\/$/, "");
        // Save the token (a secret) FIRST so it can't be lost, then the config.
        const saveConfig = () => post("/api/settings", { ambient: { ntfy } }).then(() => onPatch({}));
        if (ntfyToken.trim()) {
            void post("/api/secrets", { name: "ntfy_token", value: ntfyToken.trim(), hint: "ntfy push token (used by the ambient monitor)" }).then(() => {
                setNtfyToken("");
                void saveConfig();
            });
        } else void saveConfig();
    };
    const inputCls = "w-full rounded-lg border bg-background px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:border-ring/60";
    const tabs: { id: typeof tab; label: string; icon: any }[] = [
        { id: "behaviour", label: "Behaviour", icon: Keyboard },
        { id: "models", label: "Models", icon: Sparkles },
        { id: "ambient", label: "Ambient", icon: Radar },
        { id: "mcp", label: "MCP", icon: Plug },
        { id: "secrets", label: "Secrets", icon: Lock },
        { id: "server", label: "Server", icon: Globe },
    ];
    const lanOn = (state?.settings?.bindHost ?? "127.0.0.1") === "0.0.0.0";
    return (
        <Modal onClose={onClose} wide>
            <div className="flex items-center justify-between p-3 pb-2 text-[15px] font-semibold">
                Settings
                <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
                    <X className="size-4" />
                </button>
            </div>
            {/* tab bar */}
            <div className="px-3 pb-2">
                <div className="grid grid-cols-5 gap-1 rounded-xl bg-muted/60 p-1">
                    {tabs.map((t) => (
                        <button
                            key={t.id}
                            onClick={() => setTab(t.id)}
                            className={cn(
                                "flex items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-[11px] font-medium transition-colors",
                                tab === t.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                            )}
                        >
                            <t.icon className="size-3.5 shrink-0" /> <span className="truncate">{t.label}</span>
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex-1 overflow-auto p-3 pt-1">
                {/* ------------------------------ behaviour ----------------------------- */}
                {tab === "behaviour" && (
                    <div className="space-y-5">
                        <div>
                            <div className="mb-1.5 flex items-baseline justify-between">
                                <span className="text-[13px] font-medium">Autonomy</span>
                                <span className="text-[11px] text-muted-foreground">{AUTONOMY_LABELS[autonomy]?.label ?? "Balanced"}</span>
                            </div>
                            <input
                                type="range"
                                min={0}
                                max={5}
                                step={1}
                                value={autonomy}
                                className="w-full accent-primary"
                                onChange={(e) => onPatch({ autonomy: parseInt(e.target.value, 10) })}
                            />
                            <p className="mt-1 text-[11px] text-muted-foreground">
                                {AUTONOMY_LABELS[autonomy]?.description ?? ""} Dangerous and outward-facing actions always ask first.
                            </p>
                        </div>
                        <div className="border-t pt-3">
                            <div className="mb-1.5 flex items-baseline justify-between">
                                <span className="text-[13px] font-medium">Typing style</span>
                                <span className="text-[11px] text-muted-foreground">{hv === 0 ? "Precise" : hv >= 0.9 ? "Very human" : "Human"}</span>
                            </div>
                            <input type="range" min={0} max={1} step={0.1} defaultValue={hv} className="w-full accent-primary" onChange={(e) => onPatch({ humanize: parseFloat(e.target.value) })} />
                            <p className="mt-1 text-[11px] text-muted-foreground">0 = no typos, full speed · 1 = natural typos &amp; cadence</p>
                        </div>
                        <div>
                            <div className="mb-1.5 flex items-baseline justify-between">
                                <span className="text-[13px] font-medium">Typing speed</span>
                                <span className="text-[11px] text-muted-foreground">~{s?.wpm ?? 95} WPM</span>
                            </div>
                            <input type="range" min={40} max={180} step={5} defaultValue={s?.wpm ?? 95} className="w-full accent-primary" onChange={(e) => onPatch({ wpm: parseInt(e.target.value, 10) })} />
                            <p className="mt-1 text-[11px] text-muted-foreground">Baseline — randomised per run</p>
                        </div>
                        <div className="border-t pt-3">
                            <Row
                                label="Keyboard layout"
                                desc="The target's layout. Get this wrong and symbols come out as the wrong characters."
                                control={
                                    <div className="flex gap-0.5 rounded-lg bg-muted/60 p-0.5">
                                        {(["us", "uk"] as const).map((l) => (
                                            <button
                                                key={l}
                                                onClick={() => onPatch({ keyboardLayout: l })}
                                                className={cn(
                                                    "rounded-md px-2.5 py-1 text-xs font-medium uppercase transition-colors",
                                                    (s?.keyboardLayout ?? "us") === l ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                                                )}
                                            >
                                                {l}
                                            </button>
                                        ))}
                                    </div>
                                }
                            />
                        </div>
                        <div className="border-t pt-3">
                            <Row
                                label="Pause on presence"
                                desc="Hold automation while the target mic/audio is live"
                                control={<Switch checked={s?.pauseOnPresence ?? true} onChange={(v) => onPatch({ pauseOnPresence: v })} />}
                            />
                        </div>
                        <div className="border-t pt-3">
                            <Row
                                label="Mouse jiggler"
                                desc="Nudge the cursor every ~60s of inactivity to keep the target awake (restores the exact position)"
                                control={<Switch checked={s?.jiggler ?? true} onChange={(v) => onPatch({ jiggler: v })} />}
                            />
                        </div>
                        <div className="border-t pt-3">
                            <Row
                                label="Smart model routing"
                                desc="Use a capable model for thinking, a cheap/fast one for routine clicks &amp; typing"
                                control={
                                    <Switch
                                        checked={s?.modelRouting?.enabled ?? true}
                                        onChange={(v) => post("/api/settings", { modelRouting: { enabled: v } }).then(() => onPatch({}))}
                                    />
                                }
                            />
                            <button
                                onClick={() => setTab("models")}
                                className="mt-2 flex w-full items-center gap-1.5 rounded-lg border bg-card/60 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                            >
                                <Sparkles className="size-3.5" /> Choose providers &amp; per-role models in the <b className="text-foreground">Models</b> tab →
                            </button>
                        </div>
                        {(state?.schedules ?? []).length > 0 && (
                            <div className="border-t pt-3">
                                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    <Clock className="size-3" /> Scheduled tasks
                                </div>
                                <div className="flex flex-col gap-1">
                                    {(state?.schedules ?? []).map((j) => (
                                        <div key={j.id} className="flex items-center gap-2 rounded-lg border bg-card/60 px-2.5 py-1.5 text-xs">
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate">{j.label}</div>
                                                <div className="text-[10px] text-muted-foreground">{j.when}</div>
                                            </div>
                                            <button className="text-muted-foreground hover:text-destructive" onClick={() => post("/api/schedules/cancel", { id: j.id }).then(() => onPatch({}))}>
                                                <X className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* ----------------------------- models / providers --------------------- */}
                {tab === "models" && <ModelsTab state={state} inputCls={inputCls} onPatch={onPatch} />}

                {/* ------------------------------- ambient ------------------------------ */}
                {tab === "ambient" && (
                    <div className="space-y-3">
                        <div className="space-y-2 rounded-xl border bg-card/40 p-3">
                            <WebNotifyRow />
                            <Row
                                label="Suggested actions"
                                desc="Watch the screen and offer to act — e.g. a lock screen → log in"
                                control={<Switch checked={amb?.suggest ?? true} onChange={(v) => onPatch({ ambient: { suggest: v } })} />}
                            />
                            <Row
                                label="Auto-transcribe audio"
                                desc="Local whisper — auto-starts whenever the target has audio; stays on this machine"
                                control={<Switch checked={amb?.transcribe ?? false} onChange={(v) => onPatch({ ambient: { transcribe: v } })} />}
                            />
                        </div>
                        <Row
                            label="Background monitoring"
                            desc="Cheap on-device watch; calls a model only when something happens"
                            control={<Switch checked={amb?.enabled ?? false} onChange={(v) => onPatch({ ambient: { enabled: v } })} />}
                        />
                        {amb?.enabled ? (
                            <>
                                <div className="space-y-2 rounded-xl border bg-card/40 p-3">
                                    <Row label="Push notifications" desc="ntfy alerts for emails, messages, meetings" control={<Switch checked={amb?.notify ?? true} onChange={(v) => onPatch({ ambient: { notify: v } })} />} />
                                    <Row label="Meeting assistant" desc="Brief you when a call starts" control={<Switch checked={amb?.meetingAssist ?? true} onChange={(v) => onPatch({ ambient: { meetingAssist: v } })} />} />
                                </div>

                                {amb?.notify && (
                                    <div className="rounded-xl border bg-card/40 p-3">
                                        <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium">
                                            <Bell className="size-3.5 text-muted-foreground" /> ntfy
                                            <span className={cn("ml-auto text-[10px]", amb?.hasToken ? "text-emerald-500" : "text-amber-500")}>{amb?.hasToken ? "token saved" : "no token"}</span>
                                        </div>
                                        <div className="space-y-1.5">
                                            <input value={ntfyBaseUrl} onChange={(e) => setNtfyBaseUrl(e.target.value)} placeholder="Server URL (e.g. https://ntfy.sh)" className={inputCls} />
                                            <div className="flex gap-1.5">
                                                <input value={ntfyTopic} onChange={(e) => setNtfyTopic(e.target.value)} placeholder="Topic" className={cn(inputCls, "w-28")} />
                                                <input type="password" value={ntfyToken} onChange={(e) => setNtfyToken(e.target.value)} placeholder={amb?.hasToken ? "Replace token" : "Token (optional)"} className={cn(inputCls, "flex-1")} />
                                            </div>
                                            <div className="flex items-center justify-between pt-0.5">
                                                <button className="text-[11px] text-primary hover:underline" onClick={() => post("/api/ambient/test")}>Send test</button>
                                                <Button size="sm" className="h-7" onClick={saveNtfy}>Save</Button>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                <div className="rounded-xl border bg-card/40 p-3">
                                    <Row label="Active hours only" desc="Monitor within a time window" control={<Switch checked={amb?.activeHours?.enabled ?? false} onChange={(v) => onPatch({ ambient: { activeHours: { enabled: v } } })} />} />
                                    {amb?.activeHours?.enabled && (
                                        <div className="mt-2.5 flex items-center gap-2 border-t pt-2.5 text-[13px]">
                                            <input
                                                type="time"
                                                value={amb?.activeHours?.start ?? "09:00"}
                                                onChange={(e) => onPatch({ ambient: { activeHours: { start: e.target.value } } })}
                                                className="rounded-lg border bg-background px-2 py-1 text-[13px] outline-none"
                                            />
                                            <span className="text-muted-foreground">to</span>
                                            <input
                                                type="time"
                                                value={amb?.activeHours?.end ?? "18:00"}
                                                onChange={(e) => onPatch({ ambient: { activeHours: { end: e.target.value } } })}
                                                className="rounded-lg border bg-background px-2 py-1 text-[13px] outline-none"
                                            />
                                            <span className="ml-auto text-[10px] text-muted-foreground">overnight ok</span>
                                        </div>
                                    )}
                                </div>
                            </>
                        ) : (
                            <p className="rounded-xl border border-dashed p-4 text-center text-[12px] leading-relaxed text-muted-foreground">
                                Turn on monitoring to configure notifications, the meeting assistant, transcription, and active hours.
                            </p>
                        )}
                    </div>
                )}

                {/* ============================ MCP servers ============================ */}
                {/* NEW SECTION — generic, config-driven MCP server registry. Atlas is just
                    one entry here. Add any stdio (command/args/env) or http (url/headers)
                    MCP server; its tools become the agent's tools at the next restart. */}
                {tab === "mcp" && <McpServersTab servers={s?.mcpServers ?? []} inputCls={inputCls} onPatch={onPatch} />}

                {/* ------------------------------- secrets ------------------------------ */}
                {tab === "secrets" && (
                    <div className="space-y-3">
                        <p className="text-[12px] leading-snug text-muted-foreground">
                            Values (passwords, PINs) the agent can <em>type</em> but never sees. A hint tells it when to use each. Entered by name with{" "}
                            <code className="text-primary">type_secret</code>.{" "}
                            {state?.secrets?.encrypted ? "Encrypted with your OS keychain." : "⚠ Stored unencrypted (no OS keychain)."}
                        </p>
                        {secretItems.length > 0 && (
                            <div className="flex flex-col gap-1">
                                {secretItems.map((it) => (
                                    <SecretRow key={it.name} name={it.name} {...(it.hint ? { hint: it.hint } : {})} onChanged={() => onPatch({})} />
                                ))}
                            </div>
                        )}
                        <div className="space-y-1.5 rounded-xl border bg-card/40 p-3">
                            <div className="text-[11px] font-medium text-muted-foreground">Add a secret</div>
                            <div className="flex gap-1.5">
                                <input value={secName} onChange={(e) => setSecName(e.target.value)} placeholder="Name (e.g. Windows password)" className={cn(inputCls, "flex-1")} />
                                <input type="password" value={secVal} onChange={(e) => setSecVal(e.target.value)} placeholder="Value" className={cn(inputCls, "w-24")} />
                            </div>
                            <div className="flex gap-1.5">
                                <input
                                    value={secHint}
                                    onChange={(e) => setSecHint(e.target.value)}
                                    placeholder="When to use it (e.g. Windows lock screen)"
                                    className={cn(inputCls, "flex-1")}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") addSecret();
                                    }}
                                />
                                <Button size="sm" className="h-8 shrink-0" disabled={!secName.trim() || !secVal} onClick={addSecret}>Add</Button>
                            </div>
                        </div>
                    </div>
                )}

                {/* -------------------------------- server ------------------------------ */}
                {tab === "server" && (
                    <div className="space-y-3">
                        {IS_EMBED_DESKTOP && desktopOrigin && (
                            <div className="rounded-xl border bg-card/40 p-3">
                                <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium">
                                    <Globe className="size-3.5 text-muted-foreground" /> Console source
                                    <span className={cn("ml-auto text-[10px]", desktopOrigin.isLocal ? "text-muted-foreground" : "text-emerald-500")}>
                                        {desktopOrigin.isLocal ? "local" : "remote"}
                                    </span>
                                </div>
                                <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
                                    Where this desktop app loads the console from. Leave blank for the built-in local server, or point it at a
                                    hosted deployment (a full <code>https://host</code> origin). Changing it restarts the app.
                                </p>
                                <div className="flex gap-1.5">
                                    <input
                                        type="url"
                                        inputMode="url"
                                        placeholder="https://host  (blank = local)"
                                        value={originInput}
                                        disabled={desktopOrigin.envLocked}
                                        onChange={(e) => setOriginInput(e.target.value)}
                                        className={cn(inputCls, "text-[12px]")}
                                    />
                                    <Button
                                        size="sm"
                                        className="h-8 shrink-0"
                                        disabled={desktopOrigin.envLocked || originInput.trim().replace(/\/$/, "") === (desktopOrigin.isLocal ? "" : desktopOrigin.origin)}
                                        onClick={() => window.parent.postMessage({ type: "desktop-set-console-origin", origin: originInput.trim() }, "*")}
                                    >
                                        Save &amp; restart
                                    </Button>
                                </div>
                                {desktopOrigin.envLocked && (
                                    <p className="mt-1 text-[10px] text-amber-500">Locked by the PIKVM_CONSOLE_ORIGIN environment variable.</p>
                                )}
                                {desktopOrigin.isLocal && (
                                    <div className="mt-3 border-t pt-2.5">
                                        <div className="mb-1 text-[12px] font-medium">PiKVM address</div>
                                        <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
                                            Where the local backend reaches your PiKVM. Include credentials if needed, e.g.{" "}
                                            <code>https://user:pass@pikvm/</code>. Changing it restarts the app.
                                        </p>
                                        <div className="flex gap-1.5">
                                            <input
                                                type="text"
                                                placeholder="https://pikvm/"
                                                value={pikvmInput}
                                                onChange={(e) => setPikvmInput(e.target.value)}
                                                className={cn(inputCls, "text-[12px]")}
                                            />
                                            <Button
                                                size="sm"
                                                className="h-8 shrink-0"
                                                disabled={!pikvmInput.trim() || pikvmInput.trim().replace(/\/$/, "") === (desktopOrigin.pikvmOrigin || "").replace(/\/$/, "")}
                                                onClick={() => window.parent.postMessage({ type: "desktop-set-pikvm-origin", url: pikvmInput.trim() }, "*")}
                                            >
                                                Save &amp; restart
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                        <p className="text-[12px] leading-snug text-muted-foreground">
                            Use this on your phone or another browser. The server proxies the PiKVM UI and serves the agent, so a client only
                            needs the address below and the access token.
                        </p>
                        <Row
                            label="Allow access from the LAN"
                            desc="Bind to 0.0.0.0 so other devices can reach it. Needs a restart to take effect."
                            control={<Switch checked={lanOn} onChange={(v) => onPatch({ bindHost: v ? "0.0.0.0" : "127.0.0.1" })} />}
                        />
                        <Row
                            label="Desktop view via proxy"
                            desc="Render this app's KVM view through the proxy too (one path with the web client). Off by default; needs a restart."
                            control={<Switch checked={state?.settings?.desktopUseProxy ?? false} onChange={(v) => onPatch({ desktopUseProxy: v })} />}
                        />
                        <div className="rounded-xl border bg-card/40 p-3">
                            <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium">
                                <Lock className="size-3.5 text-muted-foreground" /> Access token
                                <span className={cn("ml-auto text-[10px]", state?.settings?.hasToken ? "text-emerald-500" : "text-amber-500")}>
                                    {state?.settings?.hasToken ? "set" : "not set"}
                                </span>
                            </div>
                            <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
                                Required for LAN clients (this machine is always allowed). PiKVM credentials stay on the server.
                            </p>
                            <div className="flex gap-1.5">
                                <input
                                    type="password"
                                    value={accessToken}
                                    onChange={(e) => setAccessToken(e.target.value)}
                                    placeholder={state?.settings?.hasToken ? "Replace token" : "Set a token"}
                                    className={cn(inputCls, "flex-1")}
                                />
                                <Button size="sm" className="h-8" onClick={() => post("/api/settings", { accessToken: accessToken.trim() }).then(() => { setAccessToken(""); onPatch({}); })}>
                                    Save
                                </Button>
                            </div>
                            {state?.settings?.hasToken && (
                                <button className="mt-1.5 text-[11px] text-destructive hover:underline" onClick={() => post("/api/settings", { accessToken: "" }).then(() => onPatch({}))}>
                                    Clear token (open access)
                                </button>
                            )}
                        </div>
                        <div className="rounded-xl border bg-card/40 p-3 text-[12px]">
                            <div className="mb-1 font-medium">Connect a device</div>
                            <p className="leading-snug text-muted-foreground">
                                On the same network, open <code className="text-primary">http://&lt;this-machine-ip&gt;:25650</code> in a browser, then
                                enter the access token. Tap the floating button to open the agent.
                            </p>
                        </div>

                        {!IS_DESKTOP && state?.settings?.hasToken && (
                            <button
                                className="w-full rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/20"
                                onClick={() => {
                                    // The sidebar is a same-origin iframe; navigate the TOP page to the
                                    // logout route so the whole client returns to the login screen.
                                    const target = `${AGENT_ORIGIN}/_agent/logout`;
                                    try {
                                        (window.top ?? window).location.assign(target);
                                    } catch {
                                        window.location.assign(target);
                                    }
                                }}
                            >
                                Sign out of this device
                            </button>
                        )}

                    </div>
                )}

                <p className="mt-4 text-center text-[10px] text-muted-foreground">Model &amp; review policy live in the header · settings persist across restarts</p>
            </div>
        </Modal>
    );
}

/* ---------------------------------- app ---------------------------------- */

function App() {
    const [serverState, setServerState] = useState<ServerState | null>(null);
    const [decided, setDecided] = useState<Set<string>>(new Set());
    // Ephemeral "agent is doing an internal step" label (e.g. "Checking the screen…").
    // Auto-clears as a safety in case the explicit clear event is missed.
    const [liveActivity, setLiveActivity] = useState<string | null>(null);
    // A run is live on the hub (any client) — drives the Stop button instantly,
    // before the 3s state poll catches up. Cleared on the SSE "end".
    const [externalBusy, setExternalBusy] = useState(false);
    // Set the instant Stop is pressed: forces the UI to idle immediately, overriding the
    // lagging serverState.streaming / externalBusy, so control returns NOW. Cleared once
    // the server confirms it stopped, or when a fresh run is started.
    const [forceIdle, setForceIdle] = useState(false);
    const activityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const showActivity = (text: string | null) => {
        if (activityTimer.current) clearTimeout(activityTimer.current);
        setLiveActivity(text);
        if (text) activityTimer.current = setTimeout(() => setLiveActivity(null), 12000);
    };
    const [input, setInput] = useState("");
    const [lightbox, setLightbox] = useState<string | null>(null);
    // A ?panel= hint opens straight to a panel — the desktop console uses this to pop a
    // dedicated Settings / Monitor window now that the chat itself is the Claude terminal.
    const initialPanel = (() => {
        const p = new URLSearchParams(location.search).get("panel");
        return p === "settings" || p === "history" || p === "ambient" || p === "activity" ? p : "none";
    })();
    const [panel, setPanel] = useState<"none" | "activity" | "settings" | "history" | "ambient">(initialPanel);
    const [historyQuery, setHistoryQuery] = useState("");
    const [images, setImages] = useState<{ url: string; mediaType: string }[]>([]);
    const fileInput = useRef<HTMLInputElement>(null);
    const transport = useRef(new DefaultChatTransport({ api: BASE + "/api/chat", body: { clientId: CLIENT_ID } }));
    const messagesRef = useRef<any[]>([]);
    const { messages, sendMessage, status, stop, setMessages, regenerate, error } = useChat({ transport: transport.current });
    messagesRef.current = messages;
    const inputRef = useRef<HTMLTextAreaElement>(null);

    const conversationText = () =>
        (messagesRef.current as any[])
            .map((m) => {
                const t = (m.parts ?? [])
                    .filter((p: any) => p.type === "text")
                    .map((p: any) => p.text)
                    .join(" ")
                    .trim();
                return t ? `${m.role === "user" ? "You" : "Agent"}: ${t}` : "";
            })
            .filter(Boolean)
            .join("\n\n");

    const copyConversation = () => {
        const t = conversationText();
        if ((window as any).ui?.copy) (window as any).ui.copy(t);
        else void navigator.clipboard?.writeText(t);
    };

    // "Copy conversation" from the right-click menu.
    useEffect(() => {
        (window as any).ui?.on?.("copy-conversation", copyConversation);
    }, []);

    const lastStateJson = useRef("");
    // Polls fire from several places (interval, visibility, the data-auth SSE) and can be
    // in flight concurrently; responses arrive out of order. Discard any response older
    // than one we've already applied, so a stale /api/state can't resurrect a resolved
    // approval prompt or hide a live one.
    const stateReqSeq = useRef(0);
    const stateAppliedSeq = useRef(0);
    const refreshState = () => {
        const myReq = ++stateReqSeq.current;
        return fetch(BASE + "/api/state")
            .then((r) => r.json())
            .then((s) => {
                if (myReq < stateAppliedSeq.current) return; // a newer poll already landed
                stateAppliedSeq.current = myReq;
                // Skip the re-render when the polled state is byte-identical to the last
                // one — an idle session shouldn't re-render the whole conversation every 3s.
                const j = JSON.stringify(s);
                if (j === lastStateJson.current) return;
                lastStateJson.current = j;
                setServerState(s);
            })
            .catch(() => {});
    };

    useEffect(() => {
        refreshState();
        // Poll every 3s. We DON'T skip when document.hidden: in the desktop console the
        // sidebar view is frequently unfocused/occluded while you watch the KVM — and
        // that's exactly when the agent hits an approval gate. Skipping then meant the
        // approval dialog never appeared until you clicked Stop. The byte-identical dedup
        // (lastStateJson) keeps an idle session from re-rendering, so polling-while-hidden
        // is cheap. (backgroundThrottling:false on the view keeps this timer alive too.)
        const id = setInterval(() => {
            void refreshState();
        }, 3000);
        const onVis = () => {
            if (!document.hidden) void refreshState();
        };
        document.addEventListener("visibilitychange", onVis);
        return () => {
            clearInterval(id);
            document.removeEventListener("visibilitychange", onVis);
        };
    }, []);


    // A prompt only shows once the server confirms it's pending (via /api/state).
    // When one streams into the transcript, refresh immediately so there's no
    // poll-latency gap before the card appears.
    const lastAuthId = useRef<string | null>(null);
    useEffect(() => {
        let latest: string | null = null;
        outer: for (let mi = messages.length - 1; mi >= 0; mi--) {
            const parts = (messages[mi] as any).parts ?? [];
            for (let pi = parts.length - 1; pi >= 0; pi--) {
                if (parts[pi].type === "data-auth") {
                    latest = parts[pi].data.request.id;
                    break outer;
                }
            }
        }
        if (latest && latest !== lastAuthId.current) {
            lastAuthId.current = latest;
            refreshState();
        }
    }, [messages]);

    // Restore the current session's transcript (with screenshots) on load.
    const [convLoading, setConvLoading] = useState(true);
    // True while we're spectating a live run (between begin/end on /api/events). The
    // persisted snapshot doesn't include an in-flight exchange, so while one is live we
    // must NOT let a (re)load clobber the live messages we've rebuilt from the stream —
    // we merge them on top of the snapshot instead. Order-independent, so the snapshot
    // fetch racing the stream can't drop or duplicate anything.
    const liveActiveRef = useRef(false);
    // Held true briefly across a session switch (new chat / resume) so a trailing
    // debounced persist of the previous transcript can't land in the new session.
    const suppressPersist = useRef(false);
    // The in-flight "new chat" session-switch promise; send() awaits it so a pasted
    // prompt runs in the NEW session, not the one we just left.
    const newChatPending = useRef<Promise<unknown> | null>(null);
    const loadTranscript = () =>
        fetch(BASE + "/api/sessions/current")
            .then((r) => r.json())
            .then((d) => {
                if (!Array.isArray(d.messages)) return;
                const base = d.messages as any[];
                if (!liveActiveRef.current) {
                    setMessages(base);
                    return;
                }
                setMessages((prev: any[]) => {
                    const baseIds = new Set(base.map((m) => m.id));
                    const liveExtras = prev.filter((m) => !baseIds.has(m.id)); // current prompt + in-flight reply
                    return [...base, ...liveExtras];
                });
            })
            .catch(() => {})
            .finally(() => setConvLoading(false));
    useEffect(() => {
        void loadTranscript();
    }, []);

    // Live spectating: render runs started by OTHER clients (or autonomously) in
    // real time, from /api/events. Our OWN run is owned by useChat (we tag it and
    // skip its echo here), so this is purely additive and can't disturb sending.
    useEffect(() => {
        const es = new EventSource(BASE + "/api/events");
        let spec: any = null; // the assistant message we're building from the stream
        let active = false; // are we spectating the current run?
        const flush = () =>
            setMessages((prev: any[]) => {
                if (!spec) return prev;
                const clone = { ...spec, parts: spec.parts.slice() };
                const i = prev.findIndex((m) => m.id === spec.id);
                if (i < 0) return [...prev, clone];
                const next = prev.slice();
                next[i] = clone;
                return next;
            });
        const apply = (c: any) => {
            const parts = spec.parts;
            switch (c.type) {
                case "text-start":
                    parts.push({ type: "text", text: "", _id: c.id });
                    break;
                case "text-delta": {
                    const p = parts.find((x: any) => x._id === c.id);
                    if (p) p.text += c.delta ?? "";
                    break;
                }
                case "data-thinking": {
                    const p = parts.find((x: any) => x.type === "data-thinking" && x.data?.id === c.data.id);
                    if (p) p.data = c.data;
                    else parts.push({ type: "data-thinking", data: c.data });
                    break;
                }
                case "tool-input-available":
                    parts.push({ type: `tool-${c.toolName}`, toolName: c.toolName, toolCallId: c.toolCallId, state: "input-available", input: c.input });
                    break;
                case "tool-output-available": {
                    const p = parts.find((x: any) => x.toolCallId === c.toolCallId);
                    if (p) {
                        p.state = "output-available";
                        p.output = c.output;
                    }
                    break;
                }
                case "data-screenshot":
                    parts.push({ type: "data-screenshot", id: c.id, data: c.data });
                    break;
                case "data-marker":
                    parts.push({ type: "data-marker", data: c.data });
                    break;
                case "data-status":
                    parts.push({ type: "data-status", data: c.data });
                    break;
                case "data-auth":
                    parts.push({ type: "data-auth", data: c.data });
                    break;
                case "data-steer":
                    parts.push({ type: "data-steer", data: c.data });
                    break;
            }
        };
        es.onmessage = (ev) => {
            let c: any;
            try {
                c = JSON.parse(ev.data);
            } catch {
                return;
            }
            if (c.type === "begin") {
                active = c.clientId !== CLIENT_ID; // our own run is handled by useChat
                liveActiveRef.current = active;
                // Stable id from the server → replays/reconnects update ONE message
                // (flush() finds it by id) instead of stacking duplicates.
                spec = active ? { id: c.messageId || `spec-${Date.now()}`, role: "assistant", parts: [] } : null;
                setExternalBusy(true); // a run is live (any client) — show Stop instantly
                return;
            }
            if (c.type === "user") {
                if (c.clientId === CLIENT_ID) return; // our own message — already shown
                setMessages((prev: any[]) =>
                    prev.some((m) => m.id === c.id)
                        ? prev
                        : [
                              ...prev,
                              {
                                  id: c.id,
                                  role: "user",
                                  parts: [
                                      ...(c.text ? [{ type: "text", text: c.text }] : []),
                                      ...((c.images ?? []) as { url: string }[]).map((im) => ({ type: "file", url: im.url, mediaType: "image/jpeg" })),
                                  ],
                              },
                          ],
                );
                return;
            }
            if (c.type === "end") {
                active = false;
                liveActiveRef.current = false;
                spec = null;
                setExternalBusy(false);
                showActivity(null); // a finished run clears any lingering internal-step chip
                // On desktop the main process already fires a native "finished"
                // notification, so only the web path notifies here.
                if (!IS_EMBED_DESKTOP) notify("Agent finished", "The task is complete.", "agent-finished");
                return; // the canonical saved transcript lands via the uiVersion reload
            }
            // Ephemeral internal-step indicator — handled globally (works for our own
            // run too, since this stream is always open), never appended to a message.
            if (c.type === "data-activity") {
                showActivity(c.data?.text ?? null);
                return;
            }
            // An approval request — the dialog renders from polled state (works even
            // while our own run's stream is blocked on it), so refresh NOW for an instant
            // prompt instead of waiting for the next 3s poll. Don't return: spectated runs
            // still append it via apply() below.
            if (c.type === "data-auth") void refreshState();
            if (!active || !spec) return;
            apply(c);
            flush();
        };
        return () => es.close();
    }, [setMessages]);

    // When an autonomous (scheduled) run updates the transcript, reload it so its
    // flow shows in the sidebar — as long as the user isn't mid-conversation.
    const seenUiVersion = useRef(0);
    useEffect(() => {
        const v = serverState?.uiVersion ?? 0;
        if (v !== seenUiVersion.current) {
            seenUiVersion.current = v;
            if (status !== "streaming" && status !== "submitted") void loadTranscript();
        }
    }, [serverState?.uiVersion, status]);

    // Free the pixels of all but the most recent screenshots so the renderer (and the
    // persisted transcript) stay bounded. Only call setMessages when something actually
    // changed — calling it unconditionally loops forever (useChat's setMessages doesn't
    // bail on an identical array the way plain useState does → React #185).
    useEffect(() => {
        const pruned = pruneUiScreens(messages as any[]);
        if (pruned !== messages) setMessages(pruned as any);
    }, [messages]);

    // Persist the transcript shortly after each change settles, so it survives restarts.
    // Skip while spectating a live run: those messages are rebuilt from the stream (the
    // in-flight reply carries a transient live- id) and the run's OWNER persists the
    // canonical transcript — a spectator writing its half-built copy would just fight it.
    useEffect(() => {
        if (suppressPersist.current || status === "streaming" || status === "submitted" || messages.length === 0 || liveActiveRef.current) return;
        // Tag with the session these messages belong to (captured now, at render time).
        // The server drops the save if it has since switched sessions — so a trailing
        // persist can't bleed the old transcript into a freshly-created chat.
        const sessionId = serverState?.sessionId;
        const t = setTimeout(() => void post("/api/sessions/ui", { messages, sessionId }), 800);
        return () => clearTimeout(t);
    }, [messages, status]);

    const decide = (id: string, verdict: any) => {
        setDecided((s) => new Set(s).add(id));
        // INSTANT FEEDBACK: flip the matching request_approval tool card from its spinning
        // "Waiting for you to approve…" to done the moment you click, so it's obvious the
        // decision registered and the agent is moving on (instead of a card that keeps
        // spinning while the post-approval turn runs). The server's tool-output catches up.
        const done = verdict?.decision === "allow" ? "Approved by you — proceeding" : "Declined by you";
        setMessages((prev: any[]) =>
            prev.map((m) => {
                const parts = m.parts ?? [];
                let changed = false;
                const np = parts.map((p: any) => {
                    const name = p.toolName ?? (typeof p.type === "string" && p.type.startsWith("tool-") ? p.type.slice(5) : "");
                    if (name === "request_approval" && p.state && p.state !== "output-available") {
                        changed = true;
                        return { ...p, state: "output-available", output: { summary: done, isError: verdict?.decision === "deny" } };
                    }
                    return p;
                });
                return changed ? { ...m, parts: np } : m;
            }),
        );
        void post("/api/approve", { id, ...verdict });
    };
    // Keep `decided` to ONLY ids the server still lists as pending — i.e. ones we just
    // approved whose resolution hasn't polled back yet. Without this, a decided id lingers
    // forever; combined with a reused id it made a fresh request look already-handled,
    // hiding its approve buttons and hanging the agent. (Server ids are now unique too —
    // this is the belt to that braces, and bounds the set.)
    useEffect(() => {
        setDecided((prev) => pruneDecided(prev, serverState?.pendingAuthIds ?? []) as Set<string>);
    }, [serverState?.pendingAuthIds]);
    // The most recent still-undecided authorization request — floated above the
    // composer. Only show it if the server is actually still blocked on it (or a
    // run is live and just emitted it), so stale prompts from a reloaded transcript
    // don't reappear when you re-open the sidebar.
    const pendingAuth = useMemo<AuthRequest | null>(() => {
        // All auth requests in the stream, oldest → newest (fallback for the instant
        // before the next state poll lands). pickPendingAuth (shared, tested) decides
        // which — if any — prompt to surface, preferring the server's live pending list.
        const messageAuths: AuthRequest[] = [];
        for (const m of messages) {
            for (const p of ((m as any).parts ?? [])) {
                if (p.type === "data-auth") messageAuths.push(p.data.request as AuthRequest);
            }
        }
        const busyNow = status === "streaming" || status === "submitted" || externalBusy || !!serverState?.streaming;
        return pickPendingAuth({
            pendingAuths: serverState?.pendingAuths ?? [],
            pendingAuthIds: serverState?.pendingAuthIds ?? [],
            decided,
            messageAuths,
            busy: busyNow,
        });
    }, [messages, decided, serverState?.pendingAuths, serverState?.pendingAuthIds, status, externalBusy, serverState?.streaming]);

    // Browser-notify when the agent newly needs authorization, or hits an error.
    const notifiedAuth = useRef<string | null>(null);
    useEffect(() => {
        if (pendingAuth && pendingAuth.id !== notifiedAuth.current) {
            notifiedAuth.current = pendingAuth.id;
            notify("Authorization needed", describeOp(pendingAuth.op) || "The agent needs your approval to continue.", "agent-auth");
        }
        if (!pendingAuth) notifiedAuth.current = null;
    }, [pendingAuth?.id]);
    const notifiedError = useRef(false);
    useEffect(() => {
        if (error && !notifiedError.current) {
            notifiedError.current = true;
            notify("Agent error", error.message || "The agent hit a problem and stopped.", "agent-error");
        }
        if (!error) notifiedError.current = false;
    }, [error]);
    const addImageFiles = (files: File[]) => {
        for (const f of files) {
            if (!f.type.startsWith("image/")) continue;
            const r = new FileReader();
            r.onload = () => setImages((prev) => [...prev, { url: String(r.result), mediaType: f.type || "image/png" }]);
            r.readAsDataURL(f);
        }
    };

    const send = async (text = input) => {
        const t = text.trim();
        if (!t && images.length === 0) return;
        const files = images.map((im) => ({ type: "file" as const, mediaType: im.mediaType, url: im.url }));
        setInput("");
        setImages([]);
        setForceIdle(false); // a new run — drop any post-Stop idle override
        // If a "new chat" session switch is still in flight, WAIT for it — otherwise this
        // prompt races ahead and runs in the previous session (the "+ then it goes back to
        // the old chat" bug). The switch is fast; this just orders the two requests.
        if (newChatPending.current) {
            try { await newChatPending.current; } catch { /* proceed regardless */ }
        }
        void sendMessage({ text: t, ...(files.length ? { files } : {}) });
    };

    // Stop = the user's escape route. It must return control INSTANTLY — never wait on
    // the backend to unwind (an in-flight model call can take tens of seconds). So we
    // optimistically force the UI to idle right now (forceIdle), abort our own stream,
    // and fire /api/stop; the server's confirmation just reconciles afterwards.
    const stopAll = () => {
        setForceIdle(true);
        setExternalBusy(false);
        showActivity(null);
        stop(); // abort our own useChat POST stream immediately
        void post("/api/stop");
    };

    // Queue/steer a message while the agent is already working. The server echoes
    // it into the live stream (data-steer) so it lands inline at the right spot.
    const steer = (text = input) => {
        const t = text.trim();
        if (!t) return;
        setInput("");
        setForceIdle(false);
        void post("/api/steer", { text: t });
    };

    // "Busy" = our own chat is streaming OR the SERVER says the agent is running (a
    // suggestion-tapped / autonomous / other-client run) — so Stop + steer show then too.
    // Once the server confirms it's no longer streaming, drop the optimistic override.
    // (A fresh send/steer clears it explicitly — see those handlers — so a new run isn't
    // hidden by it; we deliberately DON'T key off `status` here, since the just-aborted
    // run can still read "streaming" for a tick and would clear the override too early.)
    useEffect(() => {
        if (forceIdle && !serverState?.streaming) setForceIdle(false);
    }, [serverState?.streaming, forceIdle]);
    // Watchdog: a spectated run that never emits `end` (hard SSE drop / crash) would leave
    // liveActiveRef stuck true forever — blocking this client's persistence and making every
    // loadTranscript merge stale messages. If the server reports NOT streaming for ~2 ticks
    // while we still think a live run is on, force-clear (and the stuck externalBusy too).
    // The 2-tick delay avoids the brief post-`begin` window where the poll hasn't caught up.
    const serverStateRef = useRef(serverState);
    serverStateRef.current = serverState;
    const liveIdleTicks = useRef(0);
    useEffect(() => {
        const id = setInterval(() => {
            const st = serverStateRef.current;
            if (liveActiveRef.current && st && !st.streaming) {
                if (++liveIdleTicks.current >= 2) {
                    liveActiveRef.current = false;
                    liveIdleTicks.current = 0;
                    setExternalBusy(false);
                }
            } else {
                liveIdleTicks.current = 0;
            }
        }, 3500);
        return () => clearInterval(id);
    }, []);
    const isBusy = () => !forceIdle && (status === "streaming" || status === "submitted" || externalBusy || !!serverState?.streaming);
    const submit = () => (isBusy() ? steer() : send());
    // New chat. Clear FIRST (synchronously) so any pending debounced persist of the OLD
    // transcript is cancelled before the server switches sessions — otherwise that save
    // lands in the fresh session and a reload "restores" the previous conversation.
    // suppressPersist holds off saves across the switch as belt-and-braces.
    const newChat = () => {
        suppressPersist.current = true;
        liveActiveRef.current = false;
        setForceIdle(false);
        setMessages([]);
        const p = post("/api/sessions/new").then(async (r) => {
            setMessages([]);
            await refreshState();
            setTimeout(() => { suppressPersist.current = false; }, 600);
            return r;
        });
        // send() awaits this so a pasted prompt can't run in the old session.
        newChatPending.current = p;
        void p.finally(() => { if (newChatPending.current === p) newChatPending.current = null; });
    };
    const resume = (id: string) => {
        // Same guard as newChat: don't let a trailing persist of the current transcript
        // land in the session we're switching TO.
        suppressPersist.current = true;
        liveActiveRef.current = false;
        setForceIdle(false);
        void post("/api/sessions/resume", { id }).then((r) => r.json()).then((d) => {
            setMessages(d.messages ?? []);
            refreshState();
            setPanel("none");
            setTimeout(() => { suppressPersist.current = false; }, 600);
        });
    };
    const del = (id: string) => void post("/api/sessions/delete", { id }).then(refreshState);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const mod = e.metaKey || e.ctrlKey;
            if (e.key === "Escape") stop();
            else if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); newChat(); }
            else if (mod && e.key.toLowerCase() === "l") { e.preventDefault(); inputRef.current?.focus(); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const onHandleDown = (e: React.MouseEvent) => {
        e.preventDefault();
        const onMove = (ev: MouseEvent) => (window as any).ui?.send?.("sidebar:resize", window.innerWidth - ev.movementX);
        const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    const copyText = (m: any) => {
        const t = (m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
        if ((window as any).ui?.copy) (window as any).ui.copy(t);
        else void navigator.clipboard?.writeText(t);
    };

    // Auto-grow the composer with its content. The min-h-[40px] class floors the
    // collapsed height so the empty and single-line states are identical — combined
    // with the layout effect (runs before paint) there's no snap on first keystroke.
    useLayoutEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }, [input, images.length]);
    // Re-measure once after first paint in case the composer was laid out late
    // (hidden panel / fonts settling), which would otherwise lock in a stale height.
    useEffect(() => {
        const r = requestAnimationFrame(() => {
            const el = inputRef.current;
            if (!el) return;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 200) + "px";
        });
        return () => cancelAnimationFrame(r);
    }, []);

    const comps: CommandSpec[] = useMemo(() => completions(input), [input]);
    const busy = !forceIdle && (status === "streaming" || status === "submitted" || externalBusy || !!serverState?.streaming);
    const empty = messages.length === 0;
    const lastAssistantId = useMemo(() => [...messages].reverse().find((m: any) => m.role === "assistant")?.id, [messages]);

    // Embedded in the web console: no agent header — the console's single merged
    // bar drives these actions over postMessage, and we report status back to it.
    const agentActions = useRef({ newChat, setPanel, copyConversation });
    agentActions.current = { newChat, setPanel, copyConversation };
    useEffect(() => {
        if (!IS_EMBED) return;
        const onMsg = (e: MessageEvent) => {
            const d = e.data as { type?: string; action?: string };
            if (!d || d.type !== "agent-action") return;
            const a = agentActions.current;
            if (d.action === "new") a.newChat();
            else if (d.action === "copy") a.copyConversation();
            else if (d.action) a.setPanel(d.action as any);
        };
        window.addEventListener("message", onMsg);
        return () => window.removeEventListener("message", onMsg);
    }, []);
    useEffect(() => {
        if (!IS_EMBED) return;
        const text = busy ? "Working…" : serverState?.pausedForUser || serverState?.presence?.paused ? "Paused" : "Idle";
        try {
            parent.postMessage({ type: "agent-status", busy, text, inMeeting: !!serverState?.ambient?.inMeeting }, "*");
        } catch {
            /* not embedded */
        }
    }, [busy, serverState]);
    // A panel (history/settings/…) should cover the whole phone, not just the chat
    // pane — ask the WEB console to expand the chat to full-screen while one is open.
    // The DESKTOP console keeps the panel inside its right column (the live screen on
    // the left must stay visible + clickable), so we never full-screen there.
    useEffect(() => {
        if (!IS_EMBED || IS_EMBED_DESKTOP) return;
        try {
            parent.postMessage({ type: "chat-fullscreen", on: panel !== "none" }, "*");
        } catch {
            /* not embedded */
        }
    }, [panel]);
    // Tell the console the conversation is ready, so it can slide the chat in.
    useEffect(() => {
        if (!IS_EMBED || convLoading) return;
        try {
            parent.postMessage({ type: "chat-ready" }, "*");
        } catch {
            /* not embedded */
        }
    }, [convLoading]);
    const latestShotId = useMemo(() => {
        for (let mi = (messages as any[]).length - 1; mi >= 0; mi--) {
            const parts = (messages as any[])[mi].parts ?? [];
            for (let pi = parts.length - 1; pi >= 0; pi--)
                if (parts[pi].type === "data-screenshot") return parts[pi].data.toolCallId;
        }
        return undefined;
    }, [messages]);
    const markerMap = useMemo(() => {
        const map: Record<string, MarkerData[]> = {};
        for (const m of messages as any[]) for (const p of m.parts ?? []) if (p.type === "data-marker") (map[p.data.screenshotId] ??= []).push(p.data);
        return map;
    }, [messages]);

    return (
        <div className="relative flex h-screen w-full flex-col overflow-hidden bg-background text-foreground">
            {/* Width-resize handle is only meaningful for the desktop docked sidebar;
                on web (embedded in the console / FAB panel) it is a stray edge bar. */}
            {IS_DESKTOP && (
                <div className="absolute left-0 top-0 z-30 h-full w-1.5 cursor-ew-resize hover:bg-primary/40" onMouseDown={onHandleDown} title="Drag to resize" />
            )}

            {/* header — hidden when embedded in the WEB console (its single bar carries
                these actions via postMessage), so there's only ONE toolbar. In the
                DESKTOP console (?embed=desktop) it stays: the agent panel is its own
                column on the right and owns these actions. */}
            {(!IS_EMBED || IS_EMBED_DESKTOP) && (
                <header className="flex h-14 shrink-0 items-center gap-2.5 border-b bg-card px-4">
                    <div className="flex size-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
                        <Sparkles className="size-4" />
                    </div>
                    <span className="text-[15px] font-semibold tracking-tight">Agent</span>
                    <StatusPill state={serverState} />
                    <span className="flex-1" />
                    <div className="flex items-center gap-0.5">
                        <Button size="icon" variant="ghost" className="size-8 text-muted-foreground" title="New chat (⌘K)" onClick={newChat}>
                            <Plus className="size-[18px]" />
                        </Button>
                        <Button size="icon" variant="ghost" className="size-8 text-muted-foreground" title="History" onClick={() => setPanel("history")}>
                            <History className="size-[18px]" />
                        </Button>
                        <Button size="icon" variant="ghost" className="size-8 text-muted-foreground" title="Copy conversation" onClick={copyConversation}>
                            <Copy className="size-[18px]" />
                        </Button>
                        <Button size="icon" variant="ghost" className="relative size-8 text-muted-foreground" title="Ambient monitor" onClick={() => setPanel("ambient")}>
                            <Radar className={cn("size-[18px]", serverState?.ambient?.enabled && "text-primary")} />
                            {serverState?.ambient?.inMeeting && <span className="absolute right-1 top-1 size-2 rounded-full bg-emerald-500" />}
                        </Button>
                        <Button size="icon" variant="ghost" className="size-8 text-muted-foreground" title="Activity" onClick={() => setPanel("activity")}>
                            <Activity className="size-[18px]" />
                        </Button>
                        <Button size="icon" variant="ghost" className="size-8 text-muted-foreground" title="Settings" onClick={() => setPanel("settings")}>
                            <Settings2 className="size-[18px]" />
                        </Button>
                    </div>
                </header>
            )}

            {serverState && !serverState.loggedIn && (
                <div className="border-b bg-card px-3 py-2">
                    <Button className="w-full" onClick={() => post("/api/login").then(refreshState)}>
                        Sign in with ChatGPT
                    </Button>
                </div>
            )}
            {serverState?.presence?.paused && (
                <div className="flex items-center justify-between gap-2 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                    <span>⏸ {serverState.presence.reason ?? "Paused"}</span>
                    <Button size="sm" className="h-6" onClick={() => post("/api/presence", { mode: "resume" }).then(refreshState)}>
                        Resume
                    </Button>
                </div>
            )}
            {serverState?.pausedForUser && (
                <div className="flex items-center justify-between gap-2 border-b bg-amber-500/15 px-3 py-1.5 text-xs text-amber-300">
                    <span>⏸ Paused — you have control of the screen</span>
                    <Button size="sm" className="h-6" onClick={() => post("/api/resume").then(refreshState)}>
                        Resume agent
                    </Button>
                </div>
            )}
            {serverState?.goal && <div className="border-b bg-primary/10 px-3 py-1.5 text-xs">🎯 {serverState.goal}</div>}

            {/* ── self-verifying goal loop ───────────────────────────────── */}
            {serverState?.goalLoop && <GoalLoopBanner loop={serverState.goalLoop} />}
            {/* ──────────────────────────────────────────────────────────── */}

            {/* conversation */}
            {convLoading ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
                    <Loader />
                    <span className="text-sm">Loading conversation…</span>
                </div>
            ) : (
            <Conversation initial="instant" resize="instant" className="flex-1">
                <ConversationContent className="gap-2.5 px-3 py-3">
                    {empty && (
                        <div className="flex flex-1 flex-col justify-center gap-7 py-4">
                            <div className="text-center">
                                <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                                    <Sparkles className="size-6" />
                                </div>
                                <h2 className="mt-4 text-lg font-semibold text-foreground">Drive the machine</h2>
                                <p className="mt-1.5 text-sm text-muted-foreground">Give the agent a task and watch it work on the KVM.</p>
                            </div>
                            {(serverState?.sessions ?? []).length > 0 && (
                                <div>
                                    <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Recent</div>
                                    <div className="flex flex-col gap-0.5">
                                        {(serverState?.sessions ?? []).slice(0, 4).map((s) => (
                                            <button
                                                key={s.id}
                                                onClick={() => resume(s.id)}
                                                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-accent"
                                            >
                                                <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                                                <span className="flex-1 truncate text-sm">{s.title}</span>
                                                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(s.updatedAt)}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                            <div>
                                <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Try</div>
                                <div className="flex flex-col gap-2">
                                    {SUGGESTIONS.map((s) => (
                                        <button
                                            key={s}
                                            onClick={() => send(s)}
                                            className="rounded-xl border bg-card px-3.5 py-3 text-left text-sm transition-colors hover:border-primary/50 hover:bg-accent"
                                        >
                                            {s}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {messages.map((m: any) => {
                        const parts = m.parts ?? [];
                        return (
                        <div key={m.id} className={cn("group flex gap-3", m.role === "user" ? "justify-end" : "")}>
                            <div className={cn("flex min-w-0 flex-col gap-2.5 leading-relaxed", m.role === "user" ? "max-w-[85%] items-end" : "flex-1")}>
                                {parts.map((p: any, i: number) => {
                                    if (p.type === "file" && typeof p.url === "string" && String(p.mediaType).startsWith("image/"))
                                        return <img key={i} src={p.url} alt="attachment" className="max-h-56 rounded-xl border" />;
                                    if (p.type === "text") {
                                        if (!p.text) return null;
                                        return m.role === "user" ? (
                                            <div key={i} className="max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[14px] text-primary-foreground">
                                                {p.text}
                                            </div>
                                        ) : (
                                            <ChatMarkdown key={i} text={p.text} />
                                        );
                                    }
                                    if (p.type === "data-thinking") {
                                        // If a run was cancelled mid-thought, drop an empty thought and
                                        // stop the perpetual "Thinking…" — finalize it instead.
                                        if (!busy && !p.data.text) return null;
                                        return (
                                            <Reasoning key={i} isStreaming={!p.data.done && busy} defaultOpen={false} className="mb-0">
                                                <ReasoningTrigger />
                                                <ReasoningContent>{p.data.text}</ReasoningContent>
                                            </Reasoning>
                                        );
                                    }
                                    if (p.type === "data-screenshot") {
                                        // Only group screenshots that are ADJACENT (no thinking/tool between).
                                        if (i > 0 && parts[i - 1]?.type === "data-screenshot") return null; // mid-run
                                        let j = i;
                                        const run: any[] = [];
                                        while (j < parts.length && parts[j].type === "data-screenshot") {
                                            run.push(parts[j]);
                                            j++;
                                        }
                                        const isLatest = run.some((s) => s.data.toolCallId === latestShotId);
                                        return <ScreenshotBlock key={i} shots={run} markerMap={markerMap} isLatest={isLatest} onOpen={setLightbox} />;
                                    }
                                    if (p.type === "data-steer")
                                        return (
                                            <div key={i} className="flex flex-col items-end gap-1 self-end max-w-[85%]">
                                                <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-dashed border-primary/45 bg-primary/10 px-3.5 py-2 text-[14px] text-foreground">
                                                    {p.data.text}
                                                </div>
                                                <span className="flex items-center gap-1 pr-1 text-[10px] font-medium text-muted-foreground">
                                                    <Clock className="size-2.5" /> Queued · the agent will read this next turn
                                                </span>
                                            </div>
                                        );
                                    if (p.type === "data-status")
                                        return <div key={i} className="text-xs italic text-muted-foreground">{p.data.text}</div>;
                                    if (p.type === "data-auth") {
                                        const req: AuthRequest = p.data.request;
                                        // "Still awaiting" if the server lists it pending OR a run is live (poll may
                                        // be frozen mid-run). Matches pickPendingAuth so the inline status and the
                                        // floated card never disagree.
                                        const livePending = (serverState?.pendingAuthIds ?? []).includes(req.id) || busy;
                                        if (decided.has(req.id) || !livePending)
                                            return (
                                                <div key={i} className="flex items-center gap-1.5 text-[11px] italic text-muted-foreground">
                                                    <Check className="size-3" /> authorization handled
                                                </div>
                                            );
                                        return (
                                            <div key={i} className="flex items-center gap-1.5 text-[11px] font-medium text-amber-500">
                                                <AlertTriangle className="size-3" /> Awaiting your authorization…
                                            </div>
                                        );
                                    }
                                    if (p.type === "dynamic-tool" || (typeof p.type === "string" && p.type.startsWith("tool-"))) {
                                        const name = p.toolName ?? p.type.replace("tool-", "");
                                        // The screenshot itself is shown as a thumbnail; skip the duplicate row.
                                        if (name === "screenshot") return null;
                                        // Surface memory writes prominently so you can watch knowledge build up.
                                        if (name === "remember" && p.input?.text)
                                            return (
                                                <div key={i} className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[12px] leading-snug">
                                                    <span className="mt-0.5 shrink-0">📌</span>
                                                    <span><span className="font-medium text-amber-500">Remembered</span> {p.input.text}</span>
                                                </div>
                                            );
                                        return <ToolCall key={i} name={name} state={p.state} input={p.input} output={p.output} />;
                                    }
                                    return null;
                                })}
                                {m.role === "assistant" && !busy && (
                                    <div className="flex gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:hover:opacity-100">
                                        <Button size="icon" variant="ghost" className="size-6" title="Copy" onClick={() => copyText(m)}>
                                            <Copy className="size-3.5" />
                                        </Button>
                                        {m.id === lastAssistantId && (
                                            <Button size="icon" variant="ghost" className="size-6" title="Regenerate" onClick={() => regenerate()}>
                                                <RotateCcw className="size-3.5" />
                                            </Button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                        );
                    })}

                    {status === "submitted" && (
                        <div className="flex items-center gap-2 text-muted-foreground">
                            <Loader /> Thinking…
                        </div>
                    )}
                    {error && (
                        <div className="flex items-center justify-between gap-2 rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-xs">
                            <span>⚠ {error.message || "Something went wrong."}</span>
                            <Button size="sm" variant="destructive" className="h-6" onClick={() => regenerate()}>Retry</Button>
                        </div>
                    )}
                </ConversationContent>
                <ConversationScrollButton />
            </Conversation>
            )}

            {/* slash autocomplete */}
            {comps.length > 0 && (
                <div className="max-h-40 overflow-auto border-t bg-card">
                    {comps.map((c) => (
                        <div key={c.name} className="cursor-pointer px-3 py-1.5 text-xs hover:bg-accent" onClick={() => setInput(`/${c.name} `)}>
                            <code className="text-primary">/{c.name}</code> <span className="text-primary/70">{c.arg ?? ""}</span>{" "}
                            <span className="text-muted-foreground">{c.summary}</span>
                        </div>
                    ))}
                </div>
            )}

            {/* composer */}
            <div
                className="relative p-2 pt-0"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                    e.preventDefault();
                    addImageFiles(Array.from(e.dataTransfer.files));
                }}
            >
                {/* Authorization prompt floats above the composer, anchored to it. */}
                {pendingAuth && (
                    <div className="absolute inset-x-2 bottom-full z-30 mb-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
                        <AuthCard req={pendingAuth} onDecide={(v) => decide(pendingAuth.id, v)} />
                    </div>
                )}
                {/* Ephemeral internal-step chip (e.g. "Checking the screen…") so a
                    blocking step isn't silent. Auth card takes priority when present. */}
                {!pendingAuth && liveActivity && (
                    <div className="pointer-events-none absolute inset-x-2 bottom-full z-20 mb-2 flex justify-center">
                        <div className="flex items-center gap-1.5 rounded-full border bg-card/95 px-3 py-1 text-[11px] text-muted-foreground shadow-sm animate-in fade-in slide-in-from-bottom-1">
                            <Loader size={12} className="text-primary" /> {liveActivity}
                        </div>
                    </div>
                )}
                <div className="rounded-2xl border bg-card transition-colors focus-within:border-ring/50">
                    {images.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
                            {images.map((im, i) => (
                                <div key={i} className="relative">
                                    <img src={im.url} alt="attachment" className="size-12 rounded-md border object-cover" />
                                    <button
                                        className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-white"
                                        onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                                    >
                                        <X className="size-2.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                    <textarea
                        ref={inputRef}
                        value={input}
                        placeholder={busy ? "Steer the agent…" : "Give the agent a task…"}
                        className="block max-h-[200px] min-h-[40px] w-full resize-none bg-transparent px-3.5 pb-1 pt-2.5 text-sm leading-normal outline-none placeholder:text-muted-foreground"
                        onChange={(e) => setInput(e.target.value)}
                        onPaste={(e) => {
                            const imgs = Array.from(e.clipboardData.items)
                                .filter((it) => it.type.startsWith("image/"))
                                .map((it) => it.getAsFile())
                                .filter((f): f is File => !!f);
                            if (imgs.length) {
                                e.preventDefault();
                                addImageFiles(imgs);
                            }
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
                        }}
                    />
                    <div
                        className="flex items-center gap-1 px-2 pb-1.5 pt-0.5"
                        style={{ paddingBottom: "max(0.375rem, env(safe-area-inset-bottom))" }}
                    >
                        <input
                            ref={fileInput}
                            type="file"
                            accept="image/*"
                            multiple
                            className="hidden"
                            onChange={(e) => {
                                addImageFiles(Array.from(e.target.files ?? []));
                                e.target.value = "";
                            }}
                        />
                        <Button size="icon" variant="ghost" className="size-7 shrink-0 text-muted-foreground" title="Attach image" onClick={() => fileInput.current?.click()}>
                            <Paperclip className="size-4" />
                        </Button>
                        <PillSelect
                            className="min-w-[58px] max-w-[132px]"
                            value={serverState?.settings?.modelRouting?.enabled ? "__auto__" : (serverState?.settings?.modelRouting?.reasoningModel ?? serverState?.model ?? "")}
                            title="Model — Auto routes reasoning vs fast per turn"
                            onChange={(m) => {
                                // Auto = dynamic routing on; any specific provider/model pins it
                                // (routing off, that model every turn). Same path as the role pickers.
                                const patch = m === "__auto__" ? { enabled: true } : { enabled: false, reasoningModel: m };
                                void post("/api/settings", { modelRouting: patch }).then(refreshState);
                            }}
                        >
                            <option value="__auto__">Auto</option>
                            {(() => {
                                const authed = (serverState?.providers ?? []).filter((p) => p.ready && p.models.length);
                                // Fall back to the legacy codex list if providers aren't populated.
                                if (!authed.length) return (serverState?.models ?? []).map((m) => <option key={m} value={`codex/${m}`}>{m}</option>);
                                return authed.map((p) => (
                                    <optgroup key={p.id} label={p.label}>
                                        {p.models.map((m) => (
                                            <option key={m} value={m}>{m}</option>
                                        ))}
                                    </optgroup>
                                ));
                            })()}
                        </PillSelect>
                        <PillSelect className="shrink-0" value={serverState?.policy ?? "risky-only"} title="Review policy" onChange={(p) => post("/api/policy", { policy: p }).then(refreshState)}>
                            <option value="risky-only">Confirm risky</option>
                            <option value="review-all">Review all</option>
                            <option value="autorun-trusted">Autorun</option>
                        </PillSelect>
                        <span className="flex-1" />
                        {(() => {
                            const c = serverState?.context;
                            if (!c || !c.max) return null;
                            const pct = Math.min(100, Math.round((c.tokens / c.max) * 100));
                            const col = pct > 85 ? "var(--destructive)" : pct > 65 ? "#e0a52b" : "var(--primary)";
                            return (
                                <div
                                    title={`Context ${pct}% — ${c.tokens.toLocaleString()} / ${c.max.toLocaleString()} tokens`}
                                    className="size-[18px] shrink-0 rounded-full"
                                    style={{
                                        background: `conic-gradient(${col} ${pct * 3.6}deg, var(--border) 0deg)`,
                                        WebkitMask: "radial-gradient(closest-side, transparent 56%, #000 58%)",
                                        mask: "radial-gradient(closest-side, transparent 56%, #000 58%)",
                                    }}
                                />
                            );
                        })()}
                        {busy && (
                            <Button size="icon" variant="ghost" className="size-8 shrink-0 rounded-full text-destructive hover:bg-destructive/10" onClick={stopAll} title="Stop the agent">
                                <Square className="size-3.5 fill-current" />
                            </Button>
                        )}
                        <Button
                            size="icon"
                            className="size-8 shrink-0 rounded-full disabled:opacity-30"
                            disabled={!input.trim() && images.length === 0}
                            onClick={submit}
                            title={busy ? "Steer / queue" : "Send"}
                        >
                            <ArrowUp className="size-4" />
                        </Button>
                    </div>
                </div>
            </div>

            {/* panels */}
            {panel === "ambient" && <AmbientPanel state={serverState} onClose={() => setPanel("none")} onRefresh={refreshState} />}
            {panel === "activity" && <ActivityPanel state={serverState} onClose={() => setPanel("none")} />}
            {panel === "settings" && <SettingsPanel state={serverState} onClose={() => setPanel("none")} onPatch={(p) => post("/api/settings", p).then(refreshState)} />}
            {panel === "history" && (
                <Modal onClose={() => setPanel("none")}>
                    <div className="flex items-center justify-between border-b p-3 font-semibold">
                        History
                        <button onClick={() => setPanel("none")} className="text-muted-foreground"><X className="size-4" /></button>
                    </div>
                    <div className="border-b p-2">
                        <input
                            autoFocus
                            value={historyQuery}
                            onChange={(e) => setHistoryQuery(e.target.value)}
                            placeholder="Search conversations…"
                            className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring/60"
                        />
                    </div>
                    <div className="flex-1 overflow-auto">
                        {(() => {
                            const q = historyQuery.trim().toLowerCase();
                            const list = (serverState?.sessions ?? []).filter((s) => !q || s.title.toLowerCase().includes(q));
                            if (list.length === 0)
                                return <div className="p-4 text-sm text-muted-foreground">{q ? "No matches." : "No saved sessions."}</div>;
                            return list.map((s) => (
                                <div key={s.id} className={cn("flex items-center gap-2 border-b px-3 py-2 text-sm", s.id === serverState?.sessionId && "bg-primary/10")}>
                                    <span className="flex-1 cursor-pointer truncate" onClick={() => resume(s.id)}>{s.title}</span>
                                    <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(s.updatedAt)}</span>
                                    <button className="text-muted-foreground hover:text-destructive" onClick={() => del(s.id)}><Trash2 className="size-3.5" /></button>
                                </div>
                            ));
                        })()}
                    </div>
                </Modal>
            )}

            {lightbox && (
                <div className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/85" onClick={() => setLightbox(null)}>
                    <img src={lightbox} alt="screen" className="max-h-[96%] max-w-[96%] rounded-lg" />
                </div>
            )}
        </div>
    );
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
