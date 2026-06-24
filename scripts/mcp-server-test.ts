// Smoke test for the integrated MCP server (src/mcp-server.ts) — the PiKVM "eyes +
// hands" Claude Code drives. Spins the real server over an in-process HTTP transport
// with a recording stub control, then exercises tools/list AND tools/call to prove every
// tool is registered and actually invokes the right control method (catches wiring bugs
// before the GUI test). No Electron, no Pi.
//   esbuild scripts/mcp-server-test.ts --bundle --platform=node --format=cjs \
//     --outfile=dist/mcp-server-test.cjs && node dist/mcp-server-test.cjs

import http from "node:http";
import { createMcpHttpHandler } from "../src/mcp-server";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
    if (cond) console.log(`  ok   ${name}`);
    else {
        failed++;
        console.log(`  FAIL ${name}`, extra ?? "");
    }
}

// Recording stub control: every method logs its call so we can assert the tool routed to it.
const calls: { fn: string; args: unknown[] }[] = [];
const rec = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve();
};
const presenceCalls: string[] = [];
const stub: any = {
    control: {
        screenshot: (...a: unknown[]) => {
            calls.push({ fn: "screenshot", args: a });
            return Promise.resolve({ base64: "AAAA", mimeType: "image/jpeg", width: 1400, height: 788 });
        },
        ocr: (...a: unknown[]) => {
            calls.push({ fn: "ocr", args: a });
            return Promise.resolve("hello world");
        },
        moveMouse: rec("moveMouse"),
        click: rec("click"),
        doubleClick: rec("doubleClick"),
        drag: rec("drag"),
        typeText: rec("typeText"),
        pressKey: rec("pressKey"),
        hotkey: rec("hotkey"),
        scroll: rec("scroll"),
        getLayout: () => "us",
        setLayout: () => {},
        getDimensions: () => ({ width: 1400, height: 788 }),
        captureGrid: () => Promise.resolve(null),
        onTypingEvent: () => {},
    },
    reviewer: { review: async () => ({ decision: "allow" }), assess: () => ({ decision: "allow", risky: false }) },
    presence: { waitUntilAllowed: () => (presenceCalls.push("yield"), Promise.resolve()) },
    secrets: { list: () => [{ name: "vpn", hint: "the corp VPN password" }], names: () => ["vpn"], get: (n: string) => (n === "vpn" ? "s3cr3t" : undefined) },
    getRegions: () => ({ regions: [{ label: "Terminal", kind: "terminal", bbox: { x: 0, y: 0, width: 800, height: 600 } }], width: 1400, height: 788, at: 0 }),
    opticalRead: async () => "hello world",
    // Per-session KVM lease + dangerous-op guardrail (the codex/opencode path, keyed by the
    // /mcp/<session> URL). A click at the sentinel x=666 is a "dangerous" verdict.
    acquireKvmControl: (s?: string) => (!s || !leaseHolder || leaseHolder === s ? ((leaseHolder = s ?? null), { ok: true }) : { ok: false, reason: `held by ${leaseHolder}` }),
    releaseKvmControl: (s?: string) => { if (leaseHolder === s) leaseHolder = null; },
    assessOp: async (tool: string, args: any, s: string) => {
        if (tool === "click" && args?.x === 666) return { decision: "deny", reason: "dangerous op blocked" };
        return stub.acquireKvmControl(s).ok ? { decision: "allow" } : { decision: "deny", reason: "held by another session" };
    },
};
let leaseHolder: string | null = null;

const handler = createMcpHttpHandler(stub);
const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
        const m = (req.url || "").match(/^\/mcp\/(.+)$/);
        void handler(req, res, b ? JSON.parse(b) : undefined, m ? decodeURIComponent(m[1]) : undefined);
    });
});

const PORT = 25779;
function rpc(method: string, params: unknown, id: number, session?: string) {
    return fetch(`http://127.0.0.1:${PORT}/${session ? `mcp/${session}` : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }).then((r) => r.text());
}
const text = (raw: string) => raw.replace(/^.*?\n\ndata: /s, ""); // strip the SSE event wrapper

server.listen(PORT, "127.0.0.1", async () => {
    try {
        await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }, 1);

        const tools = [...(await rpc("tools/list", {}, 2)).matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);
        const want = ["screenshot", "ocr", "get_regions", "move_mouse", "click", "double_click", "drag", "type_text", "press_key", "hotkey", "scroll", "list_secrets", "type_secret"];
        check(`lists all ${want.length} eyes+hands tools`, want.every((t) => tools.includes(t)), { got: tools });

        const call = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args }, 100);

        const ss = text(await call("screenshot", {}));
        check("screenshot returns an image + dims", ss.includes('"image"') && ss.includes("1400x788"), ss.slice(0, 120));

        const o = text(await call("ocr", {}));
        check("ocr returns the read text", o.includes("hello world"));

        const gr = text(await call("get_regions", {}));
        check("get_regions lists labelled regions", gr.includes("Terminal") && gr.includes("terminal"));

        calls.length = 0;
        presenceCalls.length = 0;
        await call("move_mouse", { x: 42, y: 99 });
        check("move_mouse → control.moveMouse(42,99)", calls.some((c) => c.fn === "moveMouse" && c.args[0] === 42 && c.args[1] === 99), calls);
        check("move_mouse yielded to presence (DND gate)", presenceCalls.length === 1);

        calls.length = 0;
        await call("click", { x: 10, y: 20, button: "right" });
        check("click moves then right-clicks", calls.some((c) => c.fn === "moveMouse") && calls.some((c) => c.fn === "click" && c.args[0] === "right"), calls);

        calls.length = 0;
        const ts = text(await call("type_secret", { name: "vpn" }));
        check("type_secret types the looked-up value, hides it", calls.some((c) => c.fn === "typeText" && c.args[0] === "s3cr3t") && ts.includes("value hidden") && !ts.includes("s3cr3t"), ts.slice(0, 120));

        const ls = text(await call("list_secrets", {}));
        check("list_secrets shows names + hints, not values", ls.includes("vpn") && ls.includes("corp VPN") && !ls.includes("s3cr3t"));

        const miss = text(await call("type_secret", { name: "nope" }));
        check("type_secret on a missing name is handled", miss.toLowerCase().includes("no secret"));

        // ---- per-session guardrail + KVM lease (the codex/opencode path: /mcp/<session>) ----
        const callS = (session: string, name: string, args: unknown, id = 200) => rpc("tools/call", { name, arguments: args }, id, session);
        await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }, 50, "agentA");

        calls.length = 0;
        leaseHolder = null;
        const dangerous = text(await callS("agentA", "click", { x: 666, y: 1 }));
        check("hook-less hands op: dangerous verdict hard-denied before it acts", dangerous.includes("dangerous op blocked") && dangerous.includes('"isError":true') && !calls.some((c) => c.fn === "click"), dangerous.slice(0, 140));

        calls.length = 0;
        leaseHolder = null;
        await callS("agentA", "click", { x: 5, y: 5 });
        check("agentA acquires control + clicks", calls.some((c) => c.fn === "click") && leaseHolder === "agentA");
        const denied = text(await callS("agentB", "click", { x: 7, y: 7 }, 201));
        check("agentB denied the KVM while agentA holds control", denied.includes('"isError":true') && denied.toLowerCase().includes("held"), denied.slice(0, 140));

        stub.releaseKvmControl("agentA");
        calls.length = 0;
        await callS("agentB", "click", { x: 9, y: 9 }, 202);
        check("after release, agentB takes control", calls.some((c) => c.fn === "click") && leaseHolder === "agentB");
    } catch (e: any) {
        check("no exceptions", false, e.message);
    } finally {
        server.close();
        console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
        process.exit(failed === 0 ? 0 : 1);
    }
});
