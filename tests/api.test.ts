/**
 * /app/api/v1 through the real server: the HttpApi implementation, the
 * Node adapter and the settings and macro stores behind them.
 *
 * Responses are decoded with the contracts' own schemas, so a drift between
 * what the server sends and what the web app expects fails here.
 */

import { Macro, MacrosResponse, Settings, State, TargetConfig } from "@pikvm/contracts/api";
import { Schema } from "effect";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
    layouts: string[];
    /** Every target the control core was told to use. */
    targets: { origin: string; username: string; password: string }[];
    dir: string;
    close(): Promise<void>;
}

async function start(options: { editable?: boolean } = {}): Promise<Running> {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-api-test-"));
    const settings = new SettingsStore(join(dir, "settings.json"));
    settings.patch({ accessToken: "a-secret-that-must-never-be-readable", jiggler: false });
    const layouts: string[] = [];
    const targets: Running["targets"] = [];
    const store = new TargetStore(dir);
    const control = {
        setTarget: (t: Running["targets"][number]) => targets.push(t),
        proxyTarget: async () => ({ origin: new URL("https://kvm.example.test:8443"), headers: {}, rejectUnauthorized: false }),
        getHidState: () => undefined,
        setLayout: (layout: string) => layouts.push(layout),
        lastInputAt: () => 0,
        noteObservedMouse: () => {},
    } as unknown as PiKvmControl;
    const server: Server = startControlServer(
        {
            control,
            settings,
            images: noImages,
            createChat: stubChat(),
            daemonToken: "unused",
            ...(options.editable
                ? {
                      target: {
                          view: () => store.view(),
                          save: (change) => {
                              control.setTarget(store.save(change));
                              return store.view();
                          },
                      },
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
        layouts,
        targets,
        dir,
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
        assert.deepEqual(s.layouts, ["uk"]);

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
