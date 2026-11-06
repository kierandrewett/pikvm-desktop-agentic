import {
    Button,
    SettingRow,
    SettingsCard,
    SettingsPage,
    SettingsSection,
} from "@pikvm/chat-web/settings";
import type { SessionView } from "@pikvm/contracts/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSession } from "../../api/queries";

interface DeviceRow {
    readonly id: string;
    readonly name: string;
    readonly createdAt: number;
    readonly lastUsedAt: number;
}

const devicesKey = ["devices"] as const;

/** The desktop apps signed in to this host. Plain requests: the host answers them itself, they are not part of the app API. */
function useDevices(enabled: boolean) {
    return useQuery<readonly DeviceRow[]>({
        queryKey: devicesKey,
        enabled,
        queryFn: async ({ signal }) => {
            const response = await fetch("/app/api/v1/devices", { signal });
            if (!response.ok)
                throw new Error(`The host answered ${response.status}.`);
            return ((await response.json()) as { devices: DeviceRow[] })
                .devices;
        },
    });
}

function useRevokeDevice() {
    const queryClient = useQueryClient();
    return useMutation<void, Error, string>({
        mutationFn: async (id) => {
            const response = await fetch(`/app/api/v1/devices/${id}`, {
                method: "DELETE",
            });
            if (!response.ok)
                throw new Error(`The host answered ${response.status}.`);
        },
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: devicesKey }),
    });
}

/** How the request got in, in the words a person would use for it. */
const METHOD_WORDING: Record<NonNullable<SessionView["method"]>, string> = {
    token: "With the access token.",
    password: "With your password.",
    device: "From a signed-in desktop app.",
    oidc: "Through your identity provider.",
    bearer: "With a header credential.",
    basic: "With a header credential.",
};

/** Where an MCP client connects: this host's own MCP endpoint. */
function McpAddress() {
    const [copied, setCopied] = useState(false);
    const address = `${window.location.origin}/app/mcp`;
    return (
        <SettingsSection title="MCP server">
            <SettingsCard>
                <SettingRow
                    label="Address"
                    description={address}
                    control={
                        <Button
                            onClick={() => {
                                void navigator.clipboard.writeText(address).then(() => setCopied(true));
                            }}
                        >
                            {copied ? "Copied" : "Copy"}
                        </Button>
                    }
                />
                <SettingRow
                    label="Connect an agent"
                    description={`Add the address to any agent that supports MCP over HTTP. The agent opens this site to sign you in, and then shows up below until you revoke it. For example: claude mcp add --transport http pikvm ${address}`}
                />
            </SettingsCard>
        </SettingsSection>
    );
}

export function AccountPage() {
    const session = useSession();
    // A device cannot list the others, so the list is for a person signed in some other way.
    const listed =
        session.data?.signIn === true && session.data.method !== "device";
    const devices = useDevices(listed);
    const revoke = useRevokeDevice();

    if (session.data?.signIn !== true) {
        return (
            <SettingsPage title="Account">
                <SettingsSection>
                    <SettingsCard>
                        <SettingRow
                            label="No sign-in on this host"
                            description="This host does not sign users in. There is nothing to sign out of."
                        />
                    </SettingsCard>
                </SettingsSection>
            </SettingsPage>
        );
    }

    const { subject, method, canSignOut } = session.data;

    return (
        <SettingsPage title="Account" description="The sign-in for this host.">
            <SettingsSection>
                <SettingsCard>
                    <SettingRow
                        label={`Signed in as ${subject ?? "unknown"}`}
                        description={
                            method ? METHOD_WORDING[method] : undefined
                        }
                    />
                    {canSignOut ? (
                        <SettingRow
                            label="Sign out"
                            description="You must sign in again to use the app."
                            control={
                                <Button variant="danger" asChild>
                                    <a href="/app/logout">Sign out</a>
                                </Button>
                            }
                        />
                    ) : (
                        <SettingRow label="This sign-in has no session to end." />
                    )}
                </SettingsCard>
            </SettingsSection>
            <McpAddress />
            {listed && devices.data && devices.data.length > 0 ? (
                <SettingsSection title="Signed-in apps">
                    <SettingsCard>
                        {devices.data.map((device) => (
                            <SettingRow
                                key={device.id}
                                label={device.name}
                                description={`Signed in ${new Date(device.createdAt).toLocaleDateString()}, last used ${new Date(device.lastUsedAt).toLocaleDateString()}.`}
                                control={
                                    <Button
                                        variant="danger"
                                        disabled={revoke.isPending}
                                        onClick={() => revoke.mutate(device.id)}
                                    >
                                        Revoke
                                    </Button>
                                }
                            />
                        ))}
                    </SettingsCard>
                </SettingsSection>
            ) : null}
        </SettingsPage>
    );
}
