/**
 * The form that connects this app to a server: its address and an access token. Shared by Settings > Connection and the
 * first-run screen, so both ask the same things in the same words.
 */

import { Button, Notice, SettingRow, TextField } from "@pikvm/chat-web/settings";
import type { ServerAdd, ServerEntry } from "@pikvm/contracts/api";
import { type FormEvent, useState } from "react";
import { useAddServer, useUseServer } from "../../api/queries";
import { reloadApp } from "../../host/reload";
import { addressProblem, Field } from "./target-form";

/**
 * Connects to a server that is not saved yet: the probe, then making it the one in use. The token leaves the page
 * with the request. If the save worked but making it the one in use failed, the saved address is shown with Connect
 * to try that again, so the server is not added twice.
 */
export function ConnectForm({ saved }: { readonly saved: ServerEntry | undefined }) {
    const add = useAddServer();
    const use = useUseServer();
    const [origin, setOrigin] = useState("");
    const [token, setToken] = useState("");
    const [problems, setProblems] = useState({ origin: "", token: "" });
    const pending = add.isPending || use.isPending;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const next = {
            origin: addressProblem(origin),
            token: token === "" ? "Enter the access token." : "",
        };
        setProblems(next);
        if (next.origin || next.token) return;

        const payload: ServerAdd = { origin: origin.trim(), token };
        // The token leaves the page with the request; it is not kept once sent.
        setToken("");
        add.mutate(payload, {
            onSuccess: (entry) => use.mutate(entry.id, { onSuccess: () => reloadApp() }),
        });
    };

    if (saved) {
        return (
            <>
                <SettingRow
                    label={saved.origin}
                    description="Saved, but not in use yet."
                    control={
                        <Button
                            variant="primary"
                            disabled={use.isPending}
                            onClick={() => use.mutate(saved.id, { onSuccess: () => reloadApp() })}
                        >
                            Connect
                        </Button>
                    }
                />
                {use.error ? <Notice tone="danger">Could not connect: {use.error.message}</Notice> : null}
            </>
        );
    }

    const error = add.error ?? use.error;
    return (
        <form onSubmit={submit} noValidate>
            <SettingRow
                label="Address"
                description="Starts with https://, or http:// for this computer."
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
                label="Access token"
                description="Not shown again after you save it."
                stack
                control={
                    <Field error={problems.token}>
                        <TextField
                            label="Access token"
                            type="password"
                            autoComplete="off"
                            value={token}
                            invalid={!!problems.token}
                            onChange={(value) => {
                                setToken(value);
                                setProblems((p) => ({ ...p, token: "" }));
                            }}
                        />
                    </Field>
                }
            />
            {error ? <Notice tone="danger">Could not connect: {error.message}</Notice> : null}
            <div className="flex flex-wrap justify-end gap-2 px-4 pt-2 pb-4">
                <Button type="submit" variant="primary" busy={pending}>
                    Connect
                </Button>
            </div>
        </form>
    );
}
