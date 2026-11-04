/**
 * `/app/api/v1/*`: the implementation of the HttpApi declared in
 * packages/contracts. The definition lives there so the web app imports the
 * same one; this file only supplies what the server knows.
 */

import { HttpApiBuilder, HttpServer } from "@effect/platform";
import {
    BadRequest,
    Conflict,
    Forbidden,
    NotFound,
    PikvmApi,
    type Features,
    type Macro,
    type PikvmAdd,
    type PikvmEntry,
    type PikvmList,
    type PikvmPatch,
    type ServerList,
    type Settings,
    type State,
    type TargetConfig,
    type TargetPatch,
} from "@pikvm/contracts/api";
import { Effect, Layer } from "effect";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MacroStore } from "../../macros";
import type { JigglerStatus } from "../../mouse-jiggler";
import type { PiKvmControl } from "../../pikvm-control";
import type { SettingsStore } from "../../settings";
import { ServerAlreadySaved, ServerError, ServerNotFound } from "../../server-store";
import { TargetNotFound } from "../../target-store";
import type { ServerEditor } from "../sync";
import { serveWith } from "./web-handler";

/** What the desktop app offers for managing the PiKVMs it talks to. Absent on a host that pins it. */
export interface PikvmEditor {
    entries(): PikvmEntry[];
    /** Throws an Error whose message is fit to show, and never carries a password. */
    add(input: PikvmAdd): PikvmEntry;
    update(id: string, patch: PikvmPatch): PikvmEntry;
    remove(id: string): PikvmEntry[];
    setDefault(id: string): PikvmEntry[];
    activate(id: string): PikvmEntry[];
    /** The active PiKVM, for `/target`. */
    targetView(): { origin: string; username: string; passwordSet: boolean };
    /** Change the active PiKVM (or add the first one). The return value is not sent to a client. */
    save(change: TargetPatch): unknown;
}

export interface ApiDeps {
    control: PiKvmControl;
    settings: SettingsStore;
    macros: MacroStore;
    jigglerStatus: () => JigglerStatus;
    /** What this host serves; read per request because it can change while the
     *  server runs (the agent behind the Chat tab comes and goes). */
    features: () => Features | Promise<Features>;
    /** The app's version string. */
    version: string;
    /** Present where the host owns the PiKVM list (the desktop app). */
    pikvms?: PikvmEditor;
    /** Present where the host owns its state (the desktop app): the saved remote servers it may use. */
    servers?: ServerEditor;
}

/** The user-editable slice of the settings file. An allow-list on purpose:
 *  `accessToken` and the rest of the file must never be readable here, and a
 *  field added to the settings store stays private until it is named. */
function publicSettings(deps: ApiDeps): Settings {
    const s = deps.settings.get();
    return { keyboardLayout: s.keyboardLayout, jiggler: s.jiggler };
}

async function readState(deps: ApiDeps): Promise<State> {
    const target = await deps.control.proxyTarget();
    return {
        settings: publicSettings(deps),
        features: await deps.features(),
        jigglerStatus: deps.jigglerStatus(),
        pikvm: {
            origin: target.origin.origin,
            // The control core opens its event socket lazily and exposes no
            // connection state; having HID state means it is open and talking.
            link: deps.control.getHidState() ? "connected" : "unknown",
        },
        version: deps.version,
    };
}

function apiLayer(deps: ApiDeps) {
    const state = HttpApiBuilder.group(PikvmApi, "state", (handlers) =>
        handlers.handle("get", () => Effect.promise(() => readState(deps))),
    );

    const macros = HttpApiBuilder.group(PikvmApi, "macros", (handlers) =>
        handlers
            .handle("list", () => Effect.sync(() => ({ macros: deps.macros.list() })))
            .handle("replace", ({ payload }) => {
                // A body we cannot read as a list would wipe every macro and report
                // success; the store refuses it, and so do we, before it gets there.
                const list = "macros" in payload ? payload.macros : payload;
                return Effect.try({
                    try: () => ({ macros: deps.macros.replace(list) }),
                    catch: (err) => new BadRequest({ error: err instanceof Error ? err.message : "Invalid macros" }),
                });
            }),
    );

    const pinnedRefusal = () =>
        new Forbidden({ error: "This host sets the PiKVM in its own configuration, not here.", pinned: true });

    const serverPinned = () =>
        new Forbidden({ error: "This host keeps its saved server in its own configuration, not here.", pinned: true });

    /** Run a store call: an unknown id is a 404, anything else it refuses is a 400 with its own sentence. */
    const guarded = <A>(run: () => A) =>
        Effect.try({
            try: run,
            catch: (err) =>
                err instanceof TargetNotFound
                    ? new NotFound({ error: err.message, notFound: true })
                    : new BadRequest({ error: err instanceof Error ? err.message : "Invalid PiKVM" }),
        });

    /** Run a store call that only an unknown id can refuse. Anything else is a fault, not the caller's mistake. */
    const byId = <A>(run: () => A) =>
        Effect.try({ try: run, catch: (err) => err }).pipe(
            Effect.catchAll((err) =>
                err instanceof TargetNotFound
                    ? Effect.fail(new NotFound({ error: err.message, notFound: true }))
                    : Effect.die(err),
            ),
        );

    const target = HttpApiBuilder.group(PikvmApi, "target", (handlers) =>
        handlers
            .handle("get", () =>
                Effect.promise(async (): Promise<TargetConfig> => {
                    if (deps.pikvms) return { ...deps.pikvms.targetView(), editable: true };
                    const pinned = await deps.control.proxyTarget();
                    return { origin: pinned.origin.origin + "/", username: "", passwordSet: false, editable: false };
                }),
            )
            .handle("update", ({ payload }) => {
                const editor = deps.pikvms;
                if (!editor) return Effect.fail(pinnedRefusal());
                return Effect.try({
                    try: (): TargetConfig => {
                        editor.save(payload);
                        return { ...editor.targetView(), editable: true };
                    },
                    catch: (err) => new BadRequest({ error: err instanceof Error ? err.message : "Invalid address" }),
                });
            }),
    );

    /** The one PiKVM a pinned host has, shaped like a stored one. */
    const pinnedList = async (): Promise<PikvmList> => {
        const pinned = await deps.control.proxyTarget();
        return {
            items: [
                {
                    id: "pinned",
                    name: pinned.origin.host,
                    origin: pinned.origin.origin + "/",
                    username: "",
                    passwordSet: false,
                    isDefault: true,
                    active: true,
                },
            ],
            editable: false,
        };
    };

    const pikvms = HttpApiBuilder.group(PikvmApi, "pikvms", (handlers) =>
        handlers
            .handle("list", () =>
                Effect.promise(
                    async (): Promise<PikvmList> =>
                        deps.pikvms ? { items: deps.pikvms.entries(), editable: true } : await pinnedList(),
                ),
            )
            .handle("add", ({ payload }) => {
                const editor = deps.pikvms;
                return editor ? guarded(() => editor.add(payload)) : Effect.fail(pinnedRefusal());
            })
            .handle("update", ({ path, payload }) => {
                const editor = deps.pikvms;
                return editor ? guarded(() => editor.update(path.id, payload)) : Effect.fail(pinnedRefusal());
            })
            .handle("remove", ({ path }) => {
                const editor = deps.pikvms;
                return editor
                    ? byId((): PikvmList => ({ items: editor.remove(path.id), editable: true }))
                    : Effect.fail(pinnedRefusal());
            })
            .handle("setDefault", ({ path }) => {
                const editor = deps.pikvms;
                return editor
                    ? byId((): PikvmList => ({ items: editor.setDefault(path.id), editable: true }))
                    : Effect.fail(pinnedRefusal());
            })
            .handle("activate", ({ path }) => {
                const editor = deps.pikvms;
                return editor
                    ? byId((): PikvmList => ({ items: editor.activate(path.id), editable: true }))
                    : Effect.fail(pinnedRefusal());
            }),
    );

    const settings = HttpApiBuilder.group(PikvmApi, "settings", (handlers) =>
        handlers
            .handle("get", () => Effect.sync(() => publicSettings(deps)))
            .handle("update", ({ payload }) =>
                Effect.sync(() => {
                    deps.settings.patch({
                        ...(payload.keyboardLayout !== undefined ? { keyboardLayout: payload.keyboardLayout } : {}),
                        ...(payload.jiggler !== undefined ? { jiggler: payload.jiggler } : {}),
                    });
                    return publicSettings(deps);
                }),
            ),
    );

    /** A host that pins its state has no saved server: it is always this computer's own. */
    const pinnedServers: ServerList = { items: [], localActive: true, editable: false };

    /** A refusal the store words itself is a 400; anything else is a fault, not the caller's mistake. */
    const refused = <A>(run: () => Promise<A>) =>
        Effect.tryPromise({ try: run, catch: (err) => err }).pipe(
            Effect.catchAll((err) => {
                if (err instanceof ServerAlreadySaved) return Effect.fail(new Conflict({ error: err.message, alreadySaved: true }));
                return err instanceof ServerError ? Effect.fail(new BadRequest({ error: err.message })) : Effect.die(err);
            }),
        );

    /** As refused, and an unknown id is a 404. */
    const refusedOrMissing = <A>(run: () => Promise<A>) =>
        Effect.tryPromise({ try: run, catch: (err) => err }).pipe(
            Effect.catchAll((err) => {
                if (err instanceof ServerNotFound) return Effect.fail(new NotFound({ error: err.message, notFound: true }));
                if (err instanceof ServerError) return Effect.fail(new BadRequest({ error: err.message }));
                return Effect.die(err);
            }),
        );

    /** An unknown id is a 404; anything else is a fault. */
    const missing = <A>(run: () => A) =>
        Effect.try({ try: run, catch: (err) => err }).pipe(
            Effect.catchAll((err) =>
                err instanceof ServerNotFound ? Effect.fail(new NotFound({ error: err.message, notFound: true })) : Effect.die(err),
            ),
        );

    const servers = HttpApiBuilder.group(PikvmApi, "servers", (handlers) =>
        handlers
            .handle("list", () => Effect.sync((): ServerList => deps.servers?.list() ?? pinnedServers))
            .handle("add", ({ payload }) => {
                const editor = deps.servers;
                return editor ? refused(() => editor.add(payload)) : Effect.fail(serverPinned());
            })
            .handle("remove", ({ path }) => {
                const editor = deps.servers;
                return editor ? missing((): ServerList => editor.remove(path.id)) : Effect.fail(serverPinned());
            })
            .handle("use", ({ path }) => {
                const editor = deps.servers;
                return editor ? refusedOrMissing(() => editor.use(path.id)) : Effect.fail(serverPinned());
            })
            .handle("useLocal", () => {
                const editor = deps.servers;
                return editor ? Effect.sync((): ServerList => editor.useLocal()) : Effect.fail(serverPinned());
            }),
    );

    return HttpApiBuilder.api(PikvmApi).pipe(
        Layer.provide(state),
        Layer.provide(macros),
        Layer.provide(settings),
        Layer.provide(target),
        Layer.provide(pikvms),
        Layer.provide(servers),
    );
}

export interface Api {
    handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
    dispose(): Promise<void>;
}

export function createApi(deps: ApiDeps): Api {
    const { handler, dispose } = HttpApiBuilder.toWebHandler(Layer.mergeAll(apiLayer(deps), HttpServer.layerContext));
    return {
        handle: (req, res) => serveWith(handler, req, res),
        dispose,
    };
}
