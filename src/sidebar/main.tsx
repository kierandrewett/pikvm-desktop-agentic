/**
 * Agent sidebar — built with the Vercel AI SDK + AI Elements components.
 *
 * Chat surface (conversation, reasoning, tool calls, suggestions, loader,
 * markdown) uses AI Elements; computer-use specifics (screenshots with action
 * markers, three-way authorization, sessions, settings, presence) are custom
 * components styled with the same shadcn tokens.
 */

import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Streamdown } from "streamdown";
import {
    Activity,
    ArrowUp,
    Camera,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Copy,
    History,
    Keyboard,
    MousePointerClick,
    Move,
    Paperclip,
    Pause,
    Plus,
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

const BASE = "http://127.0.0.1:25650";

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

function Screenshot({ src, w, h, markers, onOpen }: { src: string; w: number; h: number; markers: MarkerData[]; onOpen: (s: string) => void }) {
    return (
        <div className="relative inline-block max-w-full cursor-zoom-in self-start overflow-hidden rounded-lg border" onClick={() => onOpen(src)}>
            {/* Keep the native aspect ratio — never stretch (esp. crops). */}
            <img src={src} alt="screen" className="block max-h-[460px] max-w-full" />
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
            <span className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 text-[11px] text-white">
                {w}×{h}
            </span>
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

    if (shots.length === 1) {
        const s = shots[0].data;
        return <Screenshot src={s.src} w={s.width} h={s.height} markers={markerMap[s.toolCallId] ?? []} onOpen={onOpen} />;
    }
    const cur = shots[Math.min(idx, shots.length - 1)].data;
    return (
        <div className="relative self-start">
            <Screenshot src={cur.src} w={cur.width} h={cur.height} markers={markerMap[cur.toolCallId] ?? []} onOpen={onOpen} />
            <button
                className="absolute left-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white transition-opacity hover:bg-black/75 disabled:opacity-0"
                disabled={idx <= 0}
                onClick={() => setIdx((i) => Math.max(0, i - 1))}
            >
                <ChevronLeft className="size-4" />
            </button>
            <button
                className="absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white transition-opacity hover:bg-black/75 disabled:opacity-0"
                disabled={idx >= shots.length - 1}
                onClick={() => setIdx((i) => Math.min(shots.length - 1, i + 1))}
            >
                <ChevronRight className="size-4" />
            </button>
            <div className="absolute bottom-1.5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/55 px-2 py-1">
                {shots.map((_, i) => (
                    <button
                        key={i}
                        onClick={() => setIdx(i)}
                        className={cn("size-1.5 rounded-full transition-colors", i === idx ? "bg-white" : "bg-white/40")}
                    />
                ))}
            </div>
            <span className="absolute right-2 top-2 rounded bg-black/55 px-1.5 text-[11px] text-white">
                {idx + 1}/{shots.length}
            </span>
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
    return (
        <div className={cn("rounded-xl border p-3", req.risky ? "border-destructive/60" : "border-primary/60")}>
            <div className="flex items-center justify-between font-semibold">
                <span>{req.risky ? "⚠ Authorize action" : "Authorize action"}</span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{req.op.tool}</code>
            </div>
            {req.reason && <div className="mt-1.5 text-xs text-destructive">{req.reason}</div>}
            <pre className="mt-1.5 max-h-20 overflow-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1 text-[11px]">
                {JSON.stringify(req.op.args)}
            </pre>
            {redirect ? (
                <div className="mt-2">
                    <textarea
                        autoFocus
                        className="mb-1.5 min-h-[54px] w-full resize-y rounded-md border bg-background p-2 text-sm"
                        placeholder="Tell the agent what to do instead…"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                    />
                    <div className="flex gap-1.5">
                        <Button size="sm" className="flex-1" onClick={() => onDecide({ decision: "redirect", text })}>
                            Send redirect
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setRedirect(false)}>
                            Back
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="mt-2 flex gap-1.5">
                    <Button size="sm" className="flex-1 bg-emerald-600 hover:bg-emerald-500" onClick={() => onDecide({ decision: "allow", rememberKind: remember })}>
                        Allow
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => onDecide({ decision: "deny" })}>
                        Deny
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setRedirect(true)}>
                        Something else
                    </Button>
                </div>
            )}
            <label className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Always allow this kind
            </label>
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

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
    return (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
            <div className="flex w-72 flex-col border-l bg-card" onClick={(e) => e.stopPropagation()}>
                {children}
            </div>
        </div>
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

function SettingsPanel({ state, onClose, onPatch }: { state: ServerState | null; onClose: () => void; onPatch: (p: any) => void }) {
    const s = state?.settings;
    const hv = s?.humanize ?? 1;
    return (
        <Modal onClose={onClose}>
            <div className="flex items-center justify-between border-b p-3 font-semibold">
                Settings
                <button onClick={onClose} className="text-muted-foreground">
                    <X className="size-4" />
                </button>
            </div>
            <div className="space-y-4 p-3">
                <label className="block">
                    <span className="text-sm">Typing style</span>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.1}
                        defaultValue={hv}
                        className="mt-1 w-full"
                        onChange={(e) => onPatch({ humanize: parseFloat(e.target.value) })}
                    />
                    <small className="text-muted-foreground">{hv === 0 ? "Precise (no typos)" : hv >= 0.9 ? "Very human" : "Human"}</small>
                </label>
                <label className="block">
                    <span className="text-sm">Typing speed</span>
                    <input
                        type="range"
                        min={40}
                        max={180}
                        step={5}
                        defaultValue={s?.wpm ?? 95}
                        className="mt-1 w-full"
                        onChange={(e) => onPatch({ wpm: parseInt(e.target.value, 10) })}
                    />
                    <small className="text-muted-foreground">~{s?.wpm ?? 95} WPM baseline (randomised per run)</small>
                </label>
                <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={s?.pauseOnPresence ?? true} onChange={(e) => onPatch({ pauseOnPresence: e.target.checked })} />
                    Pause when target mic/audio is active
                </label>
                <p className="text-[11px] text-muted-foreground">Model & review policy are in the header. Settings persist across restarts.</p>
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
    const [panel, setPanel] = useState<"none" | "activity" | "settings" | "history">("none");
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

    // Restore the current session's transcript (with screenshots) on load.
    useEffect(() => {
        fetch(BASE + "/api/sessions/current")
            .then((r) => r.json())
            .then((d) => {
                if (Array.isArray(d.messages) && d.messages.length) setMessages(d.messages);
            })
            .catch(() => {});
    }, []);

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

    // Auto-grow the composer with its content (e.g. when pasting a big block).
    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 220) + "px";
    }, [input]);

    const comps: CommandSpec[] = useMemo(() => completions(input), [input]);
    const busy = status === "streaming" || status === "submitted";
    const empty = messages.length === 0;
    const lastAssistantId = useMemo(() => [...messages].reverse().find((m: any) => m.role === "assistant")?.id, [messages]);
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
                        const shots = parts.filter((p: any) => p.type === "data-screenshot");
                        const firstShot = parts.findIndex((p: any) => p.type === "data-screenshot");
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
                                    if (p.type === "data-thinking")
                                        return (
                                            <Reasoning key={i} isStreaming={!p.data.done} defaultOpen={false} className="mb-0">
                                                <ReasoningTrigger />
                                                <ReasoningContent>{p.data.text}</ReasoningContent>
                                            </Reasoning>
                                        );
                                    if (p.type === "data-screenshot")
                                        // Collapse a run of screenshots into one carousel (rendered at the first).
                                        return i === firstShot ? (
                                            <ScreenshotCarousel key="shots" shots={shots} markerMap={markerMap} onOpen={setLightbox} />
                                        ) : null;
                                    if (p.type === "data-status")
                                        return <div key={i} className="text-xs italic text-muted-foreground">{p.data.text}</div>;
                                    if (p.type === "data-auth") {
                                        const req: AuthRequest = p.data.request;
                                        if (decided.has(req.id)) return <div key={i} className="text-xs italic text-muted-foreground">authorized</div>;
                                        return <AuthCard key={i} req={req} onDecide={(v) => decide(req.id, v)} />;
                                    }
                                    if (p.type === "dynamic-tool" || (typeof p.type === "string" && p.type.startsWith("tool-"))) {
                                        const name = p.toolName ?? p.type.replace("tool-", "");
                                        // The screenshot itself is shown as a thumbnail; skip the duplicate row.
                                        if (name === "screenshot") return null;
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
                className="border-t bg-card px-3 pb-3 pt-2.5"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                    e.preventDefault();
                    addImageFiles(Array.from(e.dataTransfer.files));
                }}
            >
                <div className="rounded-2xl border bg-background p-2.5 transition-colors focus-within:border-ring/60">
                    {images.length > 0 && (
                        <div className="mb-1.5 flex flex-wrap gap-1.5">
                            {images.map((im, i) => (
                                <div key={i} className="relative">
                                    <img src={im.url} alt="attachment" className="size-14 rounded-md border object-cover" />
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
                        placeholder="Give the agent a task…  (/ for commands, paste an image)"
                        rows={1}
                        className="min-h-[34px] w-full resize-none overflow-y-auto bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-muted-foreground"
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
                            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                        }}
                    />
                    <div className="mt-1 flex items-center gap-1.5">
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
                        <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" title="Attach image" onClick={() => fileInput.current?.click()}>
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
                        {busy ? (
                            <Button size="icon" variant="destructive" className="size-8 rounded-full" onClick={() => stop()} title="Stop">
                                <Square className="size-3.5" />
                            </Button>
                        ) : (
                            <Button size="icon" className="size-8 rounded-full disabled:opacity-40" disabled={!input.trim() && images.length === 0} onClick={() => send()} title="Send">
                                <ArrowUp className="size-4" />
                            </Button>
                        )}
                    </div>
                </div>
            </div>

            {/* footer status */}
            <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-t bg-card px-4 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                    <span className={cn("size-1.5 rounded-full", serverState?.loggedIn ? "bg-emerald-500" : "bg-muted-foreground")} />
                    {serverState?.loggedIn ? "ChatGPT connected" : "Not signed in"}
                </span>
                <ContextMeter ctx={serverState?.context} />
            </div>

            {/* panels */}
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
