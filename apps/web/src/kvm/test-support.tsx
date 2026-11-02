/**
 * Shared setup for the KVM screen's tests: a real session (real keyboard, link, runners) over
 * the engine's fake socket, HTTP and a manual clock, so a test asserts what the target would
 * have been sent and decides when time passes.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createManualClock, type ManualClock } from "@pikvm/kvm-engine";
import { FakeHttp, FakeSocketHub } from "@pikvm/kvm-engine/testing";
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { createKvmSession, KvmSessionProvider, type KvmSession } from "./session";

export interface Rig {
    readonly session: KvmSession;
    readonly clock: ManualClock;
    readonly hub: FakeSocketHub;
    readonly http: FakeHttp;
    /** Everything the target was sent, as `key KeyC:down`-style lines, pings left out. */
    sent(): string[];
}

export async function openRig(options: { bindLifecycle?: boolean } = {}): Promise<Rig> {
    const clock = createManualClock(1_000_000);
    const hub = new FakeSocketHub();
    const http = new FakeHttp();
    const session = createKvmSession({
        clock,
        socket: hub.factory,
        http,
        url: "ws://kvm/api/ws",
        bindLifecycle: options.bindLifecycle ?? false,
    });
    session.start();
    await clock.settle();
    hub.last.serverOpen();
    await clock.settle();
    return {
        session,
        clock,
        hub,
        http,
        sent: () =>
            hub.sockets
                .flatMap((s) => s.commands())
                .map((c) => {
                    const ev = c.event as Record<string, unknown>;
                    if (c.event_type === "key") return `key ${String(ev["key"])}:${ev["state"] ? "down" : "up"}`;
                    if (c.event_type === "mouse_button") return `button ${String(ev["button"])}:${ev["state"] ? "down" : "up"}`;
                    return c.event_type;
                }),
    };
}

/** What the Pi sends for its LEDs and mouse mode. */
export const hidFrame = (event: Record<string, unknown>) => ({ event_type: "hid", event });

export function renderWithSession(rig: Rig, ui: ReactElement) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(
        <QueryClientProvider client={queryClient}>
            <KvmSessionProvider session={rig.session}>{ui}</KvmSessionProvider>
        </QueryClientProvider>,
    );
}
