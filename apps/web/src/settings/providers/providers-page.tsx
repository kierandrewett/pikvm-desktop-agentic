import { useQueryClient } from "@tanstack/react-query";
import { Group, InlineError, Row } from "../../ui/controls";
import { AddProvider } from "./add-provider";
import { CliRow } from "./cli-row";
import { HarnessError } from "./harness-api";
import { KeyRow } from "./key-row";
import { useCliAuth, useProviderCatalog, useProviderKeys, useProviders } from "./queries";

/** Why a list could not load, as a row: a refusal of the feature is not a broken harness. */
function Unavailable({ title, error }: { title: string; error: HarnessError }) {
    return (
        <Group title={title}>
            <InlineError>{error.message}</InlineError>
        </Group>
    );
}

/**
 * Model providers: API keys (write-only) and CLI account sign-in, all held by the agent
 * harness. The harness runs with the desktop app, so a phone or web host reaches it through
 * the host's proxy; when it is not running there is nothing here to manage.
 */
export function ProvidersPage() {
    const queryClient = useQueryClient();
    const providers = useProviders();
    const reachable = providers.isSuccess;
    const keys = useProviderKeys(reachable);
    const cli = useCliAuth(reachable);
    const catalog = useProviderCatalog(reachable);

    if (providers.isPending) {
        return (
            <Group title="Providers">
                <Row label="Loading" />
            </Group>
        );
    }

    if (providers.isError) {
        const gone = providers.error.unreachable;
        return (
            <Group
                title="Providers"
                footer={
                    gone
                        ? "Providers are held by the agent harness, which runs with the desktop app. Open the app on that computer and try again."
                        : undefined
                }
            >
                <Row
                    label={gone ? "The agent harness is not reachable" : "Could not load providers"}
                    hint={gone ? "Nothing can be set up until it is running." : providers.error.message}
                >
                    <button type="button" className="btn" onClick={() => void providers.refetch()}>
                        Try again
                    </button>
                </Row>
            </Group>
        );
    }

    const health = providers.data;
    const existing = Object.keys(health);

    return (
        <>
            {cli.isError ? (
                <Unavailable title="Sign in with an account" error={cli.error} />
            ) : (
                <Group
                    title="Sign in with an account"
                    footer="Sign-in is done by each tool's own login. The harness never sees or stores its tokens."
                >
                    {cli.data ? (
                        cli.data.map((status) => <CliRow key={status.cli} status={status} />)
                    ) : (
                        <Row label="Loading" />
                    )}
                </Group>
            )}

            {keys.isError ? (
                <Unavailable title="API keys" error={keys.error} />
            ) : (
                <Group
                    title="API keys"
                    footer="Keys are write-only. They are stored on the machine running the harness, outside its config, and cannot be read back here."
                >
                    {keys.data ? (
                        keys.data.length === 0 ? (
                            <Row label="No API providers yet" hint="Add one below." />
                        ) : (
                            keys.data.map((entry) => <KeyRow key={entry.alias} entry={entry} health={health[entry.alias]} />)
                        )
                    ) : (
                        <Row label="Loading" />
                    )}
                </Group>
            )}

            <Group title="Add">
                {catalog.isError ? (
                    <InlineError>Could not load the provider list: {catalog.error.message}</InlineError>
                ) : catalog.data ? (
                    <AddProvider catalog={catalog.data} existingAliases={existing} />
                ) : (
                    <Row label="Loading" />
                )}
            </Group>

            <div className="px-4">
                <button
                    type="button"
                    className="btn"
                    onClick={() => void queryClient.invalidateQueries({ queryKey: ["harness"] })}
                >
                    Refresh
                </button>
            </div>
        </>
    );
}
