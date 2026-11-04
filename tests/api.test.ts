/**
 * /app/api/v1 through the real server: the HttpApi implementation, the
 * Node adapter and the settings and macro stores behind them.
 *
 * Responses are decoded with the contracts' own schemas, so a drift between
 * what the server sends and what the web app expects fails here.
 */

import { Macro, MacrosResponse, PikvmEntry, PikvmList, Settings, State, TargetConfig } from "@pikvm/contracts/api";
import { Schema } from "effect";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startControlServer } from "../src/server";
import { noImages, stubChat } from "./support/chat-stub";
import type { PiKvmControl } from "../src/pikvm-control";
import { SettingsStore } from "../src/settings";
import { TargetStore } from "../src/target-store";

interface Running {
    origin: string;
    settings: SettingsStore;
    /** Every target the control core was told to use. */
    targets: { origin: string; username: string; password: string }[];
    dir: string;
    /** Behind `/pikvms` when the host is editable. */
    store: TargetStore;
    close(): Promise<void>;
}

async function start(options: { editable?: boolean } = {}): Promise<Running> {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-api-test-"));
    const settings = new SettingsStore(join(dir, "settings.json"));
    settings.patch({ accessToken: "a-secret-that-must-never-be-readable", jiggler: false });
    const targets: Running["targets"] = [];
    const store = new TargetStore(dir);
    store.subscribe((t) => targets.push(t));
    const control = {
        setTarget: () => {},
        proxyTarget: async () => ({ origin: new URL("https://kvm.example.test:8443"), headers: {}, rejectUnauthorized: false }),
        getHidState: () => undefined,
        lastInputAt: () => 0,
        noteObservedMouse: () => {},
    } as unknown as PiKvmControl;
    const server: Server = startControlServer(
        {
            control,
            settings,
            images: noImages,
            createChat: stubChat(),
            ...(options.editable
                ? {
                      pikvms: store,
                  }
                : {}),
        },
        0,
    );
    await new Promise<void>((done) => server.once("listening", done));
    const { port } = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${port}`,
        settings,
        targets,
        dir,
        store,
        close: () =>
            new Promise<void>((done) => {
                server.closeAllConnections();
                server.close(() => {
                    rmSync(dir, { recursive: true, force: true });
                    done();
                });
            }),
    };
}

const JSON_HEADERS = { "content-type": "application/json" };

test("GET /state is what the contract says, and carries no secret", async () => {
    const s = await start();
    try {
        const res = await fetch(`${s.origin}/app/api/v1/state`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("access-control-allow-origin"), null);
        const text = await res.text();
        assert.doesNotMatch(text, /a-secret-that-must-never-be-readable/);
        const state = Schema.decodeUnknownSync(State)(JSON.parse(text));
        assert.deepEqual(state.settings, { keyboardLayout: "us", jiggler: false });
        assert.deepEqual(state.features, { chat: true, agent: { found: true } });
        assert.equal(state.pikvm.origin, "https://kvm.example.test:8443");
        assert.equal(state.pikvm.link, "unknown");
        assert.equal(state.jigglerStatus.enabled, false);
        assert.ok(state.version.length > 0);
    } finally {
        await s.close();
    }
});

test("settings: only the editable fields are readable and writable", async () => {
    const s = await start();
    try {
        const read = await fetch(`${s.origin}/app/api/v1/settings`);
        assert.deepEqual(Schema.decodeUnknownSync(Settings)(await read.json()), { keyboardLayout: "us", jiggler: false });

        const patched = await fetch(`${s.origin}/app/api/v1/settings`, {
            method: "PATCH",
            headers: JSON_HEADERS,
            body: JSON.stringify({ keyboardLayout: "uk", jiggler: true }),
        });
        assert.equal(patched.status, 200);
        assert.deepEqual(await patched.json(), { keyboardLayout: "uk", jiggler: true });
        // It reached the store, and the control core that actually types.
        assert.equal(s.settings.get().keyboardLayout, "uk");

        // A partial patch leaves the rest alone.
        const jiggler = await fetch(`${s.origin}/app/api/v1/settings`, {
            method: "PATCH",
            headers: JSON_HEADERS,
            body: JSON.stringify({ jiggler: false }),
        });
        assert.deepEqual(await jiggler.json(), { keyboardLayout: "uk", jiggler: false });
    } finally {
        await s.close();
    }
});

test("settings: a secret or unknown field is refused, not ignored", async () => {
    const s = await start();
    try {
        for (const body of [{ accessToken: "hunter2" }, { keyboardLayout: "us", bindHost: "0.0.0.0" }, { keyboardLayout: "de" }]) {
            const res = await fetch(`${s.origin}/app/api/v1/settings`, {
                method: "PATCH",
                headers: JSON_HEADERS,
                body: JSON.stringify(body),
            });
            assert.equal(res.status, 400, JSON.stringify(body));
            const reply = (await res.json()) as { error: unknown };
            assert.equal(typeof reply.error, "string");
        }
        assert.equal(s.settings.get().accessToken, "a-secret-that-must-never-be-readable");
        assert.equal(s.settings.get().bindHost, "127.0.0.1");
    } finally {
        await s.close();
    }
});

test("macros: the default is served, and a save is cleaned the way the store always did", async () => {
    const s = await start();
    try {
        const first = Schema.decodeUnknownSync(MacrosResponse)(await (await fetch(`${s.origin}/app/api/v1/macros`)).json());
        assert.equal(first.macros[0]?.id, "screenshot-region");

        // A bad macro and a bad step are dropped; the good ones are kept.
        const saved = await fetch(`${s.origin}/app/api/v1/macros`, {
            method: "PUT",
            headers: JSON_HEADERS,
            body: JSON.stringify({
                macros: [
                    { label: "Run box", steps: [{ type: "chord", mods: ["MetaLeft"], code: "KeyR" }, { type: "nonsense" }] },
                    { label: "", steps: [{ type: "text", text: "x" }] },
                    { label: "Pause", steps: [{ type: "delay", ms: 99999 }] },
                ],
            }),
        });
        assert.equal(saved.status, 200);
        const result = Schema.decodeUnknownSync(MacrosResponse)(await saved.json());
        assert.deepEqual(
            result.macros.map((m) => m.label),
            ["Run box", "Pause"],
        );
        assert.equal(result.macros[0]?.steps.length, 1);
        assert.deepEqual(result.macros[1]?.steps[0], { type: "delay", ms: 10_000 });
        for (const macro of result.macros) Schema.decodeUnknownSync(Macro)(macro);

        // A bare array is accepted too, and an empty one really does empty the list.
        const emptied = await fetch(`${s.origin}/app/api/v1/macros`, { method: "PUT", headers: JSON_HEADERS, body: "[]" });
        assert.deepEqual(await emptied.json(), { macros: [] });
        assert.deepEqual(await (await fetch(`${s.origin}/app/api/v1/macros`)).json(), { macros: [] });
    } finally {
        await s.close();
    }
});

test("macros: a body that is not a list is refused rather than wiping the list", async () => {
    const s = await start();
    try {
        for (const body of ['{"nope":1}', '"text"', "null", "not json"]) {
            const res = await fetch(`${s.origin}/app/api/v1/macros`, { method: "PUT", headers: JSON_HEADERS, body });
            assert.equal(res.status, 400, body);
            assert.equal(typeof ((await res.json()) as { error: unknown }).error, "string");
        }
        const kept = Schema.decodeUnknownSync(MacrosResponse)(await (await fetch(`${s.origin}/app/api/v1/macros`)).json());
        assert.equal(kept.macros.length, 1, "the default macro is still there");
    } finally {
        await s.close();
    }
});

test("an unknown API path is a JSON 404", async () => {
    const s = await start();
    try {
        const missing = await fetch(`${s.origin}/app/api/v1/nothing`);
        assert.equal(missing.status, 404);
        assert.equal(typeof ((await missing.json()) as { error: unknown }).error, "string");
    } finally {
        await s.close();
    }
});

/* FAILURE MODES (target)
 *  1. A pinned (hosted) host lets a client change the PiKVM, or reports it as editable.
 *  2. The password appears in ANY reply, or in the file the origin is stored in.
 *  3. A bad address is a 500 or a silent success; the control core is told anyway.
 *  4. A save does not reach the control core, so the new address only works after a restart.
 *  5. An unknown field (accessToken, say) is ignored instead of refused.
 */

test("target: a host that pins the PiKVM reports it read-only and refuses a change", async () => {
    const s = await start();
    try {
        const got = Schema.decodeUnknownSync(TargetConfig)(await (await fetch(`${s.origin}/app/api/v1/target`)).json());
        assert.deepEqual(got, { origin: "https://kvm.example.test:8443/", username: "", passwordSet: false, editable: false });
        const res = await fetch(`${s.origin}/app/api/v1/target`, {
            method: "PUT",
            headers: JSON_HEADERS,
            body: JSON.stringify({ origin: "https://elsewhere/" }),
        });
        const refusal = await res.text();
        assert.equal(res.status, 403, refusal);
        assert.match(JSON.parse(refusal).error, /configuration/);
        assert.deepEqual(s.targets, []);
    } finally {
        await s.close();
    }
});

test("target: a save reaches the control core at once, and no reply carries the password", async () => {
    const s = await start({ editable: true });
    try {
        const url = `${s.origin}/app/api/v1/target`;
        const res = await fetch(url, {
            method: "PUT",
            headers: JSON_HEADERS,
            body: JSON.stringify({ origin: "https://pikvm.lan/", username: "admin", password: "hunter2-secret" }),
        });
        const text = await res.text();
        assert.equal(res.status, 200);
        assert.doesNotMatch(text, /hunter2-secret/);
        assert.deepEqual(Schema.decodeUnknownSync(TargetConfig)(JSON.parse(text)), {
            origin: "https://pikvm.lan/",
            username: "admin",
            passwordSet: true,
            editable: true,
        });
        assert.deepEqual(s.targets, [{ origin: "https://pikvm.lan/", username: "admin", password: "hunter2-secret" }]);
        const again = await (await fetch(url)).text();
        assert.doesNotMatch(again, /hunter2-secret/);
        assert.match(again, /"passwordSet":true/);
        const state = await (await fetch(`${s.origin}/app/api/v1/state`)).text();
        assert.doesNotMatch(state, /hunter2-secret/);
    } finally {
        await s.close();
    }
});

test("target: a bad address is a 400 with a sentence, and the control core is not told", async () => {
    const s = await start({ editable: true });
    try {
        const res = await fetch(`${s.origin}/app/api/v1/target`, {
            method: "PUT",
            headers: JSON_HEADERS,
            body: JSON.stringify({ origin: "ftp://admin:hunter2@pikvm/" }),
        });
        assert.equal(res.status, 400);
        const body = await res.text();
        assert.match(JSON.parse(body).error, /http/);
        assert.doesNotMatch(body, /hunter2/);
        assert.deepEqual(s.targets, []);
    } finally {
        await s.close();
    }
});

test("target: an unknown field is refused", async () => {
    const s = await start({ editable: true });
    try {
        const res = await fetch(`${s.origin}/app/api/v1/target`, {
            method: "PUT",
            headers: JSON_HEADERS,
            body: JSON.stringify({ accessToken: "x" }),
        });
        assert.equal(res.status, 400);
        assert.deepEqual(s.targets, []);
    } finally {
        await s.close();
    }
});

/* FAILURE MODES (pikvms)
 *  1. A password appears in ANY reply or error of the list routes, or in pikvms.json.
 *  2. A pinned host lets a client add, change or remove a PiKVM, or reports the list as editable.
 *  3. An unknown id is a 500 or a 200; a bad address is a 500 or a silent success.
 *  4. Activating a PiKVM does not reach the control core, so the proxy keeps the old one until a restart.
 *  5. /target stops following the active PiKVM.
 *  6. Editing without a password wipes the stored one.
 */

const call = (s: Running, path: string, method = "GET", body?: unknown) =>
    fetch(`${s.origin}/app/api/v1${path}`, {
        method,
        // Every write is marked as JSON, as the web client does, even when it has no body.
        headers: JSON_HEADERS,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

test("pikvms: a pinned host lists its one PiKVM read-only and refuses every change", async () => {
    const s = await start();
    try {
        const list = Schema.decodeUnknownSync(PikvmList)(await (await call(s, "/pikvms")).json());
        assert.equal(list.editable, false);
        assert.equal(list.items.length, 1);
        assert.equal(list.items[0]?.origin, "https://kvm.example.test:8443/");
        for (const [path, method, body] of [
            ["/pikvms", "POST", { name: "x", origin: "https://x/" }],
            ["/pikvms/pinned", "PUT", { name: "y" }],
            ["/pikvms/pinned", "DELETE", undefined],
            ["/pikvms/pinned/default", "POST", undefined],
            ["/pikvms/pinned/activate", "POST", undefined],
        ] as const) {
            const res = await call(s, path, method, body);
            assert.equal(res.status, 403, `${method} ${path}`);
        }
        assert.deepEqual(s.targets, []);
    } finally {
        await s.close();
    }
});

test("pikvms: add, edit, activate, default and delete, and no reply carries a password", async () => {
    const s = await start({ editable: true });
    try {
        const replies: string[] = [];
        const send = async (path: string, method: string, body?: unknown) => {
            const res = await call(s, path, method, body);
            const text = await res.text();
            replies.push(text);
            return { status: res.status, json: JSON.parse(text) as unknown };
        };

        const empty = await send("/pikvms", "GET");
        assert.deepEqual(Schema.decodeUnknownSync(PikvmList)(empty.json), { items: [], editable: true });

        const first = await send("/pikvms", "POST", { name: "Desk", origin: "https://desk.lan/", username: "admin", password: "pw-desk-secret" });
        assert.equal(first.status, 200);
        const desk = Schema.decodeUnknownSync(PikvmEntry)(first.json);
        assert.deepEqual({ ...desk, id: "" }, { id: "", name: "Desk", origin: "https://desk.lan/", username: "admin", passwordSet: true, isDefault: true, active: true });
        assert.deepEqual(s.targets, [{ origin: "https://desk.lan/", username: "admin", password: "pw-desk-secret" }]);

        const second = Schema.decodeUnknownSync(PikvmEntry)((await send("/pikvms", "POST", { name: "Rack", origin: "https://rack.lan/", password: "pw-rack-secret" })).json);
        assert.equal(second.isDefault || second.active, false);
        assert.equal(s.targets.length, 1, "adding a second PiKVM does not move the proxy");

        // Editing without a password keeps it; the control core is told only because the active one changed.
        const renamed = await send(`/pikvms/${desk.id}`, "PUT", { name: "Desk 2", username: "root" });
        assert.equal(Schema.decodeUnknownSync(PikvmEntry)(renamed.json).passwordSet, true);
        assert.deepEqual(s.targets.at(-1), { origin: "https://desk.lan/", username: "root", password: "pw-desk-secret" });

        // Activating the second one reaches the control core at once, and /target follows.
        const activated = Schema.decodeUnknownSync(PikvmList)((await send(`/pikvms/${second.id}/activate`, "POST")).json);
        assert.deepEqual(activated.items.map((e) => [e.name, e.isDefault, e.active]), [["Desk 2", true, false], ["Rack", false, true]]);
        assert.deepEqual(s.targets.at(-1), { origin: "https://rack.lan/", username: "", password: "pw-rack-secret" });
        const target = Schema.decodeUnknownSync(TargetConfig)((await send("/target", "GET")).json);
        assert.deepEqual(target, { origin: "https://rack.lan/", username: "", passwordSet: true, editable: true });

        // The alias edits the active one.
        await send("/target", "PUT", { username: "operator" });
        assert.deepEqual(s.targets.at(-1), { origin: "https://rack.lan/", username: "operator", password: "pw-rack-secret" });

        const defaulted = Schema.decodeUnknownSync(PikvmList)((await send(`/pikvms/${second.id}/default`, "POST")).json);
        assert.deepEqual(defaulted.items.map((e) => e.isDefault), [false, true]);

        // An empty password removes it.
        assert.equal(Schema.decodeUnknownSync(PikvmEntry)((await send(`/pikvms/${second.id}`, "PUT", { password: "" })).json).passwordSet, false);

        const removed = Schema.decodeUnknownSync(PikvmList)((await send(`/pikvms/${second.id}`, "DELETE")).json);
        assert.deepEqual(removed.items.map((e) => [e.id, e.isDefault, e.active]), [[desk.id, true, true]]);
        assert.deepEqual(s.targets.at(-1), { origin: "https://desk.lan/", username: "root", password: "pw-desk-secret" });

        for (const text of replies) assert.doesNotMatch(text, /pw-desk-secret|pw-rack-secret/);
        assert.doesNotMatch(readFileSync(join(s.dir, "pikvms.json"), "utf8"), /pw-desk-secret|pw-rack-secret/);
        assert.equal(statSync(join(s.dir, "pikvms-credentials.json")).mode & 0o777, 0o600);
    } finally {
        await s.close();
    }
});

test("pikvms: an unknown id is a 404 and a bad request a 400, with no password in the sentence", async () => {
    const s = await start({ editable: true });
    try {
        for (const [path, method, body] of [
            ["/pikvms/nope", "PUT", { name: "x", password: "hunter2" }],
            ["/pikvms/nope", "DELETE", undefined],
            ["/pikvms/nope/default", "POST", undefined],
            ["/pikvms/nope/activate", "POST", undefined],
        ] as const) {
            const res = await call(s, path, method, body);
            const text = await res.text();
            assert.equal(res.status, 404, `${method} ${path}: ${text}`);
            assert.doesNotMatch(text, /hunter2/);
            assert.equal(typeof JSON.parse(text).error, "string");
        }
        for (const body of [
            { name: "A", origin: "ftp://admin:hunter2@pikvm/", password: "hunter2" },
            { name: "", origin: "https://a/", password: "hunter2" },
            { name: "A", origin: "https://a/", accessToken: "x" },
        ]) {
            const res = await call(s, "/pikvms", "POST", body);
            const text = await res.text();
            assert.equal(res.status, 400, text);
            assert.doesNotMatch(text, /hunter2/);
        }
        assert.deepEqual(s.store.entries(), []);
        assert.deepEqual(s.targets, []);
    } finally {
        await s.close();
    }
});
