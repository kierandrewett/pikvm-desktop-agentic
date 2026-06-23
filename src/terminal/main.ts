/**
 * Renderer for the shared Claude Code terminal (xterm.js). A pure WebSocket client of the
 * server-hosted sessions (/_agent/terminal) — the SAME code runs in the desktop
 * WebContentsView and the mobile/web console, so every device sees the same tabs + live
 * output and can drive them. The PTYs live on the server; this just renders + relays input.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

type AgentKind = "claude" | "codex" | "opencode";
interface SessionInfo {
    id: string;
    agent: AgentKind;
    title: string;
    exited: boolean;
}
type ServerMsg =
    | { t: "sessions"; sessions: SessionInfo[]; cols: number; rows: number; control: string | null }
    | { t: "data"; id: string; data: string }
    | { t: "exit"; id: string; code: number }
    | { t: "control"; owner: string | null }
    | { t: "image"; reqId: number; dataUrl: string | null };

const AGENT_LABELS: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", opencode: "opencode" };

const tabsEl = document.getElementById("tabs")!;
const termsEl = document.getElementById("terms")!;
const newTabBtn = document.getElementById("new-tab")!;

// ---- WebSocket transport ---------------------------------------------------------------
const wsUrl = (() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/_agent/terminal`;
})();
let ws: WebSocket | null = null;
let authCols = 120;
let authRows = 30;
const send = (msg: unknown): void => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};

// ---- image hover preview (shared) ------------------------------------------------------
const PATH_RE = /(?:~\/|\.{1,2}\/|\/)?(?:[\w.\-]+\/)*[\w.\-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/g;
const URL_RE = /\bhttps?:\/\/[^\s'"`()<>\]]+/g;
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

// readImage over the wire (host reads the file → data URL).
let imgReq = 0;
const imgPending = new Map<number, (d: string | null) => void>();
const readImage = (path: string): Promise<string | null> =>
    new Promise((resolve) => {
        const reqId = ++imgReq;
        imgPending.set(reqId, resolve);
        send({ t: "readImage", reqId, path });
        setTimeout(() => {
            if (imgPending.delete(reqId)) resolve(null);
        }, 4000);
    });

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
    void readImage(path).then((dataUrl) => {
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
                    range: { start: { x: f.index + 1, y: bufferLineNumber }, end: { x: f.index + f.length, y: bufferLineNumber } },
                    activate(event: MouseEvent) {
                        if (!(event.ctrlKey || event.metaKey)) return;
                        if (f.kind === "url") send({ t: "openLink", url: f.text });
                        else send({ t: "openPath", path: f.text });
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

// ---- views (one per server session) ----------------------------------------------------
interface View {
    id: string;
    agent: AgentKind;
    term: Terminal;
    fit: FitAddon;
    el: HTMLDivElement;
    tab: HTMLDivElement;
    label: HTMLSpanElement;
    exited: boolean;
}
const views = new Map<string, View>();
let active: string | null = null;
let controlOwner: string | null = null; // which session currently drives the KVM

const makeTerm = (): { term: Terminal; fit: FitAddon } => {
    const term = new Terminal({
        fontFamily: 'monospace, "Noto Sans Mono", "DejaVu Sans Mono"',
        fontSize: 13,
        lineHeight: 1.0,
        letterSpacing: 0,
        cursorBlink: true,
        scrollback: 8000,
        drawBoldTextInBrightColors: true,
        allowProposedApi: true,
        theme: { background: "#0a0a0c", foreground: "#ededf1", cursor: "#5b8cff", cursorAccent: "#0a0a0c", selectionBackground: "#2c3354" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    attachLinks(term);
    return { term, fit };
};

const paintTabs = (): void => {
    for (const v of views.values()) {
        v.tab.classList.toggle("active", v.id === active);
        v.tab.classList.toggle("exited", v.exited);
        v.tab.classList.toggle("controlling", v.id === controlOwner);
    }
};

const setActive = (id: string): void => {
    const v = views.get(id);
    if (!v) return;
    active = id;
    for (const o of views.values()) o.el.classList.toggle("active", o.id === id);
    paintTabs();
    v.term.resize(authCols, authRows);
    v.term.focus();
    proposeSize();
};

const createView = (info: SessionInfo): View => {
    const { term, fit } = makeTerm();
    const el = document.createElement("div");
    el.className = "term";
    termsEl.appendChild(el);
    term.open(el);
    term.resize(authCols, authRows);

    const tab = document.createElement("div");
    tab.className = "tab";
    tab.dataset.agent = info.agent;
    const dot = document.createElement("span");
    dot.className = "dot";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = info.title;
    const ctrl = document.createElement("span");
    ctrl.className = "ctrl";
    ctrl.title = "This agent currently controls the KVM (mouse/keyboard)";
    ctrl.textContent = "⌖";
    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "✕";
    tab.append(dot, label, ctrl, close);
    tabsEl.insertBefore(tab, newTabBtn);

    const v: View = { id: info.id, agent: info.agent, term, fit, el, tab, label, exited: info.exited };
    views.set(info.id, v);

    tab.addEventListener("mousedown", (e) => {
        if ((e.target as HTMLElement).classList.contains("close")) return;
        setActive(info.id);
    });
    close.addEventListener("click", (e) => {
        e.stopPropagation();
        send({ t: "close", id: info.id });
    });
    // Keystrokes → server PTY; once exited, Enter asks the server to restart it.
    term.onData((d) => {
        if (v.exited) {
            if (d === "\r" || d === "\n") send({ t: "restart", id: info.id });
            return;
        }
        send({ t: "input", id: info.id, data: d });
    });
    return v;
};

const removeView = (id: string): void => {
    const v = views.get(id);
    if (!v) return;
    v.term.dispose();
    v.el.remove();
    v.tab.remove();
    views.delete(id);
    if (active === id) {
        const next = views.keys().next().value as string | undefined;
        active = null;
        if (next) setActive(next);
    }
};

// Reconcile local views with the server's session list.
const reconcile = (sessions: SessionInfo[]): void => {
    const seen = new Set<string>();
    for (const info of sessions) {
        seen.add(info.id);
        let v = views.get(info.id);
        if (!v) v = createView(info);
        v.label.textContent = info.title;
        v.exited = info.exited;
    }
    for (const id of [...views.keys()]) if (!seen.has(id)) removeView(id);
    if (!active || !views.has(active)) {
        const first = views.keys().next().value as string | undefined;
        if (first) setActive(first);
    }
    paintTabs();
};

// ---- sizing (server authoritative; clients propose from their container) ----------------
const applyAuthSize = (cols: number, rows: number): void => {
    authCols = cols;
    authRows = rows;
    for (const v of views.values()) {
        if (v.term.cols !== cols || v.term.rows !== rows) v.term.resize(cols, rows);
    }
};
let sizeQueued = false;
const proposeSize = (): void => {
    if (sizeQueued) return;
    sizeQueued = true;
    requestAnimationFrame(() => {
        sizeQueued = false;
        const v = active ? views.get(active) : null;
        if (!v) return;
        const dims = v.fit.proposeDimensions();
        if (dims && dims.cols && dims.rows) send({ t: "resize", cols: dims.cols, rows: dims.rows });
    });
};

// ---- + picker --------------------------------------------------------------------------
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
            send({ t: "create", agent: a });
        });
        picker!.appendChild(it);
    });
    const r = newTabBtn.getBoundingClientRect();
    picker.style.left = Math.round(r.left) + "px";
    picker.style.top = Math.round(r.bottom + 4) + "px";
    document.body.appendChild(picker);
});
document.addEventListener("click", closePicker);

new ResizeObserver(proposeSize).observe(termsEl);
window.addEventListener("resize", proposeSize);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) proposeSize();
});

// ---- connect (with auto-reconnect) ------------------------------------------------------
const onMessage = (msg: ServerMsg): void => {
    switch (msg.t) {
        case "sessions":
            applyAuthSize(msg.cols, msg.rows);
            controlOwner = msg.control;
            reconcile(msg.sessions);
            break;
        case "control":
            controlOwner = msg.owner;
            paintTabs();
            break;
        case "data":
            views.get(msg.id)?.term.write(msg.data);
            break;
        case "exit": {
            const v = views.get(msg.id);
            if (v) {
                v.exited = true;
                paintTabs();
                v.term.write(`\r\n\x1b[90m[${AGENT_LABELS[v.agent]} exited (code ${msg.code}) — press Enter to restart]\x1b[0m\r\n`);
            }
            break;
        }
        case "image": {
            const resolve = imgPending.get(msg.reqId);
            if (resolve) {
                imgPending.delete(msg.reqId);
                resolve(msg.dataUrl);
            }
            break;
        }
    }
};

let reconnectTimer: number | undefined;
const connect = (): void => {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
        // On (re)connect, clear existing terms so the server's replayed buffer redraws clean.
        for (const v of views.values()) v.term.reset();
        proposeSize();
    };
    ws.onmessage = (ev) => {
        try {
            onMessage(JSON.parse(ev.data) as ServerMsg);
        } catch {
            /* ignore malformed */
        }
    };
    ws.onclose = () => {
        ws = null;
        if (reconnectTimer) return;
        reconnectTimer = window.setTimeout(() => {
            reconnectTimer = undefined;
            connect();
        }, 1000);
    };
    ws.onerror = () => ws?.close();
};
connect();
