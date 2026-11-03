/**
 * MCP elicitation tray: attached to the top of the composer, like the approval tray, while an MCP server asks
 * the user for input. Two modes:
 *
 * - form: the fields come from the server's flat schema; values are checked against it before Submit.
 * - url: the message, the full address with the host marked, a warning for punycode hosts, "Open" and then
 *   "Done". The page is never fetched or embedded here.
 *
 * Submit and Done accept, Decline refuses, Cancel (and Escape) dismisses. The server decides what each means.
 */
import type { McpElicitationItem } from "@pikvm/chat-protocol";
import { ArrowSquareOutIcon, PlugIcon, WarningIcon } from "@pikvm/icons";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { useCoarsePointer } from "../../lib/media";
import { useT } from "../../l10n/provider";
import { Button } from "../ui/button";
import {
    checkForm,
    contentOf,
    fieldsOf,
    initialValues,
    openLink,
    respondElicitation,
    urlView,
    usePendingElicitations,
    type Field,
    type FormValue,
    type FormValues,
} from "./elicitation";

const inputClass =
    "w-full min-w-0 rounded-xl bg-soft px-3 py-2 text-base leading-5 text-text caret-[var(--text)] outline-none placeholder:text-tertiary focus-visible:ring-2 focus-visible:ring-ring sm:text-sm";

function FieldInput({
    field,
    value,
    error,
    describedBy,
    onChange,
}: {
    field: Field;
    value: FormValue | undefined;
    error?: string;
    describedBy: string;
    onChange: (v: FormValue) => void;
}) {
    const t = useT();
    const id = useId();
    const common = {
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
        "aria-required": field.required || undefined,
    };
    const label = (
        <label htmlFor={id} className="text-sm leading-5 font-medium text-text">
            {field.title}
            {field.required && <span aria-hidden> *</span>}
        </label>
    );
    const notes = (
        <>
            {field.description && <p className="text-xs leading-4 text-tertiary">{field.description}</p>}
            {error && (
                <p id={describedBy} className="text-xs leading-4 text-danger">
                    {error}
                </p>
            )}
        </>
    );
    if (field.kind === "boolean") {
        return (
            <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-sm leading-5 text-text">
                    <input
                        type="checkbox"
                        {...common}
                        checked={value === true}
                        onChange={(e) => onChange(e.target.checked)}
                        className="size-4 accent-[var(--accent)]"
                    />
                    {field.title}
                </label>
                {notes}
            </div>
        );
    }
    if (field.kind === "select") {
        return (
            <div className="flex flex-col gap-1">
                {label}
                <select
                    {...common}
                    value={String(value ?? "")}
                    onChange={(e) => onChange(e.target.value)}
                    className={inputClass}
                >
                    <option value="">{field.required ? t("thread-form-choose") : t("thread-form-none")}</option>
                    {field.options.map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.title}
                        </option>
                    ))}
                </select>
                {notes}
            </div>
        );
    }
    if (field.kind === "multi") {
        const chosen = Array.isArray(value) ? value : [];
        return (
            <fieldset className="flex flex-col gap-1" aria-describedby={describedBy}>
                <legend className="text-sm leading-5 font-medium text-text">
                    {field.title}
                    {field.required && <span aria-hidden> *</span>}
                </legend>
                <div className="flex flex-col gap-1">
                    {field.options.map((o) => (
                        <label key={o.value} className="flex items-center gap-2 text-sm leading-5 text-text">
                            <input
                                type="checkbox"
                                checked={chosen.includes(o.value)}
                                onChange={(e) =>
                                    onChange(
                                        e.target.checked ? [...chosen, o.value] : chosen.filter((c) => c !== o.value),
                                    )
                                }
                                className="size-4 accent-[var(--accent)]"
                            />
                            {o.title}
                        </label>
                    ))}
                </div>
                {notes}
            </fieldset>
        );
    }
    const numeric = field.kind === "number" || field.kind === "integer";
    const type = numeric
        ? "number"
        : field.format === "email"
          ? "email"
          : field.format === "uri"
            ? "url"
            : field.format === "date"
              ? "date"
              : field.format === "date-time"
                ? "datetime-local"
                : "text";
    return (
        <div className="flex flex-col gap-1">
            {label}
            <input
                {...common}
                type={type}
                inputMode={numeric ? "decimal" : undefined}
                step={field.kind === "integer" ? 1 : numeric ? "any" : undefined}
                min={field.minimum}
                max={field.maximum}
                maxLength={field.maxLength}
                value={String(value ?? "")}
                onChange={(e) => onChange(e.target.value)}
                className={inputClass}
            />
            {notes}
        </div>
    );
}

function FormBody({
    item,
    fields,
    values,
    setValues,
    errors,
}: {
    item: McpElicitationItem;
    fields: Field[];
    values: FormValues;
    setValues: (v: FormValues) => void;
    errors: Record<string, string>;
}) {
    const base = useId();
    if (!fields.length) return null;
    return (
        <div className="flex max-h-56 flex-col gap-3 overflow-auto px-1" data-no-drawer-gesture="" data-item={item.id}>
            {fields.map((f) => (
                <FieldInput
                    key={f.key}
                    field={f}
                    value={values[f.key]}
                    error={errors[f.key]}
                    describedBy={`${base}-${f.key}`}
                    onChange={(v) => setValues({ ...values, [f.key]: v })}
                />
            ))}
        </div>
    );
}

function UrlBody({ url, opened, onOpen }: { url: string | undefined; opened: boolean; onOpen: () => void }) {
    const t = useT();
    const view = urlView(url);
    return (
        <div className="flex flex-col gap-2 px-1">
            <p className="font-mono text-xs leading-4 break-all text-secondary" translate="no">
                {view.before}
                <strong className="font-semibold text-text">{view.host}</strong>
                {view.after}
            </p>
            {view.punycode && (
                <p role="alert" className="flex items-start gap-1.5 text-xs text-warning">
                    <WarningIcon size={14} weight="fill" className="mt-px shrink-0" />
                    {t("thread-form-punycode")}
                </p>
            )}
            {!view.openable && <p className="text-xs text-danger">{t("thread-form-unopenable")}</p>}
            <div>
                <Button
                    size="lg"
                    variant="soft"
                    pill
                    className="rounded-full!"
                    disabled={!view.openable}
                    onClick={onOpen}
                >
                    <ArrowSquareOutIcon aria-hidden />
                    {opened ? t("thread-form-open-again") : t("thread-form-open")}
                </Button>
            </div>
        </div>
    );
}

function TrayBody({
    item,
    count,
    conversationId,
}: {
    item: McpElicitationItem;
    count: number;
    conversationId: string;
}) {
    const t = useT();
    const coarse = useCoarsePointer();
    const fields = fieldsOf(item.requested_schema);
    const [values, setValues] = useState<FormValues>(() => initialValues(fields));
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [opened, setOpened] = useState(false);
    const root = useRef<HTMLElement>(null);
    const url = item.mode === "url";
    // Move focus into the tray when it opens, unless the user is typing in the composer.
    useEffect(() => {
        const el = document.activeElement;
        const typing = (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && el.value.trim() !== "";
        if (!typing) root.current?.focus();
    }, []);
    const send = (action: "accept" | "decline" | "cancel") => {
        if (action === "accept" && !url) {
            const found = checkForm(fields, values);
            setErrors(found);
            if (Object.keys(found).length) return;
            respondElicitation(conversationId, item.id, "accept", contentOf(fields, values));
            return;
        }
        respondElicitation(conversationId, item.id, action);
    };
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            send("cancel");
        }
    };
    const button = cn("rounded-full!", coarse && "h-10 px-4");
    return (
        <section
            ref={root}
            tabIndex={-1}
            aria-label={t("thread-form-asks", { server: item.server_label })}
            onKeyDown={onKeyDown}
            className="flex flex-col gap-2 px-3 pt-3 pb-[calc(24px+12px)] outline-none"
        >
            <div className="flex items-center gap-2 px-1">
                <PlugIcon size={16} className="shrink-0 text-secondary" aria-hidden />
                <h3 className="min-w-0 flex-1 truncate text-[length:var(--type-body,14px)] leading-5 font-semibold text-text">
                    {t("thread-form-asks", { server: item.server_label })}
                </h3>
                {count > 1 && (
                    <span className="text-xs text-tertiary tabular-nums">
                        {t("thread-qt-step", { step: 1, count })}
                    </span>
                )}
            </div>
            <p className="px-1 text-sm leading-5 whitespace-pre-wrap text-text">{item.message}</p>
            {url ? (
                <UrlBody
                    url={item.url}
                    opened={opened}
                    onOpen={() => {
                        if (item.url) openLink(item.url);
                        setOpened(true);
                    }}
                />
            ) : (
                <FormBody item={item} fields={fields} values={values} setValues={setValues} errors={errors} />
            )}
            <div className="flex flex-wrap items-center justify-end gap-2 px-1">
                <Button size="lg" variant="transparent" pill className={button} onClick={() => send("cancel")}>
                    {t("thread-form-cancel")}
                </Button>
                <Button size="lg" variant="soft" pill className={button} onClick={() => send("decline")}>
                    {t("thread-form-decline")}
                </Button>
                <Button
                    size="lg"
                    variant="solid"
                    pill
                    className={button}
                    disabled={url && !opened}
                    onClick={() => send("accept")}
                >
                    {url ? t("thread-form-done") : t("thread-form-submit")}
                </Button>
            </div>
        </section>
    );
}

/** Mount directly above the Composer, next to the approval tray. Renders nothing while no request is open. */
export function ElicitationTray({ conversationId }: { conversationId: string }) {
    const t = useT();
    const pending = usePendingElicitations(conversationId);
    const current = pending[0];
    const last = useRef<{ item: McpElicitationItem; count: number } | undefined>(undefined);
    if (current) last.current = { item: current, count: pending.length };
    const [mounted, setMounted] = useState(!!current);
    useEffect(() => {
        if (current) setMounted(true);
    }, [current]);
    if (!mounted || !last.current) return null;
    const leaving = !current;
    return (
        <div className="relative -mb-6 overflow-hidden px-[13px] pt-3">
            <div
                role="region"
                aria-label={t("thread-form-region")}
                aria-live="polite"
                data-state={leaving ? "closed" : "open"}
                onAnimationEnd={() => leaving && setMounted(false)}
                className="approval-tray rounded-t-2xl bg-composer shadow-composer"
            >
                <TrayBody
                    key={last.current.item.id}
                    item={last.current.item}
                    count={leaving ? 1 : last.current.count}
                    conversationId={conversationId}
                />
            </div>
        </div>
    );
}
