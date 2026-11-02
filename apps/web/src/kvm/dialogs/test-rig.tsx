/**
 * Shared setup for the dialogs' tests: the screen's session rig (real session over the engine's
 * fake socket and HTTP), a dialog mounted the way the screen mounts it, and helpers to play the
 * Pi (events on the socket, answers to HTTP calls).
 */

import { act, render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { vi } from "vitest";
import type { DialogProps } from "../dialog-seam";
import { KvmSessionProvider } from "../session";
import { openRig, type Rig } from "../test-support";

export { openRig, type Rig };

/** What the Pi sends on the event socket, delivered inside `act` so React sees the store change. */
export function pi(rig: Rig, type: string, event: unknown): void {
    act(() => {
        rig.hub.last.serverMessage({ event_type: type, event });
    });
}

export interface Mounted extends RenderResult {
    readonly rig: Rig;
    readonly closed: { count: number };
    readonly queryClient: QueryClient;
}

/** A dialog mounted with the session, a query client and a close counter. */
export async function mountDialog(
    Dialog: ComponentType<DialogProps>,
    rig?: Rig,
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }),
): Promise<Mounted> {
    const ready = rig ?? (await openRig());
    const closed = { count: 0 };
    const view = render(
        <QueryClientProvider client={queryClient}>
            <KvmSessionProvider session={ready.session}>
                <Dialog
                    session={ready.session}
                    onClose={() => {
                        closed.count++;
                        ready.session.dialogs.close();
                    }}
                />
            </KvmSessionProvider>
        </QueryClientProvider>,
    );
    return Object.assign(view, { rig: ready, closed, queryClient });
}

export interface RecordedFetch {
    readonly method: string;
    readonly url: string;
    readonly body: string | undefined;
}

/** Replace fetch with a router of path prefixes to responders; unknown paths are 404. */
export function stubFetch(
    routes: Record<string, (req: RecordedFetch) => Response | Promise<Response>>,
): RecordedFetch[] {
    const seen: RecordedFetch[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const request = input instanceof Request ? input : undefined;
            const url = String(request?.url ?? input).replace(/^https?:\/\/[^/]+/, "");
            const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
            const raw = init?.body ?? (request ? await request.text() : undefined);
            const body = raw === undefined || raw === null ? undefined : typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array);
            const recorded = { method, url, body };
            seen.push(recorded);
            const match = Object.keys(routes).find((prefix) => url.startsWith(prefix));
            const route = match ? routes[match] : undefined;
            if (!route) return new Response("not found", { status: 404 });
            return route(recorded);
        }),
    );
    return seen;
}

export const textResponse = (text: string, status = 200): Response => new Response(text, { status });
export const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Let promises and a few macrotasks run (react-query, fetch stubs). */
export async function flush(times = 5): Promise<void> {
    for (let i = 0; i < times; i++) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}
