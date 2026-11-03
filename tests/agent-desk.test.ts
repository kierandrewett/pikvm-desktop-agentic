import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { WebSocket } from "ws";
import { normToPixel, pixelToNorm, referenceSize } from "@pikvm/kvm-engine/agent";
import { createPikvmMcp, defaultPolicy, type AgentActivity, type Approver, type PikvmPolicy } from "@pikvm/mcp";
import { createFakeApprover, createTestClient, inProcessTransport, type CallResult } from "@pikvm/mcp/testing";
import { MouseJiggler } from "../src/mouse-jiggler";
import type { PiKvmControl } from "../src/pikvm-control";
import { createActivity } from "../src/server/agent/activity";
import { unavailableApprover } from "../src/server/agent/approver";
import { createDesk, type AgentDesk, type DeskImages } from "../src/server/agent/desk";
import { createPresence } from "../src/server/agent/presence";
import { createPiKvmProxy } from "../src/server/proxy/kvmd";
import { startFakeKvmd, until, type FakeKvmdHandle } from "./support/fake-kvmd";

const SECRET = "s3cret-passw0rd";
const USER = "operator";

/** Every pause an action takes, short, so a test does not wait for a human cadence. */
const FAST = {
    clickHoldMs: 2,
    multiClickGapMs: 2,
    settleMs: 1,
    moveStepMs: 1,
    dragHoldMs: 2,
    wheelGapMs: 1,
    keyHoldMs: 1,
    keyGapMs: 1,
    chordSettleMs: 1,
    chordHoldMs: 2,
    chordGapMs: 1,
    relativeGapMs: 0,
};

/** The fake serves a 320x180 JPEG whatever it reports, so image work is a marker the test can read back. */
const images: DeskImages = {
    async resize(_jpeg, width, height) {
        return Buffer.from(`resize ${width}x${height}`);
    },
    async crop(_jpeg, region) {
        return Buffer.from(`crop ${region.x},${region.y} ${region.width}x${region.height}`);
    },
};

let fake: FakeKvmdHandle;
before(async () => {
    fake = await startFakeKvmd();
});
after(async () => {
    await fake.close();
});
beforeEach(async () => {
    await fake.reset();
});

interface RigOptions {
    timing?: Partial<typeof FAST>;
    approver?: Approver;
    policy?: Partial<PikvmPolicy>;
    leaseMs?: number;
    now?: () => number;
}

const rigs: { desk: AgentDesk; stop(): Promise<void> }[] = [];
afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.stop();
});

function rig(options: RigOptions = {}) {
    const presence = createPresence();
    const activity = createActivity();
    const seen: AgentActivity[] = [];
    activity.subscribe((a) => seen.push(a));
    const desk = createDesk({
        target: async () => ({
            origin: new URL(fake.url),
            headers: { "X-KVMD-User": USER, "X-KVMD-Passwd": SECRET },
            rejectUnauthorized: false,
        }),
        images,
        presence,
        activity,
        timing: { ...FAST, ...options.timing },
        connectMs: 3000,
        ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
        ...(options.now ? { now: options.now } : {}),
    });
    const approver = createFakeApprover("approved");
    const policy: PikvmPolicy = { ...defaultPolicy, ...options.policy };
    const errors: unknown[] = [];
    const mcp = createPikvmMcp({ desk, approver: options.approver ?? approver, policy: () => policy, onError: (e) => errors.push(e) });
    const results: string[] = [];
    const client = (conversationId: string, signal?: AbortSignal) => {
        const inner = createTestClient(inProcessTransport(mcp, { conversationId, ...(signal ? { signal } : {}) }));
        return {
            ...inner,
            async call(name: string, args?: Record<string, unknown>): Promise<CallResult> {
                const result = await inner.call(name, args);
                results.push(JSON.stringify(result));
                return result;
            },
        };
    };
    const handle = { desk, presence, activity, seen, approver, client, results, errors, policy, stop: () => desk.dispose() };
    rigs.push(handle);
    return handle;
}

/** Wait for the fake to have handled everything sent so far: its count of HID events stops growing. */
async function quiet(): Promise<void> {
    let last = -1;
    let stable = 0;
    await until(async () => {
        const n = (await fake.hid()).length;
        stable = n === last ? stable + 1 : 0;
        last = n;
        return stable >= 3;
    }, "the fake to settle");
}

const types = (events: { event_type: string; event: Record<string, unknown> }[]) =>
    events.map((e) =>
        e.event_type === "key"
            ? `key:${String(e.event["key"])}:${e.event["state"] ? "down" : "up"}`
            : e.event_type === "mouse_button"
              ? `button:${String(e.event["button"])}:${e.event["state"] ? "down" : "up"}`
              : e.event_type,
    );

/** The kvmd unit the last absolute move before `index` carried. */
function lastMove(events: { event_type: string; event: Record<string, unknown> }[], before = events.length): { x: number; y: number } {
    for (let i = before - 1; i >= 0; i--) {
        const e = events[i];
        if (e?.event_type === "mouse_move") return (e.event as { to: { x: number; y: number } }).to;
    }
    throw new Error("no mouse_move was recorded");
}

describe("each tool reaches kvmd as the right HID and streamer calls", () => {
    it("screenshot asks the streamer for a snapshot and returns the image with the frame size", async () => {
        const r = rig();
        r.desk.beginRun("a");
        const shot = await r.client("a").call("screenshot");
        assert.equal(shot.isError, false);
        assert.equal(shot.text, "Screen 320x180 (frame 1). Mouse: absolute.");
        assert.equal(shot.image?.mimeType, "image/jpeg");
        const requests = await fake.requests();
        const snapshot = requests.find((q) => q.path === "/api/streamer/snapshot");
        assert.deepEqual(snapshot?.query, { allow_offline: "1" });
        assert.equal(snapshot?.authUser, USER);
        assert.ok((await fake.state()).wsAuthUsers.includes(USER), "the link to kvmd carried the credentials");
    });

    it("a zoom crops the native frame, and read_text asks kvmd's OCR for the region in native pixels", async () => {
        await fake.post("/__fake/resolution?width=1920&height=1080");
        await fake.post("/__fake/ocr", "File  Edit  View");
        const r = rig();
        r.desk.beginRun("a");
        const c = r.client("a");
        const full = await c.call("screenshot");
        assert.match(full.text, /^Screen 1280x720 \(frame 1\)/);
        assert.equal(Buffer.from(full.image!.data, "base64").toString(), "resize 1280x720");
        const zoom = await c.call("screenshot", { region: { x: 100, y: 50, width: 400, height: 200 } });
        assert.match(zoom.text, /^Zoom of x 100, y 50, 400x200 of the 1280x720 frame, shown at 600x300\./);
        assert.equal(Buffer.from(zoom.image!.data, "base64").toString(), "crop 150,75 600x300");
        const text = await c.call("read_text", { region: { x: 100, y: 50, width: 400, height: 200 } });
        assert.equal(text.text, "File  Edit  View");
        const ocr = (await fake.requests()).filter((q) => q.query["ocr"] === "1").at(-1);
        assert.deepEqual(
            [ocr?.query["ocr_left"], ocr?.query["ocr_top"], ocr?.query["ocr_right"], ocr?.query["ocr_bottom"]],
            ["150", "75", "750", "375"],
        );
    });

    it("read_text says so when the Pi has no OCR", async () => {
        await fake.post("/__fake/ocr?enabled=0");
        const r = rig();
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        const result = await c.call("read_text");
        assert.match(result.text, /^ocr_unavailable:/);
    });

    it("click is a move, then the button down and up; a double click is two pairs; the right button is right", async () => {
        const r = rig();
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        await c.call("click", { x: 160, y: 90 });
        await c.call("click", { x: 160, y: 90, button: "right", count: 2 });
        await quiet();
        const events = await fake.hid();
        assert.deepEqual(
            types(events).filter((t) => t !== "mouse_move"),
            ["button:left:down", "button:left:up", "button:right:down", "button:right:up", "button:right:down", "button:right:up"],
        );
        const firstDown = events.findIndex((e) => e.event_type === "mouse_button");
        assert.deepEqual(lastMove(events, firstDown), pixelToNorm({ width: 320, height: 180 }, { x: 160, y: 90 }));
    });

    it("mouse_move only moves, drag presses at the start and releases at the end, scroll turns the wheel the right way", async () => {
        const r = rig();
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        await c.call("mouse_move", { x: 10, y: 20 });
        await quiet();
        assert.deepEqual([...new Set(types(await fake.hid()))], ["mouse_move"]);

        await fake.reset();
        await c.call("drag", { from: { x: 10, y: 20 }, to: { x: 300, y: 170 } });
        await quiet();
        const drag = await fake.hid();
        const down = drag.findIndex((e) => e.event_type === "mouse_button");
        const up = drag.length - 1;
        assert.deepEqual([types(drag)[down], types(drag)[up]], ["button:left:down", "button:left:up"]);
        assert.deepEqual(lastMove(drag, down), pixelToNorm({ width: 320, height: 180 }, { x: 10, y: 20 }));
        assert.deepEqual(lastMove(drag, up), pixelToNorm({ width: 320, height: 180 }, { x: 300, y: 170 }));

        await fake.reset();
        await c.call("scroll", { x: 100, y: 100, dy: 3 });
        await c.call("scroll", { x: 100, y: 100, dx: -2, dy: -1 });
        await quiet();
        const wheel = (await fake.hid("mouse_wheel")).map((e) => (e.event as { delta: { x: number; y: number } }).delta);
        assert.deepEqual(wheel, [
            { x: 0, y: -1 },
            { x: 0, y: -1 },
            { x: 0, y: -1 },
            { x: -1, y: 1 },
            { x: -1, y: 0 },
        ]);
    });

    it("type_text presses physical keys through the layout the Pi reports, Shift around the ones that need it", async () => {
        await fake.post("/__fake/keymap?name=en-gb");
        const r = rig();
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        const typed = await c.call("type_text", { text: 'A"' });
        assert.equal(typed.text, "Typed 2 characters.");
        await quiet();
        assert.deepEqual(types(await fake.hid("key")), [
            "key:ShiftLeft:down",
            "key:KeyA:down",
            "key:KeyA:up",
            "key:ShiftLeft:up",
            "key:ShiftLeft:down",
            "key:Digit2:down",
            "key:Digit2:up",
            "key:ShiftLeft:up",
        ]);
        assert.deepEqual((await fake.state()).keysDown, []);
    });

    it("type_text with a character the layout has no key for types nothing and says which", async () => {
        const r = rig();
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        const result = await c.call("type_text", { text: "caf\u00e9" });
        assert.match(result.text, /^unsupported_text: .*"\u00e9"/);
        await quiet();
        assert.deepEqual(await fake.hid(), []);
    });

    it("key presses a chord with its modifiers around it and always releases them", async () => {
        const r = rig({ policy: { approval: "never" } });
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        await c.call("key", { keys: ["ctrl+c", "Enter"] });
        await quiet();
        assert.deepEqual(types(await fake.hid("key")), [
            "key:ControlLeft:down",
            "key:KeyC:down",
            "key:KeyC:up",
            "key:ControlLeft:up",
            "key:Enter:down",
            "key:Enter:up",
        ]);
    });

    it("wait sleeps, or until the screen has stopped changing", async () => {
        const r = rig();
        r.desk.beginRun("a");
        const c = r.client("a");
        const slept = await c.call("wait", { ms: 30 });
        assert.equal(slept.text, "Waited 30 ms.");
        const settled = await c.call("wait", { until_stable: true, ms: 3000 });
        assert.match(settled.text, /^The screen settled after \d+ ms\.$/);

        // A screen that keeps changing is reported as still changing, at the time limit.
        await fake.post("/__fake/picture?name=flicker");
        const busy = await c.call("wait", { until_stable: true, ms: 800 });
        assert.match(busy.text, /^The screen was still changing after \d+ ms\.$/);
    });

    it("screen_info reports the frame, the modes and who holds control", async () => {
        await fake.post("/__fake/resolution?width=1920&height=1080");
        const r = rig();
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        const info = await c.call("screen_info");
        assert.match(info.text, /Reference frame: 1280x720/);
        assert.match(info.text, /Native resolution: 1920x1080/);
        assert.match(info.text, /Mouse mode: absolute/);
        assert.match(info.text, /Control: yours/);
    });

    it("power presses the ATX button the action names, and does nothing when it is already so", async () => {
        const r = rig({ policy: { allowPower: true } });
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        assert.match((await c.call("power", { action: "on" })).text, /already on/);
        assert.match((await c.call("power", { action: "reset" })).text, /reset button/);
        assert.match((await c.call("power", { action: "off" })).text, /power button/);
        const clicks = (await fake.requests()).filter((q) => q.path === "/api/atx/click");
        assert.deepEqual(
            clicks.map((q) => [q.method, q.query["button"]]),
            [
                ["POST", "reset"],
                ["POST", "power"],
            ],
        );
        assert.equal(r.approver.requests.length, 3, "power asks every time, even when it ends up doing nothing");
    });
});

describe("coordinates", () => {
    const sizes = [
        { width: 320, height: 180 },
        { width: 1280, height: 720 },
        { width: 1920, height: 1080 },
        { width: 3840, height: 2160 },
    ];

    for (const native of sizes) {
        it(`a click on a reference pixel lands on the same pixel of a ${native.width}x${native.height} target`, async () => {
            await fake.post(`/__fake/resolution?width=${native.width}&height=${native.height}`);
            const r = rig();
            r.desk.beginRun("a");
            const c = r.client("a");
            const ref = referenceSize(native);
            const shot = await c.call("screenshot");
            assert.match(shot.text, new RegExp(`^Screen ${ref.width}x${ref.height} `));
            for (const p of [
                { x: 0, y: 0 },
                { x: Math.floor(ref.width / 2), y: Math.floor(ref.height / 2) },
                { x: ref.width - 1, y: ref.height - 1 },
                { x: 7, y: ref.height - 3 },
            ]) {
                await fake.post("/__fake/reset");
                await fake.post(`/__fake/resolution?width=${native.width}&height=${native.height}`);
                await c.call("click", p);
                await quiet();
                const events = await fake.hid();
                const norm = lastMove(events);
                assert.deepEqual(norm, pixelToNorm(ref, p));
                assert.deepEqual(normToPixel(ref, norm), p);
                // What the target makes of that unit: the native pixel under the pointer.
                const nativePixel = {
                    x: Math.floor(((norm.x + 32767) / 65534) * native.width),
                    y: Math.floor(((norm.y + 32767) / 65534) * native.height),
                };
                assert.deepEqual(nativePixel, {
                    x: Math.floor(((p.x + 0.5) / ref.width) * native.width),
                    y: Math.floor(((p.y + 0.5) / ref.height) * native.height),
                });
            }
        });
    }

    it("a relative mouse is swept to the corner then stepped, so the reports add up to the native pixel", async () => {
        await fake.post("/__fake/resolution?width=1920&height=1080");
        await fake.post("/api/hid/set_params?mouse_output=usb_rel");
        const r = rig();
        r.desk.beginRun("a");
        const c = r.client("a");
        const shot = await c.call("screenshot");
        assert.match(shot.text, /Mouse: relative \(positioning is approximate\)/);
        await until(async () => (await c.call("screen_info")).text.includes("Mouse mode: relative"), "the link to see relative mode");
        assert.equal((await c.call("click", { x: 640, y: 360 })).isError, false);
        await quiet();
        const reports = (await fake.hid("mouse_relative")).map((e) => (e.event as { delta: { x: number; y: number } }).delta);
        assert.ok(reports.every((d) => Math.abs(d.x) <= 127 && Math.abs(d.y) <= 127), "no report is over kvmd's limit");
        const sweeps = Math.ceil(1920 / 127) + 1;
        const sum = reports.reduce((a, d) => ({ x: a.x + d.x, y: a.y + d.y }), { x: 0, y: 0 });
        // The middle of reference pixel (640, 360) is native (960.75, 540.75), which rounds to 961, 541.
        assert.deepEqual({ x: sum.x + 127 * sweeps, y: sum.y + 127 * sweeps }, { x: 961, y: 541 });
        assert.equal((await fake.hid("mouse_move")).length, 0, "an absolute move is ignored by a relative Pi, so none is sent");
    });
});

describe("what the desk refuses", () => {
    it("input before any screenshot is a stale frame, and a coordinate off the frame is named", async () => {
        const r = rig();
        r.desk.beginRun("a");
        const c = r.client("a");
        const early = await c.call("click", { x: 1, y: 1 });
        assert.match(early.text, /^stale_frame: You have not taken a screenshot/);
        await c.call("screenshot");
        const off = await c.call("click", { x: 320, y: 10 });
        assert.match(off.text, /^invalid_arguments: \(320, 10\) is outside the 320x180 screenshot/);
        await quiet();
        assert.deepEqual(await fake.hid(), []);
    });

    it("a resolution change makes the next input stale, and a new screenshot clears it", async () => {
        const r = rig();
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        await fake.post("/__fake/resolution?width=640&height=360");
        await until(async () => (await c.call("screen_info")).text.includes("Native resolution: 640x360"), "the Pi's resolution event");
        const stale = await c.call("click", { x: 10, y: 10 });
        assert.match(stale.text, /^stale_frame: The screen resolution changed from 320x180 to 640x360/);
        assert.match((await c.call("type_text", { text: "x" })).text, /^stale_frame/);
        await c.call("screenshot");
        assert.equal((await c.call("click", { x: 10, y: 10 })).isError, false);
    });

    it("no run, no control: a conversation the person has not started cannot act", async () => {
        const r = rig();
        const result = await r.client("nobody").call("screenshot");
        assert.match(result.text, /^control_released: Nobody has given you control/);
    });

    it("an offline Pi is reported without the address or the credentials", async () => {
        const presence = createPresence();
        const desk = createDesk({
            target: async () => ({
                origin: new URL("http://127.0.0.1:1"),
                headers: { "X-KVMD-User": USER, "X-KVMD-Passwd": SECRET },
                rejectUnauthorized: false,
            }),
            images,
            presence,
            activity: createActivity(),
            connectMs: 400,
        });
        rigs.push({ desk, stop: () => desk.dispose() });
        const mcp = createPikvmMcp({ desk, approver: unavailableApprover });
        desk.beginRun("a");
        const result = await createTestClient(inProcessTransport(mcp, { conversationId: "a" })).call("screenshot");
        assert.match(result.text, /^target_offline:/);
        assert.ok(!JSON.stringify(result).includes(SECRET) && !result.text.includes("127.0.0.1"));
    });
});

describe("approvals", () => {
    const bar = async (r: ReturnType<typeof rig>) => {
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        return c;
    };

    it("a risky chord asks first and is sent only when approved", async () => {
        const r = rig();
        const c = await bar(r);
        const result = await c.call("key", { keys: ["alt+F4"] });
        assert.equal(result.isError, false);
        assert.equal(r.approver.requests.length, 1);
        assert.equal(r.approver.requests[0]?.title, "Press alt+F4 on the PiKVM?");
        await quiet();
        assert.deepEqual(types(await fake.hid("key")), ["key:AltLeft:down", "key:F4:down", "key:F4:up", "key:AltLeft:up"]);
    });

    it("a denial sends nothing at all", async () => {
        const r = rig();
        const c = await bar(r);
        r.approver.answer = "denied";
        const result = await c.call("key", { keys: ["alt+F4"] });
        assert.match(result.text, /^approval_denied:/);
        await quiet();
        assert.deepEqual(await fake.hid(), []);
    });

    it("with nobody to ask, risky input is refused rather than queued", async () => {
        const r = rig({ approver: unavailableApprover });
        const c = await bar(r);
        for (const [tool, args] of [
            ["key", { keys: ["super"] }],
            ["drag", { from: { x: 1, y: 1 }, to: { x: 5, y: 5 } }],
            ["type_text", { text: "ls\n" }],
        ] as const) {
            const result = await c.call(tool, args);
            assert.match(result.text, /^approval_denied: Nobody could be asked/, tool);
        }
        await quiet();
        assert.deepEqual(await fake.hid(), []);
    });

    it("plain clicks, moves, short typing and looking never ask", async () => {
        const r = rig();
        const c = await bar(r);
        await c.call("click", { x: 5, y: 5 });
        await c.call("mouse_move", { x: 6, y: 6 });
        await c.call("type_text", { text: "hello" });
        await c.call("key", { keys: ["ctrl+c"] });
        await c.call("scroll", { x: 5, y: 5 });
        await c.call("screenshot");
        await c.call("read_text");
        assert.deepEqual(r.approver.requests, []);
    });

    it("the KVM tab is told while the person is being asked", async () => {
        const gate = Promise.withResolvers<void>();
        const r = rig();
        const c = await bar(r);
        r.approver.decide = async () => {
            await gate.promise;
            return "approved";
        };
        const call = c.call("key", { keys: ["alt+F4"] });
        await until(() => r.activity.current().state === "waiting_approval", "the activity to wait for approval");
        assert.equal(r.activity.current().tool, "key");
        gate.resolve();
        await call;
        assert.equal(r.activity.current().state, "working");
    });
});

describe("a person's input ends the agent's control", () => {
    let proxyServer: Server;
    let presence = createPresence();
    const sockets: WebSocket[] = [];

    /** The real kvmd proxy in front of the fake, with its HID tap wired to the presence the desk listens to. */
    async function startProxy(into: ReturnType<typeof createPresence>): Promise<string> {
        const proxy = createPiKvmProxy({
            control: {
                proxyTarget: async () => ({ origin: new URL(fake.url), headers: {}, rejectUnauthorized: false }),
            } as unknown as PiKvmControl,
            onHidInput: (kind) => into.note(kind),
        });
        proxyServer = createServer((req, res) => void proxy.handleHttp(req, res));
        proxyServer.on("upgrade", (req, socket, head) => void proxy.handleUpgrade(req, socket, head));
        await new Promise<void>((done) => proxyServer.listen(0, "127.0.0.1", done));
        return `127.0.0.1:${(proxyServer.address() as AddressInfo).port}`;
    }

    async function person(host: string): Promise<WebSocket> {
        const ws = new WebSocket(`ws://${host}/api/ws`);
        sockets.push(ws);
        await new Promise<void>((done, fail) => {
            ws.once("open", () => done());
            ws.once("error", fail);
        });
        return ws;
    }

    afterEach(async () => {
        for (const ws of sockets.splice(0)) ws.terminate();
        await new Promise<void>((done) => proxyServer?.close(() => done()));
    });

    /** A rig whose desk hears the proxy. */
    async function wired(options: RigOptions = {}) {
        presence = createPresence();
        const host = await startProxy(presence);
        const r = rig(options);
        // The rig made its own presence; the proxy feeds the test's, which forwards to it.
        presence.subscribe((e) => r.presence.note(e.kind));
        const user = await person(host);
        return { r, user, host };
    }

    it("stops a drag in flight, lifts the button, and answers control_released until control is handed back", async () => {
        const { r, user } = await wired({ timing: { dragHoldMs: 300 } });
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        const drag = c.call("drag", { from: { x: 10, y: 10 }, to: { x: 300, y: 170 } }, );
        await until(async () => (await fake.state()).buttonsDown.includes("left"), "the button to go down");
        user.send(JSON.stringify({ event_type: "mouse_move", event: { to: { x: 100, y: 100 } } }));
        const result = await drag;
        assert.equal(result.isError, true);
        assert.match(result.text, /^control_released: The person took over/);
        await until(async () => (await fake.state()).buttonsDown.length === 0, "the button to come up");
        const buttons = types(await fake.hid("mouse_button"));
        assert.deepEqual(buttons, ["button:left:down", "button:left:up"]);

        const after = await c.call("screenshot");
        assert.match(after.text, /^control_released:/);
        assert.equal(r.desk.handBack(), 1);
        assert.equal((await c.call("screenshot")).isError, false);
        assert.equal((await c.call("click", { x: 5, y: 5 })).isError, false);
        assert.deepEqual(
            r.seen.map((a) => a.state).filter((s, i, all) => s !== all[i - 1]),
            ["working", "waiting_approval", "working", "released", "working"],
            "a drag asks first, then runs, then the person takes over, then control is handed back",
        );
        assert.equal(r.seen.find((a) => a.state === "released")?.reason, "operator");
    });

    it("lifts the modifiers and key of a chord the person interrupted", async () => {
        const { r, user } = await wired({ timing: { chordHoldMs: 400 }, policy: { approval: "never" } });
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        const chord = c.call("key", { keys: ["ctrl+alt+Delete"] });
        await until(async () => (await fake.state()).keysDown.includes("Delete"), "the chord to be held");
        user.send(JSON.stringify({ event_type: "key", event: { key: "KeyA", state: true } }));
        assert.match((await chord).text, /^control_released:/);
        await until(async () => (await fake.state()).keysDown.filter((k) => k !== "KeyA").length === 0, "the chord to be lifted");
        assert.deepEqual((await fake.state()).keysDown, ["KeyA"], "only the person's own key is down");
    });

    it("any real input does it: a button, the wheel, a key, a binary frame, and a paste over HTTP", async () => {
        const frames: [string, (user: WebSocket, host: string) => Promise<void> | void][] = [
            ["mouse_button", (u) => u.send(JSON.stringify({ event_type: "mouse_button", event: { button: "left", state: true } }))],
            ["mouse_wheel", (u) => u.send(JSON.stringify({ event_type: "mouse_wheel", event: { delta: { x: 0, y: 1 } } }))],
            ["mouse_relative", (u) => u.send(JSON.stringify({ event_type: "mouse_relative", event: { delta: { x: 1, y: 1 }, squash: true } }))],
            ["a binary key frame", (u) => u.send(Buffer.from([1, 0b10, 0x41]))],
            ["a paste", async (_u, host) => void (await fetch(`http://${host}/api/hid/print?limit=0`, { method: "POST", body: "pasted" }))],
        ];
        for (const [name, send] of frames) {
            const { r, user, host } = await wired();
            r.desk.beginRun("a");
            const c = r.client("a");
            await c.call("screenshot");
            await send(user, host);
            await until(async () => (await c.call("screen_info")).text.includes("released"), `${name} to release control`);
            assert.match((await c.call("click", { x: 5, y: 5 })).text, /^control_released:/, name);
            await r.stop();
            await Promise.all(sockets.splice(0).map((s) => s.terminate()));
            await new Promise<void>((done) => proxyServer.close(() => done()));
        }
    });

    it("a heartbeat is not input", async () => {
        const { r, user } = await wired();
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        user.send(JSON.stringify({ event_type: "ping", event: {} }));
        user.send("ping");
        user.send(Buffer.from([0]));
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal((await c.call("click", { x: 5, y: 5 })).isError, false);
    });

    it("input from before the run began does not count, and moving the mouse back never returns control", async () => {
        const { r, user } = await wired();
        user.send(JSON.stringify({ event_type: "mouse_move", event: { to: { x: 1, y: 1 } } }));
        await until(() => r.presence.lastInputAt() > 0, "the proxy to see the move");
        await new Promise((resolve) => setTimeout(resolve, 5));
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        assert.equal((await c.call("click", { x: 5, y: 5 })).isError, false);
        user.send(JSON.stringify({ event_type: "mouse_move", event: { to: { x: 2, y: 2 } } }));
        await until(async () => (await c.call("screen_info")).text.includes("released"), "the release");
        user.send(JSON.stringify({ event_type: "mouse_move", event: { to: { x: 3, y: 3 } } }));
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.match((await c.call("click", { x: 5, y: 5 })).text, /^control_released:/);
        // A new message from the person is the explicit act that returns it.
        r.desk.beginRun("a");
        assert.equal((await c.call("screenshot")).isError, false);
    });

    it("an approval the person is deciding is abandoned when they take over, and nothing is sent", async () => {
        const { r, user } = await wired();
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        let asked: AbortSignal | undefined;
        r.approver.decide = (request) => {
            asked = request.signal;
            return new Promise((resolve) => request.signal.addEventListener("abort", () => resolve("approved"), { once: true }));
        };
        const call = c.call("key", { keys: ["alt+F4"] });
        await until(() => asked !== undefined, "the question");
        user.send(JSON.stringify({ event_type: "key", event: { key: "KeyB", state: true } }));
        const result = await call;
        assert.match(result.text, /^control_released:/);
        await quiet();
        assert.deepEqual(types(await fake.hid("key")).filter((k) => k.includes("F4")), []);
    });
});

describe("who holds the desk", () => {
    it("one conversation at a time; the other is told, and may take it once the first is done", async () => {
        const r = rig();
        r.desk.beginRun("a");
        r.desk.beginRun("b");
        const a = r.client("a");
        const b = r.client("b");
        assert.equal((await a.call("screenshot")).isError, false);
        const blocked = await b.call("screenshot");
        assert.match(blocked.text, /^another_conversation_holds_control:/);
        assert.equal(r.desk.busy(), true);
        r.desk.endRun("a");
        assert.equal((await b.call("screenshot")).isError, false);
        r.desk.endRun("b");
        assert.equal(r.desk.busy(), false);
        assert.equal(r.activity.current().state, "idle");
    });

    it("a lease that has run out is taken back, and its next call is refused", async () => {
        let t = 1_000_000;
        const r = rig({ leaseMs: 60_000, now: () => t });
        r.desk.beginRun("a");
        r.desk.beginRun("b");
        await r.client("a").call("screenshot");
        t += 61_000;
        r.desk.sweepLeases();
        assert.equal(r.activity.current().reason, "lease_timeout");
        assert.match((await r.client("a").call("screenshot")).text, /^control_released: Control timed out/);
        assert.equal((await r.client("b").call("screenshot")).isError, false);
    });

    it("the idle jiggler holds off while the agent has the desk, and goes back to work when it is done", async () => {
        const r = rig();
        let nudges = 0;
        const jiggler = new MouseJiggler({
            control: {
                lastInputAt: () => 0,
                mouseNudge: async () => {
                    nudges++;
                },
            },
            enabled: () => true,
            isAgentBusy: () => r.desk.busy(),
        });
        const tick = () => (jiggler as unknown as { tick(): Promise<void> }).tick();
        (jiggler as unknown as { lastUserActivity: number }).lastUserActivity = Date.now() - 120_000;
        r.desk.beginRun("a");
        await r.client("a").call("screenshot");
        await tick();
        assert.equal(nudges, 0, "busy: no nudge");
        r.desk.endRun("a");
        await tick();
        assert.equal(nudges, 1, "idle again: nudge");
    });
});

describe("credentials stay in the server", () => {
    it("reach kvmd, and appear in no tool result, error or activity event", async () => {
        const r = rig({ policy: { allowPower: true } });
        r.desk.beginRun("a");
        const c = r.client("a");
        await c.call("screenshot");
        await c.call("click", { x: 5, y: 5 });
        await c.call("read_text");
        await c.call("type_text", { text: "hello" });
        await c.call("click", { x: 9999, y: 5 });
        await c.call("power", { action: "reset" });
        const everything = JSON.stringify([r.results, r.seen, r.errors, await c.listTools(), await c.initialize()]);
        assert.ok(!everything.includes(SECRET), "the password");
        assert.ok(!everything.includes("X-KVMD"), "the header names");
        assert.ok(!everything.includes(fake.url), "the address");
        const requests = await fake.requests();
        assert.ok(requests.length > 0 && requests.every((q) => q.authUser === USER), "every HTTP call to kvmd was authenticated");
        assert.ok((await fake.state()).wsAuthUsers.every((u) => u === USER), "and so was the HID socket");
    });
});
