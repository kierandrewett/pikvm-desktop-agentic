/**
 * Agent sidebar (Vercel AI SDK + React) — VS Code-chat-style.
 *
 * Streams the agent transcript via `useChat`, renders markdown + code blocks,
 * collapsible tool calls, screenshots, three-way authorization cards, a model
 * picker, sessions (new/resume), presence banner, and slash autocomplete.
 */

import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { completions, type CommandSpec } from "../commands";
import type { AuthRequest } from "../reviewer";
import type { ServerState, MarkerData } from "../agent/protocol";
import { Markdown } from "./markdown";

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

/* --------------------------------- parts --------------------------------- */

function Screenshot({
    src,
    w,
    h,
    markers,
    onOpen,
}: {
    src: string;
    w: number;
    h: number;
    markers: MarkerData[];
    onOpen: (s: string) => void;
}) {
    return (
        <div className="shot" onClick={() => onOpen(src)}>
            <img src={src} alt="screen" />
            {markers.map((mk, i) => (
                <span
                    key={i}
                    className={`marker ${mk.kind}`}
                    style={{ left: `${(mk.x / (w || 1)) * 100}%`, top: `${(mk.y / (h || 1)) * 100}%` }}
                    title={`${mk.kind} (${mk.x}, ${mk.y})`}
                />
            ))}
            <span className="dim">
                {w}×{h}
            </span>
        </div>
    );
}

const TOOL_ICON: Record<string, string> = {
    screenshot: "📸",
    move_mouse: "🖱",
    click: "👆",
    double_click: "👆",
    type_text: "⌨️",
    press_key: "⌨️",
    hotkey: "⌨️",
    scroll: "🖱",
};

function ToolCall({ name, state, input, summary }: { name: string; state?: string; input?: any; summary?: string }) {
    const [open, setOpen] = useState(false);
    const running = state && state !== "output-available" && state !== "output-error";
    return (
        <div className={`tool ${running ? "running" : ""}`}>
            <div className="tool-row" onClick={() => setOpen((o) => !o)}>
                <span className="tico">{TOOL_ICON[name] ?? "•"}</span>
                <span className="tname">{name}</span>
                {summary && <span className="tsum">{summary}</span>}
                {running && <span className="tspin" />}
                <span className="tchev">{open ? "▾" : "▸"}</span>
            </div>
            {open && input != null && <pre className="targs">{JSON.stringify(input, null, 2)}</pre>}
        </div>
    );
}

function AuthCard({ req, onDecide }: { req: AuthRequest; onDecide: (v: any) => void }) {
    const [redirect, setRedirect] = useState(false);
    const [text, setText] = useState("");
    const [remember, setRemember] = useState(false);
    return (
        <div className={`auth ${req.risky ? "risky" : ""}`}>
            <div className="ahdr">
                <span>{req.risky ? "⚠ Authorize action" : "Authorize action"}</span>
                <code>{req.op.tool}</code>
            </div>
            {req.reason && <div className="areason">{req.reason}</div>}
            <pre className="aargs">{JSON.stringify(req.op.args)}</pre>
            {!redirect ? (
                <div className="arow">
                    <button className="allow" onClick={() => onDecide({ decision: "allow", rememberKind: remember })}>
                        Allow
                    </button>
                    <button className="deny" onClick={() => onDecide({ decision: "deny" })}>
                        Deny
                    </button>
                    <button className="diff" onClick={() => setRedirect(true)}>
                        Do something different
                    </button>
                </div>
            ) : (
                <div className="aredir">
                    <textarea
                        autoFocus
                        placeholder="Tell the agent what to do instead…"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                    />
                    <div className="arow">
                        <button className="allow" onClick={() => onDecide({ decision: "redirect", text })}>
                            Send redirect
                        </button>
                        <button className="diff" onClick={() => setRedirect(false)}>
                            Back
                        </button>
                    </div>
                </div>
            )}
            <label className="remember">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Always allow
                this kind
            </label>
        </div>
    );
}

/* ------------------------------- sessions -------------------------------- */

function SessionMenu({
    state,
    onNew,
    onResume,
    onDelete,
}: {
    state: ServerState | null;
    onNew: () => void;
    onResume: (id: string) => void;
    onDelete: (id: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const sessions = state?.sessions ?? [];
    return (
        <div className="sessions">
            <button className="iconbtn" title="New chat" onClick={onNew}>
                ＋
            </button>
            <button className="iconbtn" title="History" onClick={() => setOpen((o) => !o)}>
                🕘
            </button>
            {open && (
                <div className="sesslist" onMouseLeave={() => setOpen(false)}>
                    {sessions.length === 0 && <div className="sessempty">No saved sessions</div>}
                    {sessions.map((s) => (
                        <div key={s.id} className={`sessrow ${s.id === state?.sessionId ? "cur" : ""}`}>
                            <span
                                className="sesstitle"
                                onClick={() => {
                                    onResume(s.id);
                                    setOpen(false);
                                }}
                            >
                                {s.title}
                            </span>
                            <button
                                className="sessdel"
                                title="Delete"
                                onClick={() => onDelete(s.id)}
                            >
                                ✕
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function Thinking({ text, done }: { text: string; done?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
        <div className={`thinking-block ${done ? "" : "live"}`}>
            <div className="tb-row" onClick={() => setOpen((o) => !o)}>
                <span className="tb-ico">🧠</span>
                <span className="tb-label">{done ? "Thought" : "Thinking…"}</span>
                <span className="tchev">{open ? "▾" : "▸"}</span>
            </div>
            {open && <div className="tb-body">{text}</div>}
        </div>
    );
}

function StatusPill({ state }: { state: ServerState | null }) {
    if (!state) return <span className="pill connecting">connecting…</span>;
    if (state.presence.paused) return <span className="pill paused">paused</span>;
    if (state.acting) return <span className="pill working">working</span>;
    return <span className="pill idle">idle</span>;
}

function ContextMeter({ ctx }: { ctx: { tokens: number; max: number } | undefined }) {
    if (!ctx || !ctx.max) return null;
    const pct = Math.min(100, Math.round((ctx.tokens / ctx.max) * 100));
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(0)}k` : `${n}`);
    return (
        <div className="ctxmeter" title={`${ctx.tokens} / ${ctx.max} context tokens`}>
            <div className="ctxbar">
                <div className="ctxfill" style={{ width: `${pct}%`, background: pct > 85 ? "var(--danger)" : "var(--accent)" }} />
            </div>
            <span className="ctxnum">
                {k(ctx.tokens)}/{k(ctx.max)}
            </span>
        </div>
    );
}

function ActivityPanel({ state, onClose }: { state: ServerState | null; onClose: () => void }) {
    const log = (state?.log ?? []).slice().reverse();
    const fmt = (t: number) => new Date(t).toLocaleTimeString();
    return (
        <div className="activity" onClick={onClose}>
            <div className="act-panel" onClick={(e) => e.stopPropagation()}>
                <div className="act-head">
                    <b>Activity</b>
                    <button onClick={onClose}>✕</button>
                </div>
                <div className="act-list">
                    {log.length === 0 && <div className="act-empty">No operations yet.</div>}
                    {log.map((e) => (
                        <div key={e.id} className={`act-row ${e.decision}`}>
                            <span className="act-dec">{e.decision === "auto-allow" ? "✓" : e.decision === "deny" ? "✕" : e.decision === "redirect" ? "↦" : "✓"}</span>
                            <span className="act-tool">{e.op.tool}</span>
                            {e.risky && <span className="act-risk">risky</span>}
                            <span className="act-time">{fmt(e.at)}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function SettingsPopover({
    state,
    onClose,
    onPatch,
}: {
    state: ServerState | null;
    onClose: () => void;
    onPatch: (p: any) => void;
}) {
    const s = state?.settings;
    return (
        <div className="settings-pop" onClick={onClose}>
            <div className="sp-panel" onClick={(e) => e.stopPropagation()}>
                <div className="sp-head">
                    <b>Settings</b>
                    <button onClick={onClose}>✕</button>
                </div>
                <label className="sp-field">
                    <span>Typing style</span>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.1}
                        defaultValue={s?.humanize ?? 1}
                        onChange={(e) => onPatch({ humanize: parseFloat(e.target.value) })}
                    />
                    <small>{(s?.humanize ?? 1) === 0 ? "Precise (no typos)" : (s?.humanize ?? 1) >= 0.9 ? "Very human" : "Human"}</small>
                </label>
                <label className="sp-check">
                    <input
                        type="checkbox"
                        checked={s?.pauseOnPresence ?? true}
                        onChange={(e) => onPatch({ pauseOnPresence: e.target.checked })}
                    />
                    <span>Pause when target mic/audio is active</span>
                </label>
                <p className="sp-note">Model & review policy are in the header. Settings persist across restarts.</p>
            </div>
        </div>
    );
}

/* ---------------------------------- app ---------------------------------- */

function App() {
    const [serverState, setServerState] = useState<ServerState | null>(null);
    const [decided, setDecided] = useState<Set<string>>(new Set());
    const [input, setInput] = useState("");
    const [lightbox, setLightbox] = useState<string | null>(null);
    const [showActivity, setShowActivity] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const transport = useRef(new DefaultChatTransport({ api: BASE + "/api/chat" }));
    const { messages, sendMessage, status, stop, setMessages, regenerate, error } = useChat({
        transport: transport.current,
    });
    const scroller = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const [atBottom, setAtBottom] = useState(true);

    const onHandleDown = (e: React.MouseEvent) => {
        e.preventDefault();
        const onMove = (ev: MouseEvent) => (window as any).ui?.send?.("sidebar:resize", window.innerWidth - ev.movementX);
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    const copyText = (m: any) =>
        navigator.clipboard?.writeText(
            (m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"),
        );

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

    useEffect(() => {
        if (atBottom) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    }, [messages, atBottom]);

    const onScroll = () => {
        const el = scroller.current;
        if (!el) return;
        setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
    };

    const decide = (id: string, verdict: any) => {
        setDecided((s) => new Set(s).add(id));
        void post("/api/approve", { id, ...verdict });
    };

    const send = (text = input) => {
        const t = text.trim();
        if (!t) return;
        setInput("");
        void sendMessage({ text: t });
    };

    const newChat = () => {
        void post("/api/sessions/new").then(() => {
            setMessages([]);
            refreshState();
        });
    };

    // Keyboard shortcuts.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const mod = e.metaKey || e.ctrlKey;
            if (e.key === "Escape") {
                stop();
            } else if (mod && e.key.toLowerCase() === "k") {
                e.preventDefault();
                newChat();
            } else if (mod && e.key.toLowerCase() === "l") {
                e.preventDefault();
                inputRef.current?.focus();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
    const resume = (id: string) => {
        void post("/api/sessions/resume", { id })
            .then((r) => r.json())
            .then((d) => {
                setMessages(d.messages ?? []);
                refreshState();
            });
    };
    const del = (id: string) => void post("/api/sessions/delete", { id }).then(refreshState);

    const comps: CommandSpec[] = useMemo(() => completions(input), [input]);
    const busy = status === "streaming" || status === "submitted";
    const empty = messages.length === 0;
    const lastAssistantId = useMemo(
        () => [...messages].reverse().find((m: any) => m.role === "assistant")?.id,
        [messages],
    );
    const markerMap = useMemo(() => {
        const map: Record<string, MarkerData[]> = {};
        for (const m of messages as any[])
            for (const p of m.parts ?? [])
                if (p.type === "data-marker") (map[p.data.screenshotId] ??= []).push(p.data);
        return map;
    }, [messages]);

    return (
        <div className="app">
            <div className="resize-handle" onMouseDown={onHandleDown} title="Drag to resize" />
            <header className="hd">
                <div className="row">
                    <span className="title">
                        ✦ Agent <StatusPill state={serverState} />
                    </span>
                    <ContextMeter ctx={serverState?.context} />
                </div>
                <div className="toolbar">
                    <select
                        className="picker"
                        title="Model"
                        value={serverState?.model ?? ""}
                        onChange={(e) => post("/api/model", { model: e.target.value }).then(refreshState)}
                    >
                        {(serverState?.models ?? []).map((m) => (
                            <option key={m} value={m}>
                                {m}
                            </option>
                        ))}
                    </select>
                    <select
                        className="picker"
                        title="Review policy"
                        value={serverState?.policy ?? "risky-only"}
                        onChange={(e) => post("/api/policy", { policy: e.target.value }).then(refreshState)}
                    >
                        <option value="risky-only">Confirm risky</option>
                        <option value="review-all">Review all</option>
                        <option value="autorun-trusted">Autorun</option>
                    </select>
                    <span className="tspacer" />
                    <button className="iconbtn" title="Activity log" onClick={() => setShowActivity(true)}>
                        📋
                    </button>
                    <button className="iconbtn" title="Settings" onClick={() => setShowSettings(true)}>
                        ⚙
                    </button>
                    <SessionMenu state={serverState} onNew={newChat} onResume={resume} onDelete={del} />
                </div>
                {serverState && !serverState.loggedIn && (
                    <button className="signin" onClick={() => post("/api/login").then(refreshState)}>
                        Sign in with ChatGPT
                    </button>
                )}
                {serverState?.presence?.paused && (
                    <div className="banner paused">
                        <span>⏸ {serverState.presence.reason ?? "Paused"}</span>
                        <button onClick={() => post("/api/presence", { mode: "resume" }).then(refreshState)}>
                            Resume anyway
                        </button>
                    </div>
                )}
                {serverState?.goal && <div className="banner goal">🎯 {serverState.goal}</div>}
            </header>

            <div className="log" ref={scroller} onScroll={onScroll}>
                {empty && (
                    <div className="welcome">
                        <div className="wmark">✦</div>
                        <h2>Drive the machine</h2>
                        <p>Give the agent a task and watch it work on the KVM. Try:</p>
                        <div className="chips">
                            {SUGGESTIONS.map((s) => (
                                <button key={s} className="chip" onClick={() => send(s)}>
                                    {s}
                                </button>
                            ))}
                        </div>
                        <p className="hint">Type / for commands · gpt-5.5 on your ChatGPT subscription</p>
                    </div>
                )}
                {messages.map((m: any) => (
                    <div key={m.id} className={`msg ${m.role}`}>
                        {m.role === "assistant" && <div className="avatar">✦</div>}
                        <div className="bubble">
                            {(m.parts ?? []).map((p: any, i: number) => {
                                if (p.type === "text")
                                    return p.text ? (
                                        m.role === "user" ? (
                                            <span key={i}>{p.text}</span>
                                        ) : (
                                            <Markdown key={i} text={p.text} />
                                        )
                                    ) : null;
                                if (p.type === "data-thinking")
                                    return <Thinking key={i} text={p.data.text} done={p.data.done} />;
                                if (p.type === "data-screenshot")
                                    return (
                                        <Screenshot
                                            key={i}
                                            src={p.data.src}
                                            w={p.data.width}
                                            h={p.data.height}
                                            markers={markerMap[p.data.toolCallId] ?? []}
                                            onOpen={setLightbox}
                                        />
                                    );
                                if (p.type === "data-status")
                                    return (
                                        <div key={i} className={`status ${p.data.kind}`}>
                                            {p.data.text}
                                        </div>
                                    );
                                if (p.type === "data-auth") {
                                    const req: AuthRequest = p.data.request;
                                    if (decided.has(req.id))
                                        return (
                                            <div key={i} className="status">
                                                authorized
                                            </div>
                                        );
                                    return <AuthCard key={i} req={req} onDecide={(v) => decide(req.id, v)} />;
                                }
                                if (p.type === "dynamic-tool" || (typeof p.type === "string" && p.type.startsWith("tool-"))) {
                                    const name = p.toolName ?? p.type.replace("tool-", "");
                                    const summary =
                                        p.output && typeof p.output === "object" ? (p.output as any).summary : undefined;
                                    return <ToolCall key={i} name={name} state={p.state} input={p.input} summary={summary} />;
                                }
                                return null;
                            })}
                            {m.role === "assistant" && !busy && (
                                <div className="msg-actions">
                                    <button onClick={() => copyText(m)} title="Copy">
                                        ⧉
                                    </button>
                                    {m.id === lastAssistantId && (
                                        <button onClick={() => regenerate()} title="Regenerate">
                                            ↻
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                ))}
                {status === "submitted" && (
                    <div className="msg assistant">
                        <div className="avatar">✦</div>
                        <div className="bubble">
                            <div className="typing">
                                <span></span>
                                <span></span>
                                <span></span>
                            </div>
                        </div>
                    </div>
                )}
                {error && (
                    <div className="errcard">
                        <span>⚠ {error.message || "Something went wrong."}</span>
                        <button onClick={() => regenerate()}>Retry</button>
                    </div>
                )}
            </div>

            {!atBottom && (
                <button
                    className="scrolldown"
                    onClick={() => {
                        setAtBottom(true);
                        scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
                    }}
                >
                    ↓
                </button>
            )}

            {comps.length > 0 && (
                <div className="autocomplete">
                    {comps.map((c) => (
                        <div key={c.name} className="ac" onClick={() => setInput(`/${c.name} `)}>
                            <code>/{c.name}</code> <span className="acarg">{c.arg ?? ""}</span>
                            <span className="acs">{c.summary}</span>
                        </div>
                    ))}
                </div>
            )}

            <div className="composer">
                <textarea
                    ref={inputRef}
                    value={input}
                    placeholder="Give the agent a task…  (/ for commands)"
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            send();
                        }
                    }}
                />
                {busy ? (
                    <button className="stop" onClick={() => stop()} title="Stop">
                        ■
                    </button>
                ) : (
                    <button className="go" onClick={() => send()} title="Send">
                        ↑
                    </button>
                )}
            </div>

            {lightbox && (
                <div className="lightbox" onClick={() => setLightbox(null)}>
                    <img src={lightbox} alt="screen" />
                </div>
            )}

            {showActivity && <ActivityPanel state={serverState} onClose={() => setShowActivity(false)} />}
            {showSettings && (
                <SettingsPopover
                    state={serverState}
                    onClose={() => setShowSettings(false)}
                    onPatch={(p) => post("/api/settings", p).then(refreshState)}
                />
            )}
        </div>
    );
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
