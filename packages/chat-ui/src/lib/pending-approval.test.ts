/**
 * FAILURE MODES (written before the tests)
 *
 *  1. A run that is not waiting on anyone shows an approval dock, or a run waiting on one
 *     shows none (no approval id to answer with).
 *  2. The dock offers a one-tap Allow: the allow option must carry the confirmation, and
 *     the deny option must not.
 *  3. A tool approval is described as a computer action (or the reverse), so the person
 *     is asked the wrong question.
 */

import { describe, expect, it } from "vitest";
import { pendingApprovalForRun } from "./run-messages";
import type { RunSnapshot } from "../types";

const run = (overrides: Record<string, unknown>): RunSnapshot =>
    ({
        run_id: "run-1",
        task: "x",
        status: "needs_approval",
        origin: "managed",
        created_at: "2026-11-02T08:00:00Z",
        updated_at: "2026-11-02T08:00:00Z",
        event_count: 0,
        event_cursor: 0,
        ...overrides,
    }) as RunSnapshot;

describe("pendingApprovalForRun", () => {
    it("is null unless the run is waiting and says on what", () => {
        expect(pendingApprovalForRun(null)).toBeNull();
        expect(pendingApprovalForRun(run({ status: "running", pending_approval: { approval_id: "a" } }))).toBeNull();
        expect(pendingApprovalForRun(run({ pending_approval: null }))).toBeNull();
        expect(pendingApprovalForRun(run({ pending_approval: { risk: "x" } }))).toBeNull();
    });

    it("confirms before allowing and not before denying", () => {
        const approval = pendingApprovalForRun(run({ pending_approval: { approval_id: "apr-1", tool: "mail.send" } }));
        const [allow, deny] = approval?.options ?? [];
        expect(allow).toMatchObject({ id: "approve", kind: "allow-once", confirm: { title: "Allow mail.send?" } });
        expect(deny).toMatchObject({ id: "reject", kind: "reject-once" });
        expect(deny).not.toHaveProperty("confirm");
    });

    it("words a tool approval and a computer approval differently", () => {
        const tool = pendingApprovalForRun(
            run({ pending_approval: { approval_id: "a", tool: "mail.send", risk: "side_effect", reason: "sends mail" } }),
        );
        expect(tool?.title).toBe("Allow mail.send?");
        expect(tool?.detail).toBe("side effect: sends mail");

        const computer = pendingApprovalForRun(run({ pending_approval: { approval_id: "a", reason: "types a password" } }));
        expect(computer?.title).toBe("Allow this computer action?");
        expect(computer?.options[0]).toMatchObject({ confirm: { description: "types a password" } });
    });
});
