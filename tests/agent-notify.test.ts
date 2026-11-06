/**
 * The agent waits for the person: when a notification goes out, and what it says.
 *
 * Failure modes, before behaviour:
 *  N1. A notification goes out for a person who switched it off, or who has no device.
 *  N2. It goes out while the person is at the app, where the card is already in front of them.
 *  N3. It carries what the agent wants to do (a command, a path): a push crosses a vendor's servers and lands on a lock screen.
 *  N4. One wait notifies again and again (the same card re-sent), or two different waits are folded into one.
 *  N5. A push service that fails breaks the run that asked, or the failure is an unhandled rejection.
 *  N6. A settings file from before this setting existed turns it off.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GRID_CELLS } from "../src/server/watch/frame-diff";
import { limitsFromEnv } from "../src/server/watch/limits";
import { createWatchService, type WatchService } from "../src/server/watch/service";
import { fakeOcr, fakePush, tempDir, tempStore, type FakePush, type TempDir } from "./support/watch-rig";

let dir: TempDir;
let push: FakePush;
let service: WatchService;
let clock = 1_000_000;
const logs: string[] = [];

beforeEach(() => {
    dir = tempDir();
    push = fakePush();
    push.subscriptions = [{ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "a", auth: "b" }, userAgent: "", createdAt: 0 }];
    clock = 1_000_000;
    logs.length = 0;
    const store = tempStore(dir.path);
    service = createWatchService({
        chat: {
            smallText: async () => undefined,
            hasSmallModel: () => false,
            userDir: (id) => join(dir.path, "users", id),
        },
        target: async () => {
            throw new Error("unused");
        },
        images: { resize: async () => null, crop: async () => null, gray: async () => new Uint8Array(GRID_CELLS) },
        dataDir: dir.path,
        limits: limitsFromEnv({}),
        ocr: fakeOcr(),
        store,
        push,
        snapshot: async () => ({ kind: "no-signal" }),
        schedule: () => () => undefined,
        now: () => clock,
        log: (line) => void logs.push(line),
    });
});
afterEach(() => {
    service.stop();
    dir.remove();
});

const settle = () => new Promise<void>((done) => setImmediate(done));

describe("the agent needs the person", () => {
    it("sends one notification, in words that say nothing about the action", async () => {
        service.agentNeeds("operator", "c1", "approval");
        await settle();
        assert.equal(push.sent.length, 1);
        const { payload, options } = push.sent[0]!;
        assert.equal(payload.body, "The agent needs your approval.");
        assert.equal(payload.url, "/app/chat");
        assert.equal(options?.urgency, "high");
        assert.ok((options?.ttlSeconds ?? 0) <= 15 * 60, "a late approval is not delivered");
    });

    it("names a question and a form for what they are", async () => {
        service.agentNeeds("operator", "c1", "question");
        service.agentNeeds("operator", "c2", "input");
        await settle();
        assert.deepEqual(push.sent.map((s) => s.payload.body), ["The agent has a question for you.", "The agent needs some information from you."]);
    });

    it("sends nothing when the person switched it off, and the setting is kept", async () => {
        service.update("operator", { notifyAgent: false });
        service.agentNeeds("operator", "c1", "approval");
        await settle();
        assert.equal(push.sent.length, 0);
        assert.equal(service.view("operator").notifyAgent, false);
    });

    it("sends nothing when no device is set up", async () => {
        push.subscriptions = [];
        service.agentNeeds("operator", "c1", "approval");
        await settle();
        assert.equal(push.sent.length, 0);
    });

    it("holds it back while the person is at the app, and sends again once they are not", async () => {
        service.presence("operator", "page", { focused: true, keyboardAgoMs: 500, pointerAgoMs: null });
        service.agentNeeds("operator", "c1", "approval");
        await settle();
        assert.equal(push.sent.length, 0);
        clock += 10 * 60_000;
        service.agentNeeds("operator", "c1", "approval");
        await settle();
        assert.equal(push.sent.length, 1);
    });

    it("tells one wait once, but a later wait, another conversation and another kind each count", async () => {
        service.agentNeeds("operator", "c1", "approval");
        service.agentNeeds("operator", "c1", "approval");
        clock += 5_000;
        service.agentNeeds("operator", "c1", "approval");
        await settle();
        assert.equal(push.sent.length, 1, "the same wait inside 20 seconds");
        service.agentNeeds("operator", "c2", "approval");
        service.agentNeeds("operator", "c1", "question");
        await settle();
        assert.equal(push.sent.length, 3);
        clock += 30_000;
        service.agentNeeds("operator", "c1", "approval");
        await settle();
        assert.equal(push.sent.length, 4, "a later wait");
    });

    it("a push service that fails is logged and goes no further", async () => {
        push.fail = new Error("the push service is down");
        service.agentNeeds("operator", "c1", "approval");
        await settle();
        assert.ok(logs.some((line) => /agent notification not sent: the push service is down/.test(line)));
    });

    it("a settings file from before the setting existed has it on", () => {
        const store = tempStore(dir.path);
        store.write("older", { rule: "x" });
        const file = join(dir.path, "users", "older", "watch", "settings.json");
        void file;
        assert.equal(store.read("older").notifyAgent, true);
    });
});
