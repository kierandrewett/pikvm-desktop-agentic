/**
 * Add a PiKVM, or edit one. The same form serves both: with `entry` it edits that PiKVM, without it adds one.
 * Only drawn where the host owns the PiKVM list (the desktop app); a hosted build pins its PiKVM and the page
 * stays read-only.
 *
 * The password starts empty and is never filled from the server, which does not send it: the server only says
 * whether one is set. Leaving it empty keeps the stored password, typing replaces it, and "Remove the stored
 * password" clears it. Nothing typed stays in the page after a save.
 */

import { Button, Notice, SettingRow, Switch, TextField } from "@pikvm/chat-web/settings";
import type { PikvmAdd, PikvmEntry, PikvmPatch } from "@pikvm/contracts/api";
import { type FormEvent, type ReactNode, useState } from "react";
import { useAddPikvm, useUpdatePikvm } from "../../api/queries";
import { reloadApp } from "../../host/reload";

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

export function nameProblem(value: string): string {
    return value.trim() === "" ? "Give it a name." : "";
}

interface Problems {
    readonly name: string;
    readonly origin: string;
}

/** A field's complaint sits under the field, announced as it appears. */
export function Field({ error, children }: { readonly error: string; readonly children: ReactNode }) {
    return (
        <div className="flex w-full flex-col gap-1.5">
            {children}
            {error && (
                <p role="alert" className="text-sm leading-[18px] text-danger">
                    {error}
                </p>
            )}
        </div>
    );
}

export function PikvmForm({
    entry,
    onDone,
    onCancel,
    sentTo,
}: {
    /** The PiKVM being edited; absent when adding one. */
    readonly entry?: PikvmEntry;
    /** Called after a successful save; the parent closes the form. */
    readonly onDone: () => void;
    /** Shown when there is something to go back to. */
    readonly onCancel?: (() => void) | undefined;
    /** The server in use when it is not this computer. The password is sent to it and kept there. */
    readonly sentTo?: string | undefined;
}) {
    const add = useAddPikvm();
    const update = useUpdatePikvm();
    const [name, setName] = useState(entry?.name ?? "");
    const [origin, setOrigin] = useState(entry?.origin ?? "");
    const [username, setUsername] = useState(entry?.username ?? "");
    const [password, setPassword] = useState("");
    const [remove, setRemove] = useState(false);
    const [problems, setProblems] = useState<Problems>({ name: "", origin: "" });

    const saving = add.isPending || update.isPending;
    const failure = entry ? update.error : add.error;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const next = { name: nameProblem(name), origin: addressProblem(origin) };
        setProblems(next);
        if (next.name || next.origin) return;

        const trimmedName = name.trim();
        const trimmedOrigin = origin.trim();
        const trimmedUser = username.trim();

        if (entry) {
            // Only a change to the PiKVM in use reloads the app: its address, sign-in or password is what the
            // video and input socket are connected with. A rename or a change to another PiKVM does not.
            const passwordSent = remove || password !== "";
            const patch: PikvmPatch = {
                name: trimmedName,
                origin: trimmedOrigin,
                username: trimmedUser,
                ...(passwordSent ? { password: remove ? "" : password } : {}),
            };
            const inUse = entry.active && (trimmedOrigin !== entry.origin || trimmedUser !== entry.username || passwordSent);
            update.mutate(
                { id: entry.id, patch },
                {
                    onSuccess: () => {
                        if (inUse) reloadApp();
                        onDone();
                    },
                },
            );
            return;
        }

        const payload: PikvmAdd = {
            name: trimmedName,
            origin: trimmedOrigin,
            ...(trimmedUser !== "" ? { username: trimmedUser } : {}),
            ...(password !== "" ? { password } : {}),
        };
        add.mutate(payload, {
            onSuccess: (created) => {
                // The first PiKVM added becomes the one in use; any other waits its turn.
                if (created.active) reloadApp();
                onDone();
            },
        });
    };

    const passwordPlaceholder = entry
        ? entry.passwordSet
            ? "A password is stored. Type to replace it."
            : "No password stored"
        : "Optional";
    const passwordNote = [
        "Not shown again after you save it.",
        entry?.passwordSet ? "Leave it empty to keep the saved one." : "",
        sentTo ? `The password is sent to ${sentTo} and kept there.` : "",
    ]
        .filter((line) => line !== "")
        .join(" ");
    const submitLabel = entry ? (entry.active ? "Save and reconnect" : "Save") : "Add PiKVM";

    return (
        <form onSubmit={submit} noValidate>
            <SettingRow
                label="Name"
                stack
                control={
                    <Field error={problems.name}>
                        <TextField
                            label="Name"
                            value={name}
                            invalid={!!problems.name}
                            onChange={(value) => {
                                setName(value);
                                setProblems((p) => ({ ...p, name: "" }));
                            }}
                        />
                    </Field>
                }
            />
            <SettingRow
                label="Address"
                description="Include the scheme, for example https://pikvm.lan/"
                stack
                control={
                    <Field error={problems.origin}>
                        <TextField
                            label="Address"
                            value={origin}
                            inputMode="url"
                            invalid={!!problems.origin}
                            onChange={(value) => {
                                setOrigin(value);
                                setProblems((p) => ({ ...p, origin: "" }));
                            }}
                        />
                    </Field>
                }
            />
            <SettingRow
                label="User name"
                stack
                control={<TextField label="User name" value={username} onChange={setUsername} />}
            />
            <SettingRow
                label="Password"
                description={passwordNote}
                stack
                control={
                    <TextField
                        label="Password"
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        placeholder={passwordPlaceholder}
                        disabled={remove}
                        onChange={setPassword}
                    />
                }
            />
            {entry?.passwordSet && (
                <SettingRow
                    label="Remove the stored password"
                    description="The PiKVM is then reached without a password."
                    control={<Switch checked={remove} onChange={setRemove} label="Remove the stored password" />}
                />
            )}
            {failure && <Notice tone="danger">Could not save: {failure.message}</Notice>}
            <div className="flex flex-wrap justify-end gap-2 px-4 pt-2 pb-4">
                {onCancel && (
                    <Button type="button" onClick={onCancel} disabled={saving}>
                        Cancel
                    </Button>
                )}
                <Button type="submit" variant="primary" disabled={saving}>
                    {submitLabel}
                </Button>
            </div>
        </form>
    );
}
