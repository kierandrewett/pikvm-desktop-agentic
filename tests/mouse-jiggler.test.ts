import assert from "node:assert/strict";
import test from "node:test";
import { MouseJiggler, type JigglerControl } from "../src/mouse-jiggler";
import { makeHidTap } from "../src/server/proxy/kvmd";

/** A control stub that records nudges and can be told to fail. */
function stubControl(overrides: Partial<JigglerControl> = {}) {
    const state = {
        nudges: 0,
        lastInput: 0,
        fail: undefined as string | undefined,
        hidOnline: undefined as boolean | undefined,
        native: undefined as { enabled?: boolean; active?: boolean } | undefined,
        nativeSets: [] as boolean[],
        nativeFail: undefined as string | undefined,
        connects: 0,
        connectFail: undefined as string | undefined,
    };
    const control: JigglerControl = {
        lastInputAt: () => state.lastInput,
        connect: async () => {
            state.connects++;
            if (state.connectFail) throw new Error(state.connectFail);
        },
        isHidOnline: () => state.hidOnline,
        getNativeJiggler: () => state.native,
        setNativeJiggler: async (on: boolean) => {
            if (state.nativeFail) throw new Error(state.nativeFail);
            state.nativeSets.push(on);
        },
        mouseNudge: async () => {
            if (state.fail) throw new Error(state.fail);
            state.nudges++;
            state.lastInput = Date.now();
        },
        ...overrides,
    };
    return { control, state };
}

/** Drive the private tick loop directly — the real one is a 10s interval. */
const tick = (j: MouseJiggler) => (j as unknown as { tick(): Promise<void> }).tick();

test("nudges once the target has been idle, and holds off while the user is driving", async () => {
    const { control, state } = stubControl();
    const jiggler = new MouseJiggler({ control, enabled: () => true, isAgentBusy: () => false });

    // Fresh activity: nothing to do.
    jiggler.noteUserActivity();
    await tick(jiggler);
    assert.equal(state.nudges, 0);

    // Idle past the threshold: nudge.
    state.lastInput = Date.now() - 120_000;
    (jiggler as unknown as { lastUserActivity: number }).lastUserActivity = Date.now() - 120_000;
    await tick(jiggler);
    assert.equal(state.nudges, 1);
    assert.ok(jiggler.status().lastNudgeAt > 0);

    // The nudge itself resets the idle clock, so the next tick holds off.
    await tick(jiggler);
    assert.equal(state.nudges, 1);
});

test("never nudges while disabled or while the agent is busy", async () => {
    const { control, state } = stubControl();
    state.lastInput = Date.now() - 120_000;
    let enabled = false;
    let busy = true;
    const jiggler = new MouseJiggler({ control, enabled: () => enabled, isAgentBusy: () => busy });

    await tick(jiggler);
    assert.equal(state.nudges, 0);
    enabled = true;
    await tick(jiggler);
    assert.equal(state.nudges, 0, "agent busy must still block the nudge");
    busy = false;
    await tick(jiggler);
    assert.equal(state.nudges, 1);
});

test("a failing nudge is reported and the jiggler keeps trying", async () => {
    const { control, state } = stubControl();
    const logs: string[] = [];
    const jiggler = new MouseJiggler({ control, enabled: () => true, isAgentBusy: () => false, log: (l) => logs.push(l) });

    state.lastInput = Date.now() - 120_000;
    state.fail = "websocket closed";
    await tick(jiggler);
    assert.equal(jiggler.status().failures, 1);
    assert.equal(jiggler.status().lastError, "websocket closed");
    assert.match(logs.join("\n"), /nudge failed/);

    // Still idle (a failed nudge doesn't touch the input clock), so it tries again.
    state.fail = undefined;
    await tick(jiggler);
    assert.equal(state.nudges, 1);
    assert.equal(jiggler.status().failures, 0);
});

test("a detached HID counts as a failure, not a silent success", async () => {
    const { control, state } = stubControl();
    state.lastInput = Date.now() - 120_000;
    state.hidOnline = false;
    const jiggler = new MouseJiggler({ control, enabled: () => true, isAgentBusy: () => false });
    await tick(jiggler);
    assert.equal(state.nudges, 0);
    assert.match(jiggler.status().lastError ?? "", /detached/);
});

test("the Pi's own jiggler is left to do the work when it is running", async () => {
    const { control, state } = stubControl();
    state.lastInput = Date.now() - 120_000;
    state.native = { enabled: true, active: true };
    const jiggler = new MouseJiggler({ control, enabled: () => true, isAgentBusy: () => false });

    await tick(jiggler);
    assert.equal(state.nudges, 0, "nudging as well as the Pi would just move the cursor twice");
    assert.deepEqual(state.nativeSets, [], "already on — nothing to switch");
    assert.equal(jiggler.status().mode, "pi");
});

test("the Pi's jiggler is switched back on every time something turns it off", async () => {
    const { control, state } = stubControl();
    state.lastInput = Date.now() - 120_000;
    state.native = { enabled: true, active: false };
    const logs: string[] = [];
    const jiggler = new MouseJiggler({ control, enabled: () => true, isAgentBusy: () => false, log: (l) => logs.push(l) });

    await tick(jiggler);
    assert.deepEqual(state.nativeSets, [true]);

    // kvmd echoes the new state back; we then leave it alone.
    state.native = { enabled: true, active: true };
    await tick(jiggler);
    assert.deepEqual(state.nativeSets, [true], "no repeat switch while it is on");

    // Another client (or a kvmd restart) turns it off — switch it straight back on.
    state.native = { enabled: true, active: false };
    await tick(jiggler);
    assert.deepEqual(state.nativeSets, [true, true]);
    assert.equal(jiggler.status().nativeSwitchOns, 2);
    assert.match(logs.join("\n"), /switching it back on/);
});

test("the Pi's state socket is opened before deciding anything", async () => {
    // The control core opens it lazily inside the first send, and nothing else opens
    // it — so without this the jiggler is blind to hid state and nudges locally on a
    // board whose own jiggler it should have used.
    const { control, state } = stubControl();
    state.lastInput = Date.now() - 120_000;
    state.native = { enabled: true, active: false };
    const jiggler = new MouseJiggler({ control, enabled: () => true, isAgentBusy: () => false });

    await tick(jiggler);
    assert.equal(state.connects, 1);
    assert.deepEqual(state.nativeSets, [true], "must reach the native jiggler on the FIRST tick");
    assert.equal(state.nudges, 0, "and must not nudge locally on a board that has its own");
});

test("start() seeds the idle clock so boot does not count as idle", async () => {
    // lastActivity() is 0 on a fresh start, so without the seed the first tick reads
    // as decades idle and fires a blind nudge before the Pi's state has arrived.
    const { control, state } = stubControl();
    const jiggler = new MouseJiggler({ control, enabled: () => true, isAgentBusy: () => false });
    jiggler.start();
    try {
        await tick(jiggler);
        assert.equal(state.nudges, 0, "boot must get the full idle grace period");
    } finally {
        jiggler.stop();
    }
});

test("an unreachable state socket does not stop the fallback nudge", async () => {
    const { control, state } = stubControl();
    state.lastInput = Date.now() - 120_000;
    state.connectFail = "ECONNREFUSED";
    const jiggler = new MouseJiggler({ control, enabled: () => true, isAgentBusy: () => false });
    await tick(jiggler);
    assert.equal(state.nudges, 1);
});

test("a board with no native jiggler still gets nudged from here", async () => {
    const { control, state } = stubControl();
    state.lastInput = Date.now() - 120_000;
    state.native = { enabled: false };
    const jiggler = new MouseJiggler({ control, enabled: () => true, isAgentBusy: () => false });

    await tick(jiggler);
    assert.equal(state.nudges, 1);
    assert.deepEqual(state.nativeSets, []);
    assert.equal(jiggler.status().mode, "local");
});

test("if the Pi's jiggler cannot be switched on, we nudge rather than give up", async () => {
    const { control, state } = stubControl();
    state.lastInput = Date.now() - 120_000;
    state.native = { enabled: true, active: false };
    state.nativeFail = "403 Forbidden";
    const jiggler = new MouseJiggler({ control, enabled: () => true, isAgentBusy: () => false });

    await tick(jiggler);
    assert.equal(state.nudges, 1, "a target with no keep-awake at all is the one outcome to avoid");
});

/** Build a masked client→server WebSocket text frame, the way a browser sends one. */
function maskedTextFrame(text: string): Buffer {
    const payload = Buffer.from(text, "utf8");
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.concat([Buffer.from([0x81, 0xfe]), (() => {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(payload.length);
        return b;
    })()]);
    const masked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i & 3]!;
    return Buffer.concat([header, mask, masked]);
}

test("the HID tap reports activity and decodes the cursor position", () => {
    const moves: Array<{ x: number; y: number }> = [];
    let activity = 0;
    const tap = makeHidTap({ onActivity: () => activity++, onMouseMove: (x, y) => moves.push({ x, y }) });

    tap(maskedTextFrame(JSON.stringify({ event_type: "mouse_move", event: { to: { x: -1234, y: 5678 } } })));
    tap(maskedTextFrame(JSON.stringify({ event_type: "key", event: { key: "KeyA", state: true } })));

    assert.equal(activity, 2);
    assert.deepEqual(moves, [{ x: -1234, y: 5678 }]);
});

test("the HID tap reassembles frames split across TCP segments", () => {
    const moves: Array<{ x: number; y: number }> = [];
    const tap = makeHidTap({ onActivity: () => {}, onMouseMove: (x, y) => moves.push({ x, y }) });
    const frame = maskedTextFrame(JSON.stringify({ event_type: "mouse_move", event: { to: { x: 100, y: 200 } } }));

    tap(frame.subarray(0, 9));
    assert.deepEqual(moves, [], "an incomplete frame must not be decoded");
    tap(frame.subarray(9));
    assert.deepEqual(moves, [{ x: 100, y: 200 }]);
});

test("ping/pong frames are not treated as user activity", () => {
    let activity = 0;
    const tap = makeHidTap({ onActivity: () => activity++ });
    tap(Buffer.from([0x89, 0x80, 0x00, 0x00, 0x00, 0x00])); // masked, empty ping
    assert.equal(activity, 0);
});
