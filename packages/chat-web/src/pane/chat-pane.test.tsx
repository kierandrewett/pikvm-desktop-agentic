import type { OutputItem } from "@pikvm/chat-protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetSession, queryClient } from "../lib/queries";
import { bootstrap, FakeSocket, installFakeServer } from "../test/fake-server";
import { ChatPane } from "./chat-pane";
import { ChatScope } from "./chat-scope";

const summary = {
    id: "c1",
    title: "Open the BIOS",
    updatedAt: 1,
    createdAt: 1,
    pinnedAt: null,
    archivedAt: null,
    active: false,
    model: "fake/model",
};

const user: OutputItem = {
    id: "u1",
    type: "message",
    role: "user",
    status: "completed",
    created_at: 1,
    content: [{ type: "input_text", text: "Click the centre" }],
} as OutputItem;

function routes(items: OutputItem[]) {
    return {
        "/bootstrap": bootstrap,
        "/settings": { settings: [], free: [] },
        "/conversations": { conversations: [summary] },
        "/conversations/c1": { conversation: summary },
        "/conversations/c1/items": { items, hasMore: false },
        "/models": { models: [], defaultModel: null },
    };
}

function mount() {
    return render(
        <ChatScope>
            <ChatPane />
        </ChatScope>,
    );
}

beforeEach(() => {
    queryClient.clear();
    // Drop the socket and the live state of the previous test; the next mount connects again.
    forgetSession();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

async function open() {
    mount();
    await userEvent.click(await screen.findByRole("link", { name: /Open the BIOS/ }));
}

describe("ChatPane", () => {
    it("shows the signed-out note when the server answers without a user", async () => {
        installFakeServer({ ...routes([]), "/bootstrap": { ...bootstrap, user: null } });
        mount();
        expect(await screen.findByText("You are signed out")).toBeInTheDocument();
    });

    it("renders stored turns and a PiKVM tool card", async () => {
        installFakeServer(
            routes([
                user,
                {
                    id: "f1",
                    type: "function_call",
                    status: "completed",
                    call_id: "k1",
                    name: "mcp__pikvm_click",
                    arguments: JSON.stringify({ x: 640, y: 360 }),
                } as OutputItem,
                {
                    id: "o1",
                    type: "function_call_output",
                    status: "completed",
                    call_id: "k1",
                    output: "Clicked (left) at (640, 360).",
                } as OutputItem,
            ]),
        );
        mount();
        await userEvent.click(await screen.findByRole("link", { name: /Open the BIOS/ }));
        expect(await screen.findByText("Click the centre")).toBeInTheDocument();
        // The group of steps is collapsed behind a header; open it.
        await userEvent.click(await screen.findByRole("button", { name: /Used click/ }));
        const card = await waitFor(() => {
            const el = document.querySelector("[data-pikvm-step]");
            expect(el).not.toBeNull();
            return el as HTMLElement;
        });
        expect(within(card).getByText("Click at (640, 360)")).toBeInTheDocument();
        expect(within(card).getByText("Clicked (left) at (640, 360).")).toBeInTheDocument();
    });

    it("shows the screenshot and the click point on the PiKVM cards of a stored turn", async () => {
        const frame = { id: "abc123def456ghi789", width: 320, height: 180, url: "/api/conversations/c1/frames/abc123def456ghi789" };
        const call = (id: string, name: string, args: unknown) =>
            ({ id, type: "function_call", status: "completed", call_id: id, name, arguments: JSON.stringify(args) }) as OutputItem;
        const result = (id: string, output: string) =>
            ({ id: `o${id}`, type: "function_call_output", status: "completed", call_id: id, output, frame }) as OutputItem;
        installFakeServer(
            routes([
                user,
                call("k1", "mcp__pikvm_screenshot", {}),
                result("k1", "Screen 320x180 (frame 1). Mouse: absolute."),
                call("k2", "mcp__pikvm_click", { x: 160, y: 90 }),
                result("k2", "Clicked (left) at (160, 90)."),
            ]),
        );
        await open();
        await userEvent.click(await screen.findByRole("button", { name: /Used / }));
        const cards = await waitFor(() => {
            const found = [...document.querySelectorAll<HTMLElement>("[data-pikvm-step]")];
            expect(found).toHaveLength(2);
            return found;
        });
        for (const c of cards) {
            expect(c.querySelector("[data-pikvm-thumb] img")?.getAttribute("src")).toBe(
                "/app/chat/api/conversations/c1/frames/abc123def456ghi789",
            );
        }
        // The look has no point; the click is drawn on the middle of the same frame.
        expect(cards[0]!.querySelector("[data-pikvm-marker]")).toBeNull();
        const mark = cards[1]!.querySelector<HTMLElement>("[data-pikvm-marker]")!;
        expect([mark.style.left, mark.style.top]).toEqual(["50%", "50%"]);
    });

    it("streams an assistant reply into the thread", async () => {
        installFakeServer(routes([user]));
        await open();
        await screen.findByText("Click the centre");
        const ws = FakeSocket.current!;
        const response = {
            id: "r1",
            conversation: { id: "c1" },
            status: "in_progress",
            output: [],
        };
        act(() => {
            ws.emit({ type: "response.created", response });
            ws.emit({
                type: "response.output_item.added",
                response_id: "r1",
                output_index: 0,
                item: {
                    id: "m1",
                    type: "message",
                    role: "assistant",
                    status: "in_progress",
                    content: [{ type: "output_text", text: "", annotations: [] }],
                },
            });
            ws.emit({
                type: "response.output_text.delta",
                response_id: "r1",
                output_index: 0,
                content_index: 0,
                delta: "The screen shows the BIOS.",
            });
        });
        await waitFor(() => expect(document.querySelector(".thread-scroll")?.textContent).toContain("The screen shows the BIOS."));
    });

    it("sends the right protocol message for Allow and for Deny", async () => {
        installFakeServer(routes([user]));
        await open();
        await screen.findByText("Click the centre");
        const ws = FakeSocket.current!;
        const approval = (id: string, summary = "Press ctrl+alt+delete") => ({
            id,
            type: "mcp_approval_request",
            server_label: "pikvm",
            name: "mcp__pikvm_key",
            arguments: JSON.stringify({ keys: ["ctrl", "alt", "delete"] }),
            title: summary,
            reason: "risky",
            summary,
            reasons: ["system shortcut"],
        });
        act(() => {
            ws.emit({
                type: "response.created",
                response: { id: "r2", conversation: { id: "c1" }, status: "in_progress", output: [] },
            });
            ws.emit({ type: "response.output_item.added", response_id: "r2", output_index: 0, item: approval("a1") });
        });
        const region = await screen.findByRole("region", { name: /Approval needed/ });
        expect(within(region).getByText("Press ctrl+alt+delete")).toBeInTheDocument();
        await userEvent.click(within(region).getByRole("button", { name: "Deny" }));
        expect(ws.sent.at(-1)).toMatchObject({
            type: "response.create",
            conversation: "c1",
            input: [{ type: "mcp_approval_response", approval_request_id: "a1", approve: false }],
        });
        act(() => {
            ws.emit({ type: "response.output_item.added", response_id: "r2", output_index: 1, item: approval("a2", "Press ctrl+c") });
        });
        const second = await screen.findByRole("region", { name: /Approval needed/ });
        await within(second).findByText("Press ctrl+c");
        await userEvent.click(within(second).getByRole("button", { name: "Allow" }));
        expect(ws.sent.at(-1)).toMatchObject({
            input: [{ type: "mcp_approval_response", approval_request_id: "a2", approve: true }],
        });
    });

    it("docks the composer at the bottom of the pane and uses the drawer layout on a phone", async () => {
        vi.stubGlobal(
            "matchMedia",
            (query: string) =>
                ({
                    matches: query.includes("pointer: coarse") || query.includes("max-width"),
                    media: query,
                    addEventListener() {},
                    removeEventListener() {},
                }) as unknown as MediaQueryList,
        );
        installFakeServer(routes([user]));
        mount();
        expect(await screen.findByRole("button", { name: "Open sidebar" })).toBeInTheDocument();
        expect(document.querySelector('[data-shell="phone"]')).not.toBeNull();
        // The drawer is inside the pane, not over the window.
        expect(document.querySelector(".chat-scope [data-shell='phone']")).not.toBeNull();
        await userEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
        await userEvent.click(await screen.findByRole("link", { name: /Open the BIOS/ }));
        await screen.findByText("Click the centre");
        const footer = document.querySelector("footer");
        expect(footer?.className).toMatch(/absolute/);
        expect(footer?.className).toMatch(/bottom-0/);
        expect(footer?.className).toMatch(/safe-bottom/);
    });
});
