/**
 * Renderer for the shared terminal (xterm.js). A pure WebSocket client of the
 * server-hosted sessions (/_agent/terminal) - the SAME code runs in the desktop
 * WebContentsView and the mobile/web console, so every device sees the same tabs + live
 * output and can drive them. The PTYs live on the server; this just renders + relays input.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

// One declaration of the wire, shared with the server. See terminal-protocol.ts.
import type { SessionInfo, ServerMsg } from "../terminal-protocol";


const tabsEl = document.getElementById("tablist")!;
const termsEl = document.getElementById("terms")!;
const newTabBtn = document.getElementById("new-tab") as HTMLButtonElement;
const statusEl = document.getElementById("term-status")!;
const hintEl = document.getElementById("term-hint")!;

/* How the escape hatch is advertised. WCAG 2.1.2 allows a non-standard way out
 * of a trap only if the user is told about it, and neither audience can guess
 * "Escape then Tab": screen readers get it from aria-describedby on the helper
 * textarea, sighted keyboard users get the same words in the tab strip.
 *
 * Only when focus arrived from the keyboard, though. Someone who clicked into
 * the terminal was never stuck — they can click straight back out — and a
 * standing line of advice above a shell you are working in is noise. */
const ESCAPE_HATCH_MS = 1500;

/* Keep the selected tab visible after anything resizes the strip.
 *
 * The tabs scroll inside their own region, so whatever else appears on that row
 * takes width from them. setActive scrolled the tab into view and then focused
 * the terminal, which raised the hint, which shrank the strip by 178px and put
 * the tab straight back out of sight — measured with twelve shells open: the
 * selected tab sat at 266..355 against a strip ending at 173.
 *
 * A function declaration on purpose: setLinkUp calls this before the view state
 * below is initialised, and only a hoisted binding survives that. The work is
 * deferred to a frame anyway, both to let the layout change land first and
 * because by then the views map exists. */
/* Mark whichever edges the tabs continue past.
 *
 * The strip scrolls but hides its scrollbar on both engines, so without this a
 * strip wider than its room ended at a hard edge that reads as finished rather
 * than cut. Measured with eight shells at 420px - the terminal column on a
 * phone - 372px of tabs off the right and nothing saying so. Same two classes
 * and the same 2px dead zone as the console's drawer and macro strip. */
function paintTabOverflow(): void {
    const max = tabsEl.scrollWidth - tabsEl.clientWidth;
    tabsEl.classList.toggle("more-before", max > 2 && tabsEl.scrollLeft > 2);
    tabsEl.classList.toggle("more-after", max > 2 && tabsEl.scrollLeft < max - 2);
}
tabsEl.addEventListener("scroll", paintTabOverflow, { passive: true });
window.addEventListener("resize", paintTabOverflow);
/* Tabs open and close without either of those firing, and the fade has to
 * follow the strip's width rather than only the ways a user can move it. */
if (typeof ResizeObserver !== "undefined") new ResizeObserver(paintTabOverflow).observe(tabsEl);

function revealActiveTab(): void {
    requestAnimationFrame(() => {
        const v = active ? views.get(active) : null;
        v?.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
        // scrollIntoView moves the strip, and a scroll event does not always
        // follow a programmatic one in time to repaint before the frame.
        paintTabOverflow();
    });
}
let cameByKeyboard = false;
document.addEventListener("keydown", () => { cameByKeyboard = true; }, true);
document.addEventListener("mousedown", () => { cameByKeyboard = false; }, true);
let hintTimer: number | undefined;
const showEscapeHint = (on: boolean): void => {
    window.clearTimeout(hintTimer);
    // The disconnect notice is the more urgent thing and shares this row.
    hintEl.hidden = !on || !statusEl.hidden;
    revealActiveTab();
    if (on) hintTimer = window.setTimeout(() => { hintEl.hidden = true; }, 6000);
};

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
    // They share the row, and losing the socket outranks advice about focus.
    // Without this the hint stayed up alongside the notice and the two together
    // squeezed the tab strip to nothing.
    if (!up) showEscapeHint(false);
    const text = up ? "" : "Terminal disconnected — reconnecting…";
    if (statusEl.textContent !== text) statusEl.textContent = text;
    // The row can be narrower than the sentence; the tooltip keeps all of it.
    if (statusEl.title !== text) statusEl.title = text;
    // The notice takes its width from the tabs, same as the hint does.
    revealActiveTab();
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
    close: HTMLButtonElement;
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

/* System clipboard.
 *
 * The bridge below is currently never present, and the fallback is the only
 * live path. src/preload-terminal.ts exposed `termClipboard` for a terminal
 * that ran in its own WebContentsView; the terminal is an iframe in the console
 * now, and an iframe cannot carry a preload — those attach to a view, not to a
 * frame. The preload was still being built (the build discovers preloads rather
 * than listing them) but no window ever loaded it, so it has been deleted.
 *
 * The check stays because it costs nothing and says what would be needed if a
 * native terminal view ever comes back. What it does NOT do is work today, and
 * that matters: the preload's own note was that navigator.clipboard.readText()
 * is unreliable behind Electron's permission model, which is exactly what this
 * now depends on. Worth checking paste in the packaged app — see TODO.md. */
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

/* Name the tab and its close button.
 *
 * The tab strip was three unlabelled divs to a screen reader: "shell s1" came
 * from a span, the close control was the bare glyph "✕", and the state a
 * sighted user reads from colour — which one is live, which one holds the KVM
 * lease, which one has exited — was in class names only. Say all of it. */
const nameTab = (v: View, title: string): void => {
    const state = v.exited ? " (exited)" : v.id === controlOwner ? " (has KVM control)" : "";
    v.tab.setAttribute("aria-label", `${title}${state}`);
    v.close.setAttribute("aria-label", `Close ${title}`);
    v.close.title = `Close ${title}`;
};

const paintTabs = (): void => {
    for (const v of views.values()) {
        const on = v.id === active;
        v.tab.classList.toggle("active", on);
        v.tab.classList.toggle("exited", v.exited);
        v.tab.classList.toggle("controlling", v.id === controlOwner);
        v.tab.setAttribute("aria-selected", String(on));
        // Roving tabindex: the strip is a single tab stop and arrows move within
        // it, so Tab does not have to walk past every open shell.
        v.tab.tabIndex = on ? 0 : -1;
        nameTab(v, v.label.textContent ?? "");
    }
};

const setActive = (id: string, opts?: { focusTerm?: boolean }): void => {
    const v = views.get(id);
    if (!v) return;
    active = id;
    for (const o of views.values()) o.el.classList.toggle("active", o.id === id);
    paintTabs();
    // Now that the tabs scroll inside their own strip, the selected one can be
    // out of sight — a new shell opened past the overflow used to switch to a
    // tab nobody could see.
    revealActiveTab();
    // Arrowing along the strip selects without stealing focus — xterm swallows
    // arrow keys, so focusing the terminal here would end the walk at the first
    // press and strand the keyboard in whichever shell it landed on.
    if (opts?.focusTerm !== false) v.term.focus();
    fitAndProposeSize();
};

const createView = (info: SessionInfo): View => {
    const { term, fit } = makeTerm();
    const el = document.createElement("div");
    el.className = "term";
    el.id = `term-${info.id}`;
    el.setAttribute("role", "tabpanel");
    termsEl.appendChild(el);
    term.open(el);
    term.resize(authCols, authRows);
    const helper = el.querySelector(".xterm-helper-textarea");
    if (helper) {
        helper.setAttribute("aria-describedby", "term-hatch");
        helper.addEventListener("focus", () => showEscapeHint(cameByKeyboard));
        helper.addEventListener("blur", () => showEscapeHint(false));
    }

    const tab = document.createElement("div");
    tab.className = "tab";
    tab.id = `tab-${info.id}`;
    tab.dataset.agent = info.agent;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", el.id);
    el.setAttribute("aria-labelledby", tab.id);
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = info.title;
    label.title = info.title;
    const ctrl = document.createElement("span");
    ctrl.className = "ctrl";
    ctrl.title = "This terminal currently controls the KVM mouse/keyboard";
    ctrl.textContent = "ctl";
    // The restart is only discoverable by reading the dead shell's last line,
    // so the marker's tooltip says it too. aria-hidden because the tab's own
    // name already carries the state.
    const dead = document.createElement("span");
    dead.className = "dead";
    dead.title = "This shell has exited — press Enter in it to restart";
    dead.setAttribute("aria-hidden", "true");
    dead.textContent = "exited";
    // A real button, not a span: it is an action, and screen readers were told
    // nothing about the "✕" glyph. tabindex -1 keeps it out of the tab sequence
    // (the tab strip is one stop), and Delete on the tab reaches it — the tab
    // pattern's own way of closing a tab.
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.tabIndex = -1;
    close.textContent = "✕";
    tab.append(label, ctrl, dead, close);
    tabsEl.appendChild(tab);

    const v: View = { id: info.id, term, fit, el, tab, label, close, exited: info.exited };
    views.set(info.id, v);
    nameTab(v, info.title);

    tab.addEventListener("mousedown", (e) => {
        if ((e.target as HTMLElement).closest(".close")) return;
        setActive(info.id);
    });
    close.addEventListener("click", (e) => {
        e.stopPropagation();
        send({ t: "close", id: info.id });
    });
    tab.addEventListener("keydown", (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        // Enter/Space hand focus to the terminal the tab names; arrows and
        // Home/End move along the strip, switching as they go but leaving focus
        // here so the next arrow still works; Delete closes.
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setActive(info.id);
            return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            send({ t: "close", id: info.id });
            return;
        }
        const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        const order = [...views.values()];
        let next: View | undefined;
        if (step) next = order[(order.findIndex((o) => o.id === info.id) + step + order.length) % order.length];
        else if (e.key === "Home") next = order[0];
        else if (e.key === "End") next = order[order.length - 1];
        if (!next) return;
        e.preventDefault();
        setActive(next.id, { focusTerm: false });
        next.tab.focus();
    });
    const pasteFromClipboard = (): void => {
        void sysClipboard.read().then((t) => { if (t && !v.exited) v.term.paste(t); });
    };
    // Right-click pastes (common terminal convention).
    el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); pasteFromClipboard(); });

    let escapeArmedUntil = 0;
    term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        /* ── The way back out (WCAG 2.1.2) ──
         * xterm sends Tab, Shift+Tab, Escape and F6 to the PTY, so once focus
         * reached the terminal nothing moved it again — measured over CDP, all
         * four left activeElement on the helper textarea. That is a keyboard
         * trap, and now that the tab strip can hand focus over deliberately it
         * is a trap people will actually fall into.
         *
         * Escape then Tab, the convention VS Code's terminal uses, because
         * every unmodified key belongs to the PTY and Ctrl+Shift+Tab is
         * browser-reserved on the web console this same file serves. It steals
         * nothing on its own: Escape is still forwarded, and only a Tab
         * directly after one is taken. The cost is bash's M-Tab and vim's
         * jumplist-forward, which is the trade this convention exists to make.
         */
        const bareTab = e.key === "Tab" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
        if (bareTab && Date.now() <= escapeArmedUntil) {
            escapeArmedUntil = 0;
            e.preventDefault();
            v.tab.focus();
            return false;
        }
        escapeArmedUntil =
            e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey ? Date.now() + ESCAPE_HATCH_MS : 0;
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
    // Closing a tab from the keyboard destroys the element holding focus, which
    // drops it to <body> — the next Delete or arrow then goes nowhere. Keep it
    // in the strip: the next tab, or New shell once the last one is gone.
    const hadFocus = v.tab.contains(document.activeElement);
    v.term.dispose();
    v.el.remove();
    v.tab.remove();
    views.delete(id);
    if (active === id) {
        const next = views.keys().next().value as string | undefined;
        active = null;
        if (next) setActive(next, { focusTerm: !hadFocus });
    }
    if (!hadFocus) return;
    const landing = active ? views.get(active)?.tab : newTabBtn;
    landing?.focus();
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
                /* The notice itself arrives as ordinary session data now, so
                 * writing it here too would print it twice. The server puts it
                 * in the buffer, which is what makes it survive a reconnect and
                 * be there for a client that arrives after the shell died. */
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

/* Back off, matching the console's video stream and its HID socket.
 *
 * This retried every second forever. A host that is off, rebooting, or behind a
 * dropped VPN got sixty failed connects a minute for as long as the window
 * stayed open, and the "Terminal disconnected — reconnecting…" notice made that
 * loop visible without making it any less wasteful. Same 1.7 curve and 8s
 * ceiling as the two sockets in the console, so panes talking to the same host
 * do not drift apart. */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 8000;
let reconnectMs = RECONNECT_MIN_MS;
let reconnectTimer: number | undefined;
const connect = (): void => {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
        // A connection that lands starts the next outage from the short wait
        // again, so a brief blip still recovers promptly.
        reconnectMs = RECONNECT_MIN_MS;
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
        }, reconnectMs);
        reconnectMs = Math.min(Math.round(reconnectMs * 1.7), RECONNECT_MAX_MS);
    };
    ws.onerror = () => ws?.close();
};
connect();
