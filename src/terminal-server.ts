/**
 * Server-hosted terminal sessions — the Claude Code (and codex/opencode) PTYs live HERE,
 * in the backend, not in any one client. Every connected device (desktop WebContentsView,
 * mobile/web console) subscribes over the /_agent/terminal WebSocket and sees the SAME
 * tabs + live output, and can drive them (shared-tmux model). Whoever hosts the server owns
 * the sessions; they persist as long as the host runs.
 *
 * Output is buffered per session so a newly-connected client gets the current screen state
 * replayed. PTY size is authoritative on the server (last client resize wins) so all clients
 * render the same grid.
 */
import { ClaudeTerminal } from "./claude-pty";
import { buildAgentSpec, AGENT_LABELS, type AgentKind } from "./agents";

const isAgent = (a: unknown): a is AgentKind => a === "claude" || a === "codex" || a === "opencode";

export interface TerminalSessionsDeps {
    /** The vault folder (cwd for every agent). */
    vaultPath: () => string;
    /** CONTROL_PORT — for the per-session MCP URL + the permcheck hook URL. */
    port: number;
    /** Write the agent's config for this session BEFORE it spawns (claude .mcp.json+hook,
     *  opencode opencode.json; codex needs none — it's injected via launch args). */
    prepareAgent: (agent: AgentKind, sessionId: string) => void;
    /** Called when a session's PTY exits (e.g. release its KVM control lease). */
    onSessionExit?: (sessionId: string) => void;
    /** Read an image file (resolved against the vault) → data URL, host-side. */
    resolveImage?: (path: string) => string | null;
    /** Open a path / URL on the HOST (the machine running the server). */
    openPath?: (path: string) => void;
    openExternal?: (url: string) => void;
}

export interface SessionInfo {
    id: string;
    agent: AgentKind;
    title: string;
    exited: boolean;
}

/** Frames the server pushes to clients. */
type ServerMsg =
    | { t: "sessions"; sessions: SessionInfo[]; cols: number; rows: number; control: string | null }
    | { t: "data"; id: string; data: string }
    | { t: "exit"; id: string; code: number }
    | { t: "control"; owner: string | null }
    | { t: "image"; reqId: number; dataUrl: string | null };

/** Frames clients send. */
export type ClientMsg =
    | { t: "create"; agent?: AgentKind }
    | { t: "input"; id: string; data: string }
    | { t: "resize"; cols: number; rows: number }
    | { t: "close"; id: string }
    | { t: "restart"; id: string }
    | { t: "openPath"; path: string }
    | { t: "openLink"; url: string }
    | { t: "readImage"; reqId: number; path: string };

type Sub = (msg: ServerMsg) => void;

interface Session {
    id: string;
    agent: AgentKind;
    title: string;
    term: ClaudeTerminal;
    buffer: string[];
    bufLen: number;
    exited: boolean;
}

const BUFFER_CAP = 256 * 1024; // bytes of recent output replayed to new clients

export class TerminalSessions {
    private sessions = new Map<string, Session>();
    private subs = new Set<Sub>();
    private counter = 0;
    private cols = 120;
    private rows = 30;
    private controlOwner: string | null = null;

    constructor(private deps: TerminalSessionsDeps) {}

    /** Update the KVM control holder (from the runner lease) and tell every client live, so
     *  the UI can badge whichever tab is currently driving the machine. */
    setControlOwner(owner: string | null): void {
        if (this.controlOwner === owner) return;
        this.controlOwner = owner;
        this.broadcast({ t: "control", owner });
    }

    list(): SessionInfo[] {
        return [...this.sessions.values()].map((s) => ({ id: s.id, agent: s.agent, title: s.title, exited: s.exited }));
    }

    /** Subscribe a client; immediately sends the tab list + replays each session's buffer. */
    subscribe(send: Sub): () => void {
        this.subs.add(send);
        send({ t: "sessions", sessions: this.list(), cols: this.cols, rows: this.rows, control: this.controlOwner });
        for (const s of this.sessions.values()) {
            const data = s.buffer.join("");
            if (data) send({ t: "data", id: s.id, data });
        }
        return () => this.subs.delete(send);
    }

    private broadcast(msg: ServerMsg): void {
        for (const send of this.subs) {
            try {
                send(msg);
            } catch {
                /* a dead socket — its close handler will unsubscribe it */
            }
        }
    }

    private sendSessions(): void {
        this.broadcast({ t: "sessions", sessions: this.list(), cols: this.cols, rows: this.rows, control: this.controlOwner });
    }

    private append(s: Session, data: string): void {
        s.buffer.push(data);
        s.bufLen += data.length;
        while (s.bufLen > BUFFER_CAP && s.buffer.length > 1) {
            s.bufLen -= s.buffer.shift()!.length;
        }
    }

    /** Spawn a new session, or re-spawn an exited one with the same id (keeping its tab). */
    create(agent: AgentKind = "claude", forceId?: string): string {
        const id = forceId ?? "s" + ++this.counter;
        const existing = this.sessions.get(id);
        if (existing && existing.term.running) return id;
        try {
            this.deps.prepareAgent(agent, id);
        } catch (e) {
            console.error("[terminal] prepareAgent failed:", e);
        }
        const spec = buildAgentSpec(agent, { sessionId: id, port: this.deps.port });
        const n = existing ? 0 : [...this.sessions.values()].filter((s) => s.agent === agent).length + 1;
        const term = new ClaudeTerminal({
            cwd: this.deps.vaultPath(),
            bin: spec.bin,
            args: spec.args,
            cols: this.cols,
            rows: this.rows,
            env: {
                PIKVM_PERMCHECK_URL: `http://127.0.0.1:${this.deps.port}/_agent/api/permcheck`,
                PIKVM_SESSION_ID: id,
            },
        });
        const s: Session = existing
            ? Object.assign(existing, { term, agent, exited: false, buffer: [], bufLen: 0 })
            : { id, agent, title: `${AGENT_LABELS[agent]} ${n}`, term, buffer: [], bufLen: 0, exited: false };
        term.onData((d) => {
            this.append(s, d);
            this.broadcast({ t: "data", id, data: d });
        });
        term.onExit((info) => {
            s.exited = true; // keep the tab so clients can restart it
            this.deps.onSessionExit?.(id);
            this.broadcast({ t: "exit", id, code: info.code });
            this.sendSessions();
        });
        this.sessions.set(id, s);
        term.start();
        this.sendSessions();
        return id;
    }

    /** Ensure the always-present primary tab exists (called on first client / boot). */
    ensurePrimary(): void {
        if (!this.sessions.has("main")) this.create("claude", "main");
    }

    private resize(cols: number, rows: number): void {
        const c = Math.max(2, Math.floor(cols) || this.cols);
        const r = Math.max(2, Math.floor(rows) || this.rows);
        if (c === this.cols && r === this.rows) return;
        this.cols = c;
        this.rows = r;
        for (const s of this.sessions.values()) s.term.resize(c, r);
        this.sendSessions();
    }

    /** Handle a frame from a client. */
    handle(msg: ClientMsg, send: Sub): void {
        switch (msg.t) {
            case "create":
                this.create(isAgent(msg.agent) ? msg.agent : "claude");
                break;
            case "input":
                this.sessions.get(msg.id)?.term.write(msg.data);
                break;
            case "resize":
                this.resize(msg.cols, msg.rows);
                break;
            case "close": {
                const s = this.sessions.get(msg.id);
                if (s) {
                    s.term.kill();
                    this.sessions.delete(msg.id);
                    this.sendSessions();
                }
                break;
            }
            case "restart": {
                const s = this.sessions.get(msg.id);
                if (s && !s.term.running) this.create(s.agent, msg.id);
                else if (!s) this.create("claude", msg.id);
                break;
            }
            case "openPath":
                if (typeof msg.path === "string") this.deps.openPath?.(msg.path);
                break;
            case "openLink":
                if (typeof msg.url === "string") this.deps.openExternal?.(msg.url);
                break;
            case "readImage":
                send({ t: "image", reqId: msg.reqId, dataUrl: typeof msg.path === "string" ? (this.deps.resolveImage?.(msg.path) ?? null) : null });
                break;
        }
    }

    /** Type a line + Enter into a session (e.g. a tapped suggestion). */
    submitLine(id: string, text: string): void {
        this.sessions.get(id)?.term.submitLine(text);
    }

    /** The active/primary session id (for run-task routing). */
    primaryId(): string {
        return this.sessions.has("main") ? "main" : (this.sessions.keys().next().value as string) ?? "main";
    }

    killAll(): void {
        for (const s of this.sessions.values()) s.term.kill();
        this.sessions.clear();
    }
}
