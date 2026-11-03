// Shared plumbing for the browser end-to-end runs: headless Chrome, the fake kvmd's control
// API, and touch gestures sent as raw CDP events (Puppeteer's own touchscreen is one finger).
//
// The runs are against a real web host (node dist/web-server.js) in front of tools/fake-kvmd, so
// what they assert is what kvmd would have received. They never touch a real PiKVM.
//
// Puppeteer is not a dependency of the repo. Point PUPPETEER_CORE at a node_modules directory
// that has puppeteer-core, and CHROME at a Chrome binary (see docs/e2e/README.md).

import { createRequire } from "node:module";

export const WEB = process.env.KVM_WEB ?? "http://127.0.0.1:8099";
export const FAKE = process.env.KVM_FAKE ?? "http://127.0.0.1:4510";

const modules = process.env.PUPPETEER_CORE ?? `${process.env.HOME}/dev/sidekick/node_modules/`;
const require = createRequire(modules.endsWith("/") ? modules : `${modules}/`);
export const puppeteer = require("puppeteer-core");

const chrome =
    process.env.CHROME ?? `${process.env.HOME}/.cache/puppeteer/chrome/linux-154.0.8037.57/chrome-linux64/chrome`;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `backForwardCache: false` for a run that loads pages one after another in the same tab (`page.goto`). With the cache
 * on, Chrome parks every page it leaves, still holding its long-lived connections (the app's picture stream and two
 * event streams are three), and a host that speaks HTTP/1.1 lets a tab have six connections at a time: the third
 * page's requests wait in the socket pool until Chrome evicts the parked pages, so a save the run just made reaches
 * the server late or not at all. Off, a page's connections end when the tab leaves it, as they do on a reload.
 */
export async function launch({ backForwardCache = true } = {}) {
    const args = ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"];
    if (!backForwardCache) args.push("--disable-features=BackForwardCache");
    return puppeteer.launch({ executablePath: chrome, headless: true, args });
}

/* ---- the fake kvmd ---- */

export async function fakeGet(path) {
    const res = await fetch(`${FAKE}${path}`);
    return res.json();
}
export async function fakePost(path, body) {
    const res = await fetch(`${FAKE}${path}`, {
        method: "POST",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return res.json().catch(() => ({}));
}
export const fakeReset = () => fakePost("/__fake/reset");

/** What the fake received since the last call to `mark`. */
export function recorder() {
    let since = 0;
    return {
        async mark() {
            const { events, prints } = await fakeGet("/__fake/hid");
            since = Math.max(0, ...events.map((e) => e.seq), ...prints.map((p) => p.seq));
        },
        async events(settleMs = 250) {
            await sleep(settleMs);
            const { events, prints } = await fakeGet(`/__fake/hid?since=${since}`);
            return { events, prints };
        },
    };
}

/** A compact line per HID event, for assertions and for the report. */
export function describe(events) {
    return events.map((e) => {
        const ev = e.event;
        switch (e.event_type) {
            case "key":
                return `key ${ev.key} ${ev.state ? "down" : "up"}`;
            case "mouse_button":
                return `button ${ev.button} ${ev.state ? "down" : "up"}`;
            case "mouse_move":
                return `move ${ev.to.x},${ev.to.y}`;
            case "mouse_wheel":
                return `wheel ${ev.delta.x},${ev.delta.y}`;
            case "mouse_relative":
                return `relative ${ev.delta.x},${ev.delta.y}`;
            default:
                return e.event_type;
        }
    });
}

/* ---- touch, as CDP events ---- */

export async function touchSession(page) {
    const cdp = await page.createCDPSession();
    let id = 0;
    const down = new Map();
    const send = (type) =>
        cdp.send("Input.dispatchTouchEvent", {
            type,
            touchPoints: [...down.entries()].map(([pid, p]) => ({ x: p.x, y: p.y, id: pid, radiusX: 4, radiusY: 4, force: 1 })),
        });
    return {
        async start(x, y) {
            const pid = ++id;
            down.set(pid, { x, y });
            await send("touchStart");
            return pid;
        },
        async move(pid, x, y) {
            down.set(pid, { x, y });
            await send("touchMove");
        },
        /** Move several fingers in ONE event, as a real two-finger gesture does. */
        async moveAll(entries) {
            for (const [pid, x, y] of entries) down.set(pid, { x, y });
            await send("touchMove");
        },
        async end(pid) {
            const was = down.get(pid);
            down.delete(pid);
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [...down.entries()].map(([k, p]) => ({ x: p.x, y: p.y, id: k })) });
            return was;
        },
        async tap(x, y, holdMs = 40) {
            const pid = await this.start(x, y);
            await sleep(holdMs);
            await this.end(pid);
        },
        /** Drag one finger along a path, `stepMs` apart. */
        async drag(pid, path, stepMs = 16) {
            for (const [x, y] of path) {
                await this.move(pid, x, y);
                await sleep(stepMs);
            }
        },
    };
}

export function line(from, to, steps) {
    return Array.from({ length: steps }, (_, i) => [from[0] + ((to[0] - from[0]) * (i + 1)) / steps, from[1] + ((to[1] - from[1]) * (i + 1)) / steps]);
}

/* ---- results ---- */

export class Report {
    constructor(title) {
        this.title = title;
        this.rows = [];
    }
    add(profile, name, observed, pass) {
        this.rows.push({ profile, name, observed, pass });
        console.log(`${pass ? "PASS" : "FAIL"} [${profile}] ${name}: ${observed}`);
    }
    get failed() {
        return this.rows.filter((r) => !r.pass);
    }
}
