/**
 * The app's server API, called through the contract's typed HttpApi client.
 *
 * Everything here is an Effect so failures are values with a name. The edge is
 * `runApi`: components and TanStack Query see a Promise that rejects with an `ApiFailure`
 * whose `message` is already fit to show a person, whatever layer failed (network, status,
 * decode). Nothing outside this file needs to know about HttpClientError or ParseError.
 */

import { FetchHttpClient, HttpApiClient, HttpClient, HttpClientError } from "@effect/platform";
import { type Macro, PikvmApi, type Settings, type SettingsPatch, type State } from "@pikvm/contracts/api";
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
            case "ParseError":
            case "HttpApiDecodeError":
                return Effect.succeed(
                    new ApiFailure({ message: "The server sent a reply this app does not understand." }),
                );
        }
    }
    return Effect.succeed(new ApiFailure({ message: "Something went wrong." }));
};

// Built per call: it is a few object allocations, and it reads the current global fetch,
// which the tests replace.
//
// Every non-2xx reply becomes a ResponseError before the client tries to decode it against
// the endpoint's declared errors. The server answers every failure with `{error: string}`,
// which is what the user needs to read; letting the client decode a 400 against its own
// framework error shape would turn "settings file is read-only" into a decode failure.
const makeClient = HttpApiClient.make(PikvmApi, { transformClient: HttpClient.filterStatusOk });

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
