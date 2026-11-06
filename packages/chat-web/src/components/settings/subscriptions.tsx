/**
 * Model subscriptions: sign in to Claude or ChatGPT (Codex) with the plan you already pay for, through the agent runtime's own login.
 * The runtime keeps and refreshes the credential in your own private home; this page only opens the address and passes back what you paste.
 * The browser ends on a localhost address that this host's page cannot be reached from, so the last step is pasting that address.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { keys } from "../../lib/queries";
import { Button, Input, Notice, SettingRow, SettingsCard, SettingsSection } from "./kit";

type Provider = "anthropic" | "openai-codex";
interface Login {
    id: string;
    provider: Provider;
    state: "starting" | "waiting" | "done" | "failed";
    url?: string;
    error?: string;
}

const PROVIDERS: { id: Provider; label: string; description: string }[] = [
    { id: "anthropic", label: "Claude (Pro or Max)", description: "Use your Claude subscription for chat." },
    { id: "openai-codex", label: "ChatGPT (Codex)", description: "Use your ChatGPT subscription for chat." },
];

function Entry({ id, label, description }: { id: Provider; label: string; description: string }) {
    const queryClient = useQueryClient();
    const [login, setLogin] = useState<Login | undefined>();
    const [pasted, setPasted] = useState("");
    const [error, setError] = useState<string | undefined>();
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!login || (login.state !== "waiting" && login.state !== "starting")) return;
        const timer = setInterval(() => {
            void api.get<Login>(`/logins/${login.id}`).then((next) => {
                setLogin((was) => (was ? { ...was, ...next } : was));
                if (next.state === "done") void queryClient.invalidateQueries({ queryKey: keys.models });
            }, () => undefined);
        }, 1500);
        return () => clearInterval(timer);
    }, [login?.id, login?.state, queryClient]);

    const start = async () => {
        setBusy(true);
        setError(undefined);
        try {
            const started = await api.post<Login>("/logins", { provider: id });
            setLogin(started);
            window.open(started.url, "_blank", "noopener,noreferrer");
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    };
    const send = async () => {
        if (!login) return;
        setBusy(true);
        setError(undefined);
        try {
            await api.post(`/logins/${login.id}/code`, { input: pasted });
            setPasted("");
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    };
    const cancel = () => {
        if (login) void api.del(`/logins/${login.id}`);
        setLogin(undefined);
        setPasted("");
    };

    const waiting = login?.state === "waiting";
    return (
        <>
            <SettingRow
                id={`subscription-${id}`}
                label={label}
                description={login?.state === "done" ? "Signed in. Its models are in the model list." : description}
                control={
                    waiting ? (
                        <Button onClick={cancel}>Cancel</Button>
                    ) : (
                        <Button disabled={busy} onClick={() => void start()}>
                            {login?.state === "done" ? "Sign in again" : "Sign in"}
                        </Button>
                    )
                }
            />
            {waiting ? (
                <SettingRow
                    id={`subscription-${id}-paste`}
                    label="Finish signing in"
                    description={`Sign in in the tab that opened (or open it again: ${login.url}). The last page cannot load. Copy its address, or the code it shows, and paste it here.`}
                    control={
                        <>
                            <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://localhost:.../callback?code=..." aria-label="Address or code" />
                            <Button variant="primary" disabled={busy || pasted.trim().length < 4} onClick={() => void send()}>
                                Done
                            </Button>
                        </>
                    }
                />
            ) : null}
            {login?.state === "failed" || error ? (
                <Notice tone="danger">{login?.error ?? error}</Notice>
            ) : null}
        </>
    );
}

export function SubscriptionsSection() {
    return (
        <SettingsSection title="Subscriptions" description="Sign in with a plan you already pay for. No API key needed.">
            <SettingsCard>
                {PROVIDERS.map((p) => (
                    <Entry key={p.id} {...p} />
                ))}
            </SettingsCard>
        </SettingsSection>
    );
}
