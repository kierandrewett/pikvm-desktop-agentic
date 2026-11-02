import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { InlineError } from "../../ui/controls";
import { type KeyEntry, type ProviderHealth, deleteProviderKey, putProviderKey } from "./harness-api";
import { ConfirmBar, SecretField, formatWhen, messageOf } from "./parts";
import { harnessKeys } from "./queries";
import { kindLabel } from "./kinds";

type Mode = "idle" | "editing" | "confirm-remove";

const describeSource = (entry: KeyEntry): { tone: "ok" | "warn"; text: string } => {
    if (entry.set) {
        const when = formatWhen(entry.updated_at);
        return { tone: "ok", text: when ? `Key set · updated ${when}` : "Key set" };
    }
    if (entry.source === "environment") {
        return { tone: "ok", text: `Using ${entry.credential_env ?? "an environment variable"} from the harness environment` };
    }
    return { tone: "warn", text: "No key yet" };
};

/**
 * One API provider's key. The page never receives the key, so there is nothing to show: a
 * provider either has one or does not. Set and Replace send what was typed once and clear it.
 */
export function KeyRow({ entry, health }: { entry: KeyEntry; health: ProviderHealth | undefined }) {
    const queryClient = useQueryClient();
    const [mode, setMode] = useState<Mode>("idle");
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const status = describeSource(entry);
    const showField = !entry.set || mode === "editing";
    const refresh = async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: harnessKeys.keys }),
            queryClient.invalidateQueries({ queryKey: harnessKeys.providers }),
        ]);
    };

    const save = async (event: FormEvent) => {
        event.preventDefault();
        if (busy || draft.trim() === "") return;
        setBusy(true);
        setError(null);
        try {
            await putProviderKey(entry.alias, draft);
            setDraft("");
            setMode("idle");
            await refresh();
        } catch (failure) {
            setError(messageOf(failure));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            await deleteProviderKey(entry.alias);
            setMode("idle");
            await refresh();
        } catch (failure) {
            setError(messageOf(failure));
        } finally {
            setBusy(false);
        }
    };

    const cancelEdit = () => {
        setDraft("");
        setError(null);
        setMode("idle");
    };

    return (
        <div className="px-4 py-3" data-testid={`key-${entry.alias}`}>
            <div className="flex items-start gap-3">
                <div className="row-text">
                    <div className="row-label">{entry.alias}</div>
                    <div className="row-hint">
                        {kindLabel(entry.kind)}
                        {health?.configured_model ? ` · ${health.configured_model}` : ""}
                    </div>
                    <div className="row-hint">
                        <span className="status-dot" data-tone={status.tone} aria-hidden="true" />
                        <span role="status">{status.text}</span>
                    </div>
                </div>
                {entry.set && mode === "idle" ? (
                    <div className="flex shrink-0 gap-2">
                        <button type="button" className="btn" aria-label={`Replace key for ${entry.alias}`} onClick={() => setMode("editing")}>
                            Replace
                        </button>
                        <button
                            type="button"
                            className="btn"
                            style={{ color: "var(--danger)" }}
                            aria-label={`Remove key for ${entry.alias}`}
                            onClick={() => setMode("confirm-remove")}
                        >
                            Remove
                        </button>
                    </div>
                ) : null}
            </div>

            {showField ? (
                <form className="mt-3 flex items-center gap-2" onSubmit={(event) => void save(event)}>
                    <SecretField
                        label={`${entry.set ? "New" : "API"} key for ${entry.alias}`}
                        value={draft}
                        onChange={setDraft}
                        placeholder={entry.set ? "Paste a new key to replace it" : "Paste an API key"}
                        disabled={busy}
                    />
                    <button type="submit" className="btn btn-primary" disabled={busy || draft.trim() === ""}>
                        {entry.set ? "Replace" : "Set key"}
                    </button>
                    {entry.set ? (
                        <button type="button" className="btn" disabled={busy} onClick={cancelEdit}>
                            Cancel
                        </button>
                    ) : null}
                </form>
            ) : null}

            {mode === "confirm-remove" ? (
                <ConfirmBar
                    danger
                    busy={busy}
                    message={`Remove the stored key for ${entry.alias}? The provider stops working until a key is set again${
                        entry.credential_env ? `, unless ${entry.credential_env} is set in the harness environment` : ""
                    }.`}
                    confirmLabel="Remove key"
                    onConfirm={() => void remove()}
                    onCancel={() => setMode("idle")}
                />
            ) : null}

            {error ? (
                <div className="mt-2">
                    <InlineError>{error}</InlineError>
                </div>
            ) : null}
        </div>
    );
}
