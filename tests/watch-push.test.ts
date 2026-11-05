/**
 * Web Push: the key pair, the subscriptions and the send, against a fake push service that decrypts what it gets.
 *
 * Failure modes, before behaviour:
 *  W1. The VAPID key pair is made again (every device's subscription is orphaned), or is readable by other users.
 *  W2. A damaged key file is silently replaced.
 *  W3. A subscription for an address the server must not call (loopback, an internal host, plain http) is accepted.
 *  W4. A push service that says the subscription is gone (404, 410) leaves it stored, so every later push tries it again.
 *  W5. A push service's temporary failure (500) removes a good subscription.
 *  W6. The payload is not what the service worker reads, or is not encrypted for the device, or the VAPID signature is wrong.
 *  W7. A subscription's endpoint is shown in an error the browser sees.
 */
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createPush, endpointAllowed, PushError, type PushSender, type PushSubscriptionJson } from "../src/server/watch/push";
import { startFakePush } from "../tools/fake-push/server";
import { tempDir } from "./support/watch-rig";

const dirs: ReturnType<typeof tempDir>[] = [];
after(() => dirs.forEach((dir) => dir.remove()));

function setup(over: { sender?: PushSender; allowLocal?: boolean; subject?: string } = {}) {
    const dir = tempDir();
    dirs.push(dir);
    const push = createPush({
        dataDir: dir.path,
        subscriptionsFile: (userId) => join(dir.path, `${userId}-subs.json`),
        ...(over.sender ? { sender: over.sender } : {}),
        ...(over.allowLocal ? { allowLocalEndpoints: true } : {}),
        ...(over.subject ? { subject: over.subject } : {}),
        now: () => new Date("2026-11-03T10:00:00Z"),
    });
    return { dir, push };
}

/** A subscription a browser could hand over: a real P-256 key and a 16 byte secret. */
function deviceSubscription(endpoint = "https://fcm.googleapis.com/fcm/send/abc123"): PushSubscriptionJson {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("the VAPID key pair", () => {
    it("W1: is made on first use into the data volume with mode 0600, and is the same afterwards and after a restart", () => {
        const { dir, push } = setup();
        const key = push.publicKey();
        const file = join(dir.path, "push-vapid.json");
        assert.equal(Buffer.from(key, "base64url").length, 65);
        assert.equal(mode(file), 0o600);
        const stored = JSON.parse(readFileSync(file, "utf8"));
        assert.equal(stored.publicKey, key);
        assert.ok(stored.privateKey && stored.createdAt === "2026-11-03T10:00:00.000Z");
        assert.equal(push.publicKey(), key);
        const again = createPush({ dataDir: dir.path, subscriptionsFile: () => join(dir.path, "x.json") });
        assert.equal(again.publicKey(), key);
    });

    it("W1: a file that was left readable by others is tightened", () => {
        const { dir, push } = setup();
        push.publicKey();
        const file = join(dir.path, "push-vapid.json");
        chmodSync(file, 0o644);
        createPush({ dataDir: dir.path, subscriptionsFile: () => "unused" }).publicKey();
        assert.equal(mode(file), 0o600);
    });

    it("W2: a damaged file stops push with a message, and is left as it is", () => {
        const { dir } = setup();
        const file = join(dir.path, "push-vapid.json");
        writeFileSync(file, "{ not json", { mode: 0o600 });
        const push = createPush({ dataDir: dir.path, subscriptionsFile: () => "unused" });
        assert.throws(() => push.publicKey(), (error: unknown) => error instanceof PushError && error.code === "unavailable" && /every device must subscribe again/.test(error.message));
        assert.equal(readFileSync(file, "utf8"), "{ not json");
        writeFileSync(file, JSON.stringify({ publicKey: "short", privateKey: "x" }), { mode: 0o600 });
        assert.throws(() => createPush({ dataDir: dir.path, subscriptionsFile: () => "unused" }).publicKey(), PushError);
    });
});

describe("which endpoints are accepted", () => {
    it("W3: browser vendors' push services only, over https", () => {
        for (const ok of [
            "https://fcm.googleapis.com/fcm/send/x",
            "https://web.push.apple.com/QGx",
            "https://updates.push.services.mozilla.com/wpush/v2/x",
            "https://wns2-par02p.notify.windows.com/w/?token=x",
        ]) assert.equal(endpointAllowed(ok, false), true, ok);
        for (const no of [
            "http://fcm.googleapis.com/x",
            "https://127.0.0.1/x",
            "https://localhost/x",
            "https://169.254.169.254/latest/meta-data",
            "https://fcm.googleapis.com.evil.example/x",
            "https://evilpush.apple.com.example/x",
            "https://fcm.googleapis.com:8443/x",
            "https://kvm.internal/x",
            "javascript:alert(1)",
            "not a url",
        ]) assert.equal(endpointAllowed(no, false), false, no);
    });

    it("local endpoints are accepted only when the host is told to (tests and local runs)", () => {
        assert.equal(endpointAllowed("http://127.0.0.1:4520/push/x", false), false);
        assert.equal(endpointAllowed("http://127.0.0.1:4520/push/x", true), true);
        assert.equal(endpointAllowed("ftp://127.0.0.1/x", true), false);
    });

    it("W3: subscribe refuses a bad address, bad keys and a body that is not a subscription", () => {
        const { push } = setup();
        const good = deviceSubscription();
        assert.throws(() => push.subscribe("u", { ...good, endpoint: "https://127.0.0.1/x" }), (error: unknown) => error instanceof PushError && error.code === "invalid");
        assert.throws(() => push.subscribe("u", { ...good, keys: { ...good.keys, auth: "AAAA" } }), /keys are not the right size/);
        assert.throws(() => push.subscribe("u", { ...good, keys: { p256dh: "AAAA", auth: good.keys.auth } }), /keys are not the right size/);
        assert.throws(() => push.subscribe("u", { endpoint: good.endpoint }), /not a push subscription/);
        assert.throws(() => push.subscribe("u", null), /not a push subscription/);
        assert.throws(() => push.subscribe("u", "https://fcm.googleapis.com/x"), /not a push subscription/);
        assert.deepEqual(push.list("u"), []);
    });
});

describe("subscriptions", () => {
    it("are kept per user, one per endpoint, in a 0600 file, and can be removed", () => {
        const { dir, push } = setup();
        const a = deviceSubscription("https://fcm.googleapis.com/fcm/send/a");
        const b = deviceSubscription("https://web.push.apple.com/b");
        push.subscribe("u1", a, { userAgent: "iPhone", origin: "https://kvm.example.org" });
        push.subscribe("u1", b);
        push.subscribe("u2", a);
        assert.equal(push.list("u1").length, 2);
        assert.equal(push.list("u2").length, 1);
        assert.equal(mode(join(dir.path, "u1-subs.json")), 0o600);
        // Subscribing the same device again replaces it.
        const renewed = deviceSubscription(a.endpoint);
        push.subscribe("u1", renewed);
        assert.equal(push.list("u1").length, 2);
        assert.equal(push.list("u1").find((entry) => entry.endpoint === a.endpoint)!.keys.auth, renewed.keys.auth);
        assert.equal(push.unsubscribe("u1", a.endpoint), true);
        assert.equal(push.unsubscribe("u1", a.endpoint), false);
        assert.deepEqual(push.list("u1").map((entry) => entry.endpoint), [b.endpoint]);
        assert.equal(push.list("u2").length, 1);
    });

    it("sending with none is a PushError that says so", async () => {
        const { push } = setup();
        await assert.rejects(push.send("nobody", { title: "t", body: "b", tag: "x", url: "/app/" }), (error: unknown) => error instanceof PushError && error.code === "none");
    });
});

describe("sending", () => {
    const payload = { title: "PiKVM", body: "Install complete.", tag: "pikvm-screen", url: "/app/" };

    it("W4: a 410 and a 404 remove the subscription, and only that one", async () => {
        const answers = new Map<string, number>([["https://fcm.googleapis.com/gone", 410], ["https://fcm.googleapis.com/missing", 404], ["https://fcm.googleapis.com/fine", 201]]);
        const { push } = setup({
            sender: async (subscription) => {
                const status = answers.get(subscription.endpoint)!;
                if (status >= 400) throw Object.assign(new Error(`Received unexpected response code`), { statusCode: status });
                return { statusCode: status };
            },
        });
        for (const endpoint of answers.keys()) push.subscribe("u", deviceSubscription(endpoint));
        const result = await push.send("u", payload);
        assert.deepEqual({ sent: result.sent, removed: result.removed, failed: result.failed.length }, { sent: 1, removed: 2, failed: 0 });
        assert.deepEqual(push.list("u").map((entry) => entry.endpoint), ["https://fcm.googleapis.com/fine"]);
    });

    it("W5: a 500, a 429 and a network error keep the subscription and are reported by host, not endpoint", async () => {
        const { push } = setup({
            sender: async (subscription) => {
                if (subscription.endpoint.endsWith("/net")) throw new Error("socket hang up");
                throw Object.assign(new Error("Received unexpected response code"), { statusCode: subscription.endpoint.endsWith("/busy") ? 429 : 500 });
            },
        });
        for (const tail of ["down", "busy", "net"]) push.subscribe("u", deviceSubscription(`https://fcm.googleapis.com/fcm/send/${tail}`));
        const result = await push.send("u", payload);
        assert.equal(result.sent, 0);
        assert.equal(result.removed, 0);
        assert.equal(push.list("u").length, 3);
        assert.deepEqual(result.failed.map((failure) => failure.status).sort(), [429, 500, null].sort());
        for (const failure of result.failed) {
            assert.equal(failure.host, "fcm.googleapis.com");
            assert.ok(!JSON.stringify(failure).includes("/fcm/send/"), "W7: no endpoint in what is reported");
        }
    });

    it("names the sender with the origin the device subscribed from, else the configured subject", async () => {
        const seen: string[] = [];
        const sender: PushSender = async (_subscription, _body, options) => {
            seen.push(options.vapid.subject);
            return { statusCode: 201 };
        };
        const { push } = setup({ sender, subject: "mailto:ops@example.org" });
        push.subscribe("u", deviceSubscription("https://fcm.googleapis.com/a"), { origin: "https://kvm.example.org" });
        push.subscribe("u", deviceSubscription("https://fcm.googleapis.com/b"));
        await push.send("u", payload);
        assert.deepEqual(seen.sort(), ["https://kvm.example.org", "mailto:ops@example.org"]);
    });

    it("W6: a real send is encrypted for the device, signed with the server's key, and carries the payload the worker reads", async () => {
        const service = await startFakePush();
        after(() => service.close());
        const { push } = setup({ allowLocal: true });
        const device = service.subscribe();
        push.subscribe("u", { endpoint: device.endpoint, keys: device.keys }, { origin: "https://kvm.example.org" });
        const result = await push.send("u", payload);
        assert.deepEqual(result.failed, []);
        assert.equal(result.sent, 1);
        assert.equal(service.received.length, 1);
        const [got] = service.received;
        assert.deepEqual(got!.payload, payload);
        assert.equal(got!.vapid.publicKey, push.publicKey());
        assert.equal(got!.vapid.signatureValid, true);
        assert.equal(got!.vapid.subject, "https://kvm.example.org");
        assert.equal(got!.vapid.audience, service.url);
        assert.ok(got!.vapid.expiresInSeconds! > 0 && got!.vapid.expiresInSeconds! <= 24 * 3600);
        assert.equal(got!.ttl, 3600);
        assert.equal(got!.urgency, "high");
    });

    it("W4: a real push service answering 410 removes the subscription", async () => {
        const service = await startFakePush();
        after(() => service.close());
        const { push } = setup({ allowLocal: true, subject: "https://kvm.example.org" });
        const device = service.subscribe();
        push.subscribe("u", { endpoint: device.endpoint, keys: device.keys });
        service.setStatus(device.id, 410);
        const result = await push.send("u", payload);
        assert.equal(result.removed, 1);
        assert.deepEqual(push.list("u"), []);
    });

    it("W7: a send can ask for its own urgency and time to live, and without asking it is high for an hour as it always was", async () => {
        const asked: { urgency: string; ttlSeconds: number }[] = [];
        const sender: PushSender = async (_subscription, _body, options) => {
            asked.push({ urgency: options.urgency, ttlSeconds: options.ttlSeconds });
            return { statusCode: 201 };
        };
        const { push } = setup({ sender });
        push.subscribe("u", deviceSubscription("https://fcm.googleapis.com/a"));
        await push.send("u", payload);
        await push.send("u", payload, { urgency: "normal", ttlSeconds: 300 });
        await push.send("u", payload, { urgency: "high", ttlSeconds: 60 });
        assert.deepEqual(asked, [
            { urgency: "high", ttlSeconds: 3600 },
            { urgency: "normal", ttlSeconds: 300 },
            { urgency: "high", ttlSeconds: 60 },
        ]);
    });

    it("W7: the push service gets them as the Urgency and TTL headers", async () => {
        const service = await startFakePush();
        after(() => service.close());
        const { push } = setup({ allowLocal: true });
        const device = service.subscribe();
        push.subscribe("u", { endpoint: device.endpoint, keys: device.keys });
        await push.send("u", { ...payload, tag: "pikvm-call" }, { urgency: "high", ttlSeconds: 60 });
        await push.send("u", payload, { urgency: "normal", ttlSeconds: 300 });
        assert.deepEqual(service.received.map((got) => [got.urgency, got.ttl]), [["high", 60], ["normal", 300]]);
        assert.equal(service.received[0]!.payload && (service.received[0]!.payload as { tag: string }).tag, "pikvm-call");
    });
});
