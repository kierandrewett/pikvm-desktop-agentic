// @vitest-environment jsdom

/**
 * FAILURE MODES (written before the tests)
 *
 *  1. A long code block is dumped in full and pushes the conversation off screen; or a
 *     short one gets a pointless "Show all" toggle.
 *  2. The toggle names no size, so it is unclear what is being skipped, or it cannot be
 *     reopened once collapsed.
 *  3. Text inside highlighted (nested) code is miscounted, so a block collapses at the
 *     wrong length.
 *  4. A starter prompt SENDS: the agent acts on a real machine, so choosing a suggestion
 *     must only fill the composer.
 *  5. The starters stay once a conversation exists.
 *  6. Markdown is loaded lazily: a message is blank until the chunk arrives, or never
 *     gains its formatting.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseRun, installFakeHarness } from "../../test/fake-harness";
import { ChatWorkspace } from "../workspace/chat-workspace";
import { CodeBlockBody, COLLAPSE_AFTER_LINES, lineCount, textOf } from "./code-block";
import { STARTER_PROMPTS } from "./thread";

afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
});

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

describe("code blocks", () => {
    it("counts lines through highlighting spans and ignores a trailing newline", () => {
        const node = (
            <code>
                <span>one</span>
                {"\n"}
                <span>two</span>
                {"\n"}
            </code>
        );
        expect(textOf(node)).toBe("one\ntwo\n");
        expect(lineCount(textOf(node))).toBe(2);
        expect(lineCount("")).toBe(0);
    });

    it("leaves a short block alone", () => {
        render(
            <CodeBlockBody>
                <code>{lines(5)}</code>
            </CodeBlockBody>,
        );
        expect(screen.queryByRole("button")).toBeNull();
        expect(document.querySelector(".aui-code-block")).toHaveAttribute("data-collapsed", "false");
    });

    it("collapses a long block, says how long it is, and reopens and recloses it", async () => {
        const user = userEvent.setup();
        const count = COLLAPSE_AFTER_LINES + 6;
        render(
            <CodeBlockBody>
                <code>{lines(count)}</code>
            </CodeBlockBody>,
        );
        const block = document.querySelector(".aui-code-block")!;
        expect(block).toHaveAttribute("data-collapsed", "true");

        await user.click(screen.getByRole("button", { name: `Show all ${count} lines` }));
        expect(block).toHaveAttribute("data-collapsed", "false");
        expect(screen.getByRole("button", { name: "Collapse" })).toHaveAttribute("aria-expanded", "true");

        await user.click(screen.getByRole("button", { name: "Collapse" }));
        expect(block).toHaveAttribute("data-collapsed", "true");
    });
});

describe("empty state", () => {
    it("offers starters that fill the composer and never send", async () => {
        const user = userEvent.setup();
        const harness = installFakeHarness({ runs: [] });
        render(<ChatWorkspace apiBase="/app/harness" managedToken="desktop-managed" compact={false} insets="host" />);

        const prompt = STARTER_PROMPTS[0];
        await user.click(await screen.findByRole("button", { name: prompt }));

        await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(prompt));
        expect(harness.callsTo("POST", "/api/runs")).toHaveLength(0);
    });

    it("drops the starters once there is a conversation", async () => {
        installFakeHarness({ runs: [baseRun()] });
        render(<ChatWorkspace apiBase="/app/harness" managedToken="desktop-managed" compact={false} insets="host" />);
        await screen.findByText("There is 120 GB free on C:.");
        expect(screen.queryByRole("button", { name: STARTER_PROMPTS[0] })).toBeNull();
    });

    it("shows a message's text at once and formats it once the markdown chunk has loaded", async () => {
        const run = baseRun({
            conversation: [
                { message_id: "u1", role: "user", content: "hi", created_at: "2026-11-02T08:00:00Z", event_cursor: 0 },
                { message_id: "a1", role: "assistant", content: "There is **120 GB** free.", created_at: "2026-11-02T08:00:05Z", event_cursor: 0 },
            ],
        });
        installFakeHarness({ runs: [run] });
        render(<ChatWorkspace apiBase="/app/harness" managedToken="desktop-managed" compact={false} insets="host" />);
        await waitFor(() => expect(document.querySelector('[data-slot="aui_assistant-message-root"]')).not.toBeNull());
        await waitFor(() => expect(document.querySelector(".aui-md strong")).toHaveTextContent("120 GB"));
    });
});
