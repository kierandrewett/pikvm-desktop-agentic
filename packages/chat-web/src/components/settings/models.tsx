/**
 * Model query and the settings model picker (default model, model roles, the administrators' default).
 *
 * ModelSelect opens the same picker as the composer (PickerContent): an anchored popover with a tail on desktop and a
 * bottom sheet on phones. What settings add, all through props of PickerContent:
 * - "Automatic" (or the caller's label) is a pinned first row that chooses the empty value, with a line that says what
 *   it resolves to. It is checked when the value is empty.
 * - Extra models (the Decisions role's System One models) are merged into the list and grouped with it.
 * - With no models the picker shows its empty state with a link to the providers section.
 * - "Use a model not in the list" is a disclosure under the list with a validated `provider/model` field.
 *
 * The trigger shows the model mark (vendor with provider badge), the name and a chevron. A stored id that is no longer
 * listed shows as its id in monospace with a warning mark.
 */
import type { ModelInfo, ModelsResponse } from "@pikvm/chat-protocol";
import { CaretRight, Sparkle, WarningCircle } from "@pikvm/icons";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Popover } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { useT } from "../../l10n/provider";
import { cn } from "../../lib/cn";
import { useIsMobile } from "../../lib/media";
import { keys } from "../../lib/queries";
import { animateEnter } from "../model-picker/motion";
import { identityOf } from "../model-picker/models";
import { PickerContent } from "../model-picker/picker-content";
import { ModelMark } from "../model-picker/provider-logo";
import { Sheet } from "../ui/sheet";
import { TailedContent } from "../ui/tailed-content";
import { Button, fieldClass, PickerTrigger } from "./kit";

export const modelsQuery = queryOptions({
    queryKey: keys.models,
    queryFn: () => api.get<ModelsResponse>("/models"),
    retry: false,
    staleTime: 60_000,
});

/** `provider/model`: a provider id (settings key segment) and a non-empty model id. */
const MODEL_ID = /^[A-Za-z0-9_-]+\/\S+$/;

export function ModelSelect({
    value,
    onChange,
    disabled,
    label,
    emptyLabel: emptyLabelProp,
    emptyDescription: emptyDescriptionProp,
    providersSection = "providers",
    extraModels,
}: {
    value: string;
    onChange: (v: string) => void;
    disabled?: boolean;
    label: string;
    emptyLabel?: string;
    emptyDescription?: string;
    /** Settings section the empty state links to ("admin-providers" for the administrators' default). */
    providersSection?: string;
    /** Models outside the chat list, browsed with it in their own provider group (the Decisions role's System One models). */
    extraModels?: readonly ModelInfo[];
}) {
    const t = useT();
    const mobile = useIsMobile();
    const emptyLabel = emptyLabelProp ?? t("models-select-automatic");
    const emptyDescription = emptyDescriptionProp ?? t("models-select-automatic-description");
    const [open, setOpen] = useState(false);
    // Also loaded while closed: the trigger shows the chosen model's name. The query is shared and usually cached.
    const query = useQuery(modelsQuery);
    const chatModels = query.data?.models;
    const models = useMemo(() => [...(chatModels ?? []), ...(extraModels ?? [])], [chatModels, extraModels]);
    const selected = models.find((model) => model.id === value);
    const loading = !!value && query.isLoading;
    // Only a loaded list can say that a stored id is gone; a failed load says nothing about it.
    const unlisted = !!value && !selected && !!query.data;
    const pinned = useMemo(
        () => ({ label: emptyLabel, description: emptyDescription }),
        [emptyLabel, emptyDescription],
    );

    // A pick saves at once, and a saving row disables its controls: focus returns once the trigger is enabled.
    const triggerRef = useRef<HTMLButtonElement>(null);
    const refocus = useRef(false);
    useEffect(() => {
        if (disabled || !refocus.current) return;
        refocus.current = false;
        triggerRef.current?.focus({ preventScroll: true });
    }, [disabled]);
    const choose = (id: string) => {
        if (disabled) return;
        if (id !== value) onChange(id);
        setOpen(false);
        refocus.current = true;
        if (triggerRef.current && !triggerRef.current.disabled) {
            triggerRef.current.focus({ preventScroll: true });
            refocus.current = false;
        }
    };
    const shown = open && !disabled;

    const text = loading ? t("models-picker-loading") : (selected?.name ?? (value || emptyLabel));
    const trigger = (
        <PickerTrigger
            ref={triggerRef}
            label={label}
            text={text}
            mono={unlisted || (!selected && !!value && !loading)}
            leading={
                <span className="flex size-4 shrink-0 items-center justify-center text-tertiary">
                    {selected ? (
                        <ModelMark model={selected} size={16} />
                    ) : unlisted ? (
                        <WarningCircle aria-hidden className="size-4 text-warning" />
                    ) : !value ? (
                        <Sparkle aria-hidden className="size-4" />
                    ) : null}
                </span>
            }
            aria-label={`${label}: ${selected ? identityOf(selected).label : unlisted ? `${value}, ${t("models-select-unlisted")}` : text}`}
            aria-busy={loading || undefined}
            title={unlisted ? t("models-select-unlisted") : undefined}
            data-state={shown ? "open" : "closed"}
            disabled={disabled}
            className="max-w-72"
            {...(mobile
                ? { "aria-haspopup": "dialog" as const, "aria-expanded": shown, onClick: () => setOpen(true) }
                : {})}
        />
    );
    const body = (
        <PickerContent
            models={models}
            value={value}
            onSelect={choose}
            onClose={() => setOpen(false)}
            mobile={mobile}
            pinned={pinned}
            providersSection={providersSection}
            shortcutHint={false}
            footer={<CustomModel value={selected ? "" : value} onUse={choose} />}
        />
    );

    if (mobile) {
        return (
            <>
                {trigger}
                <Sheet open={shown} onOpenChange={setOpen} title={label}>
                    {body}
                </Sheet>
            </>
        );
    }
    return (
        <Popover.Root open={shown} onOpenChange={setOpen}>
            <Popover.Trigger asChild>{trigger}</Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    ref={(el) => {
                        if (el && !el.dataset.entered) {
                            el.dataset.entered = "1";
                            animateEnter(el);
                        }
                    }}
                    side="bottom"
                    align="end"
                    sideOffset={2}
                    collisionPadding={8}
                    data-model-picker-surface
                    // Same fixed size as the composer picker: it never resizes while the list changes.
                    style={{ height: "min(452px, var(--radix-popover-content-available-height))" }}
                    aria-label={label}
                    onOpenAutoFocus={(e) => e.preventDefault()}
                    asChild
                >
                    <TailedContent arrow={Popover.Arrow} className="max-w-[calc(100vw-16px)]" bodyClassName="flex">
                        {body}
                    </TailedContent>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}

/** "Use a model not in the list": a disclosure row with a validated `provider/model` field. */
function CustomModel({ value, onUse }: { value: string; onUse: (id: string) => void }) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(value);
    const [error, setError] = useState<string | null>(null);
    const panel = useId();
    const errorId = useId();
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const v = draft.trim();
        if (!MODEL_ID.test(v)) {
            setError(t("models-select-custom-format"));
            return;
        }
        onUse(v);
    };
    return (
        <div className="mt-1.5 shrink-0 rounded-2xl border border-default" data-model-select-custom>
            <button
                type="button"
                aria-expanded={open}
                aria-controls={panel}
                onClick={() => setOpen((o) => !o)}
                className="flex min-h-10 w-full items-center gap-2 rounded-2xl px-4 text-start text-sm text-secondary outline-none focus-visible:outline-2 focus-visible:outline-ring hover-device:hover:text-text"
            >
                <CaretRight aria-hidden className={cn("size-4 transition-transform", open && "rotate-90")} />
                {t("models-select-custom")}
            </button>
            {open && (
                <form id={panel} onSubmit={submit} className="flex flex-col gap-1.5 px-4 pb-3">
                    <label htmlFor={`${panel}-in`} className="text-xs text-tertiary">
                        {t("models-select-custom-label")}
                    </label>
                    <div className="flex gap-2">
                        <input
                            id={`${panel}-in`}
                            autoFocus
                            value={draft}
                            onChange={(e) => {
                                setDraft(e.target.value);
                                setError(null);
                            }}
                            placeholder="provider/model"
                            spellCheck={false}
                            autoComplete="off"
                            aria-invalid={!!error}
                            aria-describedby={error ? errorId : undefined}
                            className={cn(fieldClass("md"), "min-w-0 flex-1 font-mono text-sm")}
                        />
                        <Button variant="primary" size="md" type="submit" disabled={!draft.trim()}>
                            {t("models-select-custom-use")}
                        </Button>
                    </div>
                    {error && (
                        <p id={errorId} role="alert" className="text-xs text-danger">
                            {error}
                        </p>
                    )}
                </form>
            )}
        </div>
    );
}
