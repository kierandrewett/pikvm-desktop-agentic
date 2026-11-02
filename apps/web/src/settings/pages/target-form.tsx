/**
 * Change the PiKVM this app connects to. Only drawn where the host owns the setting (the desktop
 * app); a hosted build pins it by environment and the page stays read-only.
 *
 * The password field is write-only. It starts empty and is never filled from the server, which
 * does not send it: the server only says whether one is set. Leaving it empty keeps the stored
 * password, typing replaces it, and "Remove the stored password" clears it.
 */

import type { TargetConfig, TargetPatch } from "@pikvm/contracts/api";
import { type FormEvent, useId, useState } from "react";
import { useSaveTarget } from "../../api/queries";
import { reloadApp } from "../../host/reload";
import { Group, InlineError } from "../../ui/controls";

/** The same rule the server applies, so a typo is caught before a request. */
export function addressProblem(value: string): string {
    let parsed: URL;
    try {
        parsed = new URL(value.trim());
    } catch {
        return "That is not a URL. Include the scheme, for example https://pikvm/";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        return "The address must start with http:// or https://";
    if (!parsed.hostname) return "The address needs a host, for example https://pikvm/";
    return "";
}

export function TargetForm({ target }: { target: TargetConfig }) {
    const id = useId();
    const save = useSaveTarget();
    const [origin, setOrigin] = useState(target.origin);
    const [username, setUsername] = useState(target.username);
    const [password, setPassword] = useState("");
    const [remove, setRemove] = useState(false);
    const [problem, setProblem] = useState("");

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const bad = addressProblem(origin);
        setProblem(bad);
        if (bad) return;
        const patch: TargetPatch = {
            origin: origin.trim(),
            username: username.trim(),
            // Omitted keeps the stored password; "" removes it.
            ...(remove ? { password: "" } : password !== "" ? { password } : {}),
        };
        save.mutate(patch, {
            onSuccess: () => {
                // Never leave a typed password sitting in the page.
                setPassword("");
                setRemove(false);
                // The video and the input socket are held open through the old address; a reload
                // reconnects them to the new one.
                reloadApp();
            },
        });
    };

    return (
        <form onSubmit={submit} noValidate>
            <Group
                title="Change the PiKVM"
                footer="Saving applies at once and reloads the app. The password is stored in its own file, readable only by you, and is never shown again."
            >
                <div className="field-stack">
                    <label htmlFor={`${id}-origin`}>Address</label>
                    <input
                        id={`${id}-origin`}
                        className="field-input"
                        type="text"
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        value={origin}
                        aria-invalid={problem !== ""}
                        aria-describedby={problem ? `${id}-problem` : undefined}
                        onChange={(e) => {
                            setOrigin(e.target.value);
                            setProblem("");
                        }}
                    />
                    {problem ? (
                        <p id={`${id}-problem`} role="alert" className="inline-error">
                            {problem}
                        </p>
                    ) : null}
                    <label htmlFor={`${id}-user`}>User name</label>
                    <input
                        id={`${id}-user`}
                        className="field-input"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                    />
                    <label htmlFor={`${id}-password`}>Password</label>
                    <input
                        id={`${id}-password`}
                        className="field-input"
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        disabled={remove}
                        placeholder={
                            target.passwordSet ? "A password is stored. Type to replace it." : "No password stored"
                        }
                        onChange={(e) => setPassword(e.target.value)}
                    />
                    {target.passwordSet ? (
                        <label className="field-check">
                            <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} />
                            Remove the stored password
                        </label>
                    ) : null}
                </div>
                {save.error ? <InlineError>Could not save: {save.error.message}</InlineError> : null}
                <div className="field-actions">
                    <button type="submit" className="btn" disabled={save.isPending}>
                        {save.isPending ? "Saving" : "Save and reconnect"}
                    </button>
                </div>
            </Group>
        </form>
    );
}
