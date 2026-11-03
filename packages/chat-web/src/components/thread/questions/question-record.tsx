/**
 * A question in the thread: one compact line per question, "Asked: <question> -> Answered: <answer>",
 * with the outcome when there was no answer (skipped, no answer in time, stopped). The same item comes
 * from a live response and from history, so a reload shows the same record.
 */
import type { AskRequestItem, Question, QuestionAnswer } from "@pikvm/chat-protocol";
import {
    ArrowRightIcon,
    ChatCircleDotsIcon,
    CheckCircleIcon,
    ProhibitIcon,
    SkipForwardIcon,
    TimerIcon,
} from "@pikvm/icons";
import { memo } from "react";
import { useT } from "../../../l10n/provider";
import { msg, type Translate } from "../../../l10n/runtime";
import { cn } from "../../../lib/cn";

/** Header words for a running activity group whose newest step is an open question. */
export const QUESTION_WAITING_LABEL = msg("thread-question-waiting");

function answerWords(
    t: Translate,
    item: AskRequestItem,
    q: Question,
    a: QuestionAnswer | undefined,
): { verb: string; text: string } {
    if (a?.skipped) return { verb: t("thread-question-skipped"), text: "" };
    const picks = [...(a?.selected ?? []), ...(a?.text ? [`"${a.text}"`] : [])].join(", ");
    if (a?.timed_out) return { verb: t("thread-question-timed-out"), text: picks || t("thread-question-nothing") };
    if (picks) return { verb: t("thread-elicit-answered"), text: picks };
    if (item.outcome === "cancelled") return { verb: t("thread-question-stopped"), text: "" };
    if (item.outcome === "skipped") return { verb: t("thread-question-skipped"), text: "" };
    if (item.status === "in_progress") return { verb: t(QUESTION_WAITING_LABEL), text: "" };
    return {
        verb: q.multi ? t("thread-elicit-answered") : t("thread-act-not-answered"),
        text: q.multi && a ? t("thread-question-none") : "",
    };
}

/** Step icon for the activity timeline (14px, tone by outcome). */
export function QuestionRecordIcon({ item }: { item: AskRequestItem }) {
    const [I, tone] =
        item.status === "in_progress"
            ? [ChatCircleDotsIcon, "text-secondary"]
            : item.outcome === "answered"
              ? [CheckCircleIcon, "text-secondary"]
              : item.outcome === "timed_out"
                ? [TimerIcon, "text-tertiary"]
                : item.outcome === "skipped"
                  ? [SkipForwardIcon, "text-tertiary"]
                  : [ProhibitIcon, "text-tertiary"];
    return <I size={14} className={tone} />;
}

export const QuestionRecord = memo(function QuestionRecord({ item }: { item: AskRequestItem }) {
    const t = useT();
    return (
        <div className="flex flex-col gap-0.5">
            {item.questions.map((q, i) => {
                const a = item.answers?.find((x) => x.id === q.id) ?? item.answers?.[i];
                const { verb, text } = answerWords(t, item, q, a);
                const answered = !!text && !a?.timed_out;
                return (
                    <p key={q.id} className="text-[length:var(--type-body,14px)] leading-[22px] text-pretty">
                        <span className="text-tertiary">{t("thread-question-asked")} </span>
                        <span className="text-secondary">{q.question}</span>
                        <ArrowRightIcon
                            size={14}
                            aria-label={t("thread-question-then")}
                            className="mx-1.5 inline-block align-[-2px] text-tertiary"
                        />
                        <span className="text-tertiary">
                            {verb}
                            {text ? ": " : ""}
                        </span>
                        {text && <span className={cn(answered ? "text-text" : "text-secondary")}>{text}</span>}
                    </p>
                );
            })}
        </div>
    );
});
