/**
 * Change the PiKVM this app connects to. Only drawn where the host owns the setting (the desktop
 * app); a hosted build pins it by environment and the page stays read-only.
 *
 * The password field is write-only. It starts empty and is never filled from the server, which
 * does not send it: the server only says whether one is set. Leaving it empty keeps the stored
 * password, typing replaces it, and "Remove the stored password" clears it.
 */

import type { TargetConfig, TargetPatch } from "@pikvm/contracts/api";
import { type FormEvent, useState } from "react";
import { useSaveTarget } from "../../api/queries";
import { reloadApp } from "../../host/reload";
import { Button, SettingRow, SettingsCard, SettingsSection, Switch, TextField } from "@pikvm/chat-web/settings";

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
            <SettingsSection
                title="Change the PiKVM"
                description="Saving applies at once and reloads the app. The password is stored in its own file, readable only by you, and is never shown again."
            >
                <SettingsCard>
                    <SettingRow
                        id="target-address"
                        label="Address"
                        stack
                        error={problem || null}
                        control={
                            <TextField
                                label="Address"
                                value={origin}
                                inputMode="url"
                                invalid={problem !== ""}
                                onChange={(value) => {
                                    setOrigin(value);
                                    setProblem("");
                                }}
                            />
                        }
                    />
                    <SettingRow
                        id="target-user"
                        label="User name"
                        stack
                        control={<TextField label="User name" value={username} onChange={setUsername} />}
                    />
                    <SettingRow
                        id="target-password"
                        label="Password"
                        stack
                        control={
                            <TextField
                                label="Password"
                                type="password"
                                value={password}
                                disabled={remove}
                                placeholder={
                                    target.passwordSet ? "A password is stored. Type to replace it." : "No password stored"
                                }
                                onChange={setPassword}
                            />
                        }
                    />
                    {target.passwordSet ? (
                        <SettingRow
                            id="target-remove-password"
                            label="Remove the stored password"
                            control={<Switch label="Remove the stored password" checked={remove} onChange={setRemove} />}
                        />
                    ) : null}
                </SettingsCard>
                <div className="flex flex-col items-end gap-2">
                    {save.error ? (
                        <p role="alert" className="self-stretch text-sm text-danger">
                            Could not save: {save.error.message}
                        </p>
                    ) : null}
                    <Button type="submit" variant="primary" disabled={save.isPending}>
                        {save.isPending ? "Saving" : "Save and reconnect"}
                    </Button>
                </div>
            </SettingsSection>
        </form>
    );
}
