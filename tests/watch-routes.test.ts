/**
 * `/app/api/v1/watch/*` over HTTP, and the files behind it.
 *
 * Failure modes, before behaviour:
 *  R1. A malformed, oversized or mistyped body is a 500, or is half applied.
 *  R2. The reply to any read carries the key or a subscription endpoint.
 *  R3. Switching on where the host cannot read pop-ups answers 200.
 *  R4. The subscribe route trusts the browser's endpoint, or names the wrong sender to the push service.
 *  R5. The check log or settings are readable by other users of the machine, or a half-written line breaks reading it.
 *  R6. The log grows without end.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ALERT_ZONES, DEFAULT_ALERT_ZONE } from "@pikvm/contracts/watch";
import { GRID_CELLS } from "../src/server/watch/frame-diff";
import { limitsFromEnv } from "../src/server/watch/limits";
import { createPush } from "../src/server/watch/push";
import { createWatchRoutes } from "../src/server/watch/routes";
import { createWatchService } from "../src/server/watch/service";
import { createWatchStore, parseZone, SettingsError } from "../src/server/watch/store";
import { startFakePush, type FakePushService } from "../tools/fake-push/server";
import { fakeOcr, tempDir, tempStore } from "./support/watch-rig";

const dir = tempDir();
after(() => dir.remove());

let remote: FakePushService;
let server: Server;
let origin = "";
let canRead = true;
const ocr = fakeOcr();

before(async () => {
    remote = await startFakePush();
    ocr.unavailable = () => (canRead ? undefined : "no OCR here");
    const chat = {
        smallText: async (): Promise<string | undefined> => undefined,
        hasSmallModel: (): boolean => false,
        userDir: (userId: string) => join(dir.path, "chat", "users", userId),
    };
    const store = createWatchStore({ userDir: chat.userDir, usersRoot: () => join(dir.path, "chat", "users") });
    const service = createWatchService({
        chat,
        target: async () => {
            throw new Error("unused");
        },
        images: { resize: async () => null, crop: async () => null, gray: async () => new Uint8Array(GRID_CELLS) },
        dataDir: dir.path,
        limits: limitsFromEnv({}),
        ocr: ocr,
        store,
        push: createPush({ dataDir: dir.path, subscriptionsFile: (id) => store.subscriptionsFile(id), allowLocalEndpoints: true }),
        snapshot: async () => ({ kind: "no-signal" }),
        schedule: () => () => undefined,
        log: () => undefined,
    });
    const routes = createWatchRoutes(service, "operator");
    server = createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://x").pathname;
        if (!routes.handles(path)) {
            res.writeHead(404).end();
            return;
        }
        void routes.handle(req, res, path);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    await remote.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
});

async function call(path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
    const res = await fetch(`${origin}/app/api/v1/watch${path}`, {
        method: init.method ?? "GET",
        headers: { "content-type": "application/json", ...init.headers },
        ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

describe("reading and changing the settings", () => {
    it("R2: GET is the view, and holds neither the key nor any endpoint", async () => {
        const subscription = remote.subscribe();
        await call("/subscribe", { method: "POST", body: JSON.stringify({ subscription: { endpoint: subscription.endpoint, keys: subscription.keys } }) });
        const { status, json, text } = await call("");
        assert.equal(status, 200);
        assert.equal(json["enabled"], false);
        assert.equal(json["canEnable"].ok, true);
        assert.equal(json["push"].subscriptions, 1);
        assert.ok(!text.includes(subscription.endpoint));
        assert.ok(!text.includes(subscription.keys.auth));
    });

    it("R3: PATCH where the host cannot read pop-ups is a 409 with the reason; where it can it switches on and reports it", async () => {
        canRead = false;
        const refused = await call("", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
        assert.equal(refused.status, 409);
        assert.match(refused.json["error"], /cannot read pop-ups: no OCR here/);
        canRead = true;
        const on = await call("", { method: "PATCH", body: JSON.stringify({ enabled: true, rule: "tell me about errors" }) });
        assert.equal(on.status, 200);
        assert.equal(on.json["enabled"], true);
        assert.equal(on.json["running"], true);
        assert.equal(on.json["chatModel"], false);
        assert.equal(on.json["rule"], "tell me about errors");
        const off = await call("", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
        assert.equal(off.json["enabled"], false);
        assert.equal(off.json["rule"], "tell me about errors", "off keeps the rule");
        assert.equal(off.json["running"], false);
    });

    it("R1: a body that is not a JSON object, has the wrong types, or is too large is a 400 and changes nothing", async () => {
        for (const body of ["not json", "[1]", "null", JSON.stringify({ enabled: "yes" }), JSON.stringify({ rule: 5 }), JSON.stringify({ alertZone: 5 }), JSON.stringify({ rule: "x".repeat(40_000) })]) {
            const reply = await call("", { method: "PATCH", body });
            assert.equal(reply.status, 400, body.slice(0, 40));
            assert.ok(typeof reply.json["error"] === "string");
        }
        assert.equal((await call("")).json["rule"], "tell me about errors");
        assert.equal((await call("", { method: "DELETE" })).status, 405);
        assert.equal((await call("/test", { method: "GET" })).status, 405);
        assert.equal((await call("/nothing", { method: "POST", body: "{}" })).status, 404);
    });
});

describe("the corner", () => {
    it("R7: bottom right until asked; a chosen corner is kept; a zone that is not four fractions of the frame, or too small, is a 400", async () => {
        const view = (await call("")).json;
        assert.deepEqual(view["alertZone"], DEFAULT_ALERT_ZONE);
        assert.deepEqual(view["limits"], { intervalSec: 1, settleSec: 1.2, minCheckGapSec: 4, dailyCap: 500, askedToday: 0 });
        const topRight = ALERT_ZONES[1].zone;
        const set = await call("", { method: "PATCH", body: JSON.stringify({ alertZone: topRight }) });
        assert.deepEqual(set.json["alertZone"], topRight);
        assert.deepEqual((await call("", { method: "PATCH", body: JSON.stringify({ rule: "anything" }) })).json["alertZone"], topRight, "saving something else leaves it");
        const bodies = [
            { alertZone: null },
            { alertZone: [0, 0, 1, 1] },
            { alertZone: { x0: 0, y0: 0, x1: 1 } },
            { alertZone: { x0: "0", y0: 0, x1: 1, y1: 1 } },
            { alertZone: { x0: -0.1, y0: 0, x1: 1, y1: 1 } },
            { alertZone: { x0: 0, y0: 0, x1: 1.5, y1: 1 } },
            { alertZone: { x0: 0.6, y0: 0, x1: 0.5, y1: 1 } },
            { alertZone: { x0: 0, y0: 0, x1: 0.02, y1: 1 } },
        ];
        for (const body of bodies) assert.equal((await call("", { method: "PATCH", body: JSON.stringify(body) })).status, 400, JSON.stringify(body));
        assert.deepEqual((await call("")).json["alertZone"], topRight);
        await call("", { method: "PATCH", body: JSON.stringify({ alertZone: DEFAULT_ALERT_ZONE }) });
    });

    it("the removed settings are not settings any more: they are ignored, not stored", async () => {
        const reply = await call("", { method: "PATCH", body: JSON.stringify({ fastAlerts: true, fastSummary: true, visionModel: "a/b", summaryModel: "c/d" }) });
        assert.equal(reply.status, 200);
        for (const key of ["fastAlerts", "fastSummary", "visionModel", "summaryModel"]) assert.ok(!(key in reply.json), key);
    });
});

describe("devices", () => {
    it("R4: a subscription from outside the push services is refused; one from a device is kept, naming the origin it came from", async () => {
        const bad = await call("/subscribe", { method: "POST", body: JSON.stringify({ subscription: { endpoint: "https://127.0.0.1:9/x", keys: { p256dh: "a", auth: "b" } } }) });
        assert.equal(bad.status, 400);
        const missing = await call("/subscribe", { method: "POST", body: "{}" });
        assert.equal(missing.status, 400);

        const device = remote.subscribe();
        const ok = await call("/subscribe", {
            method: "POST",
            body: JSON.stringify({ subscription: { endpoint: device.endpoint, keys: device.keys } }),
            headers: { "x-forwarded-host": "kvm.example.org", "x-forwarded-proto": "https" },
        });
        assert.equal(ok.status, 200);
        const sent = await call("/test", { method: "POST", body: "{}" });
        assert.equal(sent.status, 200);
        assert.ok(sent.json["sent"] >= 1);
        const got = remote.received.filter((entry) => entry.id === device.id);
        assert.equal(got.length, 1);
        assert.equal(got[0]!.vapid.subject, "https://kvm.example.org");
        assert.equal((got[0]!.payload as { url: string }).url, "/app/");
    });

    it("an expired device is dropped by the test and the others still get it; unsubscribing removes one", async () => {
        const live = remote.subscribe();
        const expired = remote.subscribe();
        for (const device of [live, expired]) {
            await call("/subscribe", { method: "POST", body: JSON.stringify({ subscription: { endpoint: device.endpoint, keys: device.keys } }) });
        }
        remote.setStatus(expired.id, 410);
        const before = (await call("")).json["push"].subscriptions;
        const sent = await call("/test", { method: "POST", body: "{}" });
        assert.equal(sent.status, 200);
        assert.equal(sent.json["removed"], 1);
        assert.equal((await call("")).json["push"].subscriptions, before - 1);
        const gone = await call("/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: live.endpoint }) });
        assert.deepEqual(gone.json, { removed: true });
        assert.deepEqual((await call("/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: live.endpoint }) })).json, { removed: false });
        assert.equal((await call("/unsubscribe", { method: "POST", body: "{}" })).status, 400);
    });

    it("the check log is served newest first, bounded", async () => {
        const { status, json } = await call("/checks?limit=500");
        assert.equal(status, 200);
        assert.ok(json["checks"].length >= 1);
        assert.ok(json["checks"].length <= 100);
        assert.equal(json["checks"][0].kind, "test");
        assert.equal((await call("/checks?limit=abc")).status, 200);
    });
});

describe("the files", () => {
    const entry = (t: number, asked = true) => ({ t, at: new Date(t).toISOString(), kind: "change" as const, score: 0.1, outcome: "no" as const, asked });

    it("R5: settings and log are 0600 in a 0700 directory, and a half-written line is skipped", () => {
        const root = tempDir();
        after(() => root.remove());
        const store = tempStore(root.path);
        store.write("u", { enabled: true, rule: "r" });
        store.append("u", entry(1000));
        const watchDir = join(root.path, "users", "u", "watch");
        assert.equal(statSync(watchDir).mode & 0o777, 0o700);
        assert.equal(statSync(join(watchDir, "settings.json")).mode & 0o777, 0o600);
        assert.equal(statSync(join(watchDir, "checks.jsonl")).mode & 0o777, 0o600);
        appendFileSync(join(watchDir, "checks.jsonl"), '{"t": 2000, "at": "tru');
        store.append("u", entry(3000));
        assert.deepEqual(store.log("u", 10).map((each) => each.t), [3000, 1000], "the broken line is skipped, the later one is kept");
        assert.deepEqual(store.userIds(), ["u"]);
    });

    it("reads a settings file that is damaged or from an older version as the settings it can make sense of", () => {
        const root = tempDir();
        after(() => root.remove());
        const store = tempStore(root.path);
        store.write("u", { enabled: true });
        const file = join(root.path, "users", "u", "watch", "settings.json");
        writeFileSync(file, "{ nope");
        assert.deepEqual(store.read("u"), { enabled: false, rule: "", alertZone: DEFAULT_ALERT_ZONE });
        writeFileSync(file, JSON.stringify({ enabled: true, rule: 5, visionModel: "bad model", fastAlerts: true, extra: 1 }));
        assert.deepEqual(store.read("u"), { enabled: true, rule: "", alertZone: DEFAULT_ALERT_ZONE });
    });

    it("R8: the zone is stored, validated and read back; a damaged zone is the default", () => {
        const root = tempDir();
        after(() => root.remove());
        const store = tempStore(root.path);
        assert.deepEqual(store.write("u", { alertZone: ALERT_ZONES[2].zone }).alertZone, ALERT_ZONES[2].zone);
        assert.throws(() => store.write("u", { alertZone: { x0: 0, y0: 0, x1: 0.01, y1: 1 } }), SettingsError);
        assert.throws(() => store.write("u", { alertZone: { x0: 0, y0: 0, x1: Number.NaN, y1: 1 } }), SettingsError);
        assert.deepEqual(store.read("u").alertZone, ALERT_ZONES[2].zone, "a refused zone changes nothing");
        writeFileSync(join(root.path, "users", "u", "watch", "settings.json"), JSON.stringify({ enabled: true, alertZone: { x0: 2, y0: 0, x1: 3, y1: 1 } }));
        assert.deepEqual(store.read("u"), { enabled: true, rule: "", alertZone: DEFAULT_ALERT_ZONE });
        assert.deepEqual(parseZone({ x0: 0.5, y0: 0.5, x1: 0.56, y1: 0.56 }), { x0: 0.5, y0: 0.5, x1: 0.56, y1: 0.56 });
        assert.equal(parseZone({ x0: 0.5, y0: 0.5, x1: 0.54, y1: 1 }), undefined);
    });

    it("R8: the daily count reads both files and counts only what was read", () => {
        const root = tempDir();
        after(() => root.remove());
        const store = tempStore(root.path);
        store.append("u", { ...entry(2000), kind: "alert" });
        store.append("u", { ...entry(3000), kind: "alert" });
        store.append("u", { ...entry(4000), kind: "alert", asked: false, outcome: "skipped" });
        assert.equal(store.askedSince("u", 0), 2);
        assert.equal(store.askedSince("u", 2500), 1);
    });

    it("R6: the log is rotated at half a megabyte and the daily count reads both files", () => {
        const root = tempDir();
        after(() => root.remove());
        const store = tempStore(root.path);
        const big = { ...entry(1), description: "x".repeat(2000) };
        for (let i = 0; i < 300; i++) store.append("u", { ...big, t: 1000 + i });
        const file = join(root.path, "users", "u", "watch", "checks.jsonl");
        assert.ok(existsSync(`${file}.1`), "rotated");
        assert.ok(statSync(file).size < 600 * 1024);
        assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length + readFileSync(`${file}.1`, "utf8").split("\n").filter(Boolean).length, 300);
        assert.equal(store.askedSince("u", 0), 300);
        assert.equal(store.askedSince("u", 1000 + 299), 1);
        store.append("u", entry(9000, false));
        assert.equal(store.askedSince("u", 0), 300, "a skipped change is not a check");
    });
});
