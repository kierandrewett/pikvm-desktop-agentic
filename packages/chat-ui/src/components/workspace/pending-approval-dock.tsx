import type { RespondToToolApprovalOptions } from "@assistant-ui/react";
import { ShieldAlertIcon } from "lucide-react";
import type { PendingApproval } from "../../lib/run-messages";
import { ApprovalControls } from "../assistant-ui/tool-fallback";

/**
 * The approval the agent is stopped on, kept on screen above the composer.
 *
 * It exists for the thumb: on a phone the thread card for a pending approval can be
 * scrolled out of reach, and an agent waiting on a person is the one moment nothing
 * else on the screen matters. It offers exactly the card's options with the card's
 * confirmation, so a consequential Allow still takes two deliberate taps and Deny one.
 * Both end in the same request: POST /api/runs/{run}/approvals/{approval}, carrying
 * X-PiKVM-Approval-Intent (see useHarnessWorkspace.respondToApproval).
 */
export function PendingApprovalDock({
    approval,
    onRespond,
    error,
}: {
    approval: PendingApproval;
    onRespond: (decision: RespondToToolApprovalOptions) => void;
    /** Why the last answer did not go through; the controls are live again when it is set. */
    error?: string | undefined;
}) {
    // The card's controls speak in option ids; the harness wants approve/reject. This is
    // the same translation the runtime applies to the controls inside the thread.
    const respond = (response: { optionId?: string | undefined; approved?: boolean | undefined }) => {
        const option = approval.options.find((candidate) => candidate.id === response.optionId);
        const approved = response.approved ?? option?.kind === "allow-once";
        onRespond({
            approvalId: approval.id,
            approved,
            ...(response.optionId ? { optionId: response.optionId } : {}),
        });
    };

    return (
        <section
            role="region"
            aria-label="Approval needed"
            data-slot="pending-approval-dock"
            className="flex flex-col gap-2 rounded-xl border border-caution/40 bg-caution-soft px-3 py-2.5 text-foreground shadow-sm"
        >
            <div className="flex items-start gap-2">
                <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-caution-foreground" aria-hidden="true" />
                <div className="min-w-0">
                    <p className="font-semibold">{approval.title}</p>
                    {approval.detail ? <p className="text-[13px] text-muted-foreground">{approval.detail}</p> : null}
                </div>
            </div>
            {error ? (
                <p role="alert" className="text-[13px] text-destructive">
                    {error}
                </p>
            ) : null}
            <ApprovalControls
                approval={{ id: approval.id, options: approval.options }}
                respondToApproval={respond}
                className="[&_button]:min-h-12 [&_button]:flex-1 [&_button]:text-[15px]"
            />
        </section>
    );
}
