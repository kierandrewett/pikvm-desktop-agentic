// @vitest-environment jsdom

/**
 * FAILURE MODES (written before the tests)
 *
 * Layout
 *  1. A phone gets the desktop's rail (no room for the thread), or a wide screen gets the
 *     phone's "open tasks" button with nothing for it to open.
 *  2. The task sheet cannot be dismissed, or stays open after a task is chosen so the
 *     person is looking at the list instead of the conversation they picked.
 *  3. Pickers (model, header menu) are popovers on a phone: cramped, under the keyboard,
 *     with rows sized for a mouse.
 *
 * Soft keyboard
 *  4. The composer is behind the keyboard because the workspace only knows the layout
 *     viewport (iOS does not resize it).
 *  5. The workspace adds a gap for a keyboard its host already made room for (doubled).
 *  6. "Keyboard open" is judged from focus, so an external keyboard hides things for good.
 *
 * Approvals
 *  7. On a phone the approval is only in the thread, scrolled out of reach; or it is in
 *     both places and a thumb has two Allow buttons to choose between.
 *  8. Allow is one tap on a consequential action; Deny is two.
 *  9. The answer goes to the wrong endpoint, or without the intent header the harness
 *     requires, or without the header that marks the request as coming from this app.
 * 10. A refused answer leaves the controls dead, so the agent waits forever.
 *
 * Long-press
 * 11. A mouse click, a scroll, or a short touch opens the message sheet.
 * 12. Copy claims success when the clipboard refused.
 *
 * Managed host (the PiKVM app)
 * 13. The workspace asks for a token nobody has, or offers to disconnect a session the
 *     host owns, or writes the marker credential into storage.
 * 14. A 502/503 from the proxy looks like an empty workspace instead of "the agent is not
 *     running", and recovery needs a reload.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_PRESS_MS } from "../../hooks/use-long-press";
import {
    baseRun,
    type FakeHarness,
    installFakeHarness,
    installVisualViewport,
    stubLayoutBottom,
} from "../../test/fake-harness";
import { ChatWorkspace, type ChatWorkspaceProps } from "./chat-workspace";

const MANAGED = { apiBase: "/app/harness", managedToken: "desktop-managed", insets: "host" } as const;

const pendingApprovalRun = () =>
    baseRun({
        run_id: "run-1",
        task: "Send the report",
        status: "needs_approval",
        pending_approval: {
            approval_id: "apr-1",
            tool: "mail.send",
            risk: "side effect",
            reason: "This external tool may send a message.",
        },
    });

let harness: FakeHarness;

const mount = (props: ChatWorkspaceProps = {}) => render(<ChatWorkspace {...MANAGED} {...props} />);

const untilConnected = async () => {
    await screen.findByRole("region", { name: "Agent conversation" });
};

beforeEach(() => {
    harness = installFakeHarness({ runs: [baseRun()] });
});

afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "visualViewport");
});

describe("layout", () => {
    it("draws the task rail beside the thread on a wide screen, with no tasks button", async () => {
        mount({ compact: false });
        await untilConnected();
        expect(document.querySelector(".workspace-rail")).not.toBeNull();
        expect(screen.queryByRole("button", { name: "Open tasks" })).toBeNull();
        expect(document.querySelector(".workspace-shell")).toHaveAttribute("data-layout", "wide");
    });

    it("gives a phone the whole width, with the tasks behind a header button", async () => {
        mount({ compact: true });
        await untilConnected();
        expect(document.querySelector(".workspace-rail")).toBeNull();
        expect(screen.getByRole("button", { name: "Open tasks" })).toBeInTheDocument();
        expect(document.querySelector(".workspace-shell")).toHaveAttribute("data-layout", "compact");
    });

    it("opens the task list in a sheet, closes it with Escape and again when a task is chosen", async () => {
        const user = userEvent.setup();
        harness.runs = [baseRun(), baseRun({ run_id: "run-2", task: "Reboot the VM" })];
        mount({ compact: true });
        await untilConnected();

        await user.click(screen.getByRole("button", { name: "Open tasks" }));
        const sheet = await screen.findByRole("dialog", { name: "Tasks" });
        expect(within(sheet).getByText("Reboot the VM")).toBeInTheDocument();

        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Tasks" })).toBeNull());

        await user.click(screen.getByRole("button", { name: "Open tasks" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Tasks" })).getByText("Reboot the VM"));
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Tasks" })).toBeNull());
        await waitFor(() => expect(harness.callsTo("GET", "/api/runs/run-2").length).toBeGreaterThan(0));
    });

    it("shows the model picker as a bottom sheet on a phone and as a popover on a wide screen", async () => {
        const user = userEvent.setup();
        const phone = mount({ compact: true });
        await untilConnected();
        await user.click(await screen.findByRole("combobox", { name: /^Model:/ }));
        const sheet = document.querySelector('[data-slot="select-content"]');
        expect(sheet).toHaveAttribute("data-presentation", "sheet");
        phone.unmount();

        mount({ compact: false });
        await untilConnected();
        await user.click(await screen.findByRole("combobox", { name: /^Model:/ }));
        expect(document.querySelector('[data-slot="select-content"]')).toHaveAttribute("data-presentation", "popover");
    });

    it("opens the header menu as a bottom sheet on a phone", async () => {
        const user = userEvent.setup();
        mount({ compact: true });
        await untilConnected();
        await user.click(screen.getByRole("button", { name: "More workspace actions" }));
        expect(await screen.findByRole("menuitem", { name: "Diagnostics" })).toBeInTheDocument();
        expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toHaveAttribute("data-presentation", "sheet");
    });
});

describe("soft keyboard", () => {
    it("docks the composer above the keyboard when the layout viewport did not shrink", async () => {
        const viewport = installVisualViewport(800);
        stubLayoutBottom(800);
        mount({ compact: true, insets: "self" });
        await untilConnected();
        const root = document.querySelector<HTMLElement>(".workspace-shell")!;
        expect(root.style.getPropertyValue("--chat-keyboard-inset")).toBe("0px");
        expect(root).toHaveAttribute("data-keyboard", "closed");

        act(() => viewport.resize(500));
        await waitFor(() => expect(root.style.getPropertyValue("--chat-keyboard-inset")).toBe("300px"));
        expect(root).toHaveAttribute("data-keyboard", "open");

        act(() => viewport.resize(800));
        await waitFor(() => expect(root.style.getPropertyValue("--chat-keyboard-inset")).toBe("0px"));
        expect(root).toHaveAttribute("data-keyboard", "closed");
    });

    it("adds no gap when the host already resized the workspace to the visual viewport", async () => {
        const viewport = installVisualViewport(800);
        // The shell shrinks with the visual viewport, so the workspace's bottom edge follows it.
        let bottom = 800;
        vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
            () => ({ x: 0, y: 0, top: 0, left: 0, right: 390, width: 390, height: bottom, bottom, toJSON: () => ({}) }) as DOMRect,
        );
        mount({ compact: true });
        await untilConnected();
        const root = document.querySelector<HTMLElement>(".workspace-shell")!;

        bottom = 500;
        act(() => viewport.resize(500));
        await waitFor(() => expect(root).toHaveAttribute("data-keyboard", "open"));
        expect(root.style.getPropertyValue("--chat-keyboard-inset")).toBe("0px");
    });

    it("measures the keyboard from the viewport, not from focus", async () => {
        const viewport = installVisualViewport(800);
        stubLayoutBottom(800);
        mount({ compact: true });
        await untilConnected();
        const root = document.querySelector<HTMLElement>(".workspace-shell")!;
        // A composer with focus but a viewport that has not shrunk: an external keyboard.
        screen.getByRole("textbox", { name: "Message" }).focus();
        act(() => viewport.resize(780));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(root).toHaveAttribute("data-keyboard", "closed");
    });
});

describe("approvals", () => {
    beforeEach(() => {
        harness.runs = [pendingApprovalRun()];
    });

    it("keeps the approval in a dock above the composer on a phone, and not on a wide screen", async () => {
        const phone = mount({ compact: true });
        const dock = await screen.findByRole("region", { name: "Approval needed" });
        expect(within(dock).getByText("Allow mail.send?")).toBeInTheDocument();
        expect(within(dock).getByRole("button", { name: "Allow once" })).toBeInTheDocument();
        expect(within(dock).getByRole("button", { name: "Deny & stop" })).toBeInTheDocument();
        phone.unmount();

        mount({ compact: false });
        await untilConnected();
        expect(screen.queryByRole("region", { name: "Approval needed" })).toBeNull();
    });

    it("asks for a second tap before allowing, then posts the approval with its intent header", async () => {
        const user = userEvent.setup();
        mount({ compact: true });
        const dock = await screen.findByRole("region", { name: "Approval needed" });

        await user.click(within(dock).getByRole("button", { name: "Allow once" }));
        expect(harness.callsTo("POST", "/api/runs/run-1/approvals")).toHaveLength(0);
        expect(await within(dock).findByText("This external tool may send a message.")).toBeInTheDocument();

        await user.click(within(dock).getByRole("button", { name: "Confirm" }));
        await waitFor(() => expect(harness.callsTo("POST", "/api/runs/run-1/approvals")).toHaveLength(1));
        const [call] = harness.callsTo("POST", "/api/runs/run-1/approvals");
        expect(call?.path).toBe("/api/runs/run-1/approvals/apr-1");
        expect(call?.search).toBe("?background=true");
        expect(call?.headers["x-pikvm-approval-intent"]).toBe("apr-1");
        expect(call?.headers["x-pikvm-workspace"]).toBe("1");
        expect(call?.body).toEqual({ type: "approve", reason: "" });
    });

    it("denies in one tap", async () => {
        const user = userEvent.setup();
        mount({ compact: true });
        const dock = await screen.findByRole("region", { name: "Approval needed" });

        await user.click(within(dock).getByRole("button", { name: "Deny & stop" }));
        await waitFor(() => expect(harness.callsTo("POST", "/api/runs/run-1/approvals")).toHaveLength(1));
        const [call] = harness.callsTo("POST", "/api/runs/run-1/approvals");
        expect(call?.body).toEqual({ type: "reject", reason: "" });
        expect(call?.headers["x-pikvm-approval-intent"]).toBe("apr-1");
    });

    it("shows the refusal and puts the controls back when the answer does not go through", async () => {
        const user = userEvent.setup();
        harness.approvalStatus = 409;
        mount({ compact: true });
        const dock = await screen.findByRole("region", { name: "Approval needed" });

        await user.click(within(dock).getByRole("button", { name: "Deny & stop" }));
        // The dock remounts after a refusal so its controls are live again.
        const refusal = await within(await screen.findByRole("region", { name: "Approval needed" })).findByRole("alert");
        expect(refusal).toHaveTextContent("approval refused");
        expect(screen.getByRole("button", { name: "Deny & stop" })).toBeEnabled();
    });
});

describe("message long-press", () => {
    const writeText = vi.fn<(text: string) => Promise<void>>();

    // user-event installs its own clipboard when a user is set up, so ours goes in after it.
    const setupUser = () => {
        const user = userEvent.setup();
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
        return user;
    };

    beforeEach(() => {
        writeText.mockReset();
        writeText.mockResolvedValue(undefined);
    });

    const assistantMessage = async () => {
        await screen.findByText("There is 120 GB free on C:.");
        return document.querySelector<HTMLElement>('[data-slot="aui_assistant-message-root"]')!;
    };
    const hold = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    it("opens the message sheet after a touch is held, and Copy writes the message text", async () => {
        const user = setupUser();
        mount({ compact: true });
        const message = await assistantMessage();

        fireEvent.pointerDown(message, { pointerType: "touch", clientX: 10, clientY: 10 });
        await hold(LONG_PRESS_MS + 80);
        const sheet = await screen.findByRole("dialog", { name: "Message" });

        await user.click(within(sheet).getByRole("button", { name: "Copy text" }));
        expect(writeText).toHaveBeenCalledWith("There is 120 GB free on C:.");
        expect(await within(sheet).findByText("Copied")).toBeInTheDocument();
    });

    it("ignores a mouse, a short touch and a touch that moves (a scroll)", async () => {
        mount({ compact: true });
        const message = await assistantMessage();

        fireEvent.pointerDown(message, { pointerType: "mouse", clientX: 10, clientY: 10 });
        await hold(LONG_PRESS_MS + 80);
        expect(screen.queryByRole("dialog", { name: "Message" })).toBeNull();

        fireEvent.pointerDown(message, { pointerType: "touch", clientX: 10, clientY: 10 });
        fireEvent.pointerUp(message, { pointerType: "touch" });
        await hold(LONG_PRESS_MS + 80);
        expect(screen.queryByRole("dialog", { name: "Message" })).toBeNull();

        fireEvent.pointerDown(message, { pointerType: "touch", clientX: 10, clientY: 10 });
        fireEvent.pointerMove(message, { pointerType: "touch", clientX: 10, clientY: 80 });
        await hold(LONG_PRESS_MS + 80);
        expect(screen.queryByRole("dialog", { name: "Message" })).toBeNull();
    });

    it("does nothing on a wide screen", async () => {
        mount({ compact: false });
        const message = await assistantMessage();
        fireEvent.pointerDown(message, { pointerType: "touch", clientX: 10, clientY: 10 });
        await hold(LONG_PRESS_MS + 80);
        expect(screen.queryByRole("dialog", { name: "Message" })).toBeNull();
    });

    it("says so when the browser refuses the copy", async () => {
        const user = setupUser();
        writeText.mockRejectedValue(new Error("denied"));
        mount({ compact: true });
        const message = await assistantMessage();
        fireEvent.pointerDown(message, { pointerType: "touch", clientX: 10, clientY: 10 });
        await hold(LONG_PRESS_MS + 80);
        const sheet = await screen.findByRole("dialog", { name: "Message" });
        await user.click(within(sheet).getByRole("button", { name: "Copy text" }));
        expect(await within(sheet).findByRole("alert")).toHaveTextContent("would not let this page copy");
        expect(within(sheet).queryByText("Copied")).toBeNull();
    });
});

describe("a host that manages sign-in", () => {
    it("connects through the API base with the workspace header, never asks for a token and stores nothing", async () => {
        mount();
        await untilConnected();
        const first = harness.calls.find((call) => call.path === "/api/runs");
        expect(first?.headers["x-pikvm-workspace"]).toBe("1");
        expect(first?.headers["authorization"]).toBe("Bearer desktop-managed");
        expect(screen.queryByRole("dialog", { name: /token|connect/i })).toBeNull();
        expect(sessionStorage.getItem("pikvm-harness-token")).toBeNull();
    });

    it("does not offer to disconnect a session the host owns", async () => {
        const user = userEvent.setup();
        mount({ compact: false });
        await untilConnected();
        await user.click(screen.getByRole("button", { name: "More workspace actions" }));
        await screen.findByRole("menuitem", { name: "Diagnostics" });
        expect(screen.queryByRole("menuitem", { name: "Disconnect" })).toBeNull();
    });

    it.each([502, 503])("says the agent is not running when the proxy answers %i, then recovers by itself", async (status) => {
        harness.status = status;
        mount();
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveAttribute("data-reason", "agent-down");
        expect(within(alert).getByRole("heading", { name: "The agent is not running" })).toBeInTheDocument();
        expect(alert).toHaveTextContent(String(status));
        expect(screen.queryByRole("region", { name: "Agent conversation" })).toBeNull();

        harness.status = 200;
        await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
        await untilConnected();
    });

    it("tells a refusal from an outage", async () => {
        harness.status = 403;
        mount();
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveAttribute("data-reason", "refused");
        expect(within(alert).getByRole("heading", { name: "Chat was refused" })).toBeInTheDocument();
    });
});
