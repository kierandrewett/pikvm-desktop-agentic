/**
 * FAILURE MODES (written before the tests)
 *
 *  1. The KVM tab says nothing while the agent works, so a person finds the pointer moving with no
 *     explanation, or cannot stop it.
 *  2. Stop or Hand back is shown in a state where it does nothing (Hand back while the agent holds control).
 *  3. A person's input takes control and the KVM still says "Agent is working".
 *  4. Stop sends a request a page on another origin could send (no JSON body).
 *  5. A stream message this page cannot read replaces a good state, or a dropped stream leaves a stale banner.
 *  6. An approval waits in Chat and nothing outside Chat says so.
 *  7. The agent's pointer is drawn at the wrong place, or while the picture is zoomed.
 */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { actionLabel, AgentActivityProvider, parseActivity } from "../agent/activity";
import { AgentPointer } from "./agent-banner";
import { defaultServer, FakeEventSource, installEventSource, installFakeServer, installViewport, renderApp, type ServerState } from "../test/harness";

let server: ServerState;
let posts: { path: string; headers: Record<string, string>; body: string }[];
/** When set, the next agent POSTs are refused the way the server refuses them. */
let refuse: { status: number; error: string } | undefined;

beforeAll(async () => {
    await import("@pikvm/chat-web");
});

beforeEach(() => {
    server = defaultServer();
    installFakeServer(server);
    installViewport();
    installEventSource();
    posts = [];
    refuse = undefined;
    const base = globalThis.fetch;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname;
            if (path.startsWith("/app/api/v1/agent/")) {
                posts.push({ path, headers: Object.fromEntries(new Headers(init?.headers)), body: String(init?.body) });
                if (refuse) return new Response(JSON.stringify({ error: refuse.error }), { status: refuse.status, headers: { "content-type": "application/json" } });
                const answered = path.endsWith("/approval") ? { answered: true } : path.endsWith("stop") ? { stopped: true } : { handedBack: 1 };
                return new Response(JSON.stringify(answered), { headers: { "content-type": "application/json" } });
            }
            return base(input, init);
        }),
    );
});

afterEach(() => vi.unstubAllGlobals());

const NOW = 1_700_000_000_000;
async function stream(): Promise<FakeEventSource> {
    await waitFor(() => expect(FakeEventSource.sources.length).toBeGreaterThan(0));
    return FakeEventSource.sources[0]!;
}
const push = (source: FakeEventSource, activity: object) => act(() => source.emit({ at: NOW, ...activity }));

describe("the agent on the KVM tab", () => {
    it("opens the stream only when the host has a chat server", async () => {
        server.chat = false;
        renderApp("/kvm");
        await screen.findByRole("tab", { name: "KVM" });
        await new Promise((done) => setTimeout(done, 50));
        expect(FakeEventSource.sources).toHaveLength(0);
    });

    it("shows nothing while the agent is idle", async () => {
        renderApp("/kvm");
        const source = await stream();
        expect(source.url).toBe("/app/api/v1/agent/activity");
        await push(source, { state: "idle" });
        expect(document.querySelector(".kvm-agent")).toBeNull();
    });

    it("says who has control and what the agent is doing, with Stop", async () => {
        const user = userEvent.setup();
        renderApp("/kvm");
        const source = await stream();
        await push(source, { state: "working", conversationId: "c1", tool: "click", pointer: { fx: 0.25, fy: 0.5 } });
        const chip = document.querySelector<HTMLElement>(".kvm-agent")!;
        expect(within(chip).getByText("Agent is working")).toBeInTheDocument();
        expect(within(chip).getByText("Clicking")).toBeInTheDocument();
        expect(within(chip).queryByRole("button", { name: "Hand back" })).toBeNull();
        expect(document.querySelector(".kvm-stage")).toHaveAttribute("data-agent", "working");

        await user.click(within(chip).getByRole("button", { name: "Stop" }));
        await waitFor(() => expect(posts).toHaveLength(1));
        expect(posts[0]).toMatchObject({ path: "/app/api/v1/agent/stop", body: "{}" });
        expect(posts[0]?.headers["content-type"]).toBe("application/json");
    });

    it("marks the screen as the agent's while it works, and not while it waits for an answer or has let go", async () => {
        renderApp("/kvm");
        const source = await stream();
        const screen = () => document.querySelector(".kvm-screen");
        expect(screen()).not.toHaveAttribute("data-agent-lock");
        await push(source, { state: "working", tool: "click" });
        expect(screen()).toHaveAttribute("data-agent-lock");
        await push(source, { state: "waiting_approval", tool: "key" });
        expect(screen()).not.toHaveAttribute("data-agent-lock");
        await push(source, { state: "working", tool: "click" });
        await push(source, { state: "released", reason: "stopped" });
        expect(screen()).not.toHaveAttribute("data-agent-lock");
    });

    it("says a person has control after their input, and Hand back gives it again", async () => {
        const user = userEvent.setup();
        renderApp("/kvm");
        const source = await stream();
        await push(source, { state: "working", tool: "click" });
        await push(source, { state: "released", reason: "operator" });
        const chip = document.querySelector<HTMLElement>(".kvm-agent")!;
        expect(within(chip).getByText("You have control")).toBeInTheDocument();
        expect(within(chip).queryByText("Agent is working")).toBeNull();
        expect(within(chip).queryByRole("button", { name: "Stop" })).toBeNull();

        await user.click(within(chip).getByRole("button", { name: "Hand back" }));
        await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["/app/api/v1/agent/handback"]));
    });

    it("says Stop was pressed, with no button, and a lease that ran out", async () => {
        renderApp("/kvm");
        const source = await stream();
        await push(source, { state: "released", reason: "stopped" });
        let chip = document.querySelector<HTMLElement>(".kvm-agent")!;
        expect(within(chip).getByText("Agent stopped")).toBeInTheDocument();
        expect(within(chip).queryByRole("button")).toBeNull();
        await push(source, { state: "released", reason: "lease_timeout" });
        chip = document.querySelector<HTMLElement>(".kvm-agent")!;
        expect(within(chip).getByText("Agent control timed out")).toBeInTheDocument();
    });

    it("asks for approval in Chat: a button there, and a dot on the tab while another tab is in front", async () => {
        renderApp("/kvm", { compact: false });
        const source = await stream();
        await push(source, { state: "waiting_approval", tool: "key" });
        const chip = document.querySelector<HTMLElement>(".kvm-agent")!;
        expect(within(chip).getByText("Needs your approval")).toBeInTheDocument();
        expect(within(chip).getByRole("link", { name: "Open Chat" })).toHaveAttribute("href", "/app/chat");
        expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("data-attention", "true");
        expect(screen.getByRole("tab", { name: "KVM" })).not.toHaveAttribute("data-attention");
        await push(source, { state: "working", tool: "key" });
        expect(screen.getByRole("tab", { name: "Chat" })).not.toHaveAttribute("data-attention");
    });

    it("does not send the person to Chat for an outside MCP client's action: it has no conversation there", async () => {
        renderApp("/kvm");
        const source = await stream();
        await push(source, { state: "waiting_approval", conversationId: "mcp-Claude Code (MCP)", tool: "type_text" });
        const chip = document.querySelector<HTMLElement>(".kvm-agent")!;
        expect(within(chip).getByText("Needs your approval")).toBeInTheDocument();
        expect(within(chip).queryByRole("link", { name: "Open Chat" })).toBeNull();
        expect(within(chip).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    });

    it("asks about an outside client's action on the picture itself, with who, what and why, and Allow and Deny answer it", async () => {
        const user = userEvent.setup();
        renderApp("/kvm");
        await stream();
        await waitFor(() => expect(FakeEventSource.approvals.length).toBeGreaterThan(0));
        const waiting = FakeEventSource.approvals[0]!;
        expect(waiting.url).toBe("/app/api/v1/agent/approvals");
        const first = {
            id: "a1",
            client: "Claude Code (MCP)",
            tool: "type_text",
            title: "Type this on the PiKVM?",
            summary: 'Type: "ls -la\\n"',
            reasons: ["the text contains a line break, which submits"],
            at: NOW,
            expiresAt: NOW + 120_000,
        };
        act(() => waiting.emit([first, { ...first, id: "a2" }]));
        const card = await screen.findByRole("group", { name: "Approval needed" });
        expect(within(card).getByText("Claude Code (MCP) needs your approval")).toBeInTheDocument();
        expect(within(card).getByText('Type: "ls -la\\n"')).toBeInTheDocument();
        expect(within(card).getByText(/the text contains a line break/)).toBeInTheDocument();
        expect(within(card).getByText("1 more waiting.")).toBeInTheDocument();

        await user.click(within(card).getByRole("button", { name: "Allow" }));
        await waitFor(() => expect(posts).toHaveLength(1));
        expect(posts[0]).toMatchObject({ path: "/app/api/v1/agent/approval", body: JSON.stringify({ id: "a1", decision: "approved" }) });
        expect(posts[0]?.headers["content-type"]).toBe("application/json");

        await user.click(within(card).getByRole("button", { name: "Deny" }));
        await waitFor(() => expect(posts).toHaveLength(2));
        expect(posts[1]?.body).toBe(JSON.stringify({ id: "a1", decision: "denied" }));

        act(() => waiting.emit([]));
        await waitFor(() => expect(screen.queryByRole("group", { name: "Approval needed" })).toBeNull());
    });

    it("says so when the server will not take the answer, and drops the card when the stream drops", async () => {
        const user = userEvent.setup();
        refuse = { status: 404, error: "That request is not waiting any more." };
        renderApp("/kvm");
        await stream();
        await waitFor(() => expect(FakeEventSource.approvals.length).toBeGreaterThan(0));
        const waiting = FakeEventSource.approvals[0]!;
        act(() => waiting.emit([{ id: "a1", client: "Codex", tool: "key", title: "Press Alt+F4?", summary: "Press Alt+F4.", reasons: [], at: NOW, expiresAt: NOW + 1 }]));
        const card = await screen.findByRole("group", { name: "Approval needed" });
        await user.click(within(card).getByRole("button", { name: "Allow" }));
        expect(await within(card).findByText("That request is not waiting any more.")).toBeInTheDocument();
        act(() => waiting.emit("{not json"));
        expect(screen.getByRole("group", { name: "Approval needed" })).toBeInTheDocument();
        act(() => waiting.fail());
        await waitFor(() => expect(screen.queryByRole("group", { name: "Approval needed" })).toBeNull());
    });

    it("shows the waiting actions in the order they asked, and the one a link names first", async () => {
        const ask = (id: string, client: string) => ({ id, client, tool: "key", title: "Press Alt+F4?", summary: "Press Alt+F4.", reasons: [], at: NOW, expiresAt: NOW + 1 });
        const waiting = [ask("a1", "First"), ask("a2", "Second"), ask("a3", "Third")];

        const plain = renderApp("/kvm");
        await stream();
        await waitFor(() => expect(FakeEventSource.approvals.length).toBeGreaterThan(0));
        act(() => FakeEventSource.approvals[0]!.emit(waiting));
        const card = await screen.findByRole("group", { name: "Approval needed" });
        expect(within(card).getByText("First needs your approval")).toBeInTheDocument();
        expect(within(card).getByText("2 more waiting.")).toBeInTheDocument();
        plain.unmount();

        installEventSource();
        renderApp("/kvm?approve=a3");
        await stream();
        await waitFor(() => expect(FakeEventSource.approvals.length).toBeGreaterThan(0));
        act(() => FakeEventSource.approvals[0]!.emit(waiting));
        const linked = await screen.findByRole("group", { name: "Approval needed" });
        expect(within(linked).getByText("Third needs your approval")).toBeInTheDocument();
        act(() => FakeEventSource.approvals[0]!.emit(waiting.slice(0, 2)));
        await waitFor(() => expect(screen.getByRole("group", { name: "Approval needed" })).toHaveTextContent("First needs your approval"));
    });

    it("drops the banner when the stream drops, and ignores a message it cannot read", async () => {
        renderApp("/kvm");
        const source = await stream();
        await push(source, { state: "working", tool: "click" });
        expect(document.querySelector(".kvm-agent")).not.toBeNull();
        act(() => source.emit("{not json"));
        act(() => source.emit({ state: "no-such-state", at: 1 }));
        expect(document.querySelector(".kvm-agent")).not.toBeNull();
        act(() => source.fail());
        await waitFor(() => expect(document.querySelector(".kvm-agent")).toBeNull());
    });

    it("closes its stream when the page goes", async () => {
        const { unmount } = renderApp("/kvm");
        const source = await stream();
        unmount();
        expect(source.closed).toBe(true);
    });
});

describe("what the page reads from the stream", () => {
    it("decodes an activity and refuses anything else", () => {
        expect(parseActivity(JSON.stringify({ state: "working", tool: "click", pointer: { fx: 0.5, fy: 0.5 }, at: 1 }))?.state).toBe("working");
        expect(parseActivity("nope")).toBeUndefined();
        expect(parseActivity(JSON.stringify({ state: "working" }))).toBeUndefined();
    });

    it("names an action for a person, and shows an unknown tool as its name", () => {
        expect(actionLabel("type_text")).toBe("Typing");
        expect(actionLabel(undefined)).toBe("Working");
        expect(actionLabel("new_tool")).toBe("new tool");
    });
});

describe("the agent's pointer", () => {
    const frame = (width: number, height: number, scale = 1) =>
        render(
            <AgentActivityProvider enabled>
                <AgentPointer width={width} height={height} scale={scale} />
            </AgentActivityProvider>,
        );

    it("is drawn in a box with the picture's aspect ratio, at the fractions the server sent", async () => {
        frame(1920, 1080);
        const source = await stream();
        await push(source, { state: "working", tool: "click", pointer: { fx: 0.25, fy: 0.5 } });
        const dot = await screen.findByTestId("agent-pointer");
        expect(dot.style.left).toBe("25%");
        expect(dot.style.top).toBe("50%");
        expect((dot.parentElement as HTMLElement).style.aspectRatio).toBe("1920 / 1080");
    });

    it("is not drawn before a frame, while the picture is zoomed, or when the agent is not working", async () => {
        const { rerender } = frame(0, 0);
        const source = await stream();
        await push(source, { state: "working", pointer: { fx: 0.5, fy: 0.5 } });
        expect(screen.queryByTestId("agent-pointer")).toBeNull();
        rerender(
            <AgentActivityProvider enabled>
                <AgentPointer width={1920} height={1080} scale={2} />
            </AgentActivityProvider>,
        );
        expect(screen.queryByTestId("agent-pointer")).toBeNull();
        await push(source, { state: "released", reason: "operator", pointer: { fx: 0.5, fy: 0.5 } });
        expect(screen.queryByTestId("agent-pointer")).toBeNull();
    });
});
