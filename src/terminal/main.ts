/**
 * Renderer for the shared terminal (xterm.js). A pure WebSocket client of the
 * server-hosted sessions (/_agent/terminal) - the SAME code runs in the desktop
 * WebContentsView and the mobile/web console, so every device sees the same tabs + live
 * output and can drive them. The PTYs live on the server; this just renders + relays input.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

type SessionKind = "shell";
interface SessionInfo {
    id: string;
    agent: SessionKind;
    title: string;
    exited: boolean;
}
type ServerMsg =
    | { t: "sessions"; sessions: SessionInfo[]; cols: number; rows: number; control: string | null }
    | { t: "data"; id: string; data: string }
    | { t: "exit"; id: string; code: number }
    | { t: "control"; owner: string | null }
    | { t: "image"; reqId: number; dataUrl: string | null };

const tabsEl = document.getElementById("tabs")!;
const termsEl = document.getElementById("terms")!;
const newTabBtn = document.getElementById("new-tab") as HTMLButtonElement;
const statusEl = document.getElementById("term-status")!;

/* Say when the socket is down, and stop offering an action that cannot happen.
 *
 * send() drops anything written while the socket is not OPEN, so with the
 * terminal service unreachable New shell did exactly nothing: no tab, no
 * message, no error — and the reconnect loop below ran on unseen. Measured by
 * clicking it against a host with no terminal backend: the websocket opened and
 * failed, and the page still read "+" and nothing else.
 *
 * Every other surface in this app reports the same condition — the console's
 * chip reads "Live · input offline" when the HID socket drops, the conversation
 * says "Updates offline", the titlebar pill says "Agent unavailable". This was
 * the one that stayed quiet. */
const setLinkUp = (up: boolean): void => {
    newTabBtn.disabled = !up;
    statusEl.hidden = up;
    const text = up ? "" : "Terminal disconnected — reconnecting…";
    if (statusEl.textContent !== text) statusEl.textContent = text;
};
// Disabled until the first open, so the button never invites a click it would
// swallow. A healthy connection settles long before anyone reaches for it.
setLinkUp(false);

try {
    window.parent?.postMessage({ type: "chat-ready" }, "*");
} catch {
    /* top-level terminal; nothing to notify */
}

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
                        if (f.kind === "url") send({ t: "openLink", url: f.text });
                        else if (event.ctrlKey || event.metaKey) send({ t: "openPath", path: f.text });
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
    term: Terminal;
    fit: FitAddon;
    el: HTMLDivElement;
    tab: HTMLDivElement;
    label: HTMLSpanElement;
    exited: boolean;
}
const views = new Map<string, View>();

/* The terminal canvas is painted by xterm, not by CSS, so it does not follow
 * the page's tokens — it has to be told. Mirrors console.css both ways: without
 * this the page around the terminal went light and the terminal stayed black.
 * The console already posts its theme to this frame; nothing was listening. */
const XTERM_THEME = {
    dark: {
        background: "#0a0a0c",
        foreground: "#ededf1",
        cursor: "#5b8cff",
        cursorAccent: "#0a0a0c",
        selectionBackground: "#2c3354",
    },
    light: {
        background: "#eef0f4",
        foreground: "#17171c",
        cursor: "#3b6ef0",
        cursorAccent: "#eef0f4",
        /* Light enough that the foreground still reads through it: dark text on
         * this selection is 11.62:1. Keeping the dark theme's #2c3354 under
         * light-theme text would have been 1.45:1 — selected text invisible. */
        selectionBackground: "#c3d0f5",
    },
} as const;

const currentTheme = (): "dark" | "light" =>
    document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";

/** Repaint every open terminal, plus the page around them. */
const applyTheme = (theme: "dark" | "light"): void => {
    document.documentElement.setAttribute("data-theme", theme);
    for (const v of views.values()) {
        v.term.options.theme = XTERM_THEME[theme];
    }
};

/* Same channel and same origin check as the conversation frame uses. The
 * console is the only thing that can be our parent here. */
window.addEventListener("message", (e) => {
    if (e.source !== window.parent || e.origin !== window.location.origin) return;
    const d = e.data as { channel?: string; type?: string; value?: unknown } | null;
    if (!d || d.channel !== "pikvm-panel" || d.type !== "theme") return;
    applyTheme(d.value === "light" ? "light" : "dark");
});
/* Ask for the current theme rather than waiting for the next change: this frame
 * loads well after the console applied one. */
try {
    window.parent.postMessage({ channel: "pikvm-panel", type: "subscribe" }, window.location.origin);
} catch {
    /* no parent, or a cross-origin one: the dark default stands */
}

let active: string | null = null;
let controlOwner: string | null = null; // which session currently drives the KVM
let activateNextCreated = false;
let activateNextCreatedUntil = 0;
let knownIdsBeforeCreate = new Set<string>();

// System clipboard. Prefer the Electron bridge exposed by the terminal preload (works in
// the sandboxed WebContentsView regardless of permission prompts); fall back to the async
// Clipboard API on plain web / mobile.
const sysClipboard = {
    write(text: string): void {
        if (!text) return;
        const b = (window as unknown as { termClipboard?: { writeText(t: string): void } }).termClipboard;
        if (b?.writeText) {
            try { b.writeText(text); return; } catch { /* fall through */ }
        }
        void navigator.clipboard?.writeText(text).catch(() => {});
    },
    async read(): Promise<string> {
        const b = (window as unknown as { termClipboard?: { readText(): string } }).termClipboard;
        if (b?.readText) {
            try { return String(b.readText() ?? ""); } catch { /* fall through */ }
        }
        try { return (await navigator.clipboard?.readText()) ?? ""; } catch { return ""; }
    },
};

const DEFAULT_FONT_SIZE = 13;
let fontSize = DEFAULT_FONT_SIZE;
const makeTerm = (): { term: Terminal; fit: FitAddon } => {
    const term = new Terminal({
        fontFamily: 'ui-monospace, "SFMono-Regular", "Cascadia Mono", "Noto Sans Mono", "DejaVu Sans Mono", monospace',
        fontSize,
        // NOTE: lineHeight 1.0 made xterm's DOM renderer go BLANK for full-screen TUIs like
        // opencode (a beta quirk). 1.12 renders (block/box chars get faint gaps, but visible
        // beats blank). Crisp tiling needs the WebGL renderer on a matched addon/core pair.
        lineHeight: 1.12,
        letterSpacing: 0,
        cursorBlink: true,
        scrollback: 8000,
        drawBoldTextInBrightColors: true,
        allowProposedApi: true,
        // Enable the Kitty keyboard protocol (xterm.js 6.1+). xterm now ANSWERS Claude
        // Code's keyboard-protocol probe (killing the ~1s timeout that delayed backspace
        // after Shift+Enter) and lets it turn on enhanced reporting, so Shift+Enter,
        // Ctrl+Enter and multiline editing are disambiguated natively — exactly as they
        // are in Claude Code's "normal" (Kitty-capable) terminal. We no longer hand-encode
        // Shift+Enter; xterm emits the right CSI-u (when negotiated) or legacy bytes.
        vtExtensions: { kittyKeyboard: true },
        theme: XTERM_THEME[currentTheme()],
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
    v.term.focus();
    fitAndProposeSize();
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
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = info.title;
    label.title = info.title;
    const ctrl = document.createElement("span");
    ctrl.className = "ctrl";
    ctrl.title = "This terminal currently controls the KVM mouse/keyboard";
    ctrl.textContent = "ctl";
    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "✕";
    tab.append(label, ctrl, close);
    tabsEl.insertBefore(tab, newTabBtn);

    const v: View = { id: info.id, term, fit, el, tab, label, exited: info.exited };
    views.set(info.id, v);

    tab.addEventListener("mousedown", (e) => {
        if ((e.target as HTMLElement).classList.contains("close")) return;
        setActive(info.id);
    });
    close.addEventListener("click", (e) => {
        e.stopPropagation();
        send({ t: "close", id: info.id });
    });
    const pasteFromClipboard = (): void => {
        void sysClipboard.read().then((t) => { if (t && !v.exited) v.term.paste(t); });
    };
    // Right-click pastes (common terminal convention).
    el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); pasteFromClipboard(); });

    term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        // ── Copy / paste (Ctrl+C is left alone as SIGINT; use Ctrl+Shift+C to copy) ──
        const key = e.key.toLowerCase();
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (key === "c" || e.code === "KeyC")) {
            const sel = term.getSelection();
            if (sel) sysClipboard.write(sel);
            return false;
        }
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (key === "v" || e.code === "KeyV")) {
            pasteFromClipboard();
            return false;
        }
        // Ctrl+Insert = copy, Shift+Insert = paste (the other common bindings).
        if (e.key === "Insert" && e.ctrlKey && !e.shiftKey) {
            const sel = term.getSelection();
            if (sel) sysClipboard.write(sel);
            return false;
        }
        if (e.key === "Insert" && e.shiftKey && !e.ctrlKey) {
            pasteFromClipboard();
            return false;
        }
        // Ctrl+Backspace → delete the previous WORD (xterm otherwise sends a plain DEL,
        // deleting one char). ESC+DEL is readline's backward-kill-word.
        if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "Backspace" || e.code === "Backspace")) {
            if (!v.exited) send({ t: "input", id: info.id, data: "\x1b\x7f" });
            return false; // we handled it; don't let xterm send a plain backspace
        }
        // Shift+Enter is now handled natively by xterm.js's Kitty keyboard protocol
        // (vtExtensions.kittyKeyboard) — xterm emits the disambiguated CSI-u sequence when
        // Claude Code has enabled enhanced reporting, or a plain "\r" otherwise. No
        // hand-encoding here (which would have sent CSI-u even to non-Kitty programs).
        return true;
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
    let requestedNewId: string | null = null;
    for (const info of sessions) {
        seen.add(info.id);
        let v = views.get(info.id);
        if (!v) {
            v = createView(info);
            if (activateNextCreated && Date.now() <= activateNextCreatedUntil && !knownIdsBeforeCreate.has(info.id)) requestedNewId = info.id;
        }
        // A restart (exited → running) begins a fresh screen on the server (its buffer was
        // cleared). Reset the terminal so the new session doesn't stack underneath the dead
        // one's exit/resume output.
        if (v.exited && !info.exited) v.term.reset();
        v.label.textContent = info.title;
        v.label.title = info.title;
        v.exited = info.exited;
    }
    for (const id of [...views.keys()]) if (!seen.has(id)) removeView(id);
    if (requestedNewId) {
        activateNextCreated = false;
        knownIdsBeforeCreate.clear();
        setActive(requestedNewId);
    } else if (!active || !views.has(active)) {
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
const fitAndProposeSize = (): void => {
    if (sizeQueued) return;
    sizeQueued = true;
    requestAnimationFrame(() => {
        sizeQueued = false;
        const v = active ? views.get(active) : null;
        if (!v) return;
        const dims = v.fit.proposeDimensions();
        if (!dims || !dims.cols || !dims.rows) return;
        if (v.term.cols !== dims.cols || v.term.rows !== dims.rows) v.term.resize(dims.cols, dims.rows);
        send({ t: "resize", cols: dims.cols, rows: dims.rows });
    });
};

const requestNewSession = (): void => {
    activateNextCreated = true;
    activateNextCreatedUntil = Date.now() + 5000;
    knownIdsBeforeCreate = new Set(views.keys());
    send({ t: "create" });
};

newTabBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    requestNewSession();
});
window.addEventListener("message", (e) => {
    const d = e.data;
    if (d && d.type === "agent-action" && d.action === "new") requestNewSession();
    else if (d && d.type === "terminal-fit") fitAndProposeSize();
});

// Ctrl/Cmd +/-/0 must NOT page-zoom (that breaks the xterm layout). Map them to the
// terminal FONT SIZE instead — a real, layout-safe zoom that re-fits cleanly.
const applyFontSize = (next: number): void => {
    fontSize = Math.max(8, Math.min(28, Math.round(next)));
    for (const v of views.values()) v.term.options.fontSize = fontSize;
    fitAndProposeSize();
};
window.addEventListener(
    "keydown",
    (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        if (e.key === "+" || e.key === "=") {
            e.preventDefault();
            applyFontSize(fontSize + 1);
        } else if (e.key === "-" || e.key === "_") {
            e.preventDefault();
            applyFontSize(fontSize - 1);
        } else if (e.key === "0") {
            e.preventDefault();
            applyFontSize(DEFAULT_FONT_SIZE);
        }
    },
    true, // capture, so we beat any default zoom handling
);
// Block wheel-zoom (Ctrl+scroll) too — same layout-breakage.
window.addEventListener(
    "wheel",
    (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            applyFontSize(fontSize + (e.deltaY < 0 ? 1 : -1));
        }
    },
    { passive: false, capture: true },
);

new ResizeObserver(fitAndProposeSize).observe(termsEl);
window.addEventListener("resize", fitAndProposeSize);
(window as unknown as { __pikvmTerminalFit?: () => void }).__pikvmTerminalFit = fitAndProposeSize;
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) fitAndProposeSize();
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
                v.term.write(`\r\n\x1b[90m[Shell exited (code ${msg.code}) - press Enter to restart]\x1b[0m\r\n`);
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
        setLinkUp(true);
        // On (re)connect, clear existing terms so the server's replayed buffer redraws clean.
        for (const v of views.values()) v.term.reset();
        fitAndProposeSize();
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
        setLinkUp(false);
        if (reconnectTimer) return;
        reconnectTimer = window.setTimeout(() => {
            reconnectTimer = undefined;
            connect();
        }, 1000);
    };
    ws.onerror = () => ws?.close();
};
connect();
