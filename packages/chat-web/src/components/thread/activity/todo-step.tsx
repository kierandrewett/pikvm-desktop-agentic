/**
 * The assistant's working plan, from a `todo` call (`FunctionCallOutputItem.todos`): one step row, "Updated the plan,
 * 3 of 7 done", and the task list below it, grouped by phase.
 *
 * Every todo call carries the whole list, so a turn with several calls shows the newest list open and the earlier
 * ones closed. Status is shown by icon and also in words for assistive technology.
 */
import type { TodoPhase, TodoStatus } from "@pikvm/chat-protocol";
import {
    CheckCircleIcon,
    CircleDashedIcon,
    CircleIcon,
    MinusCircleIcon,
    PauseCircleIcon,
    type Icon,
} from "@pikvm/icons";
import { memo } from "react";
import { useT } from "../../../l10n/provider";
import { msg } from "../../../l10n/runtime";
import { cn } from "../../../lib/cn";
import { StepRow, type StepState } from "./shared";

const STATUS: Record<TodoStatus, { icon: Icon; label: string; className: string; weight?: "fill" }> = {
    completed: { icon: CheckCircleIcon, label: msg("thread-todo-done"), className: "text-secondary", weight: "fill" },
    in_progress: { icon: CircleDashedIcon, label: msg("thread-todo-in-progress"), className: "text-text" },
    pending: { icon: CircleIcon, label: msg("thread-todo-pending"), className: "text-tertiary" },
    blocked: { icon: PauseCircleIcon, label: msg("thread-todo-blocked"), className: "text-tertiary" },
    abandoned: { icon: MinusCircleIcon, label: msg("thread-todo-dropped"), className: "text-tertiary" },
};

/** Done and total, not counting dropped tasks. */
export function todoProgress(phases: readonly TodoPhase[]): { done: number; total: number } {
    let done = 0;
    let total = 0;
    for (const p of phases)
        for (const t of p.tasks) {
            if (t.status === "abandoned") continue;
            total++;
            if (t.status === "completed") done++;
        }
    return { done, total };
}

function TodoList({ phases }: { phases: readonly TodoPhase[] }) {
    const t = useT();
    const titled = phases.length > 1;
    return (
        <div className="flex flex-col gap-2 px-1" data-todo-list>
            {phases.map((p, i) => (
                <section key={`${i}:${p.name}`} aria-label={titled ? p.name : t("thread-todo-tasks")}>
                    {titled && <h4 className="mb-1 text-sm leading-5 font-medium text-secondary">{p.name}</h4>}
                    <ul className="flex flex-col gap-0.5">
                        {p.tasks.map((task, j) => {
                            const s = STATUS[task.status];
                            const Glyph = s.icon;
                            return (
                                <li
                                    key={`${j}:${task.content}`}
                                    data-status={task.status}
                                    className="flex min-w-0 items-start gap-2 text-sm leading-5"
                                >
                                    <Glyph
                                        aria-hidden
                                        size={16}
                                        weight={s.weight}
                                        className={cn("mt-0.5 shrink-0", s.className)}
                                    />
                                    <span className="sr-only">{t(s.label)}: </span>
                                    <span
                                        className={cn(
                                            "min-w-0 break-words",
                                            task.status === "completed" || task.status === "abandoned"
                                                ? "text-tertiary line-through"
                                                : task.status === "in_progress"
                                                  ? "font-medium text-text"
                                                  : "text-secondary",
                                        )}
                                    >
                                        {task.content}
                                        {task.blocker && <span className="text-tertiary"> ({task.blocker})</span>}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                </section>
            ))}
        </div>
    );
}

export const TodoStep = memo(function TodoStep({
    phases,
    state,
    latest,
}: {
    /** Undefined while the call runs or when it failed. */
    phases: readonly TodoPhase[] | undefined;
    state: StepState;
    /** The newest todo call of the turn: its list starts open. */
    latest: boolean;
}) {
    const t = useT();
    const progress = phases ? todoProgress(phases) : undefined;
    return (
        <StepRow
            kind="todo"
            state={state}
            verb={state === "running" ? t("thread-act-updating-plan") : t("thread-todo-updated")}
            meta={
                progress && progress.total > 0
                    ? t("thread-todo-progress", { done: progress.done, total: progress.total })
                    : undefined
            }
            note={
                state === "failed" ? t("thread-act-failed") : state === "stopped" ? t("thread-act-stopped") : undefined
            }
            open={latest}
            detail={phases && phases.some((p) => p.tasks.length) ? () => <TodoList phases={phases} /> : undefined}
        />
    );
});
