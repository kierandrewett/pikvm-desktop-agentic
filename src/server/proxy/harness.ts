/**
 * The Chat tab's way to an agent, for the headless web host.
 *
 * Two upstreams can answer `/app/harness/*`, and exactly one is ever chosen,
 * from the environment, by `resolveHarnessUpstream`:
 *
 *   harness   PIKVM_HARNESS_URL + PIKVM_HARNESS_TOKEN: a harness of its own (the
 *             deploy/agent sidecar). The app prefix is stripped and the harness's
 *             operator capability is attached.
 *   desktop   PIKVM_DESKTOP_URL + PIKVM_DESKTOP_TOKEN: the desktop app's console
 *             server, which mounts the harness at the same path and attaches the
 *             operator capability itself. The path is forwarded whole and the
 *             desktop's access token is attached.
 *
 * Either way the credential is attached here, server-side; no request can choose
 * where it goes, and the browser never holds it.
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { endpointIsTls, endpointRequestOptions, parseEndpoint } from "../../endpoint";
import { WORKSPACE_HEADER } from "../auth";
import { createDaemonProxy } from "./daemon";

/** Where the app's harness routes live on this host. */
export const HARNESS_PREFIX = "/app/harness";

/** The harness refuses an operator token shorter than this; saying so here
 *  turns a crash loop in a sidecar into a message at the web host's start. */
const HARNESS_TOKEN_MIN = 32;

export interface HarnessUpstream {
    kind: "harness" | "desktop";
    /** A bare origin, no trailing slash. */
    origin: string;
    /** Attached to every forwarded request. */
    token: string;
    /** Stripped from the request path before forwarding. */
    prefix: string;
}

function bareOrigin(name: string, value: string): string {
    try {
        const u = new URL(value);
        if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
            throw new Error("not an origin");
        }
        return u.origin;
    } catch {
        throw new Error(`${name} must be a bare origin like http://host:47616, not ${value}`);
    }
}

/** Decide the upstream from `env`. Null when neither is configured; throws an
 *  Error fit to show an operator when the configuration is wrong. */
export function resolveHarnessUpstream(env: Record<string, string | undefined>): HarnessUpstream | null {
    const get = (name: string): string => (env[name] ?? "").trim();
    const harnessUrl = get("PIKVM_HARNESS_URL");
    const harnessToken = get("PIKVM_HARNESS_TOKEN");
    const desktopUrl = get("PIKVM_DESKTOP_URL");
    const desktopToken = get("PIKVM_DESKTOP_TOKEN");

    if (!!harnessUrl !== !!harnessToken) throw new Error("PIKVM_HARNESS_URL and PIKVM_HARNESS_TOKEN go together");
    if (!!desktopUrl !== !!desktopToken) throw new Error("PIKVM_DESKTOP_URL and PIKVM_DESKTOP_TOKEN go together");
    if (harnessUrl && desktopUrl) {
        throw new Error("PIKVM_HARNESS_URL and PIKVM_DESKTOP_URL are two ways to reach an agent; set only one");
    }

    if (harnessUrl) {
        const origin = bareOrigin("PIKVM_HARNESS_URL", harnessUrl);
        if (harnessToken.length < HARNESS_TOKEN_MIN) {
            throw new Error(`PIKVM_HARNESS_TOKEN must be at least ${HARNESS_TOKEN_MIN} characters (the harness rejects shorter)`);
        }
        return { kind: "harness", origin, token: harnessToken, prefix: HARNESS_PREFIX };
    }
    if (desktopUrl) {
        return { kind: "desktop", origin: bareOrigin("PIKVM_DESKTOP_URL", desktopUrl), token: desktopToken, prefix: "" };
    }
    return null;
}

export interface HarnessProxyOptions {
    /** How long one answer to "is the agent there?" is reused. */
    probeTtlMs?: number;
    /** How long to wait for the agent's health before saying it is not. */
    probeTimeoutMs?: number;
    /** A clock, for tests. */
    now?: () => number;
}

export interface HarnessProxy {
    handleHttp(req: IncomingMessage, res: ServerResponse): void;
    /** Does the agent answer its health route right now? Never throws. */
    available(): Promise<boolean>;
}

export function createHarnessProxy(
    upstream: Pick<HarnessUpstream, "origin" | "token" | "prefix"> & Partial<Pick<HarnessUpstream, "kind">>,
    options: HarnessProxyOptions = {},
): HarnessProxy {
    const { probeTtlMs = 2_000, probeTimeoutMs = 1_500, now = Date.now } = options;

    const forward = createDaemonProxy({
        origin: upstream.origin,
        bearerToken: upstream.token,
        prefix: upstream.prefix,
        // The agent has no use for the browser's session with the identity
        // provider in front of this host.
        dropHeaders: ["cookie"],
        unreachableError: "harness_unreachable",
    });

    const endpoint = parseEndpoint(upstream.origin);
    const doRequest = endpointIsTls(endpoint) ? httpsRequest : httpRequest;
    /* The health route as this upstream knows it: the same rewrite a browser's
     * request gets, so one rule says where `/app/harness/api/health` ends up. */
    const healthPath = (upstream.prefix ? "" : HARNESS_PREFIX) + "/api/health";

    function probe(): Promise<boolean> {
        return new Promise((done) => {
            let settled = false;
            const settle = (value: boolean): void => {
                if (settled) return;
                settled = true;
                done(value);
            };
            const req = doRequest(
                endpointRequestOptions(endpoint, healthPath, "GET", {
                    authorization: `Bearer ${upstream.token}`,
                    // The desktop's route demands it; the harness ignores it.
                    [WORKSPACE_HEADER]: "1",
                }),
                (res) => {
                    res.resume();
                    settle(res.statusCode === 200);
                },
            );
            req.setTimeout(probeTimeoutMs, () => {
                req.destroy();
                settle(false);
            });
            req.on("error", () => settle(false));
            req.end();
        });
    }

    // One answer is reused for a moment: the app asks on every state poll, and a
    // sidecar that is down should not make each of them wait for its own timeout.
    let cached: { at: number; answer: Promise<boolean> } | null = null;

    return {
        handleHttp: forward.handleHttp,
        available(): Promise<boolean> {
            if (cached && now() - cached.at <= probeTtlMs) return cached.answer;
            const answer = probe();
            cached = { at: now(), answer };
            return answer;
        },
    };
}
