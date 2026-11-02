import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { InlineError } from "../../ui/controls";
import {
    type CatalogEntry,
    type ConnectionBody,
    connectProvider,
    connectWithKey,
} from "./harness-api";
import { AUTH_MODE_LABEL, KIND_FORMS, type AuthMode, takesKey } from "./kinds";
import { SecretField, fieldClass, messageOf } from "./parts";
import { harnessKeys, useModelCatalog } from "./queries";

const TIER_LABEL: Readonly<Record<string, string>> = { stable: "Stable", beta: "Beta", bridge: "Bridge" };

interface AddProviderProps {
    catalog: ReadonlyArray<CatalogEntry>;
    existingAliases: ReadonlyArray<string>;
}

/** The first alias from `hint` that is not taken: `openai`, then `openai-2`, and so on. */
const freeAlias = (hint: string, taken: ReadonlyArray<string>): string => {
    if (!taken.includes(hint)) return hint;
    for (let n = 2; ; n += 1) if (!taken.includes(`${hint}-${n}`)) return `${hint}-${n}`;
};

export function AddProvider({ catalog, existingAliases }: AddProviderProps) {
    const [open, setOpen] = useState(false);
    const [added, setAdded] = useState<string | null>(null);

    if (!open) {
        return (
            <div className="px-4 py-3">
                <div className="flex items-center gap-3">
                    <div className="row-text">
                        <div className="row-label">Add a provider</div>
                        <div className="row-hint">Connect an API provider with its key, or an account that signs in with a CLI.</div>
                    </div>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                            setAdded(null);
                            setOpen(true);
                        }}
                    >
                        Add provider
                    </button>
                </div>
                {added ? (
                    <p className="row-hint mt-2 mb-0" role="status">
                        Added {added}. It is not on any route yet: pick it for a task, or promote it in the harness config.
                    </p>
                ) : null}
            </div>
        );
    }

    const offered = catalog.filter((entry) => entry.kind in KIND_FORMS);
    return (
        <AddForm
            offered={offered}
            existingAliases={existingAliases}
            onClose={() => setOpen(false)}
            onAdded={(alias) => {
                setAdded(alias);
                setOpen(false);
            }}
        />
    );
}

interface AddFormProps {
    offered: ReadonlyArray<CatalogEntry>;
    existingAliases: ReadonlyArray<string>;
    onClose: () => void;
    onAdded: (alias: string) => void;
}

function AddForm({ offered, existingAliases, onClose, onAdded }: AddFormProps) {
    const queryClient = useQueryClient();
    const ids = { kind: useId(), alias: useId(), model: useId(), baseUrl: useId(), auth: useId(), models: useId() };
    const firstKind = offered[0]?.kind ?? "openai_responses";
    const [kind, setKind] = useState(firstKind);
    const form = KIND_FORMS[kind];
    const [alias, setAlias] = useState(() => freeAlias(KIND_FORMS[firstKind]?.aliasHint ?? "provider", existingAliases));
    const [model, setModel] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [authMode, setAuthMode] = useState<AuthMode | undefined>(KIND_FORMS[firstKind]?.authModes?.[0]);
    const [apiKey, setApiKey] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const models = useModelCatalog(true);
    const suggestions = (models.data?.kinds[kind] ?? []).flatMap((id) => models.data?.providers[id]?.models ?? []);

    const needsKey = takesKey(kind, authMode);
    const baseUrlRequired = form?.baseUrl === "required";
    const showBaseUrl = form !== undefined && form.baseUrl !== "none";
    const ready =
        alias.trim() !== "" &&
        model.trim() !== "" &&
        (!baseUrlRequired || baseUrl.trim() !== "") &&
        (!needsKey || apiKey.trim() !== "");

    const chooseKind = (next: string) => {
        const nextForm = KIND_FORMS[next];
        setKind(next);
        setAlias(freeAlias(nextForm?.aliasHint ?? "provider", existingAliases));
        setAuthMode(nextForm?.authModes?.[0]);
        setBaseUrl("");
        setModel("");
        setApiKey("");
        setError(null);
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (busy || !ready) return;
        const connection: ConnectionBody = {
            alias: alias.trim(),
            kind,
            model: model.trim(),
            ...(showBaseUrl && baseUrl.trim() !== "" ? { base_url: baseUrl.trim() } : {}),
            ...(authMode ? { auth_mode: authMode } : {}),
        };
        setBusy(true);
        setError(null);
        try {
            if (needsKey) await connectWithKey(connection, apiKey);
            else await connectProvider(connection);
            setApiKey("");
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: harnessKeys.providers }),
                queryClient.invalidateQueries({ queryKey: harnessKeys.keys }),
            ]);
            onAdded(connection.alias);
        } catch (failure) {
            setError(messageOf(failure));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form className="flex flex-col gap-3 px-4 py-3" aria-label="Add a provider" onSubmit={(event) => void submit(event)}>
            <div className="row-label">Add a provider</div>

            <label className="flex flex-col gap-1" htmlFor={ids.kind}>
                <span className="row-hint">Provider</span>
                <select id={ids.kind} className="field-select max-w-full" value={kind} disabled={busy} onChange={(event) => chooseKind(event.target.value)}>
                    {offered.map((entry) => (
                        <option key={entry.kind} value={entry.kind}>
                            {KIND_FORMS[entry.kind]?.label ?? entry.kind} · {entry.interface} ({TIER_LABEL[entry.support_tier] ?? entry.support_tier})
                        </option>
                    ))}
                </select>
            </label>

            {form?.authModes ? (
                <label className="flex flex-col gap-1" htmlFor={ids.auth}>
                    <span className="row-hint">Sign-in</span>
                    <select
                        id={ids.auth}
                        className="field-select max-w-full"
                        value={authMode ?? ""}
                        disabled={busy}
                        onChange={(event) => setAuthMode(event.target.value as AuthMode)}
                    >
                        {form.authModes.map((mode) => (
                            <option key={mode} value={mode}>
                                {AUTH_MODE_LABEL[mode]}
                            </option>
                        ))}
                    </select>
                </label>
            ) : null}

            <label className="flex flex-col gap-1" htmlFor={ids.alias}>
                <span className="row-hint">Name</span>
                <input id={ids.alias} className={fieldClass} value={alias} disabled={busy} spellCheck={false} autoCapitalize="off" onChange={(event) => setAlias(event.target.value)} />
            </label>

            <label className="flex flex-col gap-1" htmlFor={ids.model}>
                <span className="row-hint">Model</span>
                <input
                    id={ids.model}
                    className={fieldClass}
                    value={model}
                    list={ids.models}
                    placeholder={form?.modelHint ?? ""}
                    disabled={busy}
                    spellCheck={false}
                    autoCapitalize="off"
                    onChange={(event) => setModel(event.target.value)}
                />
            </label>
            <datalist id={ids.models}>
                {suggestions.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                        {entry.name ?? entry.id}
                    </option>
                ))}
            </datalist>

            {showBaseUrl ? (
                <label className="flex flex-col gap-1" htmlFor={ids.baseUrl}>
                    <span className="row-hint">Base URL{baseUrlRequired ? "" : " (optional)"}</span>
                    <input
                        id={ids.baseUrl}
                        className={fieldClass}
                        type="url"
                        value={baseUrl}
                        placeholder="https://"
                        disabled={busy}
                        spellCheck={false}
                        autoCapitalize="off"
                        onChange={(event) => setBaseUrl(event.target.value)}
                    />
                </label>
            ) : null}

            {needsKey ? (
                <div className="flex flex-col gap-1">
                    <span className="row-hint">API key (kept on the machine running the harness, never shown again)</span>
                    <SecretField label="API key" value={apiKey} onChange={setApiKey} placeholder="Paste an API key" disabled={busy} />
                </div>
            ) : form?.family === "account" ? (
                <p className="row-hint m-0">This provider uses the account the CLI is signed in to. Sign in above after adding it.</p>
            ) : (
                <p className="row-hint m-0">This sign-in uses the cloud CLI on the machine running the harness; no key is needed.</p>
            )}

            {error ? <InlineError>{error}</InlineError> : null}

            <div className="flex gap-2">
                <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
                    {needsKey ? "Add provider and save key" : "Add provider"}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={onClose}>
                    Cancel
                </button>
            </div>
        </form>
    );
}
