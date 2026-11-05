/**
 * The screen watch inside the real control server: routed, behind the JSON-only rule, and harmless where the host has no OCR.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PiKvmControl } from "../src/pikvm-control";
import { startControlServer } from "../src/server";
import { SettingsStore } from "../src/settings";
import { noImages, stubChat } from "./support/chat-stub";

async function run(body: (origin: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "pikvm-watch-host-"));
    const settings = new SettingsStore(join(dir, "settings.json"));
    const control = {
        proxyTarget: async () => ({ origin: new URL("https://kvm.example.test:8443"), headers: {}, rejectUnauthorized: false }),
        getHidState: () => undefined,
        lastInputAt: () => 0,
        noteObservedMouse: () => {},
    } as unknown as PiKvmControl;
    const server: Server = startControlServer({ control, settings, images: { ...noImages, gray: async () => null }, createChat: stubChat() }, 0);
    await new Promise<void>((done) => server.once("listening", done));
    try {
        await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        rmSync(dir, { recursive: true, force: true });
    }
}

test("the watch is mounted: where the host has no OCR it reports why it cannot be switched on, and refuses to be", async () => {
    await run(async (origin) => {
        const view = (await (await fetch(`${origin}/app/api/v1/watch`)).json()) as Record<string, any>;
        assert.equal(view["enabled"], false);
        assert.equal(view["running"], false);
        assert.equal(view["canEnable"].ok, false);
        assert.match(view["canEnable"].reason, /cannot read pop-ups/);

        const refused = await fetch(`${origin}/app/api/v1/watch`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: true }),
        });
        assert.equal(refused.status, 409);
        assert.match(((await refused.json()) as { error: string }).error, /cannot read pop-ups/);

        const form = await fetch(`${origin}/app/api/v1/watch`, { method: "PATCH", headers: { "content-type": "text/plain" }, body: "{}" });
        assert.equal(form.status, 415, "a write must be JSON");
    });
});
