import { Badge, Button, EmptyState, Notice, Segmented, SettingRow, SettingsCard, SettingsPage, SettingsSection, Spinner } from "@pikvm/chat-web/settings";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useServers, useSession } from "../../api/queries";
import { isDesktopApp } from "../../kvm/platform";
import { useDevices, useRevokeDevice } from "./devices";
import { StatusDot } from "./value";

/** A copyable block: the exact text a person pastes into a terminal or a file. */
function Code({ text, label }: { text: string; label: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <div className="flex items-start gap-2">
            <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-all rounded-xl bg-soft px-4 py-3 font-mono text-sm leading-6 text-text select-text">{text}</pre>
            <Button
                aria-label={`Copy ${label}`}
                onClick={() => {
                    void navigator.clipboard.writeText(text).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1800);
                    });
                }}
            >
                {copied ? "Copied" : "Copy"}
            </Button>
        </div>
    );
}

function Step({ n, title, children }: { n: number; title: string; children?: React.ReactNode }) {
    return (
        <li className="flex gap-3">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-soft text-xs font-semibold text-secondary" aria-hidden="true">
                {n}
            </span>
            <div className="min-w-0 flex-1 space-y-2">
                <p className="m-0 text-base text-text">{title}</p>
                {children}
            </div>
        </li>
    );
}

type Client = "claude" | "codex" | "cursor" | "other";
const CLIENTS: { value: Client; label: string }[] = [
    { value: "claude", label: "Claude Code" },
    { value: "codex", label: "Codex" },
    { value: "cursor", label: "Cursor" },
    { value: "other", label: "Other" },
];

function Setup({ address, desktop, remote }: { address: string; desktop: boolean; remote: boolean }) {
    const [client, setClient] = useState<Client>("claude");
    const signIn = desktop
        ? "This is the desktop app's own server. Browser sign-in is a web-host feature, so there is no sign-in step: if you set an access token, pass it as a bearer header."
        : `The first time it connects, your browser opens ${remote ? "the server" : "this site"} to ask whether to let that agent in. Sign in if asked, then press Allow.`;
    return (
        <SettingsCard>
            <div className="space-y-4 px-4 py-4">
                <Segmented<Client> label="Agent" value={client} options={CLIENTS} onChange={setClient} />
                <ol className="m-0 list-none space-y-4 p-0">
                    {client === "claude" ? (
                        <>
                            <Step n={1} title="Add the server">
                                <Code label="Claude Code command" text={`claude mcp add --transport http pikvm ${address}`} />
                            </Step>
                            <Step n={2} title={desktop ? "Start Claude Code" : "Sign in"}>
                                <p className="m-0 text-sm text-secondary">{desktop ? signIn : `Run /mcp inside Claude Code and choose pikvm, then Authenticate. ${signIn}`}</p>
                            </Step>
                        </>
                    ) : null}
                    {client === "codex" ? (
                        <>
                            <Step n={1} title="Add the server">
                                <Code label="Codex command" text={`codex mcp add pikvm --url ${address}`} />
                            </Step>
                            <Step n={2} title={desktop ? "Start Codex" : "Sign in"}>
                                {desktop ? <p className="m-0 text-sm text-secondary">{signIn}</p> : <Code label="Codex sign-in" text="codex mcp login pikvm" />}
                                {desktop ? null : <p className="m-0 text-sm text-secondary">{signIn}</p>}
                            </Step>
                        </>
                    ) : null}
                    {client === "cursor" ? (
                        <>
                            <Step n={1} title="Open the MCP settings file" >
                                <p className="m-0 text-sm text-secondary">Cursor reads <code>~/.cursor/mcp.json</code> for every project, or <code>.cursor/mcp.json</code> for one.</p>
                            </Step>
                            <Step n={2} title="Add the server">
                                <Code label="Cursor config" text={JSON.stringify({ mcpServers: { pikvm: { url: address } } }, null, 2)} />
                            </Step>
                            <Step n={3} title={desktop ? "Reload Cursor" : "Sign in"}>
                                <p className="m-0 text-sm text-secondary">{signIn}</p>
                            </Step>
                        </>
                    ) : null}
                    {client === "other" ? (
                        <>
                            <Step n={1} title="Point the client at the address">
                                <Code label="MCP address" text={address} />
                                <p className="m-0 text-sm text-secondary">Any client that supports MCP over HTTP (streamable HTTP) works. The server speaks OAuth 2.1 with PKCE and dynamic client registration, as the MCP specification describes.</p>
                            </Step>
                            <Step n={2} title="Or send a bearer token instead">
                                <Code label="Authorization header" text="Authorization: Bearer <access token>" />
                                <p className="m-0 text-sm text-secondary">For a script that cannot open a browser. Use the access token this host was started with, and keep it out of shared files.</p>
                            </Step>
                        </>
                    ) : null}
                </ol>
            </div>
        </SettingsCard>
    );
}

interface ToolInfo {
    readonly name: string;
    readonly description?: string;
}

/** Ask this host's own MCP endpoint what it offers, with the browser's session: the same answer an agent gets, and proof the endpoint is up. */
function useEndpoint(address: string, enabled: boolean) {
    return useQuery({
        queryKey: ["mcp-endpoint", address],
        enabled,
        retry: false,
        queryFn: async ({ signal }) => {
            const started = performance.now();
            const response = await fetch(address, {
                method: "POST",
                headers: { "content-type": "application/json", accept: "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
                signal,
            });
            if (!response.ok) throw new Error(response.status === 401 ? "The host asked for a sign-in." : `The host answered ${response.status}.`);
            const body = (await response.json()) as { result?: { tools?: ToolInfo[] }; error?: { message?: string } };
            if (body.error) throw new Error(body.error.message ?? "The server refused the request.");
            return { tools: body.result?.tools ?? [], ms: Math.round(performance.now() - started) };
        },
    });
}

/** The first sentence of a tool's description: the rest is for the model. */
const firstSentence = (text: string | undefined): string | undefined => {
    const first = text?.split("\n")[0] ?? "";
    const cut = /^(.+?[.!?])(\s|$)/.exec(first)?.[1] ?? first;
    return cut.length > 140 ? `${cut.slice(0, 137)}...` : cut;
};

const ago = (t: number): string => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * How to give an agent, on this machine or any other, the PiKVM's screen, keyboard and mouse: this host's own MCP server
 * (docs/deploy-web.md, "MCP server"). The agent signs in with the browser the first time it connects; nothing is typed here.
 */
export function McpPage() {
    const servers = useServers();
    // Connected to a server, the agent talks to that server: it holds the PiKVM and does the sign-in. The app's own address is not it.
    const server = servers.data && !servers.data.localActive ? servers.data.items[0] : undefined;
    const address = `${server ? server.origin.replace(/\/+$/, "") : window.location.origin}/app/mcp`;
    const desktop = isDesktopApp() && !server;
    const session = useSession();
    const endpoint = useEndpoint(address, server === undefined);
    const listed = session.data?.signIn === true && session.data.method !== "device";
    const devices = useDevices(listed && !server);
    const revoke = useRevokeDevice();
    const agents = (devices.data ?? []).filter((d) => d.name.endsWith("(MCP)"));

    return (
        <SettingsPage title="MCP server" description="Give an agent the screen, keyboard and mouse of this PiKVM.">
            <SettingsSection title="Status">
                <SettingsCard>
                    {server ? (
                        <SettingRow
                            label={server.name || new URL(server.origin).host}
                            description="You are connected to this server, so agents use its MCP server. It holds the PiKVM and signs the agent in with your browser."
                        />
                    ) : (
                    <SettingRow
                            label={
                                <span>
                                    <StatusDot tone={endpoint.isError ? "danger" : endpoint.isSuccess ? "ok" : "idle"} />
                                    {endpoint.isError ? "Not reachable" : endpoint.isSuccess ? "Ready" : "Checking"}
                                </span>
                            }
                            description={
                                endpoint.isSuccess
                                    ? `Answered in ${endpoint.data.ms} ms with ${endpoint.data.tools.length} tools.`
                                    : endpoint.isError
                                      ? (endpoint.error as Error).message
                                      : "Asking the server what it offers."
                            }
                            control={
                                endpoint.isFetching ? (
                                    <Spinner />
                                ) : (
                                    <Button onClick={() => void endpoint.refetch()}>Test</Button>
                                )
                            }
                        />
                    )}
                    <div className="px-4 pb-4">
                        <Code label="MCP address" text={address} />
                    </div>
                </SettingsCard>
            </SettingsSection>

            <SettingsSection title="Connect an agent">
                <Setup address={address} desktop={desktop} remote={server !== undefined} />
            </SettingsSection>

            {!desktop && !server ? (
                <SettingsSection title="Connected agents" description="Agents you let in. Remove one and it stops working straight away.">
                    <SettingsCard>
                        {!listed ? (
                            <EmptyState title="Nothing to list here" description="Sign in to this host with a password, token or your identity provider to see the agents that signed in." />
                        ) : devices.isLoading ? (
                            <div className="grid place-items-center py-6">
                                <Spinner />
                            </div>
                        ) : agents.length === 0 ? (
                            <EmptyState title="No agent has signed in yet" description="When one connects through your browser it shows up here." />
                        ) : (
                            agents.map((agent) => (
                                <SettingRow
                                    key={agent.id}
                                    label={agent.name.replace(/ \(MCP\)$/, "")}
                                    description={`Allowed ${ago(agent.createdAt)}. Last used ${ago(agent.lastUsedAt)}.`}
                                    control={
                                        <Button variant="danger" disabled={revoke.isPending} onClick={() => revoke.mutate(agent.id)}>
                                            Remove
                                        </Button>
                                    }
                                />
                            ))
                        )}
                    </SettingsCard>
                </SettingsSection>
            ) : null}

            {!server ? <SettingsSection title="What an agent can do" description="The same tools the built-in chat uses.">
                <SettingsCard>
                    {endpoint.isSuccess && endpoint.data.tools.length > 0 ? (
                        endpoint.data.tools.map((tool) => (
                            <SettingRow key={tool.name} label={<code className="font-mono text-sm">{tool.name}</code>} description={firstSentence(tool.description)} />
                        ))
                    ) : (
                        <EmptyState title="The tool list is not available" description="It appears here once the server answers." />
                    )}
                </SettingsCard>
                <div className="mt-3">
                    <Notice tone="neutral">
                        Actions that need approval, such as typing risky commands or using power control, are refused for agents outside the chat, because nobody can be asked. A person using the mouse or keyboard takes control from the agent until they press Hand back.
                    </Notice>
                </div>
            </SettingsSection> : null}
        </SettingsPage>
    );
}
