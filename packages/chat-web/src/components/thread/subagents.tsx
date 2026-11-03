/**
 * Subagents: the `task` tool's parallel agents.
 *
 * - `SubagentsStep`: one step row in the activity ("Ran 2 subagents · 1 failed"). Opened, one lane per
 *   subagent: status, goal, name, a trail of its tool calls, a clock and a "now doing" line. A lane opens to
 *   its steps (the same row grammar as the main activity).
 *
 * Inputs are plain protocol data: the `subagents` array on the `task` call's `function_call_output`,
 * which the server updates live and rebuilds on reload.
 */
import type { FunctionCallItem, OutputItem, SubagentRun, SubagentStep } from "@pikvm/chat-protocol";
import {
    CaretRightIcon,
    CheckCircleIcon,
    CircleDashedIcon,
    ProhibitIcon,
    WarningCircleIcon,
} from "@pikvm/icons";
import { memo, useEffect, useId, useRef, useState } from "react";
import { Elapsed, FaviconStack, StepRow, type StepState } from "./activity/shared";
import { SubagentModel } from "./subagent-model";
import { useT } from "../../l10n/provider";
import { msg, translate } from "../../l10n/runtime";
import { ThinkingGlyph, ThinkingLabel } from "./thinking-indicator";
import { formatDuration, parseArgs, toolKind } from "./turns";

/** Subagent runs on a `task` call's output, if any. */
export function subagentRuns(output: OutputItem | undefined): SubagentRun[] | undefined {
    return output?.type === "function_call_output" && output.subagents?.length ? output.subagents : undefined;
}

/**
 * Runs for a `task` call: the server's live state when there is one, else one pending run per task in
 * the call's arguments, so lanes appear as soon as the call is made. Undefined for other tools.
 */
export function subagentRunsOf(call: FunctionCallItem, output: OutputItem | undefined): SubagentRun[] | undefined {
    const live = subagentRuns(output);
    if (live) return live;
    if (call.name !== "task") return undefined;
    const tasks = parseArgs(call.arguments)?.tasks;
    if (!Array.isArray(tasks) || !tasks.length) return undefined;
    return tasks.map((t: { name?: unknown; task?: unknown; agent?: unknown }, i) => ({
        id: typeof t.name === "string" && t.name ? t.name : `Agent ${i + 1}`,
        agent: typeof t.agent === "string" ? t.agent : "task",
        task: typeof t.task === "string" ? t.task : "",
        status: "pending",
        duration_ms: 0,
        steps: [],
        tool_count: 0,
    }));
}

/** A short goal for the lane: the assignment's first sentence or line, without markdown noise. */
export function goalOf(run: Pick<SubagentRun, "task" | "id">): string {
    const first = run.task
        .replace(/^#+\s*/gm, "")
        .split(/\n|(?<=[.!?])\s/)[0]!
        .replace(/[*_`]/g, "")
        .trim();
    return first || run.id;
}

const MAX_TRAIL = 14;

const STATUS_WORD: Record<SubagentRun["status"], string> = {
    pending: msg("thread-sub-status-pending"),
    running: msg("thread-sub-status-running"),
    completed: msg("thread-sub-status-completed"),
    failed: msg("thread-sub-status-failed"),
    cancelled: msg("thread-sub-status-cancelled"),
};

/** Status mark for a subagent: quiet for done, soft danger for failed, the thinking glyph while it runs. */
function StatusGlyph({ status, live }: { status: SubagentRun["status"]; live: boolean }) {
    if (status === "running" && live) return <ThinkingGlyph />;
    const label = translate(STATUS_WORD[status]);
    switch (status) {
        case "pending":
        case "running":
            return <CircleDashedIcon size={16} aria-label={label} className="text-tertiary" />;
        case "completed":
            return <CheckCircleIcon size={16} aria-label={label} className="text-tertiary" />;
        case "failed":
            return <WarningCircleIcon size={16} aria-label={label} className="aa-bad" />;
        case "cancelled":
            return <ProhibitIcon size={16} aria-label={label} className="text-tertiary" />;
    }
}

/** One mark per tool call: the lane's pace, without inventing a percentage. */
function Trail({ steps }: { steps: readonly SubagentStep[] }) {
    if (!steps.length) return null;
    const shown = steps.slice(-MAX_TRAIL);
    return (
        <span className="aa-trail" aria-hidden>
            {shown.map((s, i) => (
                <i key={i} data-status={s.status} />
            ))}
        </span>
    );
}

/** Verb for a nested step, from the tool name (the same words as the main activity rows). */
function nestedVerb(step: SubagentStep): string {
    const running = step.status === "running";
    const n = step.tool.toLowerCase();
    if (/web.?search/.test(n))
        return running ? translate("thread-act-searching-web") : translate("thread-act-searched-web");
    if (/^https?:\/\//.test(step.label))
        return running ? translate("thread-act-verb-reading") : translate("thread-act-verb-read");
    switch (toolKind(n)) {
        case "terminal":
            return running ? translate("thread-act-verb-running") : translate("thread-act-verb-ran");
        case "edit":
            return running ? translate("thread-act-verb-editing") : translate("thread-act-verb-edited");
        case "read":
            return running ? translate("thread-act-verb-reading") : translate("thread-act-verb-read");
        case "search":
            return running ? translate("thread-act-verb-searching") : translate("thread-act-verb-searched");
        default:
            return running
                ? translate("thread-act-using-named", { name: step.tool })
                : translate("thread-sub-used-named", { name: step.tool });
    }
}

/** A subagent's tool calls as quiet rows. */
function NestedSteps({ steps, label }: { steps: readonly SubagentStep[]; label: string }) {
    const t = useT();
    return (
        <ol className="act-steps act-steps-nested" aria-label={label}>
            {steps.map((s, i) => {
                const urls = s.sources?.map((x) => x.url) ?? [];
                const code = !/web.?search/i.test(s.tool) && !/^https?:\/\//.test(s.label);
                return (
                    <StepRow
                        key={i}
                        kind={s.tool}
                        state={s.status === "completed" ? "done" : s.status}
                        verb={nestedVerb(s)}
                        subject={s.label.replace(/^https?:\/\/(www\.)?/, "") || undefined}
                        mono={code}
                        title={s.intent ? `${s.intent}: ${s.label}` : s.label}
                        meta={
                            urls.length ? (
                                <>
                                    <FaviconStack urls={urls} max={3} size={14} />
                                    {t("thread-sub-sources", { count: urls.length })}
                                </>
                            ) : undefined
                        }
                        note={s.status === "failed" ? t("thread-act-failed") : undefined}
                    />
                );
            })}
        </ol>
    );
}

/** The second line of a lane: what it is doing now, or how it ended. */
function laneLine(run: SubagentRun): string {
    switch (run.status) {
        case "pending":
            return translate("thread-sub-waiting-start");
        case "running":
            return run.now || translate("thread-sub-starting");
        case "completed": {
            if (!run.result) return translate("thread-sub-status-completed");
            let text = run.result;
            try {
                const v: unknown = JSON.parse(run.result);
                if (typeof v === "string") text = v;
                else if (v && typeof v === "object" && !Array.isArray(v)) {
                    const values = Object.values(v as Record<string, unknown>).filter((x) =>
                        ["string", "number"].includes(typeof x),
                    );
                    if (values.length) text = values.slice(0, 3).join(" · ");
                }
            } catch {}
            return text.replace(/\s+/g, " ").trim();
        }
        case "failed":
            return run.error || translate("thread-act-failed");
        case "cancelled":
            return translate("thread-act-stopped");
    }
}

const Lane = memo(function Lane({
    run,
    live,
}: {
    run: SubagentRun;
    live: boolean;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const running = live && run.status === "running";
    const bodyId = useId();
    const line = laneLine(run);
    return (
        <div className="aa-lane" data-status={run.status}>
            <button
                type="button"
                className="aa-lane-row"
                aria-expanded={open}
                aria-controls={open ? bodyId : undefined}
                onClick={() => setOpen(!open)}
            >
                <span className="aa-lane-glyph">
                    <StatusGlyph status={run.status} live={live} />
                </span>
                <span className="min-w-0">
                    <span className="aa-lane-title">
                        <span className="aa-lane-goal">{goalOf(run)}</span>
                        <span className="aa-lane-name">{run.id}</span>
                        <SubagentModel model={run.model} className="text-[12.5px] max-w-[45%] shrink" />
                    </span>
                    <span className="aa-lane-now">
                        {running ? (
                            <ThinkingLabel label={line} />
                        ) : (
                            <span className={run.status === "failed" ? "line-clamp-2" : "aa-clip"}>{line}</span>
                        )}
                    </span>
                </span>
                <span className="aa-lane-side">
                    <Trail steps={run.steps} />
                    {run.status !== "pending" && (
                        <Elapsed startedAt={run.started_at} durationMs={run.duration_ms} running={running} />
                    )}
                    <CaretRightIcon size={14} aria-hidden className="act-caret" data-open={open} />
                </span>
            </button>
            {open && (
                <div id={bodyId} className="aa-lane-body">
                    {run.steps.length > 0 ? (
                        <NestedSteps steps={run.steps} label={t("thread-sub-steps-of", { id: run.id })} />
                    ) : (
                        <p className="act-empty">{t("thread-sub-no-steps")}</p>
                    )}
                </div>
            )}
        </div>
    );
});

/** Announces status changes (started, done, failed) once each, for screen readers. */
function useStatusAnnouncement(runs: readonly SubagentRun[]): string {
    const t = useT();
    const prev = useRef(new Map<string, SubagentRun["status"]>());
    const [message, setMessage] = useState("");
    useEffect(() => {
        const changes: string[] = [];
        for (const r of runs) {
            const before = prev.current.get(r.id);
            if (before && before !== r.status) {
                if (r.status === "completed") changes.push(t("thread-sub-finished", { id: r.id }));
                else if (r.status === "failed") changes.push(t("thread-sub-failed", { id: r.id }));
                else if (r.status === "cancelled") changes.push(t("thread-sub-stopped", { id: r.id }));
            }
            prev.current.set(r.id, r.status);
        }
        if (changes.length) setMessage(changes.join(". "));
    }, [runs, t]);
    return message;
}

/**
 * A `task` call as one step row ("Ran 2 subagents · 1 failed · 12s"), opening to one lane per subagent.
 * Open while the subagents run, so parallel progress shows without a click; closed when done.
 */
export const SubagentsStep = memo(function SubagentsStep({
    runs,
    live,
    state,
}: {
    runs: readonly SubagentRun[];
    live: boolean;
    state: StepState;
}) {
    const t = useT();
    const done = runs.filter((r) => r.status === "completed").length;
    const failed = runs.filter((r) => r.status === "failed").length;
    const stopped = runs.filter((r) => r.status === "cancelled").length;
    const active = live && (!runs.length || runs.some((r) => r.status === "running" || r.status === "pending"));
    const longest = Math.max(0, ...runs.map((r) => r.duration_ms));
    const announcement = useStatusAnnouncement(runs);
    const meta = active
        ? runs.length
            ? t("thread-sub-progress", { done: done + failed + stopped, total: runs.length })
            : undefined
        : longest >= 1000
          ? formatDuration(longest)
          : undefined;
    const note = active
        ? undefined
        : [
              failed ? t("thread-sub-n-failed", { count: failed }) : "",
              stopped ? t("thread-sub-n-stopped", { count: stopped }) : "",
          ]
              .filter(Boolean)
              .join(" · ");
    return (
        <StepRow
            kind="subagents"
            state={active ? "running" : state}
            verb={
                active
                    ? runs.length
                        ? t("thread-act-verb-running")
                        : t("thread-sub-verb-starting")
                    : t("thread-act-verb-ran")
            }
            subject={t("thread-sub-count", { count: Math.max(1, runs.length) })}
            meta={meta}
            note={note || undefined}
            open={active}
            announce={announcement}
            detail={() => (
                <div className="aa-lanes" role="group" aria-label={t("thread-panel-subagents")}>
                    {runs.map((r) => (
                        <Lane key={r.id} run={r} live={live} />
                    ))}
                </div>
            )}
        />
    );
});
