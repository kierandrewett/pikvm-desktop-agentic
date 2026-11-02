/**
 * `/app/api/v1/*`: the implementation of the HttpApi declared in
 * packages/contracts. The definition lives there so the web app imports the
 * same one; this file only supplies what the server knows.
 */

import { HttpApiBuilder, HttpServer } from "@effect/platform";
import {
    BadRequest,
    Forbidden,
    PikvmApi,
    type Features,
    type Macro,
    type Settings,
    type State,
    type TargetConfig,
} from "@pikvm/contracts/api";
import { Effect, Layer } from "effect";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MacroStore } from "../../macros";
import type { JigglerStatus } from "../../mouse-jiggler";
import type { PiKvmControl } from "../../pikvm-control";
import type { SettingsStore } from "../../settings";
import { serveWith } from "./web-handler";

/** What the desktop app offers for changing the PiKVM it talks to. Absent on a host that pins it. */
export interface TargetEditor {
    view(): { origin: string; username: string; passwordSet: boolean };
    /** Validates, stores and applies. Throws an Error whose message is fit to show; never returns the password. */
    save(change: { origin?: string | undefined; username?: string | undefined; password?: string | undefined }): {
        origin: string;
        username: string;
        passwordSet: boolean;
    };
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
    /** Present where the host owns the PiKVM setting (the desktop app). */
    target?: TargetEditor;
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

    const target = HttpApiBuilder.group(PikvmApi, "target", (handlers) =>
        handlers
            .handle("get", () =>
                Effect.promise(async (): Promise<TargetConfig> => {
                    if (deps.target) return { ...deps.target.view(), editable: true };
                    const pinned = await deps.control.proxyTarget();
                    return { origin: pinned.origin.origin + "/", username: "", passwordSet: false, editable: false };
                }),
            )
            .handle("update", ({ payload }) => {
                const editor = deps.target;
                if (!editor) {
                    return Effect.fail(
                        new Forbidden({ error: "This host sets the PiKVM in its own configuration, not here.", pinned: true }),
                    );
                }
                return Effect.try({
                    try: (): TargetConfig => ({ ...editor.save(payload), editable: true }),
                    catch: (err) => new BadRequest({ error: err instanceof Error ? err.message : "Invalid address" }),
                });
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
                    // The control core types with the layout it was told; the
                    // stored value alone would not take effect until a restart.
                    if (payload.keyboardLayout) deps.control.setLayout(payload.keyboardLayout, { source: "user" });
                    return publicSettings(deps);
                }),
            ),
    );

    return HttpApiBuilder.api(PikvmApi).pipe(
        Layer.provide(state),
        Layer.provide(macros),
        Layer.provide(settings),
        Layer.provide(target),
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
