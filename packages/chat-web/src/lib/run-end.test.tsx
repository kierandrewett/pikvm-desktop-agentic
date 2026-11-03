/**
 * The run-end signal the host hears (the app's icon badge hangs on it).
 *
 * Failure modes:
 *  R1. A response that ends is not announced, or is announced for the wrong conversation or with the wrong status.
 *  R2. The replay of an old end after a reconnect (`chat.resume`) is announced as if the run had just finished.
 *  R3. A host's listener that throws stops the pane settling the conversation, or the others hearing.
 */

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetSession, queryClient } from "./queries";
import { ChatPane } from "../pane/chat-pane";
import { ChatScope } from "../pane/chat-scope";
import { bootstrap, FakeSocket, installFakeServer } from "../test/fake-server";
import { announceRunFinished, onRunFinished, type RunFinished } from "./run-end";

const summary = { id: "c1", title: "Open the BIOS", updatedAt: 1, createdAt: 1, pinnedAt: null, archivedAt: null, active: false, model: "fake/model" };

function routes() {
    return {
        "/bootstrap": bootstrap,
        "/settings": { settings: [], free: [] },
        "/conversations": { conversations: [summary] },
        "/conversations/c1": { conversation: summary },
        "/conversations/c1/items": { items: [], hasMore: false },
        "/models": { models: [], defaultModel: null },
    };
}

beforeEach(() => {
    queryClient.clear();
    forgetSession();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

const response = (id: string, status: string) => ({ id, conversation: { id: "c1" }, status, output: [] });

describe("R1/R2: the pane announces what it watched", () => {
    async function mounted() {
        installFakeServer(routes());
        const heard: RunFinished[] = [];
        const stop = onRunFinished((event) => heard.push(event));
        render(
            <ChatScope>
                <ChatPane />
            </ChatScope>,
        );
        await screen.findByRole("link", { name: /Open the BIOS/ });
        return { heard, stop, ws: FakeSocket.current! };
    }

    it("R1: a response that completes, fails, or is stopped is announced once, with its conversation and how it ended", async () => {
        const { heard, stop, ws } = await mounted();
        act(() => {
            ws.emit({ type: "response.created", response: response("r1", "in_progress") });
            ws.emit({ type: "response.completed", response: response("r1", "completed") });
            ws.emit({ type: "response.created", response: response("r2", "in_progress") });
            ws.emit({ type: "response.failed", response: response("r2", "failed") });
            ws.emit({ type: "response.created", response: response("r3", "in_progress") });
            ws.emit({ type: "response.cancelled", response: response("r3", "cancelled") });
        });
        expect(heard).toEqual([
            { conversationId: "c1", status: "completed" },
            { conversationId: "c1", status: "failed" },
            { conversationId: "c1", status: "cancelled" },
        ]);
        stop();
    });

    it("R2: an end replayed by chat.resume for a conversation this page never watched run is not announced", async () => {
        const { heard, stop, ws } = await mounted();
        act(() => {
            ws.emit({ type: "response.completed", response: response("old", "completed") });
        });
        expect(heard).toEqual([]);
        stop();
    });

    it("R2: the same end twice is announced once", async () => {
        const { heard, stop, ws } = await mounted();
        act(() => {
            ws.emit({ type: "response.created", response: response("r1", "in_progress") });
            ws.emit({ type: "response.completed", response: response("r1", "completed") });
            ws.emit({ type: "response.completed", response: response("r1", "completed") });
        });
        expect(heard).toHaveLength(1);
        stop();
    });

    it("stops listening when asked", async () => {
        const { heard, stop, ws } = await mounted();
        stop();
        act(() => {
            ws.emit({ type: "response.created", response: response("r1", "in_progress") });
            ws.emit({ type: "response.completed", response: response("r1", "completed") });
        });
        expect(heard).toEqual([]);
    });
});

describe("R3: a listener that throws", () => {
    it("does not stop the others from hearing", () => {
        const heard = vi.fn();
        const stopBad = onRunFinished(() => {
            throw new Error("host bug");
        });
        const stopGood = onRunFinished(heard);
        expect(() => announceRunFinished({ conversationId: "c1", status: "completed" })).not.toThrow();
        expect(heard).toHaveBeenCalledTimes(1);
        stopBad();
        stopGood();
    });
});
