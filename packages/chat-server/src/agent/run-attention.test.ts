/**
 * Failure modes: a card that waits for the person (an approval, a question, a form from a connected server) does not tell
 * the host, so nothing can notify them; or a card is announced when it is answered instead of when it appears; or an
 * answered approval is announced again.
 */

import type { ServerEvent } from "@pikvm/chat-protocol";
import { describe, expect, it } from "vitest";
import { ResponseRun } from "./run.ts";

function run() {
    const events: ServerEvent[] = [];
    const told: string[] = [];
    const r = new ResponseRun("c1", "m", (e) => void events.push(e));
    r.attention = (kind) => void told.push(kind);
    r.start();
    return { r, told, events };
}

describe("a response that waits for the person tells the host when the card appears", () => {
    it("an approval from the runtime, before it is answered", async () => {
        const { r, told } = run();
        const answer = r.requestApproval({ id: "u1", method: "confirm", title: "Allow?" });
        expect(told).toEqual(["approval"]);
        expect(r.answerApproval("apr_u1", true)).toBe(true);
        await answer;
        expect(told).toEqual(["approval"]);
    });

    it("an approval from a connected server's gateway", () => {
        const { r, told } = run();
        void r.requestGatewayApproval({ server_label: "s", name: "tool", arguments: "{}", title: "Allow?" });
        expect(told).toEqual(["approval"]);
    });

    it("a question", () => {
        const { r, told } = run();
        void r.requestQuestion({ id: "u2", method: "input", title: "Name?" });
        expect(told).toEqual(["question"]);
    });

    it("a form from a connected server", () => {
        const { r, told } = run();
        void r.requestElicitation({ server_label: "s", message: "Fill in", schema: {} } as never);
        expect(told).toEqual(["input"]);
    });

    it("nothing is announced when the host set no hook", () => {
        const events: ServerEvent[] = [];
        const r = new ResponseRun("c1", "m", (e) => void events.push(e));
        r.start();
        expect(() => void r.requestApproval({ id: "u3", method: "confirm" })).not.toThrow();
    });
});
