/**
 * The thread record of an MCP elicitation: a row while the server waits for the user (answered in the composer
 * tray, thread/elicitation-tray.tsx) and a compact record of the outcome afterwards.
 */
import type { McpElicitationItem } from "@pikvm/chat-protocol";
import { memo } from "react";
import { useT } from "../../l10n/provider";
import { msg } from "../../l10n/runtime";
import { StepRow } from "./activity/shared";
import { useElicitationAnswer } from "./elicitation";

export const ELICITATION_WAITING_LABEL = msg("thread-elicit-waiting");

const OUTCOMES = {
    accept: msg("thread-elicit-answered"),
    decline: msg("thread-elicit-declined"),
    cancel: msg("thread-elicit-dismissed"),
} as const;

export const ElicitationStep = memo(function ElicitationStep({
    item,
    live,
}: {
    item: McpElicitationItem;
    live: boolean;
}) {
    const t = useT();
    const sent = useElicitationAnswer(item.id);
    const outcome = item.outcome ?? sent;
    const waiting = !outcome && item.status === "in_progress" && live;
    return (
        <StepRow
            kind="question"
            state={waiting ? "running" : "done"}
            verb={
                waiting ? t(ELICITATION_WAITING_LABEL) : outcome ? t(OUTCOMES[outcome]) : t("thread-act-not-answered")
            }
            subject={t(item.mode === "url" ? msg("thread-elicit-asked-link") : msg("thread-elicit-asked-input"), {
                server: item.server_label,
            })}
            title={item.message}
        />
    );
});
