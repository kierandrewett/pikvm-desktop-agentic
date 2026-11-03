/**
 * FAILURE MODES (written before the tests)
 *
 * Server-backed forms (keyboard layout, keep awake)
 *  1. The PATCH carries more or less than the one field changed (a full settings object would
 *     overwrite a concurrent change from the desktop app).
 *  2. A refused save shows nothing, or the control keeps showing the value that was refused.
 *  3. A second tap during a save sends a second PATCH.
 *  4. The control shows the wrong value on load (default instead of the server's).
 *  5. A failed load leaves a blank page with no way back.
 *
 * Client-side prefs (touch mode, trackpad mouse, theme, audio devices)
 *  6. The wrong localStorage key or value, so the console ignores the choice.
 *  7. Choosing the default writes a value that the console then reads as non-default.
 *  8. A stored value is not shown on load.
 *  9. "System" theme stores something, so the OS can no longer be followed.
 * 10. Any of these sends a request to the server.
 * 11. The OS's "default" device aliases are offered as real devices; an unplugged chosen device
 *     is silently shown as another.
 *
 * Read-only pages
 * 12. Link state shown as connected when the server says otherwise.
 * 13. Account appears on a host that is not behind the proxy (an HTML 200 for an unknown
 *     path counts as "no"), or the check failing the page.
 * 14. (Macros are the KVM's own manager; its failure modes are in macros-page.test.tsx.)
 *
 * Navigation
 * 15. A phone shows list and page together, or no way back; a wide screen opens on nothing.
 * 16. (Chat's own failure modes are listed in chat/chat-route.test.tsx.)
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultServer, installFakeServer, renderApp, type RecordedRequest, type ServerState } from "../test/harness";

// jsdom cannot reload; the form calls this after a successful save.
const reload = vi.hoisted(() => vi.fn());
vi.mock("../host/reload", () => ({ reloadApp: reload }));

let server: ServerState;
let requests: RecordedRequest[];

beforeEach(() => {
    server = defaultServer();
    requests = installFakeServer(server);
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-theme");
    Reflect.deleteProperty(navigator, "mediaDevices");
});

const patches = () => requests.filter((request) => request.method === "PATCH");
const apiRequests = () => requests.filter((request) => request.path.startsWith("/app/api/"));

describe("keyboard layout", () => {
    it("shows the layout the server holds", async () => {
        server.keyboardLayout = "uk";
        renderApp("/settings/keyboard");
        await waitFor(() => expect(screen.getByRole("radio", { name: "UK" })).toBeChecked());
        expect(screen.getByRole("radio", { name: "US" })).not.toBeChecked();
    });

    it("sends only the changed field", async () => {
        const user = userEvent.setup();
        renderApp("/settings/keyboard");
        await waitFor(() => expect(screen.getByRole("radio", { name: "US" })).toBeChecked());

        await user.click(screen.getByRole("radio", { name: "UK" }));

        await waitFor(() => expect(patches()).toHaveLength(1));
        expect(patches()[0]).toEqual({ method: "PATCH", path: "/app/api/v1/settings", body: { keyboardLayout: "uk" } });
        await waitFor(() => expect(screen.getByRole("radio", { name: "UK" })).toBeChecked());
    });

    it("shows the server's reason and returns to the held value when the save is refused", async () => {
        const user = userEvent.setup();
        server.patchStatus = 400;
        server.patchError = "settings file is read-only";
        renderApp("/settings/keyboard");
        await waitFor(() => expect(screen.getByRole("radio", { name: "US" })).toBeChecked());

        await user.click(screen.getByRole("radio", { name: "UK" }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("settings file is read-only");
        expect(screen.getByRole("radio", { name: "US" })).toBeChecked();
        expect(screen.getByRole("radio", { name: "UK" })).not.toBeChecked();
    });

    it("says the server cannot be reached when the request fails outright", async () => {
        const user = userEvent.setup();
        renderApp("/settings/keyboard");
        await waitFor(() => expect(screen.getByRole("radio", { name: "US" })).toBeChecked());
        const real = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
            if (init?.method === "PATCH") throw new TypeError("network down");
            return real(input, init);
        });

        await user.click(screen.getByRole("radio", { name: "UK" }));

        expect(await screen.findByRole("alert")).toHaveTextContent("Cannot reach the app server");
    });

    it("does not send a second PATCH while one is in flight", async () => {
        const user = userEvent.setup();
        const gate = Promise.withResolvers<void>();
        server.patchGate = gate.promise;
        renderApp("/settings/keyboard");
        await waitFor(() => expect(screen.getByRole("radio", { name: "US" })).toBeChecked());

        await user.click(screen.getByRole("radio", { name: "UK" }));
        await waitFor(() => expect(screen.getByRole("radio", { name: "US" })).toBeDisabled());
        // The value being saved is what the control shows meanwhile.
        expect(screen.getByRole("radio", { name: "UK" })).toBeChecked();
        await user.click(screen.getByRole("radio", { name: "US" }));
        expect(patches()).toHaveLength(1);

        gate.resolve();
        await waitFor(() => expect(screen.getByRole("radio", { name: "US" })).toBeEnabled());
    });

    it("offers a way back when the state cannot be loaded", async () => {
        const user = userEvent.setup();
        server.stateStatus = 500;
        renderApp("/settings/keyboard");
        expect(await screen.findByRole("alert")).toHaveTextContent("state is down");

        server.stateStatus = 200;
        await user.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(screen.getByRole("radio", { name: "US" })).toBeChecked());
        expect(screen.queryByRole("alert")).toBeNull();
    });
});

describe("keep awake", () => {
    it("reflects the server value", async () => {
        server.jiggler = true;
        renderApp("/settings/keep-awake");
        await waitFor(() =>
            expect(screen.getByRole("switch", { name: "Keep the target awake" })).toHaveAttribute("aria-checked", "true"),
        );
    });

    it("sends jiggler true then false, and nothing else", async () => {
        const user = userEvent.setup();
        renderApp("/settings/keep-awake");
        const toggle = await screen.findByRole("switch", { name: "Keep the target awake" });
        await waitFor(() => expect(toggle).toBeEnabled());

        await user.click(toggle);
        await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
        await waitFor(() => expect(toggle).toBeEnabled());
        await user.click(toggle);
        await waitFor(() => expect(patches()).toHaveLength(2));

        expect(patches().map((request) => request.body)).toEqual([{ jiggler: true }, { jiggler: false }]);
    });

    it("shows the error and snaps back when the save fails", async () => {
        const user = userEvent.setup();
        server.patchStatus = 500;
        server.patchError = "disk full";
        renderApp("/settings/keep-awake");
        const toggle = await screen.findByRole("switch", { name: "Keep the target awake" });
        await waitFor(() => expect(toggle).toBeEnabled());

        await user.click(toggle);

        expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
        expect(toggle).toHaveAttribute("aria-checked", "false");
    });
});

describe("touch and mouse", () => {
    it("defaults to trackpad and absolute, as the console does", async () => {
        renderApp("/settings/input");
        expect(await screen.findByRole("radio", { name: "Trackpad" })).toBeChecked();
        expect(screen.getByRole("radio", { name: "Absolute" })).toBeChecked();
    });

    it("shows what is stored", async () => {
        localStorage.setItem("pikvm-touch-mode", "direct");
        localStorage.setItem("pikvm-touch-hid", "rel");
        renderApp("/settings/input");
        expect(await screen.findByRole("radio", { name: "Touch" })).toBeChecked();
        expect(screen.getByRole("radio", { name: "Relative" })).toBeChecked();
    });

    it("writes the console's keys and values, and talks to no server", async () => {
        const user = userEvent.setup();
        renderApp("/settings/input");
        await user.click(await screen.findByRole("radio", { name: "Touch" }));
        await user.click(screen.getByRole("radio", { name: "Relative" }));

        expect(localStorage.getItem("pikvm-touch-mode")).toBe("direct");
        expect(localStorage.getItem("pikvm-touch-hid")).toBe("rel");

        await user.click(screen.getByRole("radio", { name: "Trackpad" }));
        await user.click(screen.getByRole("radio", { name: "Absolute" }));
        // What the console reads: only "direct" and "rel" are non-default.
        expect(localStorage.getItem("pikvm-touch-mode")).toBe("trackpad");
        expect(localStorage.getItem("pikvm-touch-hid")).toBe("abs");
        expect(patches()).toHaveLength(0);
    });
});

describe("display", () => {
    it("stores an explicit choice under the console's key and repaints", async () => {
        const user = userEvent.setup();
        renderApp("/settings/display");
        await user.click(await screen.findByRole("radio", { name: "Light" }));

        expect(localStorage.getItem("pikvm-console-theme")).toBe("light");
        expect(document.documentElement.getAttribute("data-theme")).toBe("light");
        expect(document.documentElement.classList.contains("dark")).toBe(false);

        await user.click(screen.getByRole("radio", { name: "Dark" }));
        expect(localStorage.getItem("pikvm-console-theme")).toBe("dark");
        expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("stores nothing for System so the OS can still be followed", async () => {
        const user = userEvent.setup();
        localStorage.setItem("pikvm-console-theme", "light");
        renderApp("/settings/display");
        expect(await screen.findByRole("radio", { name: "Light" })).toBeChecked();

        await user.click(screen.getByRole("radio", { name: "System" }));
        expect(localStorage.getItem("pikvm-console-theme")).toBeNull();
        expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    });

    it("shows System when nothing is stored", async () => {
        renderApp("/settings/display");
        expect(await screen.findByRole("radio", { name: "System" })).toBeChecked();
    });
});

describe("connection", () => {
    it("shows the PiKVM address and a connected link", async () => {
        renderApp("/settings/connection");
        expect(await screen.findByText("https://pikvm.example")).toBeInTheDocument();
        expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    it.each([
        ["offline", "Offline"],
        ["connecting", "Connecting"],
        ["unknown", "Not checked yet"],
    ] as const)("shows the %s link as %s", async (link, text) => {
        server.link = link;
        renderApp("/settings/connection");
        expect(await screen.findByText(text)).toBeInTheDocument();
        expect(screen.queryByText("Connected")).toBeNull();
    });

    it("has no control that edits the address when the host pins it", async () => {
        renderApp("/settings/connection");
        await screen.findByText("https://pikvm.example");
        expect(screen.queryByRole("textbox")).toBeNull();
        expect(screen.getByText(/set when the host starts/)).toBeInTheDocument();
    });
});

/* FAILURE MODES (editing the PiKVM, desktop app only)
 *  1. A pinned host shows a form, or sends a PUT.
 *  2. The password field is ever filled from the server, or kept in the page after a save.
 *  3. Saving with the password field empty wipes the stored password; typing does not replace it.
 *  4. A bad address is sent to the server instead of being caught first.
 *  5. A refused save loses what the user typed, or says nothing.
 *  6. A save does not reload the app, so the video and the input socket stay on the old address.
 *  7. The password is sent as anything but the password field's own value.
 */
/** A row is a labelled group, so a label's text names the group and the field; the field is what is wanted. */
const INPUT = { selector: "input" };

describe("connection: changing the PiKVM", () => {
    const editable = () => {
        server.target = { origin: "https://pikvm.example/", username: "admin", passwordSet: true, editable: true };
    };

    beforeEach(() => {
        reload.mockClear();
    });

    it("shows the current address and user, and a password field that is empty", async () => {
        editable();
        renderApp("/settings/connection");
        expect(await screen.findByLabelText("Address", INPUT)).toHaveValue("https://pikvm.example/");
        expect(screen.getByLabelText("User name", INPUT)).toHaveValue("admin");
        const password = screen.getByLabelText("Password", INPUT);
        expect(password).toHaveValue("");
        expect(password).toHaveAttribute("type", "password");
        expect(password).toHaveAttribute("placeholder", expect.stringMatching(/stored/));
    });

    it("a save with the password left empty does not send one, so the stored one is kept", async () => {
        editable();
        const user = userEvent.setup();
        renderApp("/settings/connection");
        const address = await screen.findByLabelText("Address", INPUT);
        await user.clear(address);
        await user.type(address, "https://other.lan/");
        await user.click(screen.getByRole("button", { name: "Save and reconnect" }));
        await waitFor(() => expect(reload).toHaveBeenCalled());
        const put = requests.find((r) => r.method === "PUT" && r.path === "/app/api/v1/target");
        expect(put?.body).toEqual({ origin: "https://other.lan/", username: "admin" });
        expect(server.target.passwordSet).toBe(true);
    });

    it("a typed password is sent once, replaces the stored one, and is cleared from the page", async () => {
        editable();
        const user = userEvent.setup();
        renderApp("/settings/connection");
        const password = await screen.findByLabelText("Password", INPUT);
        await user.type(password, "hunter2-typed");
        await user.click(screen.getByRole("button", { name: "Save and reconnect" }));
        await waitFor(() => expect(reload).toHaveBeenCalled());
        const put = requests.find((r) => r.method === "PUT");
        expect(put?.body).toMatchObject({ password: "hunter2-typed" });
        expect(password).toHaveValue("");
        expect(document.body.innerHTML).not.toContain("hunter2-typed");
    });

    it("removing the stored password sends an empty one", async () => {
        editable();
        const user = userEvent.setup();
        renderApp("/settings/connection");
        await user.click(await screen.findByRole("switch", { name: "Remove the stored password" }));
        expect(screen.getByLabelText("Password", INPUT)).toBeDisabled();
        await user.click(screen.getByRole("button", { name: "Save and reconnect" }));
        await waitFor(() => expect(reload).toHaveBeenCalled());
        expect(requests.find((r) => r.method === "PUT")?.body).toMatchObject({ password: "" });
        expect(server.target.passwordSet).toBe(false);
    });

    it("catches a bad address before any request, and clears the complaint when it is corrected", async () => {
        editable();
        const user = userEvent.setup();
        renderApp("/settings/connection");
        const address = await screen.findByLabelText("Address", INPUT);
        await user.clear(address);
        await user.type(address, "pikvm");
        await user.click(screen.getByRole("button", { name: "Save and reconnect" }));
        expect(await screen.findByRole("alert")).toHaveTextContent(/not a URL/);
        expect(address).toHaveAttribute("aria-invalid", "true");
        expect(requests.some((r) => r.method === "PUT")).toBe(false);
        await user.type(address, "://x");
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("a refused save says why, keeps what was typed and does not reload", async () => {
        editable();
        server.targetPutStatus = 400;
        server.targetPutError = "The address must start with http:// or https://";
        const user = userEvent.setup();
        renderApp("/settings/connection");
        const password = await screen.findByLabelText("Password", INPUT);
        await user.type(password, "keep-me");
        await user.click(screen.getByRole("button", { name: "Save and reconnect" }));
        expect(await screen.findByRole("alert")).toHaveTextContent(/must start with http/);
        expect(password).toHaveValue("keep-me");
        expect(reload).not.toHaveBeenCalled();
    });

    it("a pinned host sends no PUT and draws no form", async () => {
        renderApp("/settings/connection");
        await screen.findByText("https://pikvm.example");
        expect(screen.queryByLabelText("Password", INPUT)).toBeNull();
        expect(requests.some((r) => r.method === "PUT")).toBe(false);
    });
});

describe("account", () => {
    it("is absent from the list when the host is not behind the proxy", async () => {
        renderApp("/settings", { compact: true });
        await screen.findByRole("link", { name: "About" });
        expect(screen.queryByRole("link", { name: "Account" })).toBeNull();
    });

    it("treats an HTML 200 for the unknown path as no proxy", async () => {
        server.userinfo = { status: 200, contentType: "text/html; charset=utf-8" };
        renderApp("/settings", { compact: true });
        await screen.findByRole("link", { name: "About" });
        await waitFor(() => expect(requests.some((r) => r.path === "/oauth2/userinfo")).toBe(true));
        expect(screen.queryByRole("link", { name: "Account" })).toBeNull();
    });

    it("treats a failed check as no proxy rather than an error", async () => {
        server.userinfo = "network-error";
        renderApp("/settings", { compact: true });
        await screen.findByRole("link", { name: "About" });
        await waitFor(() => expect(requests.some((r) => r.path === "/oauth2/userinfo")).toBe(true));
        expect(screen.queryByRole("link", { name: "Account" })).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("appears with a sign-out link when the proxy answers with JSON", async () => {
        server.userinfo = { status: 200, contentType: "application/json" };
        const user = userEvent.setup();
        renderApp("/settings", { compact: true });
        await user.click(await screen.findByRole("link", { name: "Account" }));
        const signOut = await screen.findByRole("link", { name: "Sign out" });
        expect(signOut).toHaveAttribute("href", "/oauth2/sign_out");
        const probe = requests.find((request) => request.path === "/oauth2/userinfo");
        expect(probe?.method).toBe("HEAD");
    });
});

describe("about", () => {
    it("shows the app and host versions", async () => {
        renderApp("/settings/about");
        expect(await screen.findByText("9.9.9")).toBeInTheDocument();
        expect(screen.getByText("App version")).toBeInTheDocument();
    });
});

describe("audio", () => {
    const device = (kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo => ({
        kind,
        deviceId,
        label,
        groupId: "g",
        toJSON: () => ({}),
    });

    const fakeMedia = (devices: MediaDeviceInfo[]) => {
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: {
                enumerateDevices: async () => devices,
                getUserMedia: async () => ({ getTracks: () => [] }),
                addEventListener: () => {},
                removeEventListener: () => {},
            },
        });
    };

    it("is not offered when the browser cannot list devices", async () => {
        const user = userEvent.setup();
        renderApp("/settings", { compact: true });
        await screen.findByRole("link", { name: "About" });
        expect(screen.queryByRole("link", { name: "Audio" })).toBeNull();
        await user.click(screen.getByRole("link", { name: "Display" }));
        await screen.findByRole("radio", { name: "System" });
    });

    /** The Select's trigger names the row and the value ("Microphone: USB microphone"); its menu lists the options. */
    const trigger = (name: string) => screen.findByRole("button", { name: new RegExp(`^${name}:`) });
    const choices = () => [...document.querySelectorAll("[role^=menuitem]")].map((item) => item.textContent);

    it("lists real devices, drops the OS aliases and stores the choice with its label", async () => {
        const user = userEvent.setup();
        fakeMedia([
            device("audioinput", "default", "Default - Built-in"),
            device("audioinput", "communications", "Communications"),
            device("audioinput", "mic-1", "USB microphone"),
            device("audiooutput", "spk-1", "Desk speakers"),
        ]);
        renderApp("/settings/audio");
        const mic = await trigger("Microphone");
        expect(mic).toHaveAccessibleName("Microphone: Follow the system default");
        await user.click(mic);
        await screen.findByRole("menuitem", { name: "USB microphone" });
        expect(choices()).toEqual(["Follow the system default", "USB microphone"]);

        await user.click(screen.getByRole("menuitem", { name: "USB microphone" }));
        expect(JSON.parse(localStorage.getItem("pikvm-console-mic-device") ?? "null")).toEqual({
            id: "mic-1",
            label: "USB microphone",
        });
        expect(await trigger("Microphone")).toHaveAccessibleName("Microphone: USB microphone");

        await user.click(await trigger("Microphone"));
        await user.click(await screen.findByRole("menuitem", { name: "Follow the system default" }));
        expect(localStorage.getItem("pikvm-console-mic-device")).toBeNull();
        expect(apiRequests().filter((request) => request.method !== "GET")).toHaveLength(0);
    });

    it("names a chosen device that is no longer connected instead of showing another", async () => {
        const user = userEvent.setup();
        localStorage.setItem("pikvm-console-mic-device", JSON.stringify({ id: "gone", label: "Headset" }));
        fakeMedia([device("audioinput", "mic-1", "USB microphone")]);
        renderApp("/settings/audio");
        const mic = await trigger("Microphone");
        expect(mic).toHaveAccessibleName("Microphone: Headset (not connected)");
        await user.click(mic);
        await screen.findByRole("menuitem", { name: "USB microphone" });
        expect(choices()).toContain("Headset (not connected)");
    });

    it("asks for access when the browser hides device names", async () => {
        fakeMedia([device("audioinput", "mic-1", "")]);
        renderApp("/settings/audio");
        expect(await screen.findByRole("button", { name: "Allow access" })).toBeInTheDocument();
    });
});

describe("settings navigation", () => {
    it("shows only the list on a phone, then the page with a way back", async () => {
        const user = userEvent.setup();
        renderApp("/settings", { compact: true });
        await user.click(await screen.findByRole("link", { name: "Keyboard" }));
        expect(await screen.findByRole("heading", { level: 1, name: "Keyboard" })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { level: 1, name: "Settings" })).toBeNull();

        await user.click(screen.getByRole("button", { name: "Back to settings" }));
        expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Back to settings" })).toBeNull();
    });

    it("opens the first page beside the list on a wide screen", async () => {
        const { router } = renderApp("/settings", { compact: false });
        await waitFor(() => expect(router.state.location.pathname).toBe("/settings/connection"));
        expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
        expect(await screen.findByRole("heading", { level: 1, name: "Connection" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Back to settings" })).toBeNull();
    });

    it("says so for an unknown settings page", async () => {
        renderApp("/settings/nope", { compact: true });
        expect(await screen.findByText("No such setting")).toBeInTheDocument();
    });
});
