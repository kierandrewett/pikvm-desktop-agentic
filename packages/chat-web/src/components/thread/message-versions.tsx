/**
 * Message versions in the thread (docs/spec/thread-branching.md section 6).
 *
 * MessageEditor: the inline editor that replaces your message's bubble when you choose Edit. Save sends the text as
 * a new version (branch-actions.ts `sendEdit`); the old version is kept. Cancel or Escape closes it and puts focus
 * back on the Edit button. Enter follows the composer's send key setting (`ui.composer.enterToSend`); Mod+Enter
 * always saves. Attachments of the message are kept as they are.
 *
 * VersionSwitcher: `‹ 2/3 ›` under a message with more than one version. Switching changes the active path for the
 * thread and for the next turn's context. The turn remounts with the new version's id, so focus and the
 * announcement are handed over through `handover`: the new switcher takes focus on the same arrow and says which
 * version is shown.
 */
import type { MessageItem } from "@pikvm/chat-protocol";
import { CaretLeftIcon, CaretRightIcon } from "@pikvm/icons";
import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "../../l10n/provider";
import { cn } from "../../lib/cn";
import { useSetting } from "../../lib/queries";
import { useComposerChoice } from "../composer/choice";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { sendEdit, stopEditing, switchToVersion, useBranchState } from "./branch-actions";
import { ThreadContext } from "./context";
import { messageText, resendable } from "./turns";

/** Focus the Edit button of a message again (its hover row remounts when the editor closes). */
function focusEditButton(itemId: string): void {
    requestAnimationFrame(() =>
        document
            .querySelector<HTMLElement>(`[data-turn-key="${CSS.escape(itemId)}"] [data-branch-action="edit"]`)
            ?.focus({ preventScroll: true }),
    );
}

const MAX_EDITOR_PX = 320;

function fit(el: HTMLTextAreaElement): void {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_EDITOR_PX)}px`;
}

export function MessageEditor({ message }: { message: MessageItem }) {
    const t = useT();
    const { conversationId } = useContext(ThreadContext);
    const original = messageText(message);
    const [text, setText] = useState(original);
    const choice = useComposerChoice(conversationId);
    const enterToSend = useSetting<boolean>("ui.composer.enterToSend", true);
    const { busy } = useBranchState(conversationId, message.id);
    const area = useRef<HTMLTextAreaElement>(null);
    const attachments = resendable(message);
    const canSave = !busy && text !== original && (!!text.trim() || attachments.length > 0);

    useLayoutEffect(() => {
        const el = area.current;
        if (!el) return;
        fit(el);
        el.focus({ preventScroll: true });
        el.setSelectionRange(el.value.length, el.value.length);
        el.scrollIntoView({ block: "nearest" });
    }, []);

    const cancel = () => {
        stopEditing();
        focusEditButton(message.id);
    };
    const save = () => {
        if (!canSave) return;
        sendEdit(conversationId, message.id, text, attachments, {
            model: choice.modelId,
            effort: choice.effort,
            permission: choice.permission,
        });
        requestAnimationFrame(() =>
            document
                .querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
                ?.focus({ preventScroll: true }),
        );
    };
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
            return;
        }
        if (e.key !== "Enter") return;
        const mod = e.metaKey || e.ctrlKey;
        const coarse = window.matchMedia("(pointer: coarse)").matches;
        if (mod || (enterToSend && !coarse && !e.shiftKey && !e.altKey)) {
            e.preventDefault();
            save();
        }
    };

    return (
        <form
            className="flex w-full flex-col gap-2 rounded-3xl bg-user-bubble p-3"
            data-message-editor=""
            onSubmit={(e) => {
                e.preventDefault();
                save();
            }}
        >
            <textarea
                ref={area}
                value={text}
                dir="auto"
                rows={1}
                aria-label={t("branch-editor-label")}
                aria-describedby={`edit-hint-${message.id}`}
                className="max-h-80 w-full resize-none bg-transparent px-1 text-[16px] leading-6 text-text outline-none"
                onChange={(e) => {
                    setText(e.target.value);
                    fit(e.target);
                }}
                onKeyDown={onKeyDown}
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
                <p id={`edit-hint-${message.id}`} className="me-auto px-1 text-[13px] leading-5 text-tertiary">
                    {busy ? t("branch-busy") : t("branch-editor-hint")}
                </p>
                <Button size="lg" variant="soft" pill onClick={cancel}>
                    {t("branch-editor-cancel")}
                </Button>
                <Button size="lg" variant="solid" pill type="submit" aria-disabled={!canSave || undefined}>
                    {t("branch-editor-save")}
                </Button>
            </div>
        </form>
    );
}

/** The switcher that should take focus after a switch: its group (the version ids) and the arrow used. */
let handover: { group: string; dir: -1 | 1 } | null = null;

export function VersionSwitcher({ message }: { message: MessageItem }) {
    const t = useT();
    const { conversationId } = useContext(ThreadContext);
    const { busy } = useBranchState(conversationId, message.id);
    const [pending, setPending] = useState(false);
    const [said, setSaid] = useState("");
    const prev = useRef<HTMLButtonElement>(null);
    const next = useRef<HTMLButtonElement>(null);
    const versions = message.versions;
    const group = versions?.ids.join(" ") ?? "";

    useEffect(() => {
        if (!versions || handover?.group !== group) return;
        const { dir } = handover;
        handover = null;
        const first = versions.index === 0;
        const last = versions.index === versions.ids.length - 1;
        const target = (dir < 0 && !first) || last ? prev.current : next.current;
        target?.focus({ preventScroll: true });
        // The region exists before its text changes, so screen readers read the change.
        const text = t("branch-version-shown", { index: versions.index + 1, count: versions.ids.length });
        requestAnimationFrame(() => setSaid(text));
        // Only on mount for this group: a refetch gives `versions` a new identity and must not run it again.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [group]);

    if (!versions) return null;
    const { ids, index } = versions;
    const go = async (dir: -1 | 1) => {
        const target = ids[index + dir];
        if (!target || busy || pending) return;
        setPending(true);
        handover = { group, dir };
        const ok = await switchToVersion(conversationId, target);
        if (!ok) handover = null;
        setPending(false);
    };
    const arrow = (dir: -1 | 1) => {
        const label = dir < 0 ? t("branch-version-previous") : t("branch-version-next");
        const end = dir < 0 ? index === 0 : index === ids.length - 1;
        return (
            <Tooltip label={busy ? t("branch-busy") : label}>
                <Button
                    ref={dir < 0 ? prev : next}
                    size="lg"
                    uniform
                    aria-label={label}
                    disabled={end}
                    aria-disabled={busy || pending || undefined}
                    data-version-step={dir < 0 ? "previous" : "next"}
                    className="disabled:opacity-40 pointer-coarse:size-11"
                    onClick={() => void go(dir)}
                >
                    {dir < 0 ? (
                        <CaretLeftIcon aria-hidden className="rtl:-scale-x-100" />
                    ) : (
                        <CaretRightIcon aria-hidden className="rtl:-scale-x-100" />
                    )}
                </Button>
            </Tooltip>
        );
    };
    return (
        <div
            role="group"
            aria-label={t("branch-versions", { index: index + 1, count: ids.length })}
            aria-busy={pending || undefined}
            data-versions={`${index + 1}/${ids.length}`}
            className={cn("flex min-h-8 items-center text-[13px] leading-5 text-tertiary", pending && "opacity-60")}
        >
            {arrow(-1)}
            <span aria-hidden className="min-w-8 text-center tabular-nums" data-version-label="">
                {t("branch-version-count", { index: index + 1, count: ids.length })}
            </span>
            {arrow(1)}
            <span role="status" className="sr-only">
                {said}
            </span>
        </div>
    );
}
