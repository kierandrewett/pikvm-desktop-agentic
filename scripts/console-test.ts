/*
 * Behavioural test for the browser console wiring (src/views/console.js).
 *
 * The proxy smoke (smoke:proxy) covers serving + the pure helpers but never runs
 * the DOM wiring. Here we stub a minimal DOM + WebSocket, execute the full IIFE,
 * then drive real interactions (a tap, a keystroke, a theme toggle) and assert
 * the exact HID JSON the PiKVM expects goes out on the wire. Catches reference
 * errors / typos in the ~250 lines the node smoke can't reach.
 *
 *   esbuild scripts/console-test.ts --bundle --platform=node --format=cjs \
 *     --outfile=dist/console-test.cjs --log-level=error && node dist/console-test.cjs
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Handlers = Record<string, Array<(ev: any) => void>>;

interface StubEl {
    _h: Handlers;
    classList: {
        _s: Set<string>;
        add(c: string): void;
        remove(c: string): void;
        toggle(c: string, f?: boolean): boolean;
        contains(c: string): boolean;
    };
    style: Record<string, any> & { setProperty(k: string, v: string): void };
    addEventListener(t: string, fn: (ev: any) => void): void;
    emit(t: string, ev?: any): void;
    setAttribute(k: string, v: string): void;
    removeAttribute(k: string): void;
    getAttribute(k: string): any;
    focus(): void;
    blur(): void;
    getBoundingClientRect(): { left: number; top: number; width: number; height: number };
    setPointerCapture(): void;
    offsetWidth: number;
    offsetHeight: number;
    value: string;
    src?: string;
    contentWindow: { postMessage(): void };
    [k: string]: any;
}

function makeEl(attrs: Record<string, string> = {}): StubEl {
    const h: Handlers = {};
    const el: StubEl = {
        _h: h,
        classList: {
            _s: new Set<string>(),
            add(c) {
                this._s.add(c);
            },
            remove(c) {
                this._s.delete(c);
            },
            toggle(c, f) {
                if (f === undefined) {
                    if (this._s.has(c)) {
                        this._s.delete(c);
                        return false;
                    }
                    this._s.add(c);
                    return true;
                }
                if (f) this._s.add(c);
                else this._s.delete(c);
                return f;
            },
            contains(c) {
                return this._s.has(c);
            },
        },
        style: { setProperty(k: string, v: string) { (this as any)[k] = v; } } as any,
        addEventListener(t, fn) {
            (h[t] = h[t] || []).push(fn);
        },
        emit(t, ev) {
            (h[t] || []).forEach((fn) => fn(ev || {}));
        },
        setAttribute(k, v) {
            (this as any)["attr_" + k] = v;
        },
        removeAttribute(k) {
            delete (this as any)["attr_" + k];
            if (k === "src") delete (this as any).src;
        },
        getAttribute(k) {
            return (this as any)["attr_" + k] ?? attrs[k] ?? null;
        },
        focus() {},
        blur() {},
        getBoundingClientRect() {
            return { left: 0, top: 0, width: 1000, height: 600 };
        },
        setPointerCapture() {},
        offsetWidth: 1000,
        offsetHeight: 600,
        value: "",
        contentWindow: { postMessage() {} },
    };
    return el;
}

async function main(): Promise<void> {
    const checks: Array<[string, boolean]> = [];
    const sent: any[] = [];

    // --- DOM + platform stubs ------------------------------------------------
    const ids: Record<string, StubEl> = {};
    for (const id of [
        "app",
        "screen",
        "screen-video",
        "screen-pane",
        "overlay-msg",
        "conn",
        "conn-text",
        "kbd",
        "chat-frame",
        "theme-btn",
        "chat-btn",
        "kbd-btn",
        "cad",
        "drag-lock",
        "divider",
        "audio-btn",
        "mic-btn",
        "audio-pip",
        "mic-pip",
        "av-sep",
    ])
        ids[id] = makeEl();
    // The screen <img> reports its native resolution (used by the coordinate maths).
    (ids["screen"] as any).naturalWidth = 1000;
    (ids["screen"] as any).naturalHeight = 600;
    // The WebRTC <video> reports its decoded size the same way (videoWidth/Height).
    (ids["screen-video"] as any).videoWidth = 1000;
    (ids["screen-video"] as any).videoHeight = 600;
    (ids["screen-video"] as any).play = () => Promise.resolve();

    const documentElement = makeEl();
    documentElement.setAttribute("data-theme", "dark");
    const metaTheme = makeEl();

    const doc = {
        documentElement,
        getElementById: (id: string) => ids[id] ?? null,
        querySelector: (sel: string) => (sel.includes("theme-color") ? metaTheme : null),
        querySelectorAll: (_sel: string) => [] as StubEl[],
        addEventListener: (_t: string, _fn: any) => {},
    };

    class StubWS {
        static OPEN = 1;
        readyState = 1;
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onmessage: (() => void) | null = null;
        constructor(public url: string) {
            // Open on the next tick so the queue-flush path is exercised.
            setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send(raw: string) {
            sent.push(JSON.parse(raw));
        }
        close() {}
    }

    // Stub WebRTC: a JanusStream that, once start() is called, reports a live video
    // track on the next tick (so we can assert the <img>→<video> swap + fallback).
    let janusOpts: any = null;
    const janusCalls: string[] = [];
    const win: any = { innerWidth: 1200, innerHeight: 800, addEventListener: () => {}, RTCPeerConnection: function () {} };
    win.JanusStream = (opts: any) => {
        janusOpts = opts;
        return {
            start() {
                setTimeout(() => {
                    // Pretend a remote video track arrived and is playing.
                    (opts.video as any).videoWidth = 1280;
                    (opts.video as any).videoHeight = 720;
                    (opts.video as any)._hasVideo = true;
                    opts.onActive(true);
                }, 0);
            },
            stop() {
                janusCalls.push("stop");
            },
            setAudio(on: boolean) {
                janusCalls.push("audio:" + on);
            },
            setMic(on: boolean) {
                janusCalls.push("mic:" + on);
            },
            hasVideo() {
                return !!(opts.video as any)._hasVideo;
            },
        };
    };
    win.JanusStream.available = () => true;
    const location = { protocol: "http:", host: "127.0.0.1:9" };
    const navigator = { userAgent: "Mozilla/5.0 Chrome/120", mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) } };
    const store: Record<string, string> = {};
    const localStorage = {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
            store[k] = v;
        },
    };
    const fetchStub = () =>
        Promise.resolve({ json: () => Promise.resolve({ settings: { keyboardLayout: "uk" } }) });

    // --- run the real IIFE in the stubbed scope ------------------------------
    const src = readFileSync(resolve(__dirname, "../src/views/console.js"), "utf8");
    let ran = true;
    try {
        const fn = new Function(
            "window",
            "document",
            "location",
            "navigator",
            "localStorage",
            "fetch",
            "WebSocket",
            "setTimeout",
            "clearTimeout",
            "console",
            src,
        );
        fn(win, doc, location, navigator, localStorage, fetchStub, StubWS, setTimeout, clearTimeout, console);
    } catch (e) {
        ran = false;
        console.error("IIFE threw:", e);
    }
    checks.push(["console.js wiring runs without throwing", ran]);

    // Let the stub WS open + the layout fetch resolve + Janus report video.
    await new Promise((r) => setTimeout(r, 20));

    // --- WebRTC swap: <video> shown, <img> hidden + MJPEG conn released ---------
    checks.push(["WebRTC: JanusStream started with the <video> element", !!janusOpts && janusOpts.video === ids["screen-video"]]);
    checks.push(["WebRTC: audio ON by default, mic OFF (privacy)", !!janusOpts && janusOpts.wantAudio === true && !janusOpts.wantMic]);
    checks.push(["WebRTC live: <video> shown, <img> hidden", !ids["screen-video"]!.classList.contains("hidden") && ids["screen"]!.classList.contains("hidden")]);
    checks.push(["WebRTC live: MJPEG <img> src released", !ids["screen"]!.src]);
    checks.push(["WebRTC live: audio/mic toggles revealed", ids["audio-btn"]!.getAttribute("hidden") == null && ids["mic-btn"]!.getAttribute("hidden") == null]);

    const pane = ids["screen-pane"]!;

    // --- input geometry now reads the <video>, not the hidden <img> ------------
    // The video is 1280x720 in a 1000x600 box (object-fit:contain → 1000x562.5,
    // letterboxed). A mouse click at the box centre must still map to ~centre.
    sent.length = 0;
    pane.emit("pointerdown", { pointerType: "mouse", pointerId: 9, button: 0, clientX: 500, clientY: 300, preventDefault() {} });
    pane.emit("pointerup", { pointerType: "mouse", pointerId: 9, button: 0, clientX: 500, clientY: 300, preventDefault() {} });
    await new Promise((r) => setTimeout(r, 20));
    const vMoves = sent.filter((m) => m.event_type === "mouse_move");
    checks.push([
        "WebRTC: absolute click maps off the <video> geometry (~centre)",
        vMoves.length > 0 && Math.abs(vMoves[vMoves.length - 1].event.to.x) < 60 && Math.abs(vMoves[vMoves.length - 1].event.to.y) < 60,
    ]);

    // --- Audio toggle flips Janus audio + the <video> mute (default ON → off → on) -
    janusCalls.length = 0;
    ids["audio-btn"]!.emit("click", { stopPropagation() {} }); // on -> off
    const audioOffOk = janusCalls.includes("audio:false") && (ids["screen-video"] as any).muted === true;
    janusCalls.length = 0;
    ids["audio-btn"]!.emit("click", { stopPropagation() {} }); // off -> on
    const audioOnOk = janusCalls.includes("audio:true") && (ids["screen-video"] as any).muted === false;
    checks.push(["Audio toggle flips setAudio + video mute (default on → off → on)", audioOffOk && audioOnOk]);

    // --- Mic toggle requests permission then calls setMic(true) ----------------
    janusCalls.length = 0;
    ids["mic-btn"]!.emit("click", { stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 20));
    checks.push(["Mic toggle (granted) calls setMic(true)", janusCalls.includes("mic:true")]);

    // --- TOUCH = relative trackpad: a tap clicks at the cursor (no absolute move) -
    sent.length = 0;
    pane.emit("pointerdown", { pointerType: "touch", pointerId: 1, clientX: 500, clientY: 300, preventDefault() {} });
    pane.emit("pointerup", { pointerType: "touch", pointerId: 1, clientX: 500, clientY: 300, preventDefault() {} });
    await new Promise((r) => setTimeout(r, 120));
    let moves = sent.filter((m) => m.event_type === "mouse_move");
    let btns = sent.filter((m) => m.event_type === "mouse_button");
    checks.push(["touch tap does NOT send an absolute move (relative model)", moves.length === 0]);
    checks.push([
        "touch tap presses then releases left",
        btns.length >= 2 && btns[0].event.button === "left" && btns[0].event.state === true && btns.some((b) => b.event.state === false),
    ]);

    // --- TOUCH drag = relative cursor movement (delta-based) ------------------
    sent.length = 0;
    pane.emit("pointerdown", { pointerType: "touch", pointerId: 2, clientX: 400, clientY: 300, preventDefault() {} });
    pane.emit("pointermove", { pointerType: "touch", pointerId: 2, clientX: 460, clientY: 300, preventDefault() {} });
    pane.emit("pointerup", { pointerType: "touch", pointerId: 2, clientX: 460, clientY: 300, preventDefault() {} });
    await new Promise((r) => setTimeout(r, 40));
    moves = sent.filter((m) => m.event_type === "mouse_move");
    checks.push(["touch drag emits a relative mouse_move", moves.length > 0 && moves[0].event.to.x > 0]);

    // --- MOUSE (desktop) = absolute: click lands exactly where you point ------
    sent.length = 0;
    pane.emit("pointerdown", { pointerType: "mouse", pointerId: 3, button: 0, clientX: 500, clientY: 300, preventDefault() {} });
    pane.emit("pointerup", { pointerType: "mouse", pointerId: 3, button: 0, clientX: 500, clientY: 300, preventDefault() {} });
    await new Promise((r) => setTimeout(r, 20));
    moves = sent.filter((m) => m.event_type === "mouse_move");
    btns = sent.filter((m) => m.event_type === "mouse_button");
    checks.push([
        "mouse click sends an absolute move to the point (~centre 0,0)",
        moves.length > 0 && Math.abs(moves[moves.length - 1].event.to.x) < 60 && Math.abs(moves[moves.length - 1].event.to.y) < 60,
    ]);
    checks.push(["mouse click presses + releases left", btns.some((b) => b.event.state === true) && btns.some((b) => b.event.state === false)]);

    // --- drive an Enter keypress through the hidden input -------------------
    sent.length = 0;
    ids["kbd"]!.emit("keydown", { code: "Enter", key: "Enter", preventDefault() {} });
    await new Promise((r) => setTimeout(r, 50));
    const keys = sent.filter((m) => m.event_type === "key");
    checks.push([
        "Enter key sends a key down+up for Enter",
        keys.some((k) => k.event.key === "Enter" && k.event.state === true) && keys.some((k) => k.event.key === "Enter" && k.event.state === false),
    ]);

    // --- printable char honours the server layout (UK '#' -> Backslash) ----
    sent.length = 0;
    ids["kbd"]!.emit("beforeinput", { inputType: "insertText", data: "#", preventDefault() {} });
    await new Promise((r) => setTimeout(r, 40));
    const hashKeys = sent.filter((m) => m.event_type === "key");
    checks.push([
        "UK layout applied: '#' -> Backslash (no shift)",
        hashKeys.some((k) => k.event.key === "Backslash" && k.event.state === true) && !hashKeys.some((k) => k.event.key === "ShiftLeft"),
    ]);

    // --- theme toggle flips the attribute + persists ------------------------
    ids["theme-btn"]!.emit("click");
    checks.push(["theme toggle -> light", documentElement.getAttribute("data-theme") === "light"]);
    checks.push(["theme persisted to localStorage", store["pikvm-console-theme"] === "light"]);
    ids["theme-btn"]!.emit("click");
    checks.push(["theme toggle -> back to dark", documentElement.getAttribute("data-theme") === "dark"]);

    // --- report --------------------------------------------------------------
    let ok = true;
    for (const [name, pass] of checks) {
        console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
        if (!pass) ok = false;
    }
    process.exit(ok ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
