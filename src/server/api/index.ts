/**
 * `/app/api/v1/*`: the implementation of the HttpApi declared in
 * packages/contracts. The definition lives there so the web app imports the
 * same one; this file only supplies what the server knows.
 */

import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { BadRequest, PikvmApi, type Features, type Macro, type Settings, type State } from "@pikvm/contracts/api";
import { Effect, Layer } from "effect";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MacroStore } from "../../macros";
import type { JigglerStatus } from "../../mouse-jiggler";
import type { PiKvmControl } from "../../pikvm-control";
import type { SettingsStore } from "../../settings";
import { serveWith } from "./web-handler";

export interface ApiDeps {
    control: PiKvmControl;
    settings: SettingsStore;
    macros: MacroStore;
    jigglerStatus: () => JigglerStatus;
    /** What this host serves; read per request because the harness proxy may
     *  be configured after the API is built. */
    features: () => Features;
    /** The app's version string. */
    version: string;
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
        features: deps.features(),
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
