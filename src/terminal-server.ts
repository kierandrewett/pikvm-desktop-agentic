/**
 * Server-hosted terminal sessions. PTYs live in the backend, not in any one client.
 * Every connected device (desktop WebContentsView,
 * mobile/web console) subscribes over the /_agent/terminal WebSocket and sees the SAME
 * tabs + live output, and can drive them (shared-tmux model). Whoever hosts the server owns
 * the sessions; they persist as long as the host runs.
 *
 * Output is buffered per session so a newly-connected client gets the current screen state
 * replayed. PTY size is authoritative on the server (last client resize wins) so all clients
 * render the same grid.
 */
import { PtyTerminal } from "./claude-pty";
import { basename, delimiter, join } from "node:path";

/** The sessions are plain login shells now (no agent kinds). */
type SessionKind = "shell";

const DEFAULT_KIND: SessionKind = "shell";

export interface TerminalSessionsDeps {
    /** The vault folder (cwd for every terminal session). */
    vaultPath: () => string;
    /** CONTROL_PORT — for the permcheck hook URL. */
    port: number;
    /** Prepare project-local config/wrappers before spawning the PTY (no-op now). */
    prepareAgent: (agent: SessionKind, sessionId: string) => void;
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
    agent: SessionKind;
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
    | { t: "create"; agent?: SessionKind }
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
    agent: SessionKind;
    title: string;
    term: PtyTerminal;
    buffer: string[];
    bufLen: number;
    exited: boolean;
}

const BUFFER_CAP = 256 * 1024; // bytes of recent output replayed to new clients

export class TerminalSessions {
    private sessions = new Map<string, Session>();
    private subs = new Set<Sub>();
    private subSizes = new Map<Sub, { cols: number; rows: number }>();
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
        // Track this client's viewport for the shared-size calc. A non-constraining default
        // (huge) until it reports, so a just-connected client doesn't shrink everyone.
        this.subSizes.set(send, { cols: 9999, rows: 9999 });
        send({ t: "sessions", sessions: this.list(), cols: this.cols, rows: this.rows, control: this.controlOwner });
        for (const s of this.sessions.values()) {
            const data = s.buffer.join("");
            if (data) send({ t: "data", id: s.id, data });
        }
        return () => {
            this.subs.delete(send);
            this.subSizes.delete(send);
            this.recomputeSize(); // a client left — the PTY may be able to grow again
        };
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
    create(agent: SessionKind = DEFAULT_KIND, forceId?: string): string {
        const id = forceId ?? "s" + ++this.counter;
        const existing = this.sessions.get(id);
        if (existing && existing.term.running) return id;
        try {
            this.deps.prepareAgent(agent, id);
        } catch (e) {
            console.error("[terminal] prepareAgent failed:", e);
        }
        // A plain interactive login shell (no agent / MCP wiring).
        const bin = process.env.SHELL || "/bin/bash";
        const args = ["-l"];
        const label = "shell";
        const fallbackTitle = basename(bin || label);
        const cwd = this.deps.vaultPath();
        const originalPath = process.env.PATH ?? "";
        const localBin = join(cwd, ".pikvm", "bin");
        const term = new PtyTerminal({
            cwd,
            bin,
            args,
            cols: this.cols,
            rows: this.rows,
            env: {
                PATH: `${localBin}${delimiter}${originalPath}`,
                PIKVM_ORIGINAL_PATH: originalPath,
                PIKVM_WORKSPACE: cwd,
                PIKVM_PERMCHECK_URL: `http://127.0.0.1:${this.deps.port}/_agent/api/permcheck`,
                PIKVM_SESSION_ID: id,
            },
        });
        const s: Session = existing
            ? Object.assign(existing, { term, agent, title: fallbackTitle, exited: false, buffer: [], bufLen: 0 })
            : { id, agent, title: fallbackTitle, term, buffer: [], bufLen: 0, exited: false };
        term.onData((d) => {
            this.append(s, d);
            this.broadcast({ t: "data", id, data: d });
        });
        term.onTitle((title) => {
            if (s.title === title) return;
            s.title = title;
            this.sendSessions();
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

    /** Ensure the always-present primary shell tab exists (called on first client / boot). */
    ensurePrimary(): void {
        if (!this.sessions.has("main")) this.create(DEFAULT_KIND, "main");
    }

    /** A client proposed a viewport size. The shared PTY is sized to the SMALLEST connected
     *  client (tmux-style) so no device gets its output truncated. */
    private resize(cols: number, rows: number, send: Sub): void {
        const c = Math.max(2, Math.floor(cols) || 0);
        const r = Math.max(2, Math.floor(rows) || 0);
        if (!c || !r) return;
        this.subSizes.set(send, { cols: c, rows: r });
        this.recomputeSize();
    }

    private recomputeSize(): void {
        let cols = 0;
        let rows = 0;
        for (const sz of this.subSizes.values()) {
            cols = cols ? Math.min(cols, sz.cols) : sz.cols;
            rows = rows ? Math.min(rows, sz.rows) : sz.rows;
        }
        if (!cols || !rows) return; // no real proposals yet — keep the current size
        cols = Math.max(20, Math.min(cols, 500));
        rows = Math.max(5, Math.min(rows, 200));
        if (cols === this.cols && rows === this.rows) return;
        this.cols = cols;
        this.rows = rows;
        for (const s of this.sessions.values()) s.term.resize(cols, rows);
        this.sendSessions();
    }

    /** Handle a frame from a client. */
    handle(msg: ClientMsg, send: Sub): void {
        switch (msg.t) {
            case "create":
                this.create(DEFAULT_KIND);
                break;
            case "input":
                this.sessions.get(msg.id)?.term.write(msg.data);
                break;
            case "resize":
                this.resize(msg.cols, msg.rows, send);
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
                else if (!s) this.create(DEFAULT_KIND, msg.id);
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
