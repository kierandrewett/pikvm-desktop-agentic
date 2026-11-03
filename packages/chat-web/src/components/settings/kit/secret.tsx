/**
 * A stored secret (API key, client secret, token header) as a settings row. The value is never shown: the row says
 * whether it is set. "Replace" opens an inline field; "Remove" (optional secrets only) asks to confirm first, in
 * place, because a removed key cannot be read back.
 */
import { useState, type ReactNode } from "react";
import { useLocale, useT } from "../../../l10n/provider";
import { TextField } from "./controls";
import { Button } from "./feedback";
import { SettingRow } from "./layout";

const MASK = "•".repeat(8);

export function SecretRow({
    id,
    label,
    description,
    isSet,
    editable,
    optional,
    onSave,
}: {
    id?: string;
    label: string;
    description?: ReactNode;
    isSet: boolean;
    editable: boolean;
    optional?: boolean;
    /** Write the new value, or undefined to remove it. Rejects with the server error. */
    onSave: (value: string | undefined) => Promise<void>;
}) {
    const t = useT();
    const { locale } = useLocale();
    const lower = label.toLocaleLowerCase(locale);
    const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const save = async (v: string | undefined) => {
        setBusy(true);
        setError(null);
        try {
            await onSave(v);
            setMode("view");
            setDraft("");
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    if (mode === "edit") {
        return (
            <SettingRow
                id={id}
                stack
                label={label}
                description={description}
                error={error}
                control={
                    <form
                        className="flex w-full flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (draft.trim()) void save(draft.trim());
                        }}
                    >
                        <TextField
                            type="password"
                            label={t("settings-secret-new", { label: lower })}
                            autoFocus
                            mono
                            value={draft}
                            onChange={setDraft}
                            className="min-w-0 flex-1 basis-60"
                        />
                        <Button size="md" onClick={() => setMode("view")}>
                            {t("settings-cancel")}
                        </Button>
                        <Button size="md" variant="primary" type="submit" busy={busy} disabled={!draft.trim()}>
                            {t("settings-save")}
                        </Button>
                    </form>
                }
            />
        );
    }

    return (
        <SettingRow
            id={id}
            label={label}
            description={mode === "confirm" ? t("settings-secret-remove-confirm", { label: lower }) : description}
            error={error}
            control={
                mode === "confirm" ? (
                    <>
                        <Button onClick={() => setMode("view")}>{t("settings-cancel")}</Button>
                        <Button variant="danger" busy={busy} onClick={() => void save(undefined)}>
                            {t("settings-remove")}
                        </Button>
                    </>
                ) : (
                    <>
                        <span className={isSet ? "font-mono text-xs text-secondary" : "text-xs text-tertiary"}>
                            {isSet ? MASK : t("settings-secret-not-set")}
                        </span>
                        {editable && isSet && optional && (
                            <Button variant="danger" onClick={() => setMode("confirm")}>
                                {t("settings-remove")}
                            </Button>
                        )}
                        {editable && (
                            <Button onClick={() => setMode("edit")}>
                                {isSet ? t("settings-secret-replace") : t("settings-add")}
                            </Button>
                        )}
                    </>
                )
            }
        />
    );
}
