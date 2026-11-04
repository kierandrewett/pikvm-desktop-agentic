import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LEGACY_ID, TargetError, TargetNotFound, TargetStore, type ResolvedTarget } from "../src/target-store";

/* FAILURE MODES (written before the tests)
 *  1. A password ends up in pikvms.json, in a view a client can read, or in an error message.
 *  2. A credentials file is readable by others, or left half written by a crash.
 *  3. A bad address or name is accepted, or refused after something was already written.
 *  4. An install with a single pikvm.json (and pikvm-credentials.json, or user:pass in the origin) loses its
 *     PiKVM or its password on upgrade, or is rewritten by merely reading.
 *  5. The first PiKVM is not the default and the active one; deleting the default leaves none, or two.
 *  6. Saving without a password wipes the one that works; an empty password does not remove it.
 *  7. Migration drops other keys of pikvm.json (consoleOrigin) or leaves a password behind in the old files.
 *  8. A damaged file crashes the app instead of meaning "no list" or "no password".
 *  9. A change to the active PiKVM is not announced, or a change to another one is.
 */

const fresh = () => mkdtempSync(join(tmpdir(), "pikvm-target-"));
const text = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
const mode = (dir: string, name: string) => statSync(join(dir, name)).mode & 0o777;
const DEFAULT = { origin: "https://pikvm/", username: "", password: "" };

test("a new install has no PiKVMs and connects to the default address with no credentials", () => {
    const store = new TargetStore(fresh());
    assert.deepEqual(store.entries(), []);
    assert.equal(store.activeId(), null);
    assert.deepEqual(store.resolve(), DEFAULT);
    assert.deepEqual(store.targetView(), { origin: "https://pikvm/", username: "", passwordSet: false });
});

test("the first PiKVM added becomes the default and the active one; later ones are neither", () => {
    const store = new TargetStore(fresh());
    const first = store.add({ name: "Desk", origin: "https://desk.lan/" });
    const second = store.add({ name: "Rack", origin: "https://rack.lan/" });
    assert.equal(first.isDefault, true);
    assert.equal(first.active, true);
    assert.equal(second.isDefault, false);
    assert.equal(second.active, false);
    assert.equal(store.activeId(), first.id);
    assert.deepEqual(
        store.entries().map((e) => [e.name, e.isDefault, e.active]),
        [
            ["Desk", true, true],
            ["Rack", false, false],
        ],
    );
    assert.equal(store.resolve().origin, "https://desk.lan/");
});

test("activating and making default are separate, and unknown ids are refused", () => {
    const store = new TargetStore(fresh());
    const a = store.add({ name: "A", origin: "https://a/" });
    const b = store.add({ name: "B", origin: "https://b/" });
    store.activate(b.id);
    assert.equal(store.activeId(), b.id);
    assert.equal(store.entries().find((e) => e.id === a.id)?.isDefault, true);
    store.setDefault(b.id);
    assert.deepEqual(
        store.entries().map((e) => [e.id, e.isDefault, e.active]),
        [
            [a.id, false, false],
            [b.id, true, true],
        ],
    );
    for (const call of [() => store.activate("nope"), () => store.setDefault("nope"), () => store.remove("nope"), () => store.update("nope", { name: "x" })]) {
        assert.throws(call, TargetNotFound);
    }
    assert.throws(() => store.activate("nope"), TargetError);
});

test("deleting the default promotes the next one, which is also the active one when the default was", () => {
    const store = new TargetStore(fresh());
    const a = store.add({ name: "A", origin: "https://a/" });
    const b = store.add({ name: "B", origin: "https://b/" });
    const c = store.add({ name: "C", origin: "https://c/" });
    const left = store.remove(a.id);
    assert.deepEqual(
        left.map((e) => [e.id, e.isDefault, e.active]),
        [
            [b.id, true, true],
            [c.id, false, false],
        ],
    );
    assert.equal(store.resolve().origin, "https://b/");
    // The last one in the list hands over to the one before it.
    store.setDefault(c.id);
    store.activate(c.id);
    const rest = store.remove(c.id);
    assert.deepEqual(
        rest.map((e) => [e.id, e.isDefault, e.active]),
        [[b.id, true, true]],
    );
});

test("deleting a PiKVM that is neither default nor active changes neither; deleting the active one moves to the default", () => {
    const store = new TargetStore(fresh());
    const a = store.add({ name: "A", origin: "https://a/" });
    const b = store.add({ name: "B", origin: "https://b/" });
    const c = store.add({ name: "C", origin: "https://c/" });
    store.remove(b.id);
    assert.deepEqual(
        store.entries().map((e) => [e.id, e.isDefault, e.active]),
        [
            [a.id, true, true],
            [c.id, false, false],
        ],
    );
    store.activate(c.id);
    store.remove(c.id);
    assert.equal(store.activeId(), a.id);
});

test("the last PiKVM can be deleted: the list is empty and the default address applies again", () => {
    const dir = fresh();
    const store = new TargetStore(dir);
    const only = store.add({ name: "A", origin: "https://a.lan/", username: "admin", password: "pw-one" });
    assert.deepEqual(store.remove(only.id), []);
    assert.deepEqual(store.entries(), []);
    assert.equal(store.activeId(), null);
    assert.deepEqual(store.resolve(), DEFAULT);
    assert.ok(!existsSync(join(dir, "pikvms-credentials.json")));
    // The next one added is the first again.
    const again = store.add({ name: "B", origin: "https://b/" });
    assert.equal(again.isDefault && again.active, true);
});

test("each password goes to its own 0600 file keyed by id and never into pikvms.json or a view", () => {
    const dir = fresh();
    const store = new TargetStore(dir);
    const a = store.add({ name: "A", origin: "https://a.lan:8443", username: "admin", password: "s3cret-pass" });
    const b = store.add({ name: "B", origin: "https://b.lan", password: "other-pass" });
    for (const name of ["pikvms.json", "pikvms-credentials.json"]) assert.equal(mode(dir, name), 0o600, name);
    assert.ok(!text(dir, "pikvms.json").includes("s3cret-pass") && !text(dir, "pikvms.json").includes("other-pass"));
    assert.deepEqual(JSON.parse(text(dir, "pikvms-credentials.json")), { [a.id]: "s3cret-pass", [b.id]: "other-pass" });
    const everything = JSON.stringify([a, b, store.entries(), store.targetView(), store.remove(b.id)]);
    assert.ok(!everything.includes("s3cret-pass") && !everything.includes("other-pass"));
    assert.equal(store.entries()[0]?.passwordSet, true);
    assert.equal(store.resolve().password, "s3cret-pass");
    // Removing a PiKVM removes its password too.
    assert.deepEqual(JSON.parse(text(dir, "pikvms-credentials.json")), { [a.id]: "s3cret-pass" });
});

test("writes are atomic: no temporary file is left, a missing folder is created 0700, and every file is 0600", () => {
    const parent = fresh();
    const dir = join(parent, "nested", "data");
    const store = new TargetStore(dir);
    const a = store.add({ name: "A", origin: "http://pikvm/", password: "x" });
    store.update(a.id, { name: "A2", password: "y" });
    store.activate(a.id);
    assert.deepEqual(readdirSync(dir).sort(), ["pikvms-credentials.json", "pikvms.json"]);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const name of readdirSync(dir)) assert.equal(mode(dir, name), 0o600, name);
});

test("a file that already exists with loose permissions is tightened by the next write", () => {
    const dir = fresh();
    writeFileSync(join(dir, "pikvms-credentials.json"), "{}", { mode: 0o644 });
    new TargetStore(dir).add({ name: "A", origin: "https://a/", password: "pw" });
    assert.equal(mode(dir, "pikvms-credentials.json"), 0o600);
});

test("a bad address or name is refused with a sentence and nothing is written", () => {
    const dir = fresh();
    const store = new TargetStore(dir);
    for (const bad of ["", "pikvm", "ftp://pikvm/", "javascript:alert(1)", "https://", "file:///etc/passwd"]) {
        assert.throws(() => store.add({ name: "A", origin: bad, password: "pw" }), TargetError, bad);
    }
    assert.throws(() => store.add({ name: "   ", origin: "https://a/" }), /name/);
    assert.throws(() => store.add({ name: "x".repeat(81), origin: "https://a/" }), TargetError);
    assert.deepEqual(readdirSync(dir), []);
    const a = store.add({ name: "A", origin: "https://a/", password: "keep" });
    const before = text(dir, "pikvms.json");
    assert.throws(() => store.update(a.id, { origin: "nope", password: "new" }), TargetError);
    assert.throws(() => store.update(a.id, { name: "" }), TargetError);
    assert.equal(text(dir, "pikvms.json"), before);
    assert.equal(store.resolve().password, "keep");
});

test("an error never contains the password", () => {
    const store = new TargetStore(fresh());
    const attempts: (() => unknown)[] = [
        () => store.add({ name: "A", origin: "ftp://admin:hunter2@pikvm/", password: "hunter2" }),
        () => store.add({ name: "", origin: "https://admin:hunter2@pikvm/", password: "hunter2" }),
        () => store.save({ origin: "ftp://admin:hunter2@pikvm/", password: "hunter2" }),
        () => store.update("hunter2", { password: "hunter2" }),
    ];
    for (const attempt of attempts) {
        try {
            attempt();
            assert.fail("should have thrown");
        } catch (error) {
            assert.ok(error instanceof TargetError);
            assert.ok(!error.message.includes("hunter2"));
        }
    }
});

test("editing keeps the password when it is omitted and clears it on an empty string", () => {
    const dir = fresh();
    const store = new TargetStore(dir);
    const a = store.add({ name: "A", origin: "https://pikvm/", username: "admin", password: "one" });
    const b = store.add({ name: "B", origin: "https://b/", password: "bee" });
    store.update(a.id, { username: "operator", name: "Renamed", origin: "https://other.lan/" });
    assert.deepEqual(store.resolve(), { origin: "https://other.lan/", username: "operator", password: "one" });
    assert.equal(store.entries()[0]?.name, "Renamed");
    store.update(a.id, { password: "two" });
    assert.equal(store.resolve().password, "two");
    store.update(a.id, { password: "" });
    assert.equal(store.resolve().password, "");
    assert.equal(store.entries()[0]?.passwordSet, false);
    // The other PiKVM's password was never touched.
    assert.deepEqual(JSON.parse(text(dir, "pikvms-credentials.json")), { [b.id]: "bee" });
    store.update(b.id, { password: "" });
    assert.ok(!existsSync(join(dir, "pikvms-credentials.json")));
});

test("an empty username removes it", () => {
    const store = new TargetStore(fresh());
    const a = store.add({ name: "A", origin: "https://a/", username: "admin" });
    store.update(a.id, { username: "" });
    assert.equal(store.resolve().username, "");
});

test("credentials typed into the address count as the username and password", () => {
    const dir = fresh();
    const store = new TargetStore(dir);
    const a = store.add({ name: "A", origin: "https://root:toor@pikvm/" });
    assert.deepEqual(store.resolve(), { origin: "https://pikvm/", username: "root", password: "toor" });
    assert.ok(!text(dir, "pikvms.json").includes("toor"));
    store.update(a.id, { origin: "https://other:pw2@pikvm/" });
    assert.deepEqual(store.resolve(), { origin: "https://pikvm/", username: "other", password: "pw2" });
});

test("a query string or fragment in the address is dropped", () => {
    const store = new TargetStore(fresh());
    assert.equal(store.add({ name: "A", origin: "https://pikvm/kvm/?x=1#top" }).origin, "https://pikvm/kvm/");
});

test("a save to the active PiKVM changes it, and adds the first one when there is none", () => {
    const store = new TargetStore(fresh());
    assert.deepEqual(store.save({ origin: "https://pikvm.lan/", username: "admin", password: "pw" }), {
        origin: "https://pikvm.lan/",
        username: "admin",
        password: "pw",
    });
    assert.equal(store.entries().length, 1);
    assert.equal(store.entries()[0]?.name, "pikvm.lan");
    store.add({ name: "Other", origin: "https://other/" });
    store.save({ username: "operator" });
    assert.equal(store.entries().length, 2);
    assert.deepEqual(store.resolve(), { origin: "https://pikvm.lan/", username: "operator", password: "pw" });
    assert.equal(store.targetView().passwordSet, true);
});

/* ---- migration from the single-target files ----------------------------------------------------------------- */

test("legacy: pikvm.json and pikvm-credentials.json become one default, active entry, without being rewritten by a read", () => {
    const dir = fresh();
    const config = JSON.stringify({ origin: "https://kvm.lan:8443/", username: "admin", consoleOrigin: "https://kvm.example.org" });
    const credentials = JSON.stringify({ password: "legacy-pass" });
    writeFileSync(join(dir, "pikvm.json"), config);
    writeFileSync(join(dir, "pikvm-credentials.json"), credentials, { mode: 0o600 });
    const store = new TargetStore(dir);
    assert.deepEqual(store.entries(), [
        { id: LEGACY_ID, name: "kvm.lan:8443", origin: "https://kvm.lan:8443/", username: "admin", passwordSet: true, isDefault: true, active: true },
    ]);
    assert.equal(store.activeId(), LEGACY_ID);
    assert.deepEqual(store.resolve(), { origin: "https://kvm.lan:8443/", username: "admin", password: "legacy-pass" });
    assert.ok(!JSON.stringify(store.entries()).includes("legacy-pass"));
    // Reading changed nothing on disk.
    assert.deepEqual(readdirSync(dir).sort(), ["pikvm-credentials.json", "pikvm.json"]);
    assert.equal(text(dir, "pikvm.json"), config);
    assert.equal(text(dir, "pikvm-credentials.json"), credentials);
});

test("legacy: the first change writes the new files, keeps the password and pikvm.json's other keys, and retires the old password file", () => {
    const dir = fresh();
    writeFileSync(join(dir, "pikvm.json"), JSON.stringify({ origin: "https://kvm.lan/", username: "admin", consoleOrigin: "https://kvm.example.org" }));
    writeFileSync(join(dir, "pikvm-credentials.json"), JSON.stringify({ password: "legacy-pass" }), { mode: 0o600 });
    const store = new TargetStore(dir);
    const added = store.add({ name: "Second", origin: "https://second/" });
    assert.deepEqual(
        store.entries().map((e) => [e.id, e.name, e.isDefault, e.active, e.passwordSet]),
        [
            [LEGACY_ID, "kvm.lan", true, true, true],
            [added.id, "Second", false, false, false],
        ],
    );
    assert.equal(store.resolve().password, "legacy-pass");
    assert.deepEqual(JSON.parse(text(dir, "pikvms-credentials.json")), { [LEGACY_ID]: "legacy-pass" });
    assert.ok(!existsSync(join(dir, "pikvm-credentials.json")));
    assert.equal(JSON.parse(text(dir, "pikvm.json")).consoleOrigin, "https://kvm.example.org");
    // A new reader sees the same thing from the new files alone.
    assert.deepEqual(new TargetStore(dir).entries(), store.entries());
});

test("legacy: user:pass inside the address still connects, is not rewritten by a read, and moves out on the first change", () => {
    const dir = fresh();
    const original = JSON.stringify({ origin: "https://admin:p%40ss@pikvm/", consoleOrigin: "https://kvm.example.org" });
    writeFileSync(join(dir, "pikvm.json"), original);
    const store = new TargetStore(dir);
    assert.deepEqual(store.resolve(), { origin: "https://pikvm/", username: "admin", password: "p@ss" });
    assert.equal(store.entries()[0]?.passwordSet, true);
    assert.ok(!JSON.stringify(store.entries()).includes("p@ss"));
    assert.equal(text(dir, "pikvm.json"), original);
    assert.deepEqual(readdirSync(dir), ["pikvm.json"]);

    // Changing only the address keeps the working credentials.
    store.update(LEGACY_ID, { origin: "https://other.lan/" });
    assert.deepEqual(store.resolve(), { origin: "https://other.lan/", username: "admin", password: "p@ss" });
    assert.ok(!text(dir, "pikvm.json").includes("p%40ss") && !text(dir, "pikvm.json").includes("p@ss"));
    assert.equal(JSON.parse(text(dir, "pikvm.json")).consoleOrigin, "https://kvm.example.org");
    assert.equal(JSON.parse(text(dir, "pikvms-credentials.json"))[LEGACY_ID], "p@ss");
});

test("legacy: the untouched default pikvm.json is an empty list, and the first PiKVM added is the default", () => {
    const dir = fresh();
    writeFileSync(join(dir, "pikvm.json"), JSON.stringify({ origin: "https://pikvm/" }));
    const store = new TargetStore(dir);
    assert.deepEqual(store.entries(), []);
    assert.deepEqual(store.resolve(), DEFAULT);
    const added = store.add({ name: "A", origin: "https://a/" });
    assert.equal(added.isDefault && added.active, true);
    assert.deepEqual(JSON.parse(text(dir, "pikvm.json")), { origin: "https://pikvm/" });
});

test("legacy: the default address with only a password is kept", () => {
    const dir = fresh();
    writeFileSync(join(dir, "pikvm.json"), JSON.stringify({ origin: "https://pikvm/" }));
    writeFileSync(join(dir, "pikvm-credentials.json"), JSON.stringify({ password: "pw" }), { mode: 0o600 });
    const store = new TargetStore(dir);
    assert.equal(store.entries().length, 1);
    assert.equal(store.resolve().password, "pw");
});

/* ---- damage and notification -------------------------------------------------------------------------------- */

test("a damaged credentials file means no password, and an update repairs it", () => {
    const dir = fresh();
    const store = new TargetStore(dir);
    const a = store.add({ name: "A", origin: "https://a/", password: "pw" });
    writeFileSync(join(dir, "pikvms-credentials.json"), "{not json");
    assert.equal(store.resolve().password, "");
    store.update(a.id, { password: "fixed" });
    assert.equal(store.resolve().password, "fixed");
});

test("a damaged pikvms.json is an empty list, not a crash", () => {
    const dir = fresh();
    writeFileSync(join(dir, "pikvms.json"), "oops");
    const store = new TargetStore(dir);
    assert.deepEqual(store.entries(), []);
    assert.equal(store.resolve().origin, "https://pikvm/");
});

test("an entry that names a missing active or default PiKVM falls back to a real one", () => {
    const dir = fresh();
    writeFileSync(
        join(dir, "pikvms.json"),
        JSON.stringify({
            active: "ghost",
            items: [
                { id: "x", name: "X", origin: "https://x/", username: "", isDefault: false },
                { id: "x", name: "dup", origin: "https://dup/", username: "", isDefault: true },
                { id: "bad", name: "Bad", origin: "ftp://nope/", username: "" },
                { id: "y", name: "Y", origin: "https://y/", username: "", isDefault: false },
            ],
        }),
    );
    const store = new TargetStore(dir);
    assert.deepEqual(
        store.entries().map((e) => [e.id, e.isDefault, e.active]),
        [
            ["x", true, true],
            ["y", false, false],
        ],
    );
});

test("subscribers hear of a change to the active PiKVM and not of a change to another one", () => {
    const store = new TargetStore(fresh());
    const heard: ResolvedTarget[] = [];
    const stop = store.subscribe((t) => heard.push(t));
    const a = store.add({ name: "A", origin: "https://a/", username: "u", password: "pa" });
    assert.deepEqual(heard.splice(0), [{ origin: "https://a/", username: "u", password: "pa" }]);
    const b = store.add({ name: "B", origin: "https://b/", password: "pb" });
    assert.deepEqual(heard.splice(0), []);
    store.update(b.id, { name: "B2", password: "pb2" });
    assert.deepEqual(heard.splice(0), []);
    store.activate(b.id);
    assert.deepEqual(heard.splice(0), [{ origin: "https://b/", username: "", password: "pb2" }]);
    store.update(b.id, { origin: "https://b2/" });
    assert.deepEqual(heard.splice(0), [{ origin: "https://b2/", username: "", password: "pb2" }]);
    store.update(b.id, { password: "" });
    assert.deepEqual(heard.splice(0), [{ origin: "https://b2/", username: "", password: "" }]);
    store.activate(b.id);
    assert.deepEqual(heard.splice(0), []);
    store.remove(b.id);
    assert.deepEqual(heard.splice(0), [{ origin: "https://a/", username: "u", password: "pa" }]);
    stop();
    store.remove(a.id);
    assert.deepEqual(heard, []);
});
