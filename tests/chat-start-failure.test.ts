/**
 * The chat server failing to start (an unwritable data directory, a full disk) must cost the host only Chat:
 * nothing of chat's may touch its database, which never opened, and the KVM keeps working.
 *
 * Timers are mocked BEFORE the server is loaded, because chat-server's idle sweepers are created when its modules are,
 * and a sweeper that reads a setting from a database that never opened killed the whole process ~30 s after start.
 */

import { State } from "@pikvm/contracts/api";
import { Schema } from "effect";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import type { PiKvmControl } from "../src/pikvm-control";
import type { SettingsStore as SettingsStoreType } from "../src/settings";

test("a chat server that cannot start leaves the host up: no timer touches its database, Chat says why, the KVM answers", async () => {
    const crashes: unknown[] = [];
    const onCrash = (error: unknown) => crashes.push(error);
    process.on("uncaughtException", onCrash);
    mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const dir = mkdtempSync(join(tmpdir(), "pikvm-chat-fail-"));
    const upstream = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"kvmd":"alive"}'));
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));
    let server: import("node:http").Server | undefined;
    try {
        const { startControlServer } = await import("../src/server");
        const { SettingsStore } = await import("../src/settings");
        const { createChatServer } = await import("@pikvm/chat-server");
        const { noImages } = await import("./support/chat-stub");
        const settings: SettingsStoreType = new SettingsStore(join(dir, "settings.json"));
        // `<data>/chat` is a file, so the server cannot make its run directory: it fails before its database opens.
        writeFileSync(join(dir, "chat"), "in the way");
        const control = {
            setTarget: () => {},
            proxyTarget: async () => ({ origin: new URL(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`), headers: {}, rejectUnauthorized: false }),
            getHidState: () => undefined,
            lastInputAt: () => 0,
            noteObservedMouse: () => {},
        } as unknown as PiKvmControl;
        server = startControlServer({ control, settings, images: noImages, createChat: createChatServer }, 0);
        await new Promise<void>((done) => server!.once("listening", done));
        // Let the failed start settle, then let every idle sweeper fire many times over.
        await new Promise<void>((done) => setImmediate(done));
        for (let i = 0; i < 20; i++) {
            mock.timers.tick(30_000);
            await new Promise<void>((done) => setImmediate(done));
        }
        mock.timers.reset();
        console.log = log;
        assert.deepEqual(crashes, [], "no timer may throw");

        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const state = Schema.decodeUnknownSync(State)(await (await fetch(`${origin}/app/api/v1/state`)).json());
        assert.equal(state.features.chat, false);
        assert.match(state.features.agent?.reason ?? "", /ENOTDIR|EEXIST|not a directory|file already exists/i);
        assert.ok(lines.some((l) => l.startsWith("[chat] did not start:")), "the log says why");
        assert.equal((await fetch(`${origin}/app/chat/api/conversations`)).status, 503);
        const kvm = await fetch(`${origin}/api/info`);
        assert.equal(kvm.status, 200);
        assert.deepEqual(await kvm.json(), { kvmd: "alive" });
    } finally {
        console.log = log;
        mock.timers.reset();
        process.off("uncaughtException", onCrash);
        server?.closeAllConnections();
        server?.close();
        upstream.closeAllConnections();
        upstream.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
