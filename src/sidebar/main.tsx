/**
 * Agent sidebar — built with the Vercel AI SDK + AI Elements components.
 *
 * Chat surface (conversation, reasoning, tool calls, suggestions, loader,
 * markdown) uses AI Elements; computer-use specifics (screenshots with action
 * markers, three-way authorization, sessions, settings, presence) are custom
 * components styled with the same shadcn tokens.
 */

import { createRoot } from "react-dom/client";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
    History,
    Clock,
    Globe,
    Keyboard,
    Lock,
    MousePointerClick,
    Move,
    Paperclip,
    Pause,
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
import type { ServerState, MarkerData } from "../agent/protocol";

// Our API + assets live under `/_agent`. The desktop sidebar (loaded from a
// file:// page) gets the origin from its preload; a browser uses same-origin.
const AGENT_ORIGIN = (window as unknown as { __AGENT_ORIGIN__?: string }).__AGENT_ORIGIN__ ?? location.origin;
const BASE = `${AGENT_ORIGIN}/_agent`;

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
}: {
    value: string;
    onChange: (v: string) => void;
    title: string;
    children: React.ReactNode;
}) {
    return (
        <div className="relative">
            <select
                value={value}
                title={title}
                onChange={(e) => onChange(e.target.value)}
                className="cursor-pointer appearance-none rounded-full border bg-secondary py-1 pl-2.5 pr-6 text-xs text-foreground outline-none transition-colors hover:bg-accent"
            >
                {children}
            </select>
            <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        </div>
    );
}

/* ------------------------------- custom parts ----------------------------- */

/** The image + its markers, sized to its natural dimensions (never stretched). */
function ShotImage({ src, w, h, markers, onOpen }: { src: string; w: number; h: number; markers: MarkerData[]; onOpen: (s: string) => void }) {
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
function ScreenshotBlock({
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
                <img src={last.src} alt="" className="size-8 rounded object-cover" />
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
}

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
            return `Typed “${String(i.text ?? "").slice(0, 32)}${String(i.text ?? "").length > 32 ? "…" : ""}”`;
        case "press_key":
            return `Pressed ${i.key}`;
        case "hotkey":
            return `Pressed ${(i.codes ?? []).join("+")}`;
        case "scroll":
            return "Scrolled";
        default:
            return name;
    }
}

function ToolCall({ name, state, input, output }: { name: string; state?: string; input?: any; output?: any }) {
    const [open, setOpen] = useState(false);
    const running = state && state !== "output-available" && state !== "output-error";
    const isErr = state === "output-error" || (output && typeof output === "object" && output.isError);
    const Icon = TOOL_ICONS[name] ?? Activity;
    return (
        <div className="overflow-hidden rounded-lg border bg-card/60">
            <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/50">
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-foreground/90">{toolLabel(name, input)}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {running ? (
                        <Loader size={12} className="text-muted-foreground" />
                    ) : isErr ? (
                        <X className="size-3.5 text-destructive" />
                    ) : (
                        <Check className="size-3.5 text-emerald-500" />
                    )}
                    <ChevronDown className={cn("size-3 text-muted-foreground transition-transform", open && "rotate-180")} />
                </span>
            </button>
            {open && (
                <div className="space-y-2 border-t px-2.5 py-2 text-[11px]">
                    {input != null && Object.keys(input).length > 0 && (
                        <div>
                            <div className="mb-1 text-muted-foreground">Input</div>
                            <pre className="overflow-x-auto rounded-md bg-muted/60 p-2">{JSON.stringify(input, null, 2)}</pre>
                        </div>
                    )}
                    {output != null && (
                        <div>
                            <div className="mb-1 text-muted-foreground">Result</div>
                            <pre className={cn("overflow-x-auto rounded-md p-2", isErr ? "bg-destructive/10 text-destructive" : "bg-muted/60")}>
                                {typeof output === "object" ? JSON.stringify(output, null, 2) : String(output)}
                            </pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
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
                {req.reason && (
                    <div className={cn("rounded-lg px-2.5 py-1.5 text-[13px] font-medium", req.risky ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary")}>
                        {req.reason}
                    </div>
                )}
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
            <div className={cn("relative flex flex-col border-l bg-card", wide ? "w-full" : "w-72")} onClick={(e) => e.stopPropagation()}>
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

function AmbientPanel({ state, onClose }: { state: ServerState | null; onClose: () => void }) {
    const amb = state?.ambient;
    const events = amb?.events ?? [];
    const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
    const fmtSec = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    // Past meetings log.
    const [meetings, setMeetings] = useState<any[]>([]);
    const [openMeeting, setOpenMeeting] = useState<any | null>(null);
    const loadMeetings = () =>
        fetch(BASE + "/api/meetings").then((r) => r.json()).then((d) => setMeetings(d.meetings ?? [])).catch(() => {});
    useEffect(() => {
        void loadMeetings();
    }, [amb?.inMeeting]); // refresh when a meeting ends
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
            {amb?.inMeeting && amb?.transcribe && (
                <div className="border-b bg-muted/20 px-3 py-2">
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                        <span className="size-1.5 animate-pulse rounded-full bg-red-500" /> Live transcript
                    </div>
                    <div className="max-h-28 overflow-auto whitespace-pre-wrap text-[12px] leading-snug">
                        {amb.transcript?.trim() || <span className="text-muted-foreground">Listening…</span>}
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
                                        {new Date(m.startTs).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {m.suggestionCount} note{m.suggestionCount === 1 ? "" : "s"}
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
                            {new Date(openMeeting.startTs).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
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
    const fmt = (t: number) => new Date(t).toLocaleTimeString();
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

function SettingsPanel({ state, onClose, onPatch }: { state: ServerState | null; onClose: () => void; onPatch: (p: any) => void }) {
    const s = state?.settings;
    const hv = s?.humanize ?? 1;
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
    const [tab, setTab] = useState<"behaviour" | "ambient" | "secrets" | "server">("behaviour");
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
        { id: "ambient", label: "Ambient", icon: Radar },
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
                <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted/60 p-1">
                    {tabs.map((t) => (
                        <button
                            key={t.id}
                            onClick={() => setTab(t.id)}
                            className={cn(
                                "flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors",
                                tab === t.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                            )}
                        >
                            <t.icon className="size-3.5" /> {t.label}
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

                {/* ------------------------------- ambient ------------------------------ */}
                {tab === "ambient" && (
                    <div className="space-y-3">
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
                                    <Row label="Transcribe meetings" desc="Local whisper — stays on this machine" control={<Switch checked={amb?.transcribe ?? false} onChange={(v) => onPatch({ ambient: { transcribe: v } })} />} />
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
                                    <div key={it.name} className="flex items-center gap-2 rounded-lg border bg-card/60 px-2.5 py-2 text-xs">
                                        <Lock className="size-3.5 shrink-0 text-muted-foreground" />
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-[13px]">{it.name}</div>
                                            {it.hint && <div className="truncate text-[10px] text-muted-foreground">{it.hint}</div>}
                                        </div>
                                        <span className="font-mono text-muted-foreground">••••••</span>
                                        <button className="text-muted-foreground hover:text-destructive" title="Delete secret" onClick={() => post("/api/secrets/delete", { name: it.name }).then(() => onPatch({}))}>
                                            <X className="size-3.5" />
                                        </button>
                                    </div>
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

                        <div className="rounded-xl border bg-card/40 p-3">
                            <Row
                                label="Atlas memory vault"
                                desc="Store the agent's memory as markdown in an Atlas vault (via its MCP server). Needs a restart."
                                control={<Switch checked={state?.settings?.atlas?.enabled ?? false} onChange={(v) => onPatch({ atlas: { enabled: v } })} />}
                            />
                            {state?.settings?.atlas?.enabled && (
                                <div className="mt-2 space-y-1.5 border-t pt-2.5">
                                    <label className="block text-[11px] text-muted-foreground">
                                        Vault path
                                        <input
                                            defaultValue={state?.settings?.atlas?.vaultPath ?? ""}
                                            onBlur={(e) => e.target.value !== state?.settings?.atlas?.vaultPath && onPatch({ atlas: { vaultPath: e.target.value.trim() } })}
                                            placeholder="~/Documents/Atlas/Capgemini"
                                            className={cn(inputCls, "mt-1 font-mono text-[11px]")}
                                        />
                                    </label>
                                    <label className="block text-[11px] text-muted-foreground">
                                        atlas binary
                                        <input
                                            defaultValue={state?.settings?.atlas?.binPath ?? ""}
                                            onBlur={(e) => e.target.value !== state?.settings?.atlas?.binPath && onPatch({ atlas: { binPath: e.target.value.trim() } })}
                                            placeholder="/path/to/atlas"
                                            className={cn(inputCls, "mt-1 font-mono text-[11px]")}
                                        />
                                    </label>
                                    <p className="text-[10px] text-muted-foreground">Changes apply on the next restart (the vault connects at startup).</p>
                                </div>
                            )}
                        </div>
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
    const [input, setInput] = useState("");
    const [lightbox, setLightbox] = useState<string | null>(null);
    const [panel, setPanel] = useState<"none" | "activity" | "settings" | "history" | "ambient">("none");
    const [historyQuery, setHistoryQuery] = useState("");
    const [images, setImages] = useState<{ url: string; mediaType: string }[]>([]);
    const fileInput = useRef<HTMLInputElement>(null);
    const transport = useRef(new DefaultChatTransport({ api: BASE + "/api/chat" }));
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

    const refreshState = () =>
        fetch(BASE + "/api/state")
            .then((r) => r.json())
            .then(setServerState)
            .catch(() => {});

    useEffect(() => {
        refreshState();
        const id = setInterval(refreshState, 2000);
        return () => clearInterval(id);
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
    const loadTranscript = () =>
        fetch(BASE + "/api/sessions/current")
            .then((r) => r.json())
            .then((d) => {
                if (Array.isArray(d.messages)) setMessages(d.messages);
            })
            .catch(() => {});
    useEffect(() => {
        void loadTranscript();
    }, []);

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

    // Persist the transcript shortly after each change settles, so it survives restarts.
    useEffect(() => {
        if (status === "streaming" || status === "submitted" || messages.length === 0) return;
        const t = setTimeout(() => void post("/api/sessions/ui", { messages }), 800);
        return () => clearTimeout(t);
    }, [messages, status]);

    const decide = (id: string, verdict: any) => {
        setDecided((s) => new Set(s).add(id));
        void post("/api/approve", { id, ...verdict });
    };
    // The most recent still-undecided authorization request — floated above the
    // composer. Only show it if the server is actually still blocked on it (or a
    // run is live and just emitted it), so stale prompts from a reloaded transcript
    // don't reappear when you re-open the sidebar.
    const pendingAuth = useMemo<AuthRequest | null>(() => {
        let candidate: AuthRequest | null = null;
        outer: for (let mi = messages.length - 1; mi >= 0; mi--) {
            const parts = (messages[mi] as any).parts ?? [];
            for (let pi = parts.length - 1; pi >= 0; pi--) {
                if (parts[pi].type === "data-auth") {
                    candidate = parts[pi].data.request as AuthRequest;
                    break outer;
                }
            }
        }
        if (!candidate || decided.has(candidate.id)) return null;
        // Show ONLY if the server is genuinely still blocked on this exact request.
        // (Don't fall back to "is streaming" — that resurfaces a stale prompt the
        // moment a new run starts.)
        return (serverState?.pendingAuthIds ?? []).includes(candidate.id) ? candidate : null;
    }, [messages, decided, serverState?.pendingAuthIds]);
    const addImageFiles = (files: File[]) => {
        for (const f of files) {
            if (!f.type.startsWith("image/")) continue;
            const r = new FileReader();
            r.onload = () => setImages((prev) => [...prev, { url: String(r.result), mediaType: f.type || "image/png" }]);
            r.readAsDataURL(f);
        }
    };

    const send = (text = input) => {
        const t = text.trim();
        if (!t && images.length === 0) return;
        const files = images.map((im) => ({ type: "file" as const, mediaType: im.mediaType, url: im.url }));
        setInput("");
        setImages([]);
        void sendMessage({ text: t, ...(files.length ? { files } : {}) });
    };

    // Stop the agent for real — abort the run on the server, not just the client stream.
    const stopAll = () => {
        stop();
        void post("/api/stop");
    };

    // Queue/steer a message while the agent is already working. The server echoes
    // it into the live stream (data-steer) so it lands inline at the right spot.
    const steer = (text = input) => {
        const t = text.trim();
        if (!t) return;
        setInput("");
        void post("/api/steer", { text: t });
    };

    const isBusy = () => status === "streaming" || status === "submitted";
    const submit = () => (isBusy() ? steer() : send());
    const newChat = () => void post("/api/sessions/new").then(() => { setMessages([]); refreshState(); });
    const resume = (id: string) =>
        void post("/api/sessions/resume", { id }).then((r) => r.json()).then((d) => { setMessages(d.messages ?? []); refreshState(); setPanel("none"); });
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
    const busy = status === "streaming" || status === "submitted";
    const empty = messages.length === 0;
    const lastAssistantId = useMemo(() => [...messages].reverse().find((m: any) => m.role === "assistant")?.id, [messages]);
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
            <div className="absolute left-0 top-0 z-30 h-full w-1.5 cursor-ew-resize hover:bg-primary/40" onMouseDown={onHandleDown} title="Drag to resize" />

            {/* header */}
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

            {/* conversation */}
            <Conversation className="flex-1">
                <ConversationContent className="gap-6 px-4 py-5">
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
                            {m.role === "assistant" && (
                                <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/20 text-primary">
                                    <Sparkles className="size-4" />
                                </div>
                            )}
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
                                            <Streamdown key={i} className="text-[14px] leading-relaxed">{p.text}</Streamdown>
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
                                            <div key={i} className="self-end max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary/85 px-3.5 py-2 text-[14px] text-primary-foreground">
                                                {p.data.text}
                                            </div>
                                        );
                                    if (p.type === "data-status")
                                        return <div key={i} className="text-xs italic text-muted-foreground">{p.data.text}</div>;
                                    if (p.type === "data-auth") {
                                        const req: AuthRequest = p.data.request;
                                        const livePending = (serverState?.pendingAuthIds ?? []).includes(req.id);
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
                                    <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100">
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
                className="relative bg-card p-2"
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
                <div className="rounded-2xl border bg-background transition-colors focus-within:border-ring/50">
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
                    <div className="flex items-center gap-1 px-2 pb-1.5 pt-0.5">
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
                        <PillSelect value={serverState?.model ?? ""} title="Model" onChange={(m) => post("/api/model", { model: m }).then(refreshState)}>
                            {(serverState?.models ?? []).map((m) => (
                                <option key={m} value={m}>{m}</option>
                            ))}
                        </PillSelect>
                        <PillSelect value={serverState?.policy ?? "risky-only"} title="Review policy" onChange={(p) => post("/api/policy", { policy: p }).then(refreshState)}>
                            <option value="risky-only">Confirm risky</option>
                            <option value="review-all">Review all</option>
                            <option value="autorun-trusted">Autorun</option>
                        </PillSelect>
                        <span className="flex-1" />
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

            {/* footer status */}
            <div className="flex shrink-0 items-center justify-between gap-2 bg-card px-4 pb-1.5 text-[10.5px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                    <span className={cn("size-1.5 rounded-full", serverState?.loggedIn ? "bg-emerald-500" : "bg-muted-foreground")} />
                    {serverState?.loggedIn ? "ChatGPT connected" : "Not signed in"}
                </span>
                <ContextMeter ctx={serverState?.context} />
            </div>

            {/* panels */}
            {panel === "ambient" && <AmbientPanel state={serverState} onClose={() => setPanel("none")} />}
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
