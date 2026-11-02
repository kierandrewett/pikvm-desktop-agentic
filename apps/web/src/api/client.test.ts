/**
 * FAILURE MODES (written before the tests)
 *
 *  1. A non-2xx reply's `{error}` text is lost, so the user reads a status code or a decode
 *     failure instead of the server's reason.
 *  2. A reply that is not the contract's shape is accepted as if it were (a wrong type
 *     reaches the UI) or crashes with an Effect internals message.
 *  3. A dead network is reported with a message that blames the user's input.
 *  4. A failure rejects with Effect's FiberFailure wrapper, so `.message` is unreadable.
 *  5. The PATCH goes to the wrong path or carries a different body than the patch given.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, getState, patchSettings, runApi } from "./client";

afterEach(() => {
    vi.unstubAllGlobals();
});

const reply = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });

describe("api client", () => {
    it("rejects with the server's own reason on a non-2xx reply", async () => {
        vi.stubGlobal("fetch", async () => reply(400, { error: "unknown key accessToken" }));
        const failure = await runApi(patchSettings({ jiggler: true })).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ApiFailure);
        expect(failure).toMatchObject({ message: "unknown key accessToken", status: 400 });
    });

    it("falls back to the status when the error body is not ours", async () => {
        vi.stubGlobal("fetch", async () => reply(502, "<html>bad gateway</html>"));
        await expect(runApi(getState())).rejects.toMatchObject({ message: "The server answered 502.", status: 502 });
    });

    it("refuses a reply that does not match the contract", async () => {
        vi.stubGlobal("fetch", async () => reply(200, { settings: { keyboardLayout: "de", jiggler: true } }));
        await expect(runApi(getState())).rejects.toMatchObject({
            message: "The server sent a reply this app does not understand.",
        });
    });

    it("names an unreachable server as such", async () => {
        vi.stubGlobal("fetch", async () => {
            throw new TypeError("Failed to fetch");
        });
        await expect(runApi(getState())).rejects.toMatchObject({ message: "Cannot reach the app server." });
    });

    it("sends the patch as given to the settings path", async () => {
        const seen: Array<{ url: string; method: string | undefined; body: string }> = [];
        vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
            seen.push({
                url: new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname,
                method: init?.method,
                body: new TextDecoder().decode(init?.body as Uint8Array),
            });
            return reply(200, { keyboardLayout: "uk", jiggler: false });
        });
        const saved = await runApi(patchSettings({ keyboardLayout: "uk" }));
        expect(saved).toEqual({ keyboardLayout: "uk", jiggler: false });
        expect(seen).toEqual([{ url: "/app/api/v1/settings", method: "PATCH", body: '{"keyboardLayout":"uk"}' }]);
    });
});
