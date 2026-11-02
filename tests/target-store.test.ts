import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TargetError, TargetStore } from "../src/target-store";

/* FAILURE MODES (written before the tests)
 *  1. The password ends up in pikvm.json, in what a client can read, or in an error message.
 *  2. The credentials file is readable by others, or left half written by a crash.
 *  3. A bad address is accepted, or refused after something was already written.
 *  4. An install with user:pass in the origin stops working, or is rewritten by merely starting.
 *  5. Saving without a password wipes the one that works, or one given in the address is lost.
 *  6. An empty password does not remove the stored one.
 *  7. Saving drops other keys of pikvm.json (consoleOrigin).
 *  8. A damaged credentials file crashes the app instead of meaning "no password".
 */

const fresh = () => mkdtempSync(join(tmpdir(), "pikvm-target-"));
const text = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
const mode = (dir: string, name: string) => statSync(join(dir, name)).mode & 0o777;

test("a new install connects to the default address with no credentials", () => {
    const store = new TargetStore(fresh());
    assert.deepEqual(store.resolve(), { origin: "https://pikvm/", username: "", password: "" });
    assert.deepEqual(store.view(), { origin: "https://pikvm/", username: "", passwordSet: false });
});

test("the password goes to its own 0600 file and never into pikvm.json or the view", () => {
    const dir = fresh();
    const store = new TargetStore(dir);
    store.save({ origin: "https://kvm.lan:8443", username: "admin", password: "s3cret-pass" });
    assert.ok(!text(dir, "pikvm.json").includes("s3cret-pass"));
    assert.deepEqual(JSON.parse(text(dir, "pikvm.json")), { origin: "https://kvm.lan:8443/", username: "admin" });
    assert.equal(JSON.parse(text(dir, "pikvm-credentials.json")).password, "s3cret-pass");
    assert.equal(mode(dir, "pikvm-credentials.json"), 0o600);
    assert.equal(mode(dir, "pikvm.json"), 0o600);
    assert.ok(!JSON.stringify(store.view()).includes("s3cret-pass"));
    assert.equal(store.view().passwordSet, true);
    assert.equal(store.resolve().password, "s3cret-pass");
});

test("a save leaves no temporary file behind, and creates a missing folder as 0700", () => {
    const parent = fresh();
    const dir = join(parent, "nested", "data");
    new TargetStore(dir).save({ origin: "http://pikvm/", password: "x" });
    assert.deepEqual(readdirSync(dir).sort(), ["pikvm-credentials.json", "pikvm.json"]);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("a bad address is refused with a sentence and nothing is written", () => {
    const dir = fresh();
    const store = new TargetStore(dir);
    for (const bad of ["", "pikvm", "ftp://pikvm/", "javascript:alert(1)", "https://", "file:///etc/passwd"]) {
        assert.throws(() => store.save({ origin: bad, password: "pw" }), TargetError, bad);
    }
    assert.deepEqual(readdirSync(dir), []);
});

test("an error never contains the password", () => {
    const store = new TargetStore(fresh());
    try {
        store.save({ origin: "ftp://admin:hunter2@pikvm/", password: "hunter2" });
        assert.fail("should have thrown");
    } catch (error) {
        assert.ok(error instanceof TargetError);
        assert.ok(!error.message.includes("hunter2"));
    }
});

test("an install with user:pass in the origin still connects, and reading does not rewrite it", () => {
    const dir = fresh();
    const original = JSON.stringify({ origin: "https://admin:p%40ss@pikvm/" });
    writeFileSync(join(dir, "pikvm.json"), original);
    const store = new TargetStore(dir);
    assert.deepEqual(store.resolve(), { origin: "https://pikvm/", username: "admin", password: "p@ss" });
    assert.equal(store.view().passwordSet, true);
    assert.ok(!JSON.stringify(store.view()).includes("p@ss"));
    assert.equal(text(dir, "pikvm.json"), original);
    assert.ok(!existsSync(join(dir, "pikvm-credentials.json")));
});

test("the first save from Settings moves embedded credentials out of pikvm.json", () => {
    const dir = fresh();
    writeFileSync(join(dir, "pikvm.json"), JSON.stringify({ origin: "https://admin:p%40ss@pikvm/" }));
    const store = new TargetStore(dir);
    // Changing only the address keeps the working credentials.
    store.save({ origin: "https://other.lan/" });
    assert.ok(!text(dir, "pikvm.json").includes("p%40ss") && !text(dir, "pikvm.json").includes("p@ss"));
    assert.deepEqual(JSON.parse(text(dir, "pikvm.json")), { origin: "https://other.lan/", username: "admin" });
    assert.equal(JSON.parse(text(dir, "pikvm-credentials.json")).password, "p@ss");
    assert.deepEqual(store.resolve(), { origin: "https://other.lan/", username: "admin", password: "p@ss" });
});

test("credentials typed into the address count as the username and password", () => {
    const dir = fresh();
    const store = new TargetStore(dir);
    store.save({ origin: "https://root:toor@pikvm/" });
    assert.deepEqual(store.resolve(), { origin: "https://pikvm/", username: "root", password: "toor" });
    assert.ok(!text(dir, "pikvm.json").includes("toor"));
});

test("fields that are not sent keep their value; an empty password removes it", () => {
    const dir = fresh();
    const store = new TargetStore(dir);
    store.save({ origin: "https://pikvm/", username: "admin", password: "one" });
    store.save({ username: "operator" });
    assert.deepEqual(store.resolve(), { origin: "https://pikvm/", username: "operator", password: "one" });
    store.save({ password: "two" });
    assert.equal(store.resolve().password, "two");
    store.save({ password: "" });
    assert.equal(store.resolve().password, "");
    assert.ok(!existsSync(join(dir, "pikvm-credentials.json")));
    assert.equal(store.view().passwordSet, false);
});

test("an empty username removes it", () => {
    const store = new TargetStore(fresh());
    store.save({ username: "admin" });
    store.save({ username: "" });
    assert.equal(store.resolve().username, "");
});

test("other keys of pikvm.json survive a save", () => {
    const dir = fresh();
    writeFileSync(join(dir, "pikvm.json"), JSON.stringify({ origin: "https://pikvm/", consoleOrigin: "https://kvm.example.org" }));
    new TargetStore(dir).save({ origin: "https://new/" });
    assert.equal(JSON.parse(text(dir, "pikvm.json")).consoleOrigin, "https://kvm.example.org");
});

test("a damaged credentials file means no password, and a save repairs it", () => {
    const dir = fresh();
    writeFileSync(join(dir, "pikvm-credentials.json"), "{not json");
    const store = new TargetStore(dir);
    assert.equal(store.resolve().password, "");
    store.save({ password: "fixed" });
    assert.equal(store.resolve().password, "fixed");
});

test("a damaged pikvm.json falls back to the default address", () => {
    const dir = fresh();
    writeFileSync(join(dir, "pikvm.json"), "oops");
    assert.equal(new TargetStore(dir).resolve().origin, "https://pikvm/");
});

test("a query string or fragment in the address is dropped", () => {
    const store = new TargetStore(fresh());
    assert.equal(store.save({ origin: "https://pikvm/kvm/?x=1#top" }).origin, "https://pikvm/kvm/");
});
