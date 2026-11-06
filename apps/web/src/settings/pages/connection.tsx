/**
 * Where the app's PiKVMs are kept. The switch is off: this app keeps its own PiKVMs and connects to the PiKVM itself.
 * It is on: the one saved server keeps them and connects for the app. A host that pins its state (a hosted build) shows
 * its PiKVM read-only, with no switch, action or write.
 */

import {
    Badge,
    Button,
    ConfirmDialog,
    Notice,
    SettingRow,
    SettingsCard,
    SettingsPage,
    SettingsSection,
    Switch,
} from "@pikvm/chat-web/settings";
import type { PikvmEntry, PikvmList, PikvmTarget, ServerEntry } from "@pikvm/contracts/api";
import { useState } from "react";
import type { ApiFailure } from "../../api/client";
import {
    useActivatePikvm,
    useAppState,
    usePikvms,
    useRemovePikvm,
    useRemoveServer,
    useServers,
    useSetDefaultPikvm,
    useUseLocalServer,
    useUseServer,
} from "../../api/queries";
import { reloadApp } from "../../host/reload";
import { ConnectForm } from "./connect-form";
import { KeepAwakeSection } from "./keep-awake";
import { LoadError } from "./load-error";
import { PikvmForm } from "./target-form";
import { StatusDot } from "./value";

const LINK: Record<PikvmTarget["link"], { text: string; tone: "ok" | "warn" | "danger" | "idle" }> = {
    connected: { text: "Connected", tone: "ok" },
    connecting: { text: "Connecting", tone: "warn" },
    offline: { text: "Offline", tone: "danger" },
    // The server opens the PiKVM event socket lazily, so "unknown" is "not yet", not "down".
    unknown: { text: "Not checked yet", tone: "idle" },
};

const SERVER_STATE: Record<ServerEntry["state"], { text: string; tone: "ok" | "danger" | "idle" }> = {
    unchecked: { text: "Not checked yet", tone: "idle" },
    ok: { text: "Reachable", tone: "ok" },
    unreachable: { text: "Cannot reach", tone: "danger" },
};

/** The live link. Only the PiKVM in use has one; the others say nothing. */
function LinkText({ link }: { readonly link: PikvmTarget["link"] | undefined }) {
    if (!link) return null;
    const { text, tone } = LINK[link];
    return (
        <span className="inline-flex items-center gap-1.5 text-sm text-secondary">
            <StatusDot tone={tone} />
            {text}
        </span>
    );
}

/** A dot and a word, so the state is not carried by colour alone. */
function ServerState({ state }: { readonly state: ServerEntry["state"] }) {
    const { text, tone } = SERVER_STATE[state];
    return (
        <span className="inline-flex items-center gap-1.5 text-sm text-secondary">
            <StatusDot tone={tone} />
            {text}
        </span>
    );
}

/**
 * One PiKVM. Its name and address, then what state it is in and the actions that change it. Each button's accessible
 * name is its visible words with the PiKVM's name in between, so a screen reader reads "Make Rack active", as a sighted
 * user would see it.
 */
function PikvmRow({
    entry,
    several,
    link,
    busy,
    onActivate,
    onDefault,
    onEdit,
    onRemove,
}: {
    readonly entry: PikvmEntry;
    /** More than one PiKVM is stored: only then are the default and the switcher worth showing. */
    readonly several: boolean;
    readonly link: PikvmTarget["link"] | undefined;
    readonly busy: boolean;
    readonly onActivate: () => void;
    readonly onDefault: () => void;
    readonly onEdit: () => void;
    readonly onRemove: () => void;
}) {
    return (
        <SettingRow
            id={`pikvm-${entry.id}`}
            label={
                <span className="flex flex-wrap items-center gap-2">
                    <span>{entry.name}</span>
                    {several && entry.isDefault ? <Badge>Default</Badge> : null}
                </span>
            }
            description={<span className="font-mono text-sm break-all text-secondary select-text">{entry.origin}</span>}
            control={
                <div className="flex flex-wrap items-center justify-end gap-2">
                    {entry.active ? <LinkText link={link} /> : <span className="text-sm text-secondary">Not in use</span>}
                    {several && !entry.active ? (
                        <Button variant="secondary" disabled={busy} onClick={onActivate} aria-label={`Make ${entry.name} active`}>
                            Make active
                        </Button>
                    ) : null}
                    {several && !entry.isDefault ? (
                        <Button variant="secondary" disabled={busy} onClick={onDefault} aria-label={`Make ${entry.name} the default`}>
                            Make default
                        </Button>
                    ) : null}
                    <Button variant="ghost" disabled={busy} onClick={onEdit} aria-label={`Edit ${entry.name}`}>
                        Edit
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={onRemove} aria-label={`Remove ${entry.name}`}>
                        Remove
                    </Button>
                </div>
            }
        />
    );
}

/**
 * The PiKVMs the app controls, and the form that adds or edits one. `sentTo` names the server when the list is the
 * server's: its password lines then say the password is sent there.
 */
function PikvmPanel({
    data,
    link,
    sentTo,
    description,
}: {
    readonly data: PikvmList;
    readonly link: PikvmTarget["link"] | undefined;
    readonly sentTo?: string | undefined;
    readonly description?: string | undefined;
}) {
    const activate = useActivatePikvm();
    const setDefault = useSetDefaultPikvm();
    const remove = useRemovePikvm();
    /** The form on screen: "add", the id of the PiKVM being edited, or nothing. */
    const [form, setForm] = useState<string | null>(null);
    /** The PiKVM the user is being asked to remove. */
    const [asking, setAsking] = useState<PikvmEntry | null>(null);

    const { items } = data;
    const several = items.length > 1;
    const busy = activate.isPending || setDefault.isPending || remove.isPending;
    const failure = activate.error ?? setDefault.error ?? remove.error;
    const editing = items.find((item) => item.id === form);
    const close = () => setForm(null);

    if (items.length === 0) {
        return (
            <SettingsSection
                title="Add a PiKVM"
                description={description ?? "Enter the address of the PiKVM this app should control. The first one added is the one in use."}
            >
                <PikvmForm key="first" sentTo={sentTo} onDone={close} />
            </SettingsSection>
        );
    }

    return (
        <>
            <SettingsSection title="PiKVMs" description={description}>
                <SettingsCard>
                    {items.map((entry) => (
                        <PikvmRow
                            key={entry.id}
                            entry={entry}
                            several={several}
                            link={link}
                            busy={busy}
                            onActivate={() => activate.mutate(entry.id, { onSuccess: () => reloadApp() })}
                            onDefault={() => setDefault.mutate(entry.id)}
                            onEdit={() => setForm(entry.id)}
                            onRemove={() => setAsking(entry)}
                        />
                    ))}
                </SettingsCard>
                {failure ? (
                    <p role="alert" className="text-sm text-danger">
                        Could not change the PiKVM: {failure.message}
                    </p>
                ) : null}
                {form === null ? (
                    <div>
                        <Button variant="secondary" onClick={() => setForm("add")}>
                            Add a PiKVM
                        </Button>
                    </div>
                ) : null}
            </SettingsSection>
            {form === "add" ? (
                <SettingsSection title="Add a PiKVM">
                    <PikvmForm key="add" sentTo={sentTo} onDone={close} onCancel={close} />
                </SettingsSection>
            ) : editing ? (
                <SettingsSection title={`Edit ${editing.name}`}>
                    <PikvmForm key={editing.id} entry={editing} sentTo={sentTo} onDone={close} onCancel={close} />
                </SettingsSection>
            ) : null}
            <ConfirmDialog
                open={asking !== null}
                onOpenChange={(open) => {
                    if (!open) setAsking(null);
                }}
                title={asking ? `Remove ${asking.name}?` : "Remove this PiKVM?"}
                description={
                    asking?.active
                        ? "This is the one in use. The app reloads after it is removed. Its address and stored password are deleted."
                        : "Its address and stored password are deleted from this app."
                }
                confirmLabel="Remove PiKVM"
                danger
                onConfirm={() => {
                    const entry = asking;
                    if (!entry) return;
                    remove.mutate(entry.id, {
                        onSuccess: () => {
                            if (entry.active) reloadApp();
                        },
                    });
                }}
            />
        </>
    );
}

/** What a host that pins its PiKVM says, in place of the list. */
const PINNED_LINE = "The PiKVM is set by the host. Change it in the host's settings.";
/** What a server says about its own PiKVM when this app is connected to it. */
const SERVER_OWNS_LINE = "This server sets its own PiKVM. Change it in the server's settings.";

/**
 * A PiKVM list the server owns: its entries, read-only, with no add, edit, remove or default. The one line says where it
 * is changed, and only shows while this app is connected to that server.
 */
function ReadOnlyPikvms({
    items,
    link,
    inUse,
}: {
    readonly items: ReadonlyArray<PikvmEntry>;
    readonly link: PikvmTarget["link"] | undefined;
    readonly inUse: boolean;
}) {
    return (
        <SettingsSection title="PiKVMs" description={inUse ? "On this server." : undefined}>
            <SettingsCard>
                {items.map((entry) => (
                    <SettingRow
                        key={entry.id}
                        label={entry.name}
                        description={<span className="font-mono text-sm break-all text-secondary select-text">{entry.origin}</span>}
                        control={entry.active ? <LinkText link={link} /> : <span className="text-sm text-secondary">Not in use</span>}
                    />
                ))}
            </SettingsCard>
            {inUse ? <p className="text-sm text-secondary">{SERVER_OWNS_LINE}</p> : null}
        </SettingsSection>
    );
}

/** The saved server, with its state and the one action that forgets it. */
function ServerRow({
    server,
    busy,
    onForget,
}: {
    readonly server: ServerEntry;
    readonly busy: boolean;
    readonly onForget: () => void;
}) {
    return (
        <SettingsCard>
            <SettingRow
                label={server.origin}
                control={
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <ServerState state={server.state} />
                        <Button variant="secondary" disabled={busy} onClick={onForget}>
                            Forget this server
                        </Button>
                    </div>
                }
            />
        </SettingsCard>
    );
}

export function ConnectionPage() {
    const state = useAppState();
    const list = usePikvms();
    const servers = useServers();
    const useServer = useUseServer();
    const useLocal = useUseLocalServer();
    const remove = useRemoveServer();
    /** The switch was turned on while no server is saved: the connect form is shown until one is in use. */
    const [turnedOn, setTurnedOn] = useState(false);
    const [forgetting, setForgetting] = useState(false);
    const [switchError, setSwitchError] = useState("");

    const retry = () => {
        void state.refetch();
        void list.refetch();
        void servers.refetch();
    };

    if (servers.error) {
        return (
            <SettingsPage title="Connection">
                <LoadError message={servers.error.message} onRetry={retry} />
            </SettingsPage>
        );
    }

    const serverList = servers.data;
    // The page handles one server: the first saved one.
    const saved = serverList?.items[0];
    const inUse = serverList !== undefined && !serverList.localActive;
    const on = inUse || turnedOn;
    const connected = inUse ? saved : undefined;
    const unreachable = connected?.state === "unreachable";
    const showingForm = on && !inUse;
    const busy = useServer.isPending || useLocal.isPending || remove.isPending;
    /**
     * A write failed, and the lists on screen may be stale: the saved server can have been forgotten elsewhere. Reload
     * both lists first. A 404 with no saved server left means the connect form is the answer, so no error is shown.
     */
    const fail = (error: ApiFailure): void => {
        void Promise.all([servers.refetch(), list.refetch()]).then(([refreshed]) => {
            if (error.status === 404 && refreshed.data?.items.length === 0) {
                setSwitchError("");
                setTurnedOn(true);
                return;
            }
            setSwitchError(error.message);
        });
    };

    // The server in use decides where the PiKVMs and settings come from, so the app reloads onto it.
    const toggle = (next: boolean) => {
        setSwitchError("");
        if (next) {
            if (saved) useServer.mutate(saved.id, { onSuccess: () => reloadApp(), onError: fail });
            else setTurnedOn(true);
        } else if (inUse) {
            useLocal.mutate(undefined, { onSuccess: () => reloadApp(), onError: fail });
        } else {
            setTurnedOn(false);
        }
    };

    const failed = unreachable ? undefined : (state.error ?? list.error);
    if (failed) {
        return (
            <SettingsPage title="Connection">
                <LoadError message={failed.message} onRetry={retry} />
            </SettingsPage>
        );
    }

    const data = list.data;
    if (!serverList || (!data && !unreachable)) {
        return (
            <SettingsPage title="Connection" description="The PiKVM this app controls.">
                <p role="status" className="text-base text-secondary">
                    Loading
                </p>
            </SettingsPage>
        );
    }

    const link = state.data?.pikvm.link;

    if (!serverList.editable) {
        const pinned = data?.items[0];
        return (
            <SettingsPage title="Connection" description="The PiKVM this app is connected to.">
                {pinned ? (
                    <SettingsSection>
                        <SettingsCard>
                            <SettingRow label={pinned.name} description={pinned.origin} control={<LinkText link={link} />} />
                        </SettingsCard>
                    </SettingsSection>
                ) : null}
                <p className="max-w-prose text-base text-secondary">{PINNED_LINE}</p>
                <KeepAwakeSection />
            </SettingsPage>
        );
    }

    return (
        <SettingsPage title="Connection" description="The PiKVM this app controls.">
            <SettingsCard>
                <SettingRow
                    label="Use a server"
                    description="Off: this app keeps its own settings and PiKVMs and connects to the PiKVM itself. On: a server keeps them and connects to the PiKVM for you."
                    control={<Switch checked={on} disabled={busy} label="Use a server" onChange={toggle} />}
                />
            </SettingsCard>
            {switchError ? <Notice tone="danger">Could not change the server: {switchError}</Notice> : null}
            {connected ? <ServerRow server={connected} busy={busy} onForget={() => setForgetting(true)} /> : null}
            {showingForm ? (
                <SettingsSection title="Server">
                    <SettingsCard>
                        <ConnectForm saved={saved} />
                    </SettingsCard>
                </SettingsSection>
            ) : unreachable ? (
                <SettingsSection title="PiKVMs" description="On this server.">
                    <Notice tone="danger">Cannot reach the server.</Notice>
                </SettingsSection>
            ) : data?.editable === false ? (
                <ReadOnlyPikvms items={data.items} link={link} inUse={inUse} />
            ) : data ? (
                <PikvmPanel
                    data={data}
                    link={link}
                    sentTo={inUse ? "the server" : undefined}
                    description={inUse ? "On this server." : undefined}
                />
            ) : null}
            {data && !showingForm ? <KeepAwakeSection /> : null}
            <ConfirmDialog
                open={forgetting}
                onOpenChange={(open) => {
                    if (!open) setForgetting(false);
                }}
                title="Forget this server?"
                description="This app forgets its address and access token and goes back to its own settings and PiKVMs. Nothing on the server is deleted."
                confirmLabel="Forget server"
                danger
                onConfirm={() => {
                    if (!connected) return;
                    setForgetting(false);
                    setSwitchError("");
                    remove.mutate(connected.id, { onSuccess: () => reloadApp(), onError: fail });
                }}
            />
        </SettingsPage>
    );
}
