/**
 * The form that connects this app to a server: its address and an access token. Shared by Settings > Connection and the
 * first-run screen, so both ask the same things in the same words.
 */

import {
    Button,
    Notice,
    SettingRow,
    TextField,
} from "@pikvm/chat-web/settings";
import type { ServerAdd, ServerEntry } from "@pikvm/contracts/api";
import { type FormEvent, useEffect, useState } from "react";
import {
    useAddServer,
    useBeginSignIn,
    useCancelSignIn,
    useSignInStatus,
    useUseServer,
} from "../../api/queries";
import { desktopBridge } from "../../host/desktop";
import { reloadApp } from "../../host/reload";
import { addressProblem, Field } from "./target-form";

/**
 * Connects to a server that is not saved yet: the probe, then making it the one in use. The token leaves the page
 * with the request. If the save worked but making it the one in use failed, the saved address is shown with Connect
 * to try that again, so the server is not added twice.
 */
export function ConnectForm({
    saved,
}: {
    readonly saved: ServerEntry | undefined;
}) {
    const add = useAddServer();
    const use = useUseServer();
    const [origin, setOrigin] = useState("");
    const [token, setToken] = useState("");
    const [byToken, setByToken] = useState(false);
    const [attempt, setAttempt] = useState<string | undefined>(undefined);
    const [problems, setProblems] = useState({ origin: "", token: "" });
    const begin = useBeginSignIn();
    const cancel = useCancelSignIn();
    const status = useSignInStatus(attempt);
    const pending = add.isPending || use.isPending;
    const waiting =
        attempt !== undefined &&
        status.data?.state !== "done" &&
        status.data?.state !== "failed";

    // The server is saved by the time the status says done; making it the one in use is the same step as after a token.
    const done = status.data?.state === "done" ? status.data.entry : undefined;
    useEffect(() => {
        if (!done) return;
        setAttempt(undefined);
        use.mutate(done.id, { onSuccess: () => reloadApp() });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once per finished attempt
    }, [done?.id]);

    const signIn = () => {
        const problem = addressProblem(origin);
        setProblems({ origin: problem, token: "" });
        if (problem) return;
        begin.mutate(
            { origin: origin.trim() },
            {
                onSuccess: ({ id, url }) => {
                    setAttempt(id);
                    void desktopBridge()?.openExternal(url);
                },
            },
        );
    };
    const stop = () => {
        if (attempt) cancel.mutate(attempt);
        setAttempt(undefined);
    };

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
            onSuccess: (entry) =>
                use.mutate(entry.id, { onSuccess: () => reloadApp() }),
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
                            onClick={() =>
                                use.mutate(saved.id, {
                                    onSuccess: () => reloadApp(),
                                })
                            }
                        >
                            Connect
                        </Button>
                    }
                />
                {use.error ? (
                    <Notice tone="danger">
                        Could not connect: {use.error.message}
                    </Notice>
                ) : null}
            </>
        );
    }

    const error = add.error ?? use.error ?? begin.error;
    const failed =
        status.data?.state === "failed" ? status.data.error : undefined;
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
            {byToken ? (
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
            ) : null}
            {error ? (
                <Notice tone="danger">
                    Could not connect: {error.message}
                </Notice>
            ) : null}
            {failed ? <Notice tone="danger">{failed}</Notice> : null}
            {waiting ? (
                <Notice tone="neutral">
                    Finish signing in in your browser. This page continues by
                    itself.
                </Notice>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2 px-4 pt-2 pb-4">
                {waiting ? (
                    <Button onClick={stop}>Cancel</Button>
                ) : byToken ? (
                    <>
                        <Button onClick={() => setByToken(false)}>
                            Use your browser instead
                        </Button>
                        <Button type="submit" variant="primary" busy={pending}>
                            Connect
                        </Button>
                    </>
                ) : (
                    <>
                        <Button onClick={() => setByToken(true)}>
                            Use an access token instead
                        </Button>
                        <Button
                            variant="primary"
                            busy={begin.isPending || use.isPending}
                            onClick={signIn}
                        >
                            Sign in with your browser
                        </Button>
                    </>
                )}
            </div>
        </form>
    );
}
