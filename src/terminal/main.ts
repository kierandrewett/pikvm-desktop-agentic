/**
 * Renderer for the embedded Claude Code terminals (xterm.js). Hosts a tab bar over N
 * independent sessions — each tab is its own `claude` PTY in the main process (only one
 * may drive the KVM at a time; that lease is enforced server-side). Wires every session
 * to the main-process PTY via window.desktopTerminal (preload-terminal.ts), keyed by id.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

type AgentKind = "claude" | "codex" | "opencode";
type DesktopTerminal = {
    start: (id: string, agent?: AgentKind) => Promise<{ ok: boolean; reason?: string }>;
    write: (id: string, data: string) => void;
    resize: (id: string, cols: number, rows: number) => void;
    kill: (id: string) => void;
    setActive: (id: string) => void;
    onData: (cb: (id: string, data: string) => void) => () => void;
    onExit: (cb: (id: string, info: { code: number; signal?: number }) => void) => () => void;
    onRelayout: (cb: () => void) => () => void;
    openLink: (url: string) => void;
    openPath: (path: string) => void;
    readImage: (path: string) => Promise<string | null>;
};

const dt = (window as unknown as { desktopTerminal?: DesktopTerminal }).desktopTerminal;
const tabsEl = document.getElementById("tabs")!;
const termsEl = document.getElementById("terms")!;
const newTabBtn = document.getElementById("new-tab")!;

if (!dt) {
    termsEl.innerHTML = '<div style="padding:12px;color:#ff6b6b">Terminal bridge unavailable (no preload).</div>';
} else {
    const dtt = dt; // non-null for closures

    // ---- shared image hover preview (one popup for all sessions) ----------------------
    const URL_RE = /\bhttps?:\/\/[^\s'"`()<>\]]+/g;
    const PATH_RE = /(?:~\/|\.{1,2}\/|\/)?(?:[\w.\-]+\/)*[\w.\-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/g;
    const IMG_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?::\d+(?::\d+)?)?$/i;
    const stripTrail = (s: string) => s.replace(/[.,;)\]]+$/, "");
    type Found = { index: number; length: number; text: string; kind: "url" | "path" };
    const findLinks = (line: string): Found[] => {
        const out: Found[] = [];
        const taken: Array<[number, number]> = [];
        let m: RegExpExecArray | null;
        URL_RE.lastIndex = 0;
        while ((m = URL_RE.exec(line))) {
            const t = stripTrail(m[0]);
            if (t.length < 8) continue;
            out.push({ index: m.index, length: t.length, text: t, kind: "url" });
            taken.push([m.index, m.index + t.length]);
        }
        PATH_RE.lastIndex = 0;
        while ((m = PATH_RE.exec(line))) {
            const s = m.index;
            const e = m.index + m[0].length;
            if (taken.some((r) => s < r[1] && e > r[0])) continue;
            const t = stripTrail(m[0]);
            if (t.length < 3) continue;
            out.push({ index: s, length: t.length, text: t, kind: "path" });
        }
        return out;
    };
    const preview = document.createElement("div");
    preview.style.cssText =
        "position:fixed;z-index:9999;display:none;pointer-events:none;padding:4px;background:#0a0a0c;border:1px solid #2a3550;border-radius:8px;box-shadow:0 10px 34px rgba(0,0,0,.6)";
    const previewImg = document.createElement("img");
    previewImg.style.cssText = "display:block;max-width:480px;max-height:420px;border-radius:4px";
    preview.appendChild(previewImg);
    document.body.appendChild(preview);
    let previewToken = 0;
    const showPreview = (path: string, ev: MouseEvent) => {
        const mine = ++previewToken;
        void dtt.readImage(path).then((dataUrl) => {
            if (mine !== previewToken || !dataUrl) return;
            previewImg.src = dataUrl;
            preview.style.display = "block";
            const x = (ev?.clientX ?? 20) + 16;
            const y = (ev?.clientY ?? 20) + 16;
            preview.style.left = Math.max(8, Math.min(x, window.innerWidth - 500)) + "px";
            preview.style.top = Math.max(8, Math.min(y, window.innerHeight - 440)) + "px";
        });
    };
    const hidePreview = () => {
        previewToken++;
        preview.style.display = "none";
        previewImg.removeAttribute("src");
    };
    const attachLinks = (term: Terminal): void => {
        term.registerLinkProvider({
            provideLinks(bufferLineNumber, callback) {
                const line = term.buffer.active.getLine(bufferLineNumber - 1);
                if (!line) return callback(undefined);
                const found = findLinks(line.translateToString(true));
                if (!found.length) return callback(undefined);
                callback(
                    found.map((f) => ({
                        text: f.text,
                        range: {
                            start: { x: f.index + 1, y: bufferLineNumber },
                            end: { x: f.index + f.length, y: bufferLineNumber },
                        },
                        activate(event: MouseEvent) {
                            if (!(event.ctrlKey || event.metaKey)) return; // ctrl/cmd+click only
                            if (f.kind === "url") dtt.openLink(f.text);
                            else dtt.openPath(f.text);
                        },
                        hover(event: MouseEvent) {
                            if (f.kind === "path" && IMG_RE.test(f.text)) showPreview(f.text, event);
                        },
                        leave: hidePreview,
                    })),
                );
            },
        });
    };

    // ---- sessions ---------------------------------------------------------------------
    type Session = {
        id: string;
        agent: AgentKind;
        term: Terminal;
        fit: FitAddon;
        el: HTMLDivElement;
        tab: HTMLDivElement;
        label: HTMLSpanElement;
        exited: boolean;
    };
    const AGENT_LABELS: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", opencode: "opencode" };
    const sessions = new Map<string, Session>();
    let active: string | null = null;
    let counter = 0;

    const makeTerm = (): { term: Terminal; fit: FitAddon } => {
        const term = new Terminal({
            // The user's system monospace (fontconfig generic → e.g. Noto Sans Mono).
            fontFamily: 'monospace, "Noto Sans Mono", "DejaVu Sans Mono"',
            fontSize: 13,
            lineHeight: 1.0,
            letterSpacing: 0,
            cursorBlink: true,
            scrollback: 8000,
            drawBoldTextInBrightColors: true,
            allowProposedApi: true,
            // Matches the app's design tokens (console.css).
            theme: { background: "#0a0a0c", foreground: "#ededf1", cursor: "#5b8cff", cursorAccent: "#0a0a0c", selectionBackground: "#2c3354" },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        attachLinks(term);
        return { term, fit };
    };

    const syncActive = (): void => {
        if (!active) return;
        const s = sessions.get(active);
        if (!s) return;
        const beforeCols = s.term.cols;
        const beforeRows = s.term.rows;
        try {
            s.fit.fit(); // a no-op in xterm if the proposed dims are unchanged
        } catch {
            /* not laid out yet */
        }
        // Only notify the PTY when the grid actually changed — avoids a feedback loop where
        // a resize triggers the ResizeObserver which fits which resizes…
        if (s.term.cols !== beforeCols || s.term.rows !== beforeRows) dtt.resize(s.id, s.term.cols, s.term.rows);
    };
    // rAF-debounced so a burst of ResizeObserver/window-resize ticks collapses into one fit
    // per frame (the loop-warning flood otherwise).
    let syncQueued = false;
    const scheduleSync = (): void => {
        if (syncQueued) return;
        syncQueued = true;
        requestAnimationFrame(() => {
            syncQueued = false;
            syncActive();
        });
    };

    const paintTabs = (): void => {
        for (const s of sessions.values()) {
            s.tab.classList.toggle("active", s.id === active);
            s.tab.classList.toggle("exited", s.exited);
        }
    };

    const setActive = (id: string): void => {
        const s = sessions.get(id);
        if (!s) return;
        active = id;
        for (const o of sessions.values()) o.el.classList.toggle("active", o.id === id);
        dtt.setActive(id);
        paintTabs();
        syncActive();
        s.term.focus();
    };

    const launch = (s: Session): void => {
        s.exited = false;
        paintTabs();
        s.term.write(`\x1b[90mStarting ${AGENT_LABELS[s.agent]}…\x1b[0m\r\n`);
        void dtt.start(s.id, s.agent).then((r) => {
            if (!r?.ok) {
                s.exited = true;
                paintTabs();
                s.term.write(`\r\n\x1b[31mFailed to start ${AGENT_LABELS[s.agent]}: ${r?.reason ?? "unknown"}\x1b[0m\r\n\x1b[90mPress Enter to retry.\x1b[0m\r\n`);
            }
            if (s.id === active) syncActive();
            s.term.focus();
        });
    };

    const closeSession = (id: string): void => {
        const s = sessions.get(id);
        if (!s) return;
        dtt.kill(id);
        s.term.dispose();
        s.el.remove();
        s.tab.remove();
        sessions.delete(id);
        if (active === id) {
            const next = sessions.keys().next().value as string | undefined;
            if (next) setActive(next);
            else openAgent("claude"); // never leave zero tabs
        }
    };

    function newSession(agent: AgentKind, forceId?: string): Session {
        const id = forceId ?? "tab" + ++counter;
        const n = sessions.size + 1;
        const { term, fit } = makeTerm();

        const el = document.createElement("div");
        el.className = "term";
        termsEl.appendChild(el);
        term.open(el);

        const tab = document.createElement("div");
        tab.className = "tab";
        tab.dataset.agent = agent;
        const dot = document.createElement("span");
        dot.className = "dot";
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = AGENT_LABELS[agent] + " " + n;
        const close = document.createElement("span");
        close.className = "close";
        close.textContent = "✕";
        tab.append(dot, label, close);
        tabsEl.insertBefore(tab, newTabBtn);

        const s: Session = { id, agent, term, fit, el, tab, label, exited: false };
        sessions.set(id, s);

        tab.addEventListener("mousedown", (e) => {
            if ((e.target as HTMLElement).classList.contains("close")) return;
            setActive(id);
        });
        close.addEventListener("click", (e) => {
            e.stopPropagation();
            closeSession(id);
        });
        // Keystrokes → that session's PTY; once exited, Enter relaunches it.
        term.onData((d) => {
            if (s.exited) {
                if (d === "\r" || d === "\n") launch(s);
                return;
            }
            dtt.write(id, d);
        });

        return s;
    }

    // Route PTY output / exit to the owning session.
    dtt.onData((id, d) => sessions.get(id)?.term.write(d));
    dtt.onExit((id, info) => {
        const s = sessions.get(id);
        if (!s) return;
        s.exited = true;
        paintTabs();
        s.term.write(`\r\n\x1b[90m[${AGENT_LABELS[s.agent]} exited (code ${info.code}) — press Enter to restart]\x1b[0m\r\n`);
    });

    const openAgent = (agent: AgentKind): void => {
        const s = newSession(agent);
        setActive(s.id);
        launch(s);
    };

    // The + button opens a small picker so each tab can be a different agent.
    let picker: HTMLDivElement | null = null;
    const closePicker = (): void => {
        picker?.remove();
        picker = null;
    };
    newTabBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (picker) return closePicker();
        picker = document.createElement("div");
        picker.className = "agent-picker";
        (["claude", "codex", "opencode"] as AgentKind[]).forEach((a) => {
            const it = document.createElement("div");
            it.className = "agent-item";
            it.dataset.agent = a;
            it.textContent = AGENT_LABELS[a];
            it.addEventListener("click", () => {
                closePicker();
                openAgent(a);
            });
            picker!.appendChild(it);
        });
        const r = newTabBtn.getBoundingClientRect();
        picker.style.left = Math.round(r.left) + "px";
        picker.style.top = Math.round(r.bottom + 4) + "px";
        document.body.appendChild(picker);
    });
    document.addEventListener("click", closePicker);
    // One observer on the container (not per-session); rAF-debounced so fit()'s own layout
    // nudge doesn't re-trigger it into a loop.
    new ResizeObserver(scheduleSync).observe(termsEl);
    window.addEventListener("resize", scheduleSync);
    // Main fires relayout when the floating view first shows / resizes — the initial fit can
    // run while the view is hidden (0-sized), leaving the terminal at xterm's 120×30 default
    // and overflowing the panel with scrollbars. Re-fit then (and shortly after, for layout).
    dtt.onRelayout(() => {
        scheduleSync();
        setTimeout(scheduleSync, 60);
    });

    // The primary tab is "main" (Claude) — main's did-finish-load safety net targets that id,
    // so it starts even if this script is throttled. We create the tab + listeners, then launch.
    const first = newSession("claude", "main");
    setActive("main");
    launch(first);
}
