/**
 * The app's server API, called through the contract's typed HttpApi client.
 *
 * Everything here is an Effect so failures are values with a name. The edge is
 * `runApi`: components and TanStack Query see a Promise that rejects with an `ApiFailure`
 * whose `message` is already fit to show a person, whatever layer failed (network, status,
 * decode). Nothing outside this file needs to know about HttpClientError or ParseError.
 */

import { FetchHttpClient, HttpApiClient, HttpClient, HttpClientError, HttpClientRequest } from "@effect/platform";
import {
    type Macro,
    type PikvmAdd,
    PikvmApi,
    type PikvmEntry,
    type PikvmList,
    type PikvmPatch,
    type ServerAdd,
    type ServerEntry,
    type ServerList,
    type Settings,
    type SettingsPatch,
    type State,
} from "@pikvm/contracts/api";
import { Cause, Data, Effect, Exit, Option } from "effect";

export class ApiFailure extends Data.TaggedError("ApiFailure")<{
    readonly message: string;
    readonly status?: number;
}> {}

/** The `error` field every error body from this API carries. */
const bodyError = (body: unknown): string | undefined => {
    if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
    const value = body.error;
    return typeof value === "string" && value !== "" ? value : undefined;
};

/** Turn any failure from the client into one `ApiFailure` with a readable message. */
const describe = (error: unknown): Effect.Effect<ApiFailure> => {
    if (error instanceof ApiFailure) return Effect.succeed(error);
    if (HttpClientError.isHttpClientError(error)) {
        if (error._tag === "ResponseError") {
            const { response } = error;
            return Effect.map(
                Effect.orElseSucceed(response.json, () => undefined),
                (body) =>
                    new ApiFailure({
                        message: bodyError(body) ?? `The server answered ${response.status}.`,
                        status: response.status,
                    }),
            );
        }
        return Effect.succeed(new ApiFailure({ message: "Cannot reach the app server." }));
    }
    if (typeof error === "object" && error !== null && "_tag" in error) {
        switch (error._tag) {
            case "BadRequest":
                return Effect.succeed(
                    new ApiFailure({ message: bodyError(error) ?? "The server refused that change.", status: 400 }),
                );
            case "Forbidden":
                return Effect.succeed(
                    new ApiFailure({ message: bodyError(error) ?? "This host does not allow that.", status: 403 }),
                );
            case "ParseError":
            case "HttpApiDecodeError":
                return Effect.succeed(
                    new ApiFailure({ message: "The server sent a reply this app does not understand." }),
                );
        }
    }
    return Effect.succeed(new ApiFailure({ message: "Something went wrong." }));
};

/* The server refuses a write that is not marked as JSON (a cross-site page can send a bodyless POST without a
 * preflight, so the mark is what keeps it same-origin). The client marks a write that has a body by itself; the
 * bodyless ones (activate, remove a PiKVM) it leaves unmarked, so mark them here. */
const markWrites = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.mapRequest(client, (request) =>
        request.body._tag === "Empty" && request.method !== "GET" && request.method !== "HEAD"
            ? HttpClientRequest.setHeader(request, "content-type", "application/json")
            : request,
    );

// Built per call: it is a few object allocations, and it reads the current global fetch,
// which the tests replace.
//
// Every non-2xx reply becomes a ResponseError before the client tries to decode it against
// the endpoint's declared errors. The server answers every failure with `{error: string}`,
// which is what the user needs to read; letting the client decode a 400 against its own
// framework error shape would turn "settings file is read-only" into a decode failure.
const makeClient = HttpApiClient.make(PikvmApi, {
    transformClient: (client) => HttpClient.filterStatusOk(markWrites(client)),
});

const withClient = <A, E>(
    use: (client: Effect.Effect.Success<typeof makeClient>) => Effect.Effect<A, E>,
): Effect.Effect<A, ApiFailure> =>
    makeClient.pipe(
        Effect.flatMap(use),
        Effect.provide(FetchHttpClient.layer),
        Effect.catchAll((error) => Effect.flatMap(describe(error), Effect.fail)),
    );

export const getState = (): Effect.Effect<State, ApiFailure> => withClient((client) => client.state.get());

export const patchSettings = (patch: SettingsPatch): Effect.Effect<Settings, ApiFailure> =>
    withClient((client) => client.settings.update({ payload: patch }));

export const listMacros = (): Effect.Effect<ReadonlyArray<Macro>, ApiFailure> =>
    withClient((client) => Effect.map(client.macros.list(), (reply) => reply.macros));

/**
 * Run an API effect as a Promise that rejects with the `ApiFailure` itself, not Effect's
 * FiberFailure wrapper, so `error.message` is what TanStack Query hands to the UI.
 */
export const runApi = async <A>(effect: Effect.Effect<A, ApiFailure>, signal?: AbortSignal): Promise<A> => {
    const exit = await Effect.runPromiseExit(effect, signal ? { signal } : undefined);
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) throw failure.value;
    // Interrupted (the caller aborted) or a defect: not something to show the user.
    throw new ApiFailure({ message: "The request was cancelled." });
};

/**
 * Replace the whole macro list. The server keeps what it can read and returns that, so what a
 * caller holds afterwards is what is stored, not what it sent.
 */
export const replaceMacros = (macros: ReadonlyArray<unknown>): Effect.Effect<ReadonlyArray<Macro>, ApiFailure> =>
    withClient((client) => Effect.map(client.macros.replace({ payload: { macros: [...macros] } }), (reply) => reply.macros));

export const listPikvms = (): Effect.Effect<PikvmList, ApiFailure> => withClient((client) => client.pikvms.list());

/** The password in an add or a patch is write-only: nothing in any reply carries it back. */
export const addPikvm = (payload: PikvmAdd): Effect.Effect<PikvmEntry, ApiFailure> =>
    withClient((client) => client.pikvms.add({ payload }));

export const updatePikvm = (id: string, payload: PikvmPatch): Effect.Effect<PikvmEntry, ApiFailure> =>
    withClient((client) => client.pikvms.update({ path: { id }, payload }));

export const removePikvm = (id: string): Effect.Effect<PikvmList, ApiFailure> =>
    withClient((client) => client.pikvms.remove({ path: { id } }));

export const setDefaultPikvm = (id: string): Effect.Effect<PikvmList, ApiFailure> =>
    withClient((client) => client.pikvms.setDefault({ path: { id } }));

export const activatePikvm = (id: string): Effect.Effect<PikvmList, ApiFailure> =>
    withClient((client) => client.pikvms.activate({ path: { id } }));

export const listServers = (): Effect.Effect<ServerList, ApiFailure> => withClient((client) => client.servers.list());

/** The token is write-only: no reply carries it back, only `tokenSet`. The server is probed before it is saved. */
export const addServer = (payload: ServerAdd): Effect.Effect<ServerEntry, ApiFailure> =>
    withClient((client) => client.servers.add({ payload }));

export const removeServer = (id: string): Effect.Effect<ServerList, ApiFailure> =>
    withClient((client) => client.servers.remove({ path: { id } }));

/** Makes a saved server the one in use. Adding a server does not do this; the user presses Use. */
export const switchServer = (id: string): Effect.Effect<ServerList, ApiFailure> =>
    withClient((client) => client.servers.use({ path: { id } }));

/** Makes This computer's server the one in use. */
export const switchToThisComputer = (): Effect.Effect<ServerList, ApiFailure> =>
    withClient((client) => client.servers.useLocal());
