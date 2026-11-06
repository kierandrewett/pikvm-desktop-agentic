/**
 * Model subscriptions: sign in to Claude or ChatGPT (Codex) with the plan you already pay for, through the agent runtime's own login.
 * The runtime keeps and refreshes the credential in your own private home; this page only opens the address and passes back what you paste.
 * The browser ends on a localhost address that this host's page cannot be reached from, so the last step is pasting that address.
 * It sits on the Add provider screen, drawn as the same tiles as the providers below it.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { keys } from "../../lib/queries";
import { Badge, Button, Input, SettingsSection } from "./kit";

type Provider = "anthropic" | "openai-codex";
interface Login {
    id: string;
    provider: Provider;
    state: "starting" | "waiting" | "done" | "failed";
    url?: string;
    error?: string;
}

const PROVIDERS: { id: Provider; icon: string; name: string; description: string }[] = [
    { id: "anthropic", icon: "anthropic", name: "Claude", description: "Sign in with your Claude Pro or Max plan" },
    { id: "openai-codex", icon: "openai", name: "ChatGPT (Codex)", description: "Sign in with your ChatGPT plan" },
];

const signedInKey = ["logins"] as const;

function Entry({ id, icon, name, description, renderIcon, signedInAt }: (typeof PROVIDERS)[number] & { renderIcon: (id: string, name: string) => ReactNode; signedInAt?: number }) {
    const queryClient = useQueryClient();
    const [login, setLogin] = useState<Login | undefined>();
    const [pasted, setPasted] = useState("");
    const [error, setError] = useState<string | undefined>();
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!login || (login.state !== "waiting" && login.state !== "starting")) return;
        const timer = setInterval(() => {
            void api.get<Login>(`/logins/${login.id}`).then(
                (next) => {
                    setLogin((was) => (was ? { ...was, ...next } : was));
                    if (next.state === "done") {
                        void queryClient.invalidateQueries({ queryKey: keys.models });
                        void queryClient.invalidateQueries({ queryKey: signedInKey });
                    }
                },
                () => undefined,
            );
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
    const failed = login?.state === "failed" || error !== undefined;
    return (
        <>
            <button
                type="button"
                disabled={busy || waiting}
                onClick={() => void start()}
                data-preset={`subscription-${id}`}
                className="flex h-full min-h-16 w-full items-center gap-3 rounded-2xl border border-default bg-control px-3 py-2.5 text-start outline-none focus-visible:outline-2 focus-visible:outline-ring hover-device:hover:bg-hover disabled:cursor-default"
            >
                {renderIcon(icon, name)}
                <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{name}</span>
                        {(login?.state === "done" || signedInAt !== undefined) && <Badge tone="success">Signed in</Badge>}
                    </span>
                    <span className={failed ? "line-clamp-2 text-xs text-danger" : "line-clamp-2 text-xs text-tertiary"}>
                        {failed ? `Could not sign in: ${login?.error ?? error}` : waiting ? "Waiting for you to finish below" : signedInAt !== undefined ? `Signed in ${new Date(signedInAt).toLocaleDateString()}. Select to sign in again.` : description}
                    </span>
                </span>
            </button>
            {waiting ? (
                <div className="col-span-full space-y-3 rounded-2xl border border-default bg-control px-4 py-3">
                    <p className="m-0 text-sm font-medium">Finish signing in to {name}</p>
                    <ol className="m-0 list-decimal space-y-1 ps-5 text-sm text-secondary">
                        <li>
                            Sign in in the tab that opened.{" "}
                            <a className="text-text underline" href={login.url} target="_blank" rel="noreferrer">
                                Open it again
                            </a>
                            .
                        </li>
                        <li>The last page will not load. Copy its address from the address bar (or the code it shows) and paste it here.</li>
                    </ol>
                    <div className="flex items-center gap-2">
                        <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://localhost:54545/callback?code=..." aria-label="Address or code" mono />
                        <Button variant="primary" disabled={busy || pasted.trim().length < 4} onClick={() => void send()}>
                            Done
                        </Button>
                        <Button onClick={cancel}>Cancel</Button>
                    </div>
                </div>
            ) : null}
        </>
    );
}

export function SubscriptionsSection({ renderIcon }: { renderIcon: (id: string, name: string) => ReactNode }) {
    // What the server remembers: a sign-in survives a reload and shows on every device.
    const known = useQuery({ queryKey: signedInKey, queryFn: () => api.get<{ signedIn: { provider: Provider; at: number }[] }>("/logins"), retry: false });
    const at = (id: Provider) => known.data?.signedIn.find((x) => x.provider === id)?.at;
    return (
        <SettingsSection title="Use your subscription" description="Sign in with a plan you already pay for. No API key needed.">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {PROVIDERS.map((p) => (
                    <Entry key={p.id} {...p} renderIcon={renderIcon} signedInAt={at(p.id)} />
                ))}
            </div>
        </SettingsSection>
    );
}
