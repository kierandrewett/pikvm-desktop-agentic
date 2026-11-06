import assert from "node:assert/strict";
import { createPikvmMcp } from "@pikvm/mcp";
import { createDesk } from "../src/server/agent/desk";
import { createActivity } from "../src/server/agent/activity";
import { createPresence } from "../src/server/agent/presence";
import { unavailableApprover } from "../src/server/agent/approver";
import { createSharpImageOps } from "../src/image-ops-sharp";

// Run against a real PiKVM. Credentials remain in the process environment; audio is not saved.
const origin = process.env.PIKVM_URL;
const password = process.env.PIKVM_PASSWORD;
if (!origin || !password) throw new Error("Set PIKVM_URL and PIKVM_PASSWORD.");
const desk = createDesk({
    target: async () => ({
        origin: new URL(origin),
        headers: { "X-KVMD-User": process.env.PIKVM_USER || "admin", "X-KVMD-Passwd": password },
        // Same TLS policy as PiKvmControl: PiKVM ships a self-signed certificate.
        rejectUnauthorized: false,
    }),
    images: createSharpImageOps(),
    presence: createPresence(),
    activity: createActivity(),
});
const mcp = createPikvmMcp({ desk, approver: unavailableApprover });
const conversationId = "audio-smoke";
desk.beginRun(conversationId);
try {
    const response = await mcp.handle({ conversationId, signal: AbortSignal.timeout(25_000) }, {
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "listen", arguments: { duration_ms: 1000 } },
    });
    assert.ok(response && !response.error);
    const result = response.result as { isError?: boolean; content: { type: string; data?: string; mimeType?: string }[] };
    assert.ok(!result.isError, JSON.stringify(result));
    const audio = result.content.find((block) => block.type === "audio");
    assert.equal(audio?.mimeType, "audio/wav");
    const wav = Buffer.from(audio!.data!, "base64");
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    assert.equal(wav.readUInt16LE(22), 2);
    assert.equal(wav.readUInt32LE(24), 48000);
    assert.equal(wav.length, 192044);
    console.log(JSON.stringify({ tool: "listen", mimeType: audio!.mimeType, durationMs: 1000, wavBytes: wav.length }));
} finally {
    await desk.dispose();
}
