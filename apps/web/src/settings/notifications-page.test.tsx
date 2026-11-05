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
 *  G9. Fast alerts can be switched on while the watch is off, or the page does not say why not.
 *  G10. The corner choice sends more than the rectangle, or shows another corner than the stored one.
 *  G11. The fast alerts text promises what the server does not do, or talks about models.
 */

import { ALERT_ZONES, type CheckEntry, type WatchView } from "@pikvm/contracts/watch";
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
            canJudge: true,
            running: false,
            signal: "unknown",
            push: { available: true, publicKey: KEY, subscriptions: 0 },
            fastAlerts: false,
            alertZone: ALERT_ZONES[0].zone,
            limits: {
                intervalSec: 3,
                settleSec: 6,
                minCheckGapSec: 60,
                dailyCap: 200,
                askedToday: 4,
                fast: { intervalSec: 1, settleSec: 1.2, minCheckGapSec: 4, dailyCap: 500, askedToday: 7 },
            },
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
        expect(await screen.findByRole("alert")).toHaveTextContent(/are blocked on this device/);
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
        const rule = await screen.findByLabelText("Rule", { selector: "textarea" });
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
        await waitFor(() => expect(screen.getByLabelText("Image model", { selector: "input" })).toHaveValue("google/gemma-3-12b-it"));
        expect(screen.getByText(/Leave it empty to use google\/gemma-3-12b-it/)).toBeInTheDocument();
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
        expect(await screen.findByText(/every 3 seconds.*6 seconds.*one check a minute and 200 a day \(4 used/)).toBeInTheDocument();
    });
});

const FAST = "Fast alerts";

describe("fast alerts", () => {
    it("G9: off by default; with the watch off the switch is off and the page says to switch the watch on first", async () => {
        const server = watchServer();
        install(server);
        device({ permission: "granted" });
        renderApp("/settings/notifications");
        const toggle = await screen.findByRole("switch", { name: FAST });
        expect(toggle).toHaveAttribute("aria-checked", "false");
        expect(toggle).toBeDisabled();
        expect(await screen.findByText("Needs the screen watch")).toBeInTheDocument();
        expect(screen.getByText(/Switch on “Notify me when the screen changes” above first/)).toBeInTheDocument();
        expect(server.requests.some((r) => r.method === "PATCH")).toBe(false);
    });

    it("G9: a stored fast alerts choice does not show as on while the watch is off (it does nothing then)", async () => {
        install(watchServer({ enabled: false, fastAlerts: true }));
        device({ permission: "granted" });
        renderApp("/settings/notifications");
        expect(await screen.findByRole("switch", { name: FAST })).toHaveAttribute("aria-checked", "false");
    });

    it("says what it does, in plain words", async () => {
        install(watchServer({ enabled: true }));
        device({ permission: "granted", subscribed: true });
        renderApp("/settings/notifications");
        await screen.findByRole("switch", { name: FAST });
        expect(screen.getByText("Notify within a few seconds of a pop-up in the corner of the screen, such as email, Teams messages and calls.")).toBeInTheDocument();
        expect(screen.getByText("Where pop-ups appear")).toBeInTheDocument();
    });

    it("with the watch on it can be switched on and off, sending only that", async () => {
        const server = watchServer({ enabled: true, running: true, signal: "signal", push: { available: true, publicKey: KEY, subscriptions: 1 } });
        install(server);
        device({ permission: "granted", subscribed: true });
        renderApp("/settings/notifications");
        const toggle = await screen.findByRole("switch", { name: FAST });
        await waitFor(() => expect(toggle).toBeEnabled());
        expect(screen.queryByText("Needs the screen watch")).not.toBeInTheDocument();
        await userEvent.click(toggle);
        await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
        await userEvent.click(toggle);
        await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
        expect(server.requests.filter((r) => r.method === "PATCH").map((r) => r.body)).toEqual([{ fastAlerts: true }, { fastAlerts: false }]);
    });

    /** The Select's trigger names the row and the value ("Where pop-ups appear: Bottom right"); its menu lists the options. */
    const trigger = () => screen.findByRole("button", { name: /^Where pop-ups appear/ });
    /** The trigger is rebuilt when the page's data arrives (it is a plain button until the menu can open), so wait for the live one. */
    const readyTrigger = () =>
        waitFor(() => {
            const found = screen.getByRole("button", { name: /^Where pop-ups appear/ });
            expect(found).toBeEnabled();
            return found;
        });
    const choices = () => [...document.querySelectorAll("[role^=menuitem]")].map((item) => item.textContent);

    it("G10: the corner shows as stored, the four presets are offered, and picking one sends that rectangle and nothing else", async () => {
        const server = watchServer({ enabled: true });
        install(server);
        device({ permission: "granted", subscribed: true });
        renderApp("/settings/notifications");
        const user = userEvent.setup();
        const button = await readyTrigger();
        expect(button).toHaveTextContent("Bottom right");
        await user.click(button);
        await waitFor(() => expect(choices()).not.toEqual([]));
        expect(choices()).toEqual(["Bottom right", "Top right", "Bottom left", "Top left"]);
        await user.click(screen.getByRole("menuitem", { name: "Top right" }));
        await waitFor(() => expect(screen.getByRole("button", { name: /^Where pop-ups appear/ })).toHaveTextContent("Top right"));
        expect(server.requests.filter((r) => r.method === "PATCH").map((r) => r.body)).toEqual([{ alertZone: ALERT_ZONES[1].zone }]);
    });

    it("G10: a stored rectangle that is none of the presets is shown as a custom area, not as another corner", async () => {
        install(watchServer({ enabled: true, alertZone: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 } }));
        device({ permission: "granted", subscribed: true });
        renderApp("/settings/notifications");
        const button = await readyTrigger();
        expect(button).toHaveTextContent("Custom area");
    });

    it("G11: the section states its limits and does not talk about models", async () => {
        install(watchServer({ enabled: true }));
        device({ permission: "granted", subscribed: true });
        renderApp("/settings/notifications");
        await screen.findByText(/one check every 4 seconds and 500 a day \(7 used in the last 24 hours\)/);
        const heading = screen.getByRole("heading", { name: FAST });
        const section = heading.closest("section")!;
        expect(section).toHaveTextContent(/reads the pop-up itself, on the server/);
        expect(section.textContent).not.toMatch(/model|OpenRouter|Jev|OCR/i);
    });

    it("the log names a fast alert for what it is, with no screen text", async () => {
        const server = watchServer({ enabled: true });
        server.checks = [
            {
                t: Date.now(),
                at: new Date().toISOString(),
                kind: "alert",
                score: 0.12,
                outcome: "pushed",
                asked: true,
                latency: { firstSeenAt: 1, capturedAt: 2, detectedAt: 3, pushedAt: 2200, totalMs: 2200 },
                notified: { kind: "call", tag: "pikvm-call-ab", urgency: "high", ttlSec: 60, titleChars: 25, bodyChars: 30 },
            },
        ];
        install(server);
        device({ permission: "granted", subscribed: true });
        renderApp("/settings/notifications");
        expect(await screen.findByText("Pop-up in the corner: a call, 2.2 seconds to send")).toBeInTheDocument();
    });
});

describe("with no OpenRouter key: fast alerts only", () => {
    const NO_KEY = { canJudge: false, canEnable: { ok: false as const, reason: "Add an OpenRouter key in Settings, Providers first." } };

    it("says in plain words what works without a key, and the watch switch itself stays off", async () => {
        install(watchServer(NO_KEY));
        device({ permission: "granted" });
        renderApp("/settings/notifications");
        expect(await screen.findByText("Fast alerts work without a key. The whole-screen watch needs an OpenRouter key.")).toBeInTheDocument();
        expect(screen.getByRole("switch", { name: NOTIFY })).toBeDisabled();
    });

    it("switching fast alerts on sets up this device and switches the watch on in the same request", async () => {
        const server = watchServer(NO_KEY);
        install(server);
        const spies = device({ permission: "default", answer: "granted", ios: true, standalone: true });
        renderApp("/settings/notifications");
        const toggle = await screen.findByRole("switch", { name: FAST });
        await waitFor(() => expect(toggle).toBeEnabled());
        await userEvent.click(toggle);
        await waitFor(() => expect(server.requests.some((r) => r.method === "PATCH")).toBe(true));
        expect(spies.requestPermission).toHaveBeenCalledTimes(1);
        expect(server.requests.find((r) => r.method === "PATCH")!.body).toEqual({ enabled: true, fastAlerts: true });
        await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    });

    it("a server that refuses (this host has no OCR) shows its reason and leaves it off", async () => {
        const server = watchServer(NO_KEY);
        server.patchError = { status: 409, error: "Add an OpenRouter key in Settings, Providers first. (Fast alerts could run without one, but this host's OCR is not available: models missing)" };
        install(server);
        device({ permission: "granted" });
        renderApp("/settings/notifications");
        const toggle = await screen.findByRole("switch", { name: FAST });
        await waitFor(() => expect(toggle).toBeEnabled());
        await userEvent.click(toggle);
        expect(await screen.findByText(/this host's OCR is not available/)).toBeInTheDocument();
        expect(toggle).toHaveAttribute("aria-checked", "false");
    });

    it("running that way, turning fast alerts off is one request (the server then switches the watch off)", async () => {
        const server = watchServer({ ...NO_KEY, enabled: true, fastAlerts: true, running: true, signal: "signal", push: { available: true, publicKey: KEY, subscriptions: 1 } });
        install(server);
        device({ permission: "granted", subscribed: true });
        renderApp("/settings/notifications");
        const toggle = await screen.findByRole("switch", { name: FAST });
        await waitFor(() => expect(toggle).toBeEnabled());
        await userEvent.click(toggle);
        await waitFor(() => expect(server.requests.filter((r) => r.method === "PATCH").map((r) => r.body)).toEqual([{ fastAlerts: false }]));
    });

    it("with a key it says nothing of the kind, and fast alerts still need the watch on first", async () => {
        install(watchServer());
        device({ permission: "granted" });
        renderApp("/settings/notifications");
        expect(await screen.findByText("Needs the screen watch")).toBeInTheDocument();
        expect(screen.queryByText(/Fast alerts work without a key/)).not.toBeInTheDocument();
    });
});
