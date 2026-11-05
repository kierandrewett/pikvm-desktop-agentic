/**
 * Remote servers: this app can use a saved PiKVM Desktop server instead of its own.
 *
 *   - `editor` is what `/servers` offers: `add` probes a server with its token and saves it (not in use yet); `use`
 *     probes it again and, when it answers, makes it the one in use; `useLocal` gives back this computer's own server;
 *     `remove` forgets a saved server and its token.
 *   - Each server holds its own settings, macros, PiKVMs and chats. Nothing is merged or copied between them.
 *   - While a remote server is in use, `forwarder` sends every request that is not local-only to it (forward.ts): the
 *     server runs the agent, the screen watch and the PiKVM. `connected()` tells the rest of this process to stand down
 *     (the idle jiggler).
 *
 * The token stays in this process. Nothing here returns it, and every error is a fixed sentence.
 */

import type { ServerAdd, ServerEntry, ServerList } from "@pikvm/contracts/api";
import { hostname } from "node:os";
import { ServerAlreadySaved, ServerStore } from "../../server-store";
import { createForwarder, type Forwarder } from "./forward";
import { probeServer, revokeDeviceToken } from "./remote";
import { createBrowserSignIn, type SignInStatus } from "./sign-in";
import type { LiveConnections } from "../live";
import type { Probe } from "../../server-store";

/** What `/servers` needs. Absent where the host owns its state (a hosted build). */
export interface ServerEditor {
    list(): ServerList;
    /** Throws a ServerError whose message is fit to show; never the token. */
    add(input: ServerAdd): Promise<ServerEntry>;
    use(id: string): Promise<ServerList>;
    useLocal(): ServerList;
    remove(id: string): ServerList;
    /** Starts signing in to a server with the browser: the address to open, and an id to ask about. Throws a ServerError whose message is fit to show. */
    signIn(input: { origin: string; name?: string | undefined }): Promise<{ id: string; url: string }>;
    /** Where a sign-in is. Throws ServerNotFound for an id that is not one. */
    signInStatus(id: string): SignInStatus;
    signInCancel(id: string): void;
}

export interface ServerSyncDeps {
    /** The folder `servers.json` and its token file live in. */
    dir: string;
    /** Checks a server answers its token. Defaults to the real probe; tests pass a fake remote's. */
    probe?: Probe;
    /** The sockets and event streams this process serves itself: ended when the server in use changes. */
    live: LiveConnections;
}

export interface ServerSync {
    editor: ServerEditor;
    forwarder: Forwarder;
    /** True while a remote server is in use: this process forwards to it and stands its own loops down. */
    connected(): boolean;
}

export function createServerSync(deps: ServerSyncDeps): ServerSync {
    const store = new ServerStore(deps.dir);
    const browserSignIn = createBrowserSignIn({
        save: (input) => store.add(input, deps.probe ?? probeServer),
        ensureRoom: () => {
            if (store.list().items.length > 0) throw new ServerAlreadySaved();
        },
        forget: (id) => {
            store.remove(id);
        },
        deviceName: () => `${hostname()} (PiKVM Desktop)`,
    });
    const probe = deps.probe ?? probeServer;
    const forwarder = createForwarder({
        connection: () => store.connection(),
        reached: (id, ok) => store.reached(id, ok),
    });

    /* A change of the server in use ends what is open to the old one: the relays to it, and the sockets and event
     * streams served here, so each page reconnects and the new route decides where it goes. */
    const currentId = (): string | null => store.connection()?.id ?? null;
    const retarget = (before: string | null): void => {
        if (currentId() === before) return;
        if (before !== null) forwarder.closeFor(before);
        deps.live.closeAll();
    };
    const editor: ServerEditor = {
        list: () => ({ ...store.list(), editable: true }),
        add: (input) => store.add(input, probe),
        use: async (id) => {
            const before = currentId();
            try {
                return { ...(await store.use(id, probe)), editable: true };
            } finally {
                retarget(before);
            }
        },
        useLocal: () => {
            const before = currentId();
            try {
                return { ...store.useLocal(), editable: true };
            } finally {
                retarget(before);
            }
        },
        remove: (id) => {
            const before = currentId();
            const credentials = store.credentials(id);
            try {
                return { ...store.remove(id), editable: true };
            } finally {
                retarget(before);
                // A device token made by a browser sign-in is told to the server to stop, so forgetting is more than deleting a file.
                if (credentials?.token.startsWith("pkd_")) void revokeDeviceToken(credentials);
            }
        },
        signIn: (input) => browserSignIn.start(input),
        signInStatus: (id) => browserSignIn.status(id),
        signInCancel: (id) => browserSignIn.cancel(id),
    };
    return {
        editor,
        forwarder,
        connected: () => store.connection() !== null,
    };
}
