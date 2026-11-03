/**
 * Settings -> Notifications: the screen watch's switch, rule, test button and log, as a person meets them.
 *
 * Failure modes, before behaviour:
 *  G1. The switch is offered with no OpenRouter key and the person finds out later, with nothing sent.
 *  G2. On an iPhone in a Safari tab the page says nothing about the Home Screen, or offers a switch that cannot work.
 *  G3. The permission prompt is asked after an await (Safari refuses it), or asked when it is already decided.
 *  G4. A refused permission still switches the watch on server-side, so it runs and costs for nobody.
 *  G5. The device is not subscribed with the server's key, or the server is never told.
 *  G6. Saving the rule sends more than it changed, or the Save button is live with nothing to save.
 *  G7. "Send test notification" is live with no device set up, or reports success when nothing was sent.
 *  G8. The log hides why a check did not notify.
 */

import type { CheckEntry, WatchView } from "@pikvm/contracts/watch";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as deviceModule from "../notify/device";
import { keyBytes } from "../notify/push-client";
import { defaultServer, installFakeServer, renderApp } from "../test/harness";

vi.mock("../notify/device", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../notify/device")>();
    return { ...actual, readDeviceEnv: vi.fn(actual.readDeviceEnv) };
});

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-ib37J8xQmBDw_4Z3Xoy3qB8Tnh_5Glx-kNVqpCrmI9mLgnV-j6dMyNpZ-KY";

interface WatchServer {
    view: WatchView;
    checks: CheckEntry[];
    requests: { method: string; path: string; body: unknown }[];
    testReply: { status: number; body: unknown };
    patchError: { status: number; error: string } | null;
}

function watchServer(over: Partial<WatchView> = {}): WatchServer {
    return {
        view: {
            enabled: false,
            rule: "",
            visionModel: "google/gemma-3-12b-it",
            defaultVisionModel: "google/gemma-3-12b-it",
            canEnable: { ok: true },
            running: false,
            signal: "unknown",
            push: { available: true, publicKey: KEY, subscriptions: 0 },
            limits: { intervalSec: 3, settleSec: 6, minCheckGapSec: 60, dailyCap: 200, askedToday: 4 },
            ...over,
        },
        checks: [],
        requests: [],
        testReply: { status: 200, body: { sent: 1, removed: 0, failed: [] } },
        patchError: null,
    };
}

/** The fake server for everything but the watch, with the watch's routes answered from `server`. */
function install(server: WatchServer): void {
    installFakeServer(defaultServer());
    const base = globalThis.fetch;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
            if (!url.pathname.startsWith("/app/api/v1/watch")) return base(input, init);
            const method = (init?.method ?? "GET").toUpperCase();
            const body = init?.body ? JSON.parse(String(init.body)) : undefined;
            const rest = url.pathname.slice("/app/api/v1/watch".length);
            server.requests.push({ method, path: rest || "/", body });
            const reply = (status: number, value: unknown) =>
                new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
            if (rest === "" && method === "GET") return reply(200, server.view);
            if (rest === "" && method === "PATCH") {
                if (server.patchError) return reply(server.patchError.status, { error: server.patchError.error });
                server.view = { ...server.view, ...body };
                return reply(200, server.view);
            }
            if (rest === "/checks") return reply(200, { checks: server.checks });
            if (rest === "/subscribe") {
                server.view = { ...server.view, push: { ...server.view.push, subscriptions: 1 } };
                return reply(200, { subscribed: true });
            }
            if (rest === "/unsubscribe") {
                server.view = { ...server.view, push: { ...server.view.push, subscriptions: 0 } };
                return reply(200, { removed: true });
            }
            if (rest === "/test") return reply(server.testReply.status, server.testReply.body);
            return reply(404, { error: "not found" });
        }),
    );
}

interface Device {
    permission: NotificationPermission;
    answer?: NotificationPermission;
    ios?: boolean;
    standalone?: boolean;
    push?: boolean;
    subscribed?: boolean;
}

/** A browser with (or without) what Web Push needs. Returns the spies a test asserts on. */
function device(options: Device = { permission: "default" }) {
    const order: string[] = [];
    const requestPermission = vi.fn(async () => {
        order.push("permission");
        return options.answer ?? options.permission;
    });
    vi.stubGlobal("Notification", { permission: options.permission, requestPermission });
    // The page reads the environment through one function; the app around it must not see an iPhone's user agent.
    vi.mocked(deviceModule.readDeviceEnv).mockReturnValue({
        secure: true,
        ios: options.ios === true,
        standalone: options.standalone === true,
        serviceWorker: true,
        pushManager: options.push !== false,
        notification: true,
        permission: options.permission,
    });

    let current: { endpoint: string; options: { applicationServerKey: ArrayBuffer }; toJSON: () => unknown; unsubscribe: () => Promise<boolean> } | null = null;
    const subscribe = vi.fn(async (opts: { applicationServerKey: Uint8Array }) => {
        order.push("subscribe");
        current = {
            endpoint: "https://web.push.apple.com/abc",
            options: { applicationServerKey: opts.applicationServerKey.buffer as ArrayBuffer },
            toJSON: () => ({ endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "p", auth: "a" } }),
            unsubscribe: async () => {
                current = null;
                return true;
            },
        };
        return current;
    });
    const registration = { pushManager: { getSubscription: vi.fn(async () => current), subscribe } };
    Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: { getRegistration: async () => registration, ready: Promise.resolve(registration) },
    });
    if (options.subscribed) {
        // Same key as the server's, as an earlier visit would have made it.
        void subscribe({ applicationServerKey: keyBytes(KEY) });
        subscribe.mockClear();
        order.length = 0;
    }
    return { requestPermission, subscribe, order };
}

afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "serviceWorker");
});

const NOTIFY = "Notify me when the screen changes";

describe("when it cannot be switched on", () => {
    it("G1: without an OpenRouter key the switch is off and the page says what to add", async () => {
        const server = watchServer({ canEnable: { ok: false, reason: "Add an OpenRouter key in Settings, Providers first." } });
        install(server);
        device();
        renderApp("/settings/notifications");
        const toggle = await screen.findByRole("switch", { name: NOTIFY });
        expect(await screen.findByText(/Add an OpenRouter key in Settings, Providers first/)).toBeInTheDocument();
        expect(toggle).toBeDisabled();
        expect(server.requests.some((r) => r.method === "PATCH")).toBe(false);
    });

    it("G2: on an iPhone in a Safari tab the page says to add the app to the Home Screen, and the switch is off", async () => {
        install(watchServer());
        device({ permission: "default", ios: true, standalone: false, push: false });
        renderApp("/settings/notifications");
        expect(await screen.findAllByText(/Add to Home Screen/)).not.toHaveLength(0);
        expect(screen.getByRole("switch", { name: NOTIFY })).toBeDisabled();
    });

    it("blocked notifications say where to allow them, and the switch is off", async () => {
        install(watchServer());
        device({ permission: "denied", ios: true, standalone: true });
        renderApp("/settings/notifications");
        expect(await screen.findAllByText(/Settings, Notifications, PiKVM/)).not.toHaveLength(0);
        expect(screen.getByRole("switch", { name: NOTIFY })).toBeDisabled();
    });
});

describe("switching on", () => {
    it("G3/G5: asks permission first, subscribes with the server's key, tells the server, then switches the watch on", async () => {
        const server = watchServer();
        install(server);
        const spies = device({ permission: "default", answer: "granted", ios: true, standalone: true });
        renderApp("/settings/notifications");
        const toggle = await screen.findByRole("switch", { name: NOTIFY });
        await waitFor(() => expect(toggle).toBeEnabled());
        await userEvent.click(toggle);
        await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));

        expect(spies.requestPermission).toHaveBeenCalledTimes(1);
        expect(spies.order).toEqual(["permission", "subscribe"]);
        const options = spies.subscribe.mock.calls[0]![0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
        expect(options.userVisibleOnly).toBe(true);
        expect(options.applicationServerKey.length).toBe(65);
        const sent = server.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
        expect(sent.indexOf("POST /subscribe")).toBeGreaterThanOrEqual(0);
        expect(sent.indexOf("POST /subscribe")).toBeLessThan(sent.indexOf("PATCH /"));
        expect(server.requests.find((r) => r.path === "/subscribe")!.body).toEqual({ subscription: { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "p", auth: "a" } } });
        expect(server.requests.find((r) => r.method === "PATCH")!.body).toEqual({ enabled: true });
    });

    it("G3: does not ask again when the permission is already granted", async () => {
        install(watchServer());
        const spies = device({ permission: "granted", ios: true, standalone: true });
        renderApp("/settings/notifications");
        const toggle = await screen.findByRole("switch", { name: NOTIFY });
        await waitFor(() => expect(toggle).toBeEnabled());
        await userEvent.click(toggle);
        await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
        expect(spies.requestPermission).not.toHaveBeenCalled();
    });

    it("G4: a refused permission says so, subscribes nothing and leaves the watch off", async () => {
        const server = watchServer();
        install(server);
        const spies = device({ permission: "default", answer: "denied" });
        renderApp("/settings/notifications");
        const toggle = await screen.findByRole("switch", { name: NOTIFY });
        await waitFor(() => expect(toggle).toBeEnabled());
        await userEvent.click(toggle);
        expect(await screen.findByRole("alert")).toHaveTextContent(/were not allowed/);
        expect(spies.subscribe).not.toHaveBeenCalled();
        expect(server.requests.some((r) => r.method === "PATCH" || r.path === "/subscribe")).toBe(false);
        expect(toggle).toHaveAttribute("aria-checked", "false");
    });

    it("a refusal from the server (the key was removed meanwhile) is shown and the switch stays off", async () => {
        const server = watchServer();
        server.patchError = { status: 409, error: "Add an OpenRouter key in Settings, Providers first." };
        install(server);
        device({ permission: "granted" });
        renderApp("/settings/notifications");
        const toggle = await screen.findByRole("switch", { name: NOTIFY });
        await waitFor(() => expect(toggle).toBeEnabled());
        await userEvent.click(toggle);
        expect(await screen.findByText(/Could not save: Add an OpenRouter key/)).toBeInTheDocument();
        expect(toggle).toHaveAttribute("aria-checked", "false");
    });

    it("switching off tells the server and nothing else", async () => {
        const server = watchServer({ enabled: true, running: true, signal: "signal", push: { available: true, publicKey: KEY, subscriptions: 1 } });
        install(server);
        device({ permission: "granted", subscribed: true });
        renderApp("/settings/notifications");
        const toggle = await screen.findByRole("switch", { name: NOTIFY });
        expect(await screen.findByText("Watching the screen")).toBeInTheDocument();
        expect(toggle).toHaveAttribute("aria-checked", "true");
        await userEvent.click(toggle);
        await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
        expect(server.requests.filter((r) => r.method === "PATCH").map((r) => r.body)).toEqual([{ enabled: false }]);
    });

    it("an enabled watch on a device that was subscribed keeps the server's copy of the subscription current", async () => {
        const server = watchServer({ enabled: true, running: true, push: { available: true, publicKey: KEY, subscriptions: 0 } });
        install(server);
        device({ permission: "granted", subscribed: true });
        renderApp("/settings/notifications");
        await waitFor(() => expect(server.requests.some((r) => r.path === "/subscribe")).toBe(true));
    });
});

describe("the rule and the model", () => {
    it("G6: Save is off until something changes, then sends exactly the two fields and goes quiet", async () => {
        const server = watchServer({ rule: "old rule" });
        install(server);
        device({ permission: "granted" });
        renderApp("/settings/notifications");
        const save = await screen.findByRole("button", { name: "Save" });
        const rule = await screen.findByLabelText("Rule");
        await waitFor(() => expect(rule).toHaveValue("old rule"));
        expect(save).toBeDisabled();
        await userEvent.clear(rule);
        await userEvent.type(rule, "tell me when the install finishes");
        expect(save).toBeEnabled();
        await userEvent.click(save);
        await waitFor(() => expect(save).toBeDisabled());
        expect(server.requests.find((r) => r.method === "PATCH")!.body).toEqual({ rule: "tell me when the install finishes", visionModel: "google/gemma-3-12b-it" });
        expect(rule).toHaveValue("tell me when the install finishes");
    });

    it("shows the model in use, and says what an empty one means", async () => {
        install(watchServer());
        device();
        renderApp("/settings/notifications");
        await waitFor(() => expect(screen.getByLabelText("Image model")).toHaveValue("google/gemma-3-12b-it"));
        expect(screen.getByText(/empty uses google\/gemma-3-12b-it/)).toBeInTheDocument();
    });
});

describe("the test notification", () => {
    it("G7: is off while no device is set up", async () => {
        install(watchServer());
        device({ permission: "granted" });
        renderApp("/settings/notifications");
        const button = await screen.findByRole("button", { name: "Send test notification" });
        await waitFor(() => expect(screen.getByText("No device has been set up yet.")).toBeInTheDocument());
        expect(button).toBeDisabled();
    });

    it("sends, and says how many devices got it; an expired one is said to be removed", async () => {
        const server = watchServer({ push: { available: true, publicKey: KEY, subscriptions: 2 } });
        server.testReply = { status: 200, body: { sent: 1, removed: 1, failed: [] } };
        install(server);
        device({ permission: "granted" });
        renderApp("/settings/notifications");
        const button = await screen.findByRole("button", { name: "Send test notification" });
        await waitFor(() => expect(button).toBeEnabled());
        await userEvent.click(button);
        expect(await screen.findByRole("status")).toHaveTextContent("Sent to 1 device. 1 expired device was removed.");
    });

    it("G7: a refusal from the server is shown, not reported as sent", async () => {
        const server = watchServer({ push: { available: true, publicKey: KEY, subscriptions: 1 } });
        server.testReply = { status: 409, body: { error: "No device has subscribed to notifications yet." } };
        install(server);
        device({ permission: "granted" });
        renderApp("/settings/notifications");
        const button = await screen.findByRole("button", { name: "Send test notification" });
        await waitFor(() => expect(button).toBeEnabled());
        await userEvent.click(button);
        expect(await screen.findByRole("alert")).toHaveTextContent("No device has subscribed to notifications yet.");
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("'No device could be reached' when every send failed", async () => {
        const server = watchServer({ push: { available: true, publicKey: KEY, subscriptions: 1 } });
        server.testReply = { status: 200, body: { sent: 0, removed: 0, failed: [{ host: "fcm.googleapis.com", status: 500, message: "x" }] } };
        install(server);
        device({ permission: "granted" });
        renderApp("/settings/notifications");
        const button = await screen.findByRole("button", { name: "Send test notification" });
        await waitFor(() => expect(button).toBeEnabled());
        await userEvent.click(button);
        expect(await screen.findByRole("status")).toHaveTextContent("No device could be reached.");
    });
});

describe("this device", () => {
    it("can be removed: the browser's subscription is dropped and the server is told which", async () => {
        const server = watchServer({ enabled: true, push: { available: true, publicKey: KEY, subscriptions: 1 } });
        install(server);
        device({ permission: "granted", subscribed: true });
        renderApp("/settings/notifications");
        await userEvent.click(await screen.findByRole("button", { name: "Remove this device" }));
        await waitFor(() => expect(server.requests.find((r) => r.path === "/unsubscribe")).toBeTruthy());
        expect(server.requests.find((r) => r.path === "/unsubscribe")!.body).toEqual({ endpoint: "https://web.push.apple.com/abc" });
    });
});

describe("the log", () => {
    it("G8: each check says what happened and why, newest first", async () => {
        const server = watchServer();
        const at = (t: number) => ({ t, at: new Date(t).toISOString() });
        server.checks = [
            { ...at(3000), kind: "change", score: 0.2, outcome: "pushed", asked: true, description: "A dialog says Install complete." },
            { ...at(2000), kind: "change", score: 0.1, outcome: "skipped", asked: false, reason: "daily cap of 200 checks reached" },
            { ...at(1000), kind: "signal-lost", score: null, outcome: "error", asked: true, reason: "OpenRouter answered 500." },
        ];
        install(server);
        device();
        renderApp("/settings/notifications");
        const log = (await screen.findByText("Recent checks")).closest("section")!;
        await waitFor(() => expect(within(log).getByText("Screen changed: A dialog says Install complete.")).toBeInTheDocument());
        expect(within(log).getByText("Screen changed: daily cap of 200 checks reached")).toBeInTheDocument();
        expect(within(log).getByText("Video signal lost: OpenRouter answered 500.")).toBeInTheDocument();
        const labels = within(log).getAllByText(/Notified you|Not checked|Failed/).map((node) => node.textContent?.split(",")[0]);
        expect(labels).toEqual(["Notified you", "Not checked", "Failed"]);
    });

    it("says there is nothing yet when there is nothing", async () => {
        install(watchServer());
        device();
        renderApp("/settings/notifications");
        expect(await screen.findByText("Nothing yet")).toBeInTheDocument();
    });

    it("the footer states the bounds the server runs on", async () => {
        install(watchServer());
        device();
        renderApp("/settings/notifications");
        expect(await screen.findByText(/every 3 seconds.*6 seconds.*At most one check every minute and 200 a day \(4 so far/)).toBeInTheDocument();
    });
});
