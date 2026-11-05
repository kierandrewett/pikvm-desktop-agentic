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
 * 13. Account appears only on a host that signs users in (session says signIn: true), and its sign-out link
 *     follows canSignOut.
 * 14. (Macros are the KVM's own manager; its failure modes are in macros-page.test.tsx.)
 *
 * Navigation
 * 15. A phone shows list and page together, or no way back; a wide screen opens on nothing.
 * 16. (Chat's own failure modes are listed in chat/chat-route.test.tsx.)
 * 17. A phone's slide leaves its direction (data-settings-nav) on <html> after the page opens: the list that started
 *     it unmounts and takes the timer that removes it, so the slide's view-transition name stays on for good.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { DESKTOP_BRIDGE_KEY } from "@pikvm/contracts/desktop";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    defaultServer,
    type FakePikvm,
    type FakeServer,
    installFakeServer,
    renderApp,
    type RecordedRequest,
    type ServerState,
} from "../test/harness";

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
const apiRequests = () =>
    requests.filter((request) => request.path.startsWith("/app/api/"));

describe("keyboard layout", () => {
    it("shows the layout the server holds", async () => {
        server.keyboardLayout = "uk";
        renderApp("/settings/keyboard");
        await waitFor(() =>
            expect(screen.getByRole("radio", { name: "UK" })).toBeChecked(),
        );
        expect(screen.getByRole("radio", { name: "US" })).not.toBeChecked();
    });

    it("sends only the changed field", async () => {
        const user = userEvent.setup();
        renderApp("/settings/keyboard");
        await waitFor(() =>
            expect(screen.getByRole("radio", { name: "US" })).toBeChecked(),
        );

        await user.click(screen.getByRole("radio", { name: "UK" }));

        await waitFor(() => expect(patches()).toHaveLength(1));
        expect(patches()[0]).toEqual({
            method: "PATCH",
            path: "/app/api/v1/settings",
            body: { keyboardLayout: "uk" },
        });
        await waitFor(() =>
            expect(screen.getByRole("radio", { name: "UK" })).toBeChecked(),
        );
    });

    it("shows the server's reason and returns to the held value when the save is refused", async () => {
        const user = userEvent.setup();
        server.patchStatus = 400;
        server.patchError = "settings file is read-only";
        renderApp("/settings/keyboard");
        await waitFor(() =>
            expect(screen.getByRole("radio", { name: "US" })).toBeChecked(),
        );

        await user.click(screen.getByRole("radio", { name: "UK" }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("settings file is read-only");
        expect(screen.getByRole("radio", { name: "US" })).toBeChecked();
        expect(screen.getByRole("radio", { name: "UK" })).not.toBeChecked();
    });

    it("says the server cannot be reached when the request fails outright", async () => {
        const user = userEvent.setup();
        renderApp("/settings/keyboard");
        await waitFor(() =>
            expect(screen.getByRole("radio", { name: "US" })).toBeChecked(),
        );
        const real = globalThis.fetch;
        vi.stubGlobal(
            "fetch",
            async (input: string | URL | Request, init?: RequestInit) => {
                if (init?.method === "PATCH")
                    throw new TypeError("network down");
                return real(input, init);
            },
        );

        await user.click(screen.getByRole("radio", { name: "UK" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Cannot reach the app server",
        );
    });

    it("does not send a second PATCH while one is in flight", async () => {
        const user = userEvent.setup();
        const gate = Promise.withResolvers<void>();
        server.patchGate = gate.promise;
        renderApp("/settings/keyboard");
        await waitFor(() =>
            expect(screen.getByRole("radio", { name: "US" })).toBeChecked(),
        );

        await user.click(screen.getByRole("radio", { name: "UK" }));
        await waitFor(() =>
            expect(screen.getByRole("radio", { name: "US" })).toBeDisabled(),
        );
        // The value being saved is what the control shows meanwhile.
        expect(screen.getByRole("radio", { name: "UK" })).toBeChecked();
        await user.click(screen.getByRole("radio", { name: "US" }));
        expect(patches()).toHaveLength(1);

        gate.resolve();
        await waitFor(() =>
            expect(screen.getByRole("radio", { name: "US" })).toBeEnabled(),
        );
    });

    it("offers a way back when the state cannot be loaded", async () => {
        const user = userEvent.setup();
        server.stateStatus = 500;
        renderApp("/settings/keyboard");
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "state is down",
        );

        server.stateStatus = 200;
        await user.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() =>
            expect(screen.getByRole("radio", { name: "US" })).toBeChecked(),
        );
        expect(screen.queryByRole("alert")).toBeNull();
    });
});

describe("keep awake", () => {
    it("reflects the server value", async () => {
        server.jiggler = true;
        renderApp("/settings/keep-awake");
        await waitFor(() =>
            expect(
                screen.getByRole("switch", { name: "Keep the target awake" }),
            ).toHaveAttribute("aria-checked", "true"),
        );
    });

    it("sends jiggler true then false, and nothing else", async () => {
        const user = userEvent.setup();
        renderApp("/settings/keep-awake");
        const toggle = await screen.findByRole("switch", {
            name: "Keep the target awake",
        });
        await waitFor(() => expect(toggle).toBeEnabled());

        await user.click(toggle);
        await waitFor(() =>
            expect(toggle).toHaveAttribute("aria-checked", "true"),
        );
        await waitFor(() => expect(toggle).toBeEnabled());
        await user.click(toggle);
        await waitFor(() => expect(patches()).toHaveLength(2));

        expect(patches().map((request) => request.body)).toEqual([
            { jiggler: true },
            { jiggler: false },
        ]);
    });

    it("shows the error and snaps back when the save fails", async () => {
        const user = userEvent.setup();
        server.patchStatus = 500;
        server.patchError = "disk full";
        renderApp("/settings/keep-awake");
        const toggle = await screen.findByRole("switch", {
            name: "Keep the target awake",
        });
        await waitFor(() => expect(toggle).toBeEnabled());

        await user.click(toggle);

        expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
        expect(toggle).toHaveAttribute("aria-checked", "false");
    });
});

describe("touch and mouse", () => {
    it("defaults to trackpad and absolute, as the console does", async () => {
        renderApp("/settings/input");
        expect(
            await screen.findByRole("radio", { name: "Trackpad" }),
        ).toBeChecked();
        expect(screen.getByRole("radio", { name: "Absolute" })).toBeChecked();
    });

    it("shows what is stored", async () => {
        localStorage.setItem("pikvm-touch-mode", "direct");
        localStorage.setItem("pikvm-touch-hid", "rel");
        renderApp("/settings/input");
        expect(
            await screen.findByRole("radio", { name: "Touch" }),
        ).toBeChecked();
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
        expect(document.documentElement.getAttribute("data-theme")).toBe(
            "light",
        );
        expect(document.documentElement.classList.contains("dark")).toBe(false);

        await user.click(screen.getByRole("radio", { name: "Dark" }));
        expect(localStorage.getItem("pikvm-console-theme")).toBe("dark");
        expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("stores nothing for System so the OS can still be followed", async () => {
        const user = userEvent.setup();
        localStorage.setItem("pikvm-console-theme", "light");
        renderApp("/settings/display");
        expect(
            await screen.findByRole("radio", { name: "Light" }),
        ).toBeChecked();

        await user.click(screen.getByRole("radio", { name: "System" }));
        expect(localStorage.getItem("pikvm-console-theme")).toBeNull();
        expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    });

    it("shows System when nothing is stored", async () => {
        renderApp("/settings/display");
        expect(
            await screen.findByRole("radio", { name: "System" }),
        ).toBeChecked();
    });
});

describe("connection", () => {
    it("shows the PiKVM address and a connected link", async () => {
        renderApp("/settings/connection");
        expect(
            await screen.findByText("https://pikvm.example"),
        ).toBeInTheDocument();
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
        expect(
            screen.getByText(
                "The PiKVM is set by the host. Change it in the host's settings.",
            ),
        ).toBeInTheDocument();
    });
});

/* FAILURE MODES (the PiKVM list, desktop app only)
 *  1. A pinned host shows a form or an action, or sends a write.
 *  2. The password field is ever filled from the server, or kept in the page after a save.
 *  3. Saving with the password field empty wipes the stored password; typing does not replace it.
 *  4. A bad address is sent to the server instead of being caught first.
 *  5. A refused save loses what the user typed, or says nothing.
 *  6. A change to the active PiKVM does not reload the app, so the video and the input socket stay on the old
 *     one; or a change that does not touch it reloads anyway.
 *  7. The password is sent as anything but the password field's own value.
 *  8. A lone PiKVM offers a switcher, or an empty list offers no way to add the first one.
 *  9. The wrong PiKVM is made active or removed, or a removal needs no confirmation.
 * 10. A PiKVM that is not in use is shown with a live link.
 */
/** A row is a labelled group, so a label's text names the group and the field; the field is what is wanted. */
const INPUT = { selector: "input" };

const desk = (over: Partial<FakePikvm> = {}): FakePikvm => ({
    id: "desk",
    name: "Desk",
    origin: "https://pikvm.example/",
    username: "admin",
    passwordSet: true,
    isDefault: true,
    active: true,
    ...over,
});
const rack = (over: Partial<FakePikvm> = {}): FakePikvm => ({
    id: "rack",
    name: "Rack",
    origin: "https://rack.lan/",
    username: "root",
    passwordSet: false,
    isDefault: false,
    active: false,
    ...over,
});
const writes = () =>
    requests.filter(
        (r) => r.path.startsWith("/app/api/v1/pikvms") && r.method !== "GET",
    );

describe("connection: the PiKVM list", () => {
    const editable = (...items: FakePikvm[]) => {
        server.pikvms = { editable: true, items };
        server.servers = {
            ...server.servers,
            editable: true,
            items: [],
            localActive: true,
        };
    };

    beforeEach(() => {
        reload.mockClear();
    });

    describe("with one PiKVM", () => {
        it("shows its name, address and link, with no make-active or default controls", async () => {
            editable(desk());
            renderApp("/settings/connection");
            expect(await screen.findByText("Desk")).toBeInTheDocument();
            expect(
                screen.getByText("https://pikvm.example/"),
            ).toBeInTheDocument();
            expect(await screen.findByText("Connected")).toBeInTheDocument();
            expect(
                screen.getByRole("button", { name: "Edit Desk" }),
            ).toBeInTheDocument();
            expect(
                screen.getByRole("button", { name: "Remove Desk" }),
            ).toBeInTheDocument();
            expect(
                screen.queryByRole("button", { name: /Make .* active/ }),
            ).toBeNull();
            expect(screen.queryByText("Default")).toBeNull();
            expect(
                screen.queryByRole("button", { name: /Make .* the default/ }),
            ).toBeNull();
        });

        it("shows the edit form with the current values and a password field that is empty", async () => {
            editable(desk());
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Edit Desk" }),
            );
            expect(await screen.findByLabelText("Name", INPUT)).toHaveValue(
                "Desk",
            );
            expect(screen.getByLabelText("Address", INPUT)).toHaveValue(
                "https://pikvm.example/",
            );
            expect(screen.getByLabelText("User name", INPUT)).toHaveValue(
                "admin",
            );
            const password = screen.getByLabelText("Password", INPUT);
            expect(password).toHaveValue("");
            expect(password).toHaveAttribute("type", "password");
            expect(password).toHaveAttribute(
                "placeholder",
                expect.stringMatching(/stored/),
            );
            expect(document.body.textContent).not.toMatch(/only you can read/);
            expect(
                screen.getByText(/Not shown again after you save it/),
            ).toBeInTheDocument();
        });

        it("a save with the password left empty does not send one, so the stored one is kept", async () => {
            editable(desk());
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Edit Desk" }),
            );
            const address = await screen.findByLabelText("Address", INPUT);
            await user.clear(address);
            await user.type(address, "https://other.lan/");
            await user.click(
                screen.getByRole("button", { name: "Save and reconnect" }),
            );
            await waitFor(() => expect(reload).toHaveBeenCalled());
            expect(writes()).toEqual([
                {
                    method: "PUT",
                    path: "/app/api/v1/pikvms/desk",
                    body: {
                        name: "Desk",
                        origin: "https://other.lan/",
                        username: "admin",
                    },
                },
            ]);
            expect(server.pikvms.items[0]?.passwordSet).toBe(true);
        });

        it("a typed password is sent once, replaces the stored one, and is cleared from the page", async () => {
            editable(desk());
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Edit Desk" }),
            );
            const password = await screen.findByLabelText("Password", INPUT);
            await user.type(password, "hunter2-typed");
            await user.click(
                screen.getByRole("button", { name: "Save and reconnect" }),
            );
            await waitFor(() => expect(reload).toHaveBeenCalled());
            expect(writes()).toHaveLength(1);
            expect(writes()[0]?.body).toMatchObject({
                password: "hunter2-typed",
            });
            await waitFor(() =>
                expect(screen.queryByLabelText("Password", INPUT)).toBeNull(),
            );
            expect(document.body.innerHTML).not.toContain("hunter2-typed");
        });

        it("removing the stored password sends an empty one", async () => {
            editable(desk());
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Edit Desk" }),
            );
            await user.click(
                await screen.findByRole("switch", {
                    name: "Remove the stored password",
                }),
            );
            expect(screen.getByLabelText("Password", INPUT)).toBeDisabled();
            await user.click(
                screen.getByRole("button", { name: "Save and reconnect" }),
            );
            await waitFor(() => expect(reload).toHaveBeenCalled());
            expect(writes()[0]?.body).toMatchObject({ password: "" });
            expect(server.pikvms.items[0]?.passwordSet).toBe(false);
        });

        it("offers no way to remove a password that is not set", async () => {
            editable(desk({ passwordSet: false }));
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Edit Desk" }),
            );
            await screen.findByLabelText("Password", INPUT);
            expect(
                screen.queryByRole("switch", {
                    name: "Remove the stored password",
                }),
            ).toBeNull();
        });

        it("catches a bad address before any request, and clears the complaint when it is corrected", async () => {
            editable(desk());
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Edit Desk" }),
            );
            const address = await screen.findByLabelText("Address", INPUT);
            await user.clear(address);
            await user.type(address, "pikvm");
            await user.click(
                screen.getByRole("button", { name: "Save and reconnect" }),
            );
            expect(await screen.findByRole("alert")).toHaveTextContent(
                /not a URL/,
            );
            expect(address).toHaveAttribute("aria-invalid", "true");
            expect(writes()).toEqual([]);
            await user.type(address, "://x");
            expect(screen.queryByRole("alert")).toBeNull();
        });

        it("a refused save says why, keeps what was typed and does not reload", async () => {
            editable(desk());
            server.pikvmWriteStatus = 400;
            server.pikvmWriteError =
                "The address must start with http:// or https://";
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Edit Desk" }),
            );
            const name = await screen.findByLabelText("Name", INPUT);
            const password = screen.getByLabelText("Password", INPUT);
            await user.clear(name);
            await user.type(name, "Bench");
            await user.type(password, "keep-me");
            await user.click(
                screen.getByRole("button", { name: "Save and reconnect" }),
            );
            expect(await screen.findByRole("alert")).toHaveTextContent(
                /must start with http/,
            );
            expect(name).toHaveValue("Bench");
            expect(password).toHaveValue("keep-me");
            expect(reload).not.toHaveBeenCalled();
        });

        it("renaming the active PiKVM does not reload the app", async () => {
            editable(desk());
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Edit Desk" }),
            );
            const name = await screen.findByLabelText("Name", INPUT);
            await user.clear(name);
            await user.type(name, "Bench");
            await user.click(
                screen.getByRole("button", { name: "Save and reconnect" }),
            );
            expect(await screen.findByText("Bench")).toBeInTheDocument();
            expect(writes()[0]?.body).toEqual({
                name: "Bench",
                origin: "https://pikvm.example/",
                username: "admin",
            });
            expect(reload).not.toHaveBeenCalled();
        });

        it("a name is required, and is caught before any request", async () => {
            editable(desk());
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Edit Desk" }),
            );
            await user.clear(await screen.findByLabelText("Name", INPUT));
            await user.click(
                screen.getByRole("button", { name: "Save and reconnect" }),
            );
            expect(await screen.findByRole("alert")).toHaveTextContent(
                /Give it a name/,
            );
            expect(writes()).toEqual([]);
        });

        it("Cancel closes the form and sends nothing", async () => {
            editable(desk());
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Edit Desk" }),
            );
            await user.click(
                await screen.findByRole("button", { name: "Cancel" }),
            );
            expect(screen.queryByLabelText("Name", INPUT)).toBeNull();
            expect(writes()).toEqual([]);
        });
    });

    describe("with none", () => {
        it("opens on the add form, with no list and no Cancel", async () => {
            editable();
            renderApp("/settings/connection");
            const page = within(await screen.findByRole("tabpanel"));
            expect(
                await page.findByRole("heading", { name: "Add a PiKVM" }),
            ).toBeInTheDocument();
            expect(page.getByLabelText("Name", INPUT)).toHaveValue("");
            expect(page.getByLabelText("Address", INPUT)).toHaveValue("");
            expect(page.queryByRole("button", { name: "Cancel" })).toBeNull();
            expect(
                page.queryByRole("switch", {
                    name: "Remove the stored password",
                }),
            ).toBeNull();
        });

        it("adds the first PiKVM with its sign-in and reloads, since it becomes the one in use", async () => {
            editable();
            const user = userEvent.setup();
            renderApp("/settings/connection");
            const page = within(await screen.findByRole("tabpanel"));
            await user.type(await page.findByLabelText("Name", INPUT), "Desk");
            await user.type(
                page.getByLabelText("Address", INPUT),
                "https://pikvm.lan/",
            );
            await user.type(page.getByLabelText("User name", INPUT), "admin");
            await user.type(page.getByLabelText("Password", INPUT), "s3cret");
            await user.click(page.getByRole("button", { name: "Add PiKVM" }));
            await waitFor(() => expect(reload).toHaveBeenCalled());
            expect(writes()).toEqual([
                {
                    method: "POST",
                    path: "/app/api/v1/pikvms",
                    body: {
                        name: "Desk",
                        origin: "https://pikvm.lan/",
                        username: "admin",
                        password: "s3cret",
                    },
                },
            ]);
        });

        it("catches a bad address and a missing name before any request", async () => {
            editable();
            const user = userEvent.setup();
            renderApp("/settings/connection");
            const page = within(await screen.findByRole("tabpanel"));
            await user.type(
                await page.findByLabelText("Address", INPUT),
                "ftp://pikvm/",
            );
            await user.click(page.getByRole("button", { name: "Add PiKVM" }));
            expect(
                (await page.findAllByRole("alert"))
                    .map((a) => a.textContent)
                    .join(" "),
            ).toMatch(/Give it a name.*must start with http/);
            expect(writes()).toEqual([]);
        });

        it("a refused add keeps what was typed", async () => {
            editable();
            server.pikvmWriteStatus = 400;
            server.pikvmWriteError = "That address is already stored.";
            const user = userEvent.setup();
            renderApp("/settings/connection");
            const page = within(await screen.findByRole("tabpanel"));
            await user.type(await page.findByLabelText("Name", INPUT), "Desk");
            await user.type(
                page.getByLabelText("Address", INPUT),
                "https://pikvm.lan/",
            );
            await user.type(page.getByLabelText("Password", INPUT), "keep-me");
            await user.click(page.getByRole("button", { name: "Add PiKVM" }));
            expect(await page.findByRole("alert")).toHaveTextContent(
                /already stored/,
            );
            expect(page.getByLabelText("Name", INPUT)).toHaveValue("Desk");
            expect(page.getByLabelText("Password", INPUT)).toHaveValue(
                "keep-me",
            );
            expect(reload).not.toHaveBeenCalled();
        });
    });

    describe("with several", () => {
        const several = () => editable(desk(), rack());

        it("marks the default, and shows a live link only on the active one", async () => {
            several();
            renderApp("/settings/connection");
            expect(await screen.findByText("Rack")).toBeInTheDocument();
            expect(screen.getAllByText("Default")).toHaveLength(1);
            expect(screen.getByText("Connected")).toBeInTheDocument();
            expect(screen.getByText("Not in use")).toBeInTheDocument();
            expect(
                screen.queryByRole("button", { name: "Make Desk active" }),
            ).toBeNull();
            expect(
                screen.getByRole("button", { name: "Make Rack active" }),
            ).toBeInTheDocument();
        });

        it("making one the default writes the default and moves the badge, without reloading", async () => {
            several();
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", {
                    name: "Make Rack the default",
                }),
            );
            await waitFor(() =>
                expect(
                    screen.queryByRole("button", {
                        name: "Make Rack the default",
                    }),
                ).toBeNull(),
            );
            expect(writes()).toEqual([
                {
                    method: "POST",
                    path: "/app/api/v1/pikvms/rack/default",
                    body: undefined,
                },
            ]);
            expect(
                screen.getByRole("button", { name: "Make Desk the default" }),
            ).toBeInTheDocument();
            expect(reload).not.toHaveBeenCalled();
        });

        it("making one active activates that one and reloads", async () => {
            several();
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Make Rack active" }),
            );
            await waitFor(() => expect(reload).toHaveBeenCalled());
            expect(writes()).toEqual([
                {
                    method: "POST",
                    path: "/app/api/v1/pikvms/rack/activate",
                    body: undefined,
                },
            ]);
        });

        it("a refused activation says why and does not reload", async () => {
            several();
            server.pikvmWriteStatus = 404;
            server.pikvmWriteError = "No such PiKVM.";
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Make Rack active" }),
            );
            expect(await screen.findByRole("alert")).toHaveTextContent(
                /No such PiKVM/,
            );
            expect(reload).not.toHaveBeenCalled();
        });

        it("removing asks first, Cancel keeps it, and removing one that is not in use does not reload", async () => {
            several();
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Remove Rack" }),
            );
            const ask = await screen.findByRole("dialog", {
                name: "Remove Rack?",
            });
            await user.click(
                within(ask).getByRole("button", { name: "Cancel" }),
            );
            expect(writes()).toEqual([]);
            await user.click(
                screen.getByRole("button", { name: "Remove Rack" }),
            );
            await user.click(
                within(await screen.findByRole("dialog")).getByRole("button", {
                    name: "Remove PiKVM",
                }),
            );
            await waitFor(() => expect(screen.queryByText("Rack")).toBeNull());
            expect(writes()).toEqual([
                {
                    method: "DELETE",
                    path: "/app/api/v1/pikvms/rack",
                    body: undefined,
                },
            ]);
            expect(reload).not.toHaveBeenCalled();
            // One is left: it needs no switcher.
            expect(
                screen.queryByRole("button", { name: /Make .* active/ }),
            ).toBeNull();
        });

        it("removing the active one reloads", async () => {
            several();
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Remove Desk" }),
            );
            await user.click(
                within(await screen.findByRole("dialog")).getByRole("button", {
                    name: "Remove PiKVM",
                }),
            );
            await waitFor(() => expect(reload).toHaveBeenCalled());
            expect(writes()).toEqual([
                {
                    method: "DELETE",
                    path: "/app/api/v1/pikvms/desk",
                    body: undefined,
                },
            ]);
        });

        it("adds another PiKVM without reloading, since the new one is not in use", async () => {
            several();
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Add a PiKVM" }),
            );
            await user.type(await screen.findByLabelText("Name", INPUT), "Lab");
            await user.type(
                screen.getByLabelText("Address", INPUT),
                "https://lab.lan/",
            );
            await user.click(screen.getByRole("button", { name: "Add PiKVM" }));
            expect(await screen.findByText("Lab")).toBeInTheDocument();
            expect(writes()).toEqual([
                {
                    method: "POST",
                    path: "/app/api/v1/pikvms",
                    body: { name: "Lab", origin: "https://lab.lan/" },
                },
            ]);
            expect(reload).not.toHaveBeenCalled();
            expect(screen.queryByLabelText("Name", INPUT)).toBeNull();
        });

        it("changing the address of the one that is not in use does not reload", async () => {
            several();
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await user.click(
                await screen.findByRole("button", { name: "Edit Rack" }),
            );
            const address = await screen.findByLabelText("Address", INPUT);
            await user.clear(address);
            await user.type(address, "https://rack2.lan/");
            await user.click(screen.getByRole("button", { name: "Save" }));
            expect(
                await screen.findByText("https://rack2.lan/"),
            ).toBeInTheDocument();
            expect(reload).not.toHaveBeenCalled();
        });
    });

    describe("on a host that pins its PiKVM", () => {
        it("shows the one entry and no form, action or write", async () => {
            renderApp("/settings/connection");
            expect(await screen.findByText("PiKVM")).toBeInTheDocument();
            expect(
                await screen.findByText("https://pikvm.example"),
            ).toBeInTheDocument();
            expect(screen.queryByRole("textbox")).toBeNull();
            expect(screen.queryByLabelText("Password", INPUT)).toBeNull();
            expect(
                screen.queryByRole("button", { name: /Add|Edit|Remove|Make/ }),
            ).toBeNull();
            expect(writes()).toEqual([]);
        });
    });
});

describe("connection: the switch", () => {
    const serverWrites = () =>
        requests.filter(
            (r) =>
                r.path.startsWith("/app/api/v1/servers") && r.method !== "GET",
        );
    const serverGets = () =>
        requests.filter(
            (r) => r.method === "GET" && r.path === "/app/api/v1/servers",
        ).length;
    const garage = (over: Partial<FakeServer> = {}): FakeServer => ({
        id: "srv-a",
        name: "Garage",
        origin: "https://garage.lan/",
        tokenSet: true,
        active: false,
        state: "ok",
        ...over,
    });
    const open = (items: FakeServer[] = [], localActive = true) => {
        server.pikvms = { editable: true, items: [desk()] };
        server.servers = {
            ...server.servers,
            editable: true,
            items,
            localActive,
        };
    };
    const SWITCH = { name: "Use a server" };
    /** The sentence sits inside the password hint, after any other hint text, so match it as a fragment. */
    const LINE = /The password is sent to the server and kept there\./;

    beforeEach(() => {
        reload.mockClear();
    });

    it("is absent on a host that pins its PiKVM, and sends no write", async () => {
        renderApp("/settings/connection");
        expect(
            await screen.findByText("https://pikvm.example"),
        ).toBeInTheDocument();
        expect(screen.queryByRole("switch")).toBeNull();
        expect(serverWrites()).toEqual([]);
    });

    it("pins on the host's own state, even when its PiKVM list is editable", async () => {
        server.pikvms = { editable: true, items: [desk()] };
        renderApp("/settings/connection");
        expect(
            await screen.findByText("https://pikvm.example/"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "The PiKVM is set by the host. Change it in the host's settings.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole("switch")).toBeNull();
        expect(
            screen.queryByRole("button", {
                name: /Add a PiKVM|Edit|Remove|Make/,
            }),
        ).toBeNull();
        expect(serverWrites()).toEqual([]);
    });

    it("off shows this app's PiKVMs and nothing about servers", async () => {
        open([]);
        renderApp("/settings/connection");
        expect(await screen.findByText("Desk")).toBeInTheDocument();
        expect(screen.getByRole("switch", SWITCH)).toHaveAttribute(
            "aria-checked",
            "false",
        );
        expect(
            screen.getByRole("button", { name: "Edit Desk" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Forget this server" }),
        ).toBeNull();
        expect(screen.queryByText("On this server.")).toBeNull();
        expect(screen.queryByLabelText("Access token", INPUT)).toBeNull();
    });

    it("on with a server in use shows its address, Forget, and the PiKVMs on it", async () => {
        open([garage({ active: true })], false);
        renderApp("/settings/connection");
        expect(
            await screen.findByText("https://garage.lan/"),
        ).toBeInTheDocument();
        expect(screen.getByRole("switch", SWITCH)).toHaveAttribute(
            "aria-checked",
            "true",
        );
        expect(
            screen.getByRole("button", { name: "Forget this server" }),
        ).toBeInTheDocument();
        expect(screen.getByText("On this server.")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Edit Desk" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Remove Desk" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Add a PiKVM" }),
        ).toBeInTheDocument();
    });

    it("keeps the switch, Forget and a read-only PiKVM when the server owns its PiKVM", async () => {
        open([garage({ active: true })], false);
        server.pikvms = { editable: false, items: [desk()] };
        renderApp("/settings/connection");
        expect(
            await screen.findByText("https://garage.lan/"),
        ).toBeInTheDocument();
        expect(screen.getByRole("switch", SWITCH)).toHaveAttribute(
            "aria-checked",
            "true",
        );
        expect(
            screen.getByRole("button", { name: "Forget this server" }),
        ).toBeInTheDocument();
        expect(screen.getByText("On this server.")).toBeInTheDocument();
        expect(screen.getByText("Desk")).toBeInTheDocument();
        expect(screen.getByText("https://pikvm.example/")).toBeInTheDocument();
        expect(
            screen.getByText(
                "This server sets its own PiKVM. Change it in the server's settings.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", {
                name: /Add a PiKVM|Edit|Remove|Make/,
            }),
        ).toBeNull();
        expect(screen.queryByLabelText("Password", INPUT)).toBeNull();
        expect(serverWrites()).toEqual([]);
    });

    it("turning the switch off while the server owns its PiKVM sends local/use and reloads", async () => {
        open([garage({ active: true })], false);
        server.pikvms = { editable: false, items: [desk()] };
        const user = userEvent.setup();
        renderApp("/settings/connection");
        await user.click(await screen.findByRole("switch", SWITCH));
        await waitFor(() => expect(reload).toHaveBeenCalled());
        expect(serverWrites()).toEqual([
            {
                method: "POST",
                path: "/app/api/v1/servers/local/use",
                body: undefined,
            },
        ]);
    });

    it("the password line is absent while off", async () => {
        open([]);
        const user = userEvent.setup();
        renderApp("/settings/connection");
        await user.click(
            await screen.findByRole("button", { name: "Edit Desk" }),
        );
        expect(
            await screen.findByLabelText("Password", INPUT),
        ).toBeInTheDocument();
        expect(screen.queryByText(LINE)).toBeNull();
    });

    it("the password line shows under the password field while on", async () => {
        open([garage({ active: true })], false);
        const user = userEvent.setup();
        renderApp("/settings/connection");
        await user.click(
            await screen.findByRole("button", { name: "Edit Desk" }),
        );
        expect(await screen.findByText(LINE)).toBeInTheDocument();
    });

    it("turning on with none saved shows the form and sends nothing", async () => {
        open([]);
        const user = userEvent.setup();
        renderApp("/settings/connection");
        await user.click(await screen.findByRole("switch", SWITCH));
        expect(await screen.findByLabelText("Address", INPUT)).toHaveValue("");
        expect(screen.queryByLabelText("Access token", INPUT)).toBeNull();
        expect(screen.getByRole("switch", SWITCH)).toHaveAttribute(
            "aria-checked",
            "true",
        );
        expect(screen.queryByText("Desk")).toBeNull();
        expect(serverWrites()).toEqual([]);
    });

    it("turning the switch back off before connecting hides the form and sends nothing", async () => {
        open([]);
        const user = userEvent.setup();
        renderApp("/settings/connection");
        await user.click(await screen.findByRole("switch", SWITCH));
        await screen.findByLabelText("Address", INPUT);
        await user.click(screen.getByRole("switch", SWITCH));
        expect(await screen.findByText("Desk")).toBeInTheDocument();
        expect(screen.queryByLabelText("Address", INPUT)).toBeNull();
        expect(screen.getByRole("switch", SWITCH)).toHaveAttribute(
            "aria-checked",
            "false",
        );
        expect(serverWrites()).toEqual([]);
        expect(reload).not.toHaveBeenCalled();
    });

    describe("signing in with the browser", () => {
        const openExternal = vi.fn(async (_url: string) => {});
        beforeEach(() => {
            openExternal.mockClear();
            Reflect.set(window, DESKTOP_BRIDGE_KEY, { openExternal });
        });
        afterEach(() => {
            Reflect.deleteProperty(window, DESKTOP_BRIDGE_KEY);
        });
        const begin = async (user: ReturnType<typeof userEvent.setup>) => {
            await user.click(await screen.findByRole("switch", SWITCH));
            await user.type(
                await screen.findByLabelText("Address", INPUT),
                "https://garage.lan/",
            );
            await user.click(
                screen.getByRole("button", {
                    name: "Sign in with your browser",
                }),
            );
        };

        it("asks for an address, not a token, and opens the server's page in the browser", async () => {
            open([]);
            server.servers.signIn.state = "waiting";
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await begin(user);
            await waitFor(() =>
                expect(openExternal).toHaveBeenCalledWith(
                    "https://garage.lan/app/auth/device?fake=1",
                ),
            );
            expect(screen.queryByLabelText("Access token", INPUT)).toBeNull();
            expect(
                await screen.findByText(/Finish signing in in your browser/),
            ).toBeInTheDocument();
            expect(serverWrites()).toEqual([
                {
                    method: "POST",
                    path: "/app/api/v1/servers/sign-in",
                    body: { origin: "https://garage.lan/" },
                },
            ]);
            expect(reload).not.toHaveBeenCalled();
        });

        it("when the browser finishes, the saved server is made the one in use and the page reloads", async () => {
            open([]);
            server.servers.signIn.state = "done";
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await begin(user);
            await waitFor(() => expect(reload).toHaveBeenCalled());
            expect(serverWrites().map((r) => `${r.method} ${r.path}`)).toEqual([
                "POST /app/api/v1/servers/sign-in",
                "POST /app/api/v1/servers/srv-1/use",
            ]);
        });

        it("a failed sign-in says why and keeps the form", async () => {
            open([]);
            server.servers.signIn = {
                state: "failed",
                error: "The sign-in took too long. Start again.",
            };
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await begin(user);
            expect(
                await screen.findByText(
                    "The sign-in took too long. Start again.",
                ),
            ).toBeInTheDocument();
            expect(screen.getByLabelText("Address", INPUT)).toHaveValue(
                "https://garage.lan/",
            );
            expect(reload).not.toHaveBeenCalled();
        });

        it("Cancel stops the attempt on the app's server and brings back the buttons", async () => {
            open([]);
            server.servers.signIn.state = "waiting";
            const user = userEvent.setup();
            renderApp("/settings/connection");
            await begin(user);
            await user.click(
                await screen.findByRole("button", { name: "Cancel" }),
            );
            expect(
                await screen.findByRole("button", {
                    name: "Sign in with your browser",
                }),
            ).toBeInTheDocument();
            expect(
                serverWrites().map((r) => `${r.method} ${r.path}`),
            ).toContain("DELETE /app/api/v1/servers/sign-in/si-1");
        });
    });

    it("a bad address is caught before any request", async () => {
        open([]);
        const user = userEvent.setup();
        renderApp("/settings/connection");
        await user.click(await screen.findByRole("switch", SWITCH));
        await user.type(
            await screen.findByLabelText("Address", INPUT),
            "ftp://garage/",
        );
        await user.click(
            screen.getByRole("button", { name: "Use an access token instead" }),
        );
        await user.type(
            screen.getByLabelText("Access token", INPUT),
            "tok-123",
        );
        await user.click(screen.getByRole("button", { name: "Connect" }));
        expect(
            (await screen.findAllByRole("alert"))
                .map((a) => a.textContent)
                .join(" "),
        ).toMatch(/must start with http/);
        expect(serverWrites()).toEqual([]);
    });

    it("Connect sends the address and token, makes the server the one in use, and reloads", async () => {
        open([]);
        const user = userEvent.setup();
        renderApp("/settings/connection");
        await user.click(await screen.findByRole("switch", SWITCH));
        await user.type(
            await screen.findByLabelText("Address", INPUT),
            "https://garage.lan/",
        );
        await user.click(
            screen.getByRole("button", { name: "Use an access token instead" }),
        );
        await user.type(
            screen.getByLabelText("Access token", INPUT),
            "tok-123",
        );
        await user.click(screen.getByRole("button", { name: "Connect" }));
        await waitFor(() => expect(reload).toHaveBeenCalled());
        expect(serverWrites()).toEqual([
            {
                method: "POST",
                path: "/app/api/v1/servers",
                body: { origin: "https://garage.lan/", token: "tok-123" },
            },
            {
                method: "POST",
                path: "/app/api/v1/servers/srv-1/use",
                body: undefined,
            },
        ]);
    });

    it("a refused add shows the reason inline, keeps the form, and clears the token", async () => {
        open([]);
        server.servers.addStatus = 400;
        server.servers.addError = "That address is already stored.";
        const user = userEvent.setup();
        renderApp("/settings/connection");
        await user.click(await screen.findByRole("switch", SWITCH));
        await user.type(
            await screen.findByLabelText("Address", INPUT),
            "https://garage.lan/",
        );
        await user.click(
            screen.getByRole("button", { name: "Use an access token instead" }),
        );
        await user.type(
            screen.getByLabelText("Access token", INPUT),
            "tok-123",
        );
        await user.click(screen.getByRole("button", { name: "Connect" }));
        expect(await screen.findByText(/already stored/)).toBeInTheDocument();
        expect(screen.getByLabelText("Address", INPUT)).toHaveValue(
            "https://garage.lan/",
        );
        expect(screen.getByLabelText("Access token", INPUT)).toHaveValue("");
        expect(reload).not.toHaveBeenCalled();
    });

    it("on with one saved server, the switch uses it and reloads", async () => {
        open([garage()], true);
        const user = userEvent.setup();
        renderApp("/settings/connection");
        await user.click(await screen.findByRole("switch", SWITCH));
        await waitFor(() => expect(reload).toHaveBeenCalled());
        expect(serverWrites()).toEqual([
            {
                method: "POST",
                path: "/app/api/v1/servers/srv-a/use",
                body: undefined,
            },
        ]);
    });

    it("a refused turn-on says why and leaves the switch off", async () => {
        open([garage()], true);
        const base = fetch;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                const url =
                    typeof input === "string"
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                if (url.endsWith("/servers/srv-a/use")) {
                    return new Response(
                        JSON.stringify({ error: "The server refused." }),
                        {
                            status: 503,
                            headers: { "content-type": "application/json" },
                        },
                    );
                }
                return base(input, init);
            }),
        );
        const user = userEvent.setup();
        renderApp("/settings/connection");
        await user.click(await screen.findByRole("switch", SWITCH));
        expect(
            await screen.findByText(/The server refused/),
        ).toBeInTheDocument();
        expect(screen.getByRole("switch", SWITCH)).toHaveAttribute(
            "aria-checked",
            "false",
        );
        expect(reload).not.toHaveBeenCalled();
    });

    it("off while a server is in use sends local/use and reloads, and keeps the server saved", async () => {
        open([garage({ active: true })], false);
        const user = userEvent.setup();
        renderApp("/settings/connection");
        await user.click(await screen.findByRole("switch", SWITCH));
        await waitFor(() => expect(reload).toHaveBeenCalled());
        expect(serverWrites()).toEqual([
            {
                method: "POST",
                path: "/app/api/v1/servers/local/use",
                body: undefined,
            },
        ]);
        expect(server.servers.items).toHaveLength(1);
    });

    it("a use that finds the saved server gone refetches the list and shows the form, with no error", async () => {
        open([garage()], true);
        const base = fetch;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                const url =
                    typeof input === "string"
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                if (url.endsWith("/servers/srv-a/use")) {
                    // Forgotten in another window: the server answers not found, and its list no longer has the server.
                    server.servers = { ...server.servers, items: [] };
                    return new Response(
                        JSON.stringify({
                            error: "There is no server with that id.",
                        }),
                        {
                            status: 404,
                            headers: { "content-type": "application/json" },
                        },
                    );
                }
                return base(input, init);
            }),
        );
        const user = userEvent.setup();
        renderApp("/settings/connection");
        const before = serverGets();
        await user.click(await screen.findByRole("switch", SWITCH));
        expect(
            await screen.findByLabelText("Address", INPUT),
        ).toBeInTheDocument();
        expect(screen.getByRole("switch", SWITCH)).toHaveAttribute(
            "aria-checked",
            "true",
        );
        expect(screen.queryByText(/no server with that id/)).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(reload).not.toHaveBeenCalled();
        expect(serverGets()).toBeGreaterThan(before);
    });

    it("forget asks first, Cancel keeps the server, and confirming deletes it and reloads", async () => {
        open([garage({ active: true })], false);
        const user = userEvent.setup();
        renderApp("/settings/connection");
        await user.click(
            await screen.findByRole("button", { name: "Forget this server" }),
        );
        const ask = await screen.findByRole("dialog", {
            name: "Forget this server?",
        });
        await user.click(within(ask).getByRole("button", { name: "Cancel" }));
        expect(serverWrites()).toEqual([]);
        await user.click(
            screen.getByRole("button", { name: "Forget this server" }),
        );
        await user.click(
            within(await screen.findByRole("dialog")).getByRole("button", {
                name: "Forget server",
            }),
        );
        await waitFor(() => expect(reload).toHaveBeenCalled());
        expect(serverWrites()).toEqual([
            {
                method: "DELETE",
                path: "/app/api/v1/servers/srv-a",
                body: undefined,
            },
        ]);
    });

    it("an unreachable server replaces the list with a notice, and the switch can still turn it off", async () => {
        open([garage({ active: true, state: "unreachable" })], false);
        const user = userEvent.setup();
        renderApp("/settings/connection");
        expect(
            await screen.findByText("Cannot reach the server."),
        ).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Edit Desk" })).toBeNull();
        const toggle = screen.getByRole("switch", SWITCH);
        expect(toggle).toHaveAttribute("aria-checked", "true");
        expect(toggle).not.toBeDisabled();
        await user.click(toggle);
        await waitFor(() => expect(reload).toHaveBeenCalled());
        expect(serverWrites()).toEqual([
            {
                method: "POST",
                path: "/app/api/v1/servers/local/use",
                body: undefined,
            },
        ]);
    });

    it("making a PiKVM the default still works while on, without reloading", async () => {
        open([garage({ active: true })], false);
        server.pikvms = { editable: true, items: [desk(), rack()] };
        const user = userEvent.setup();
        renderApp("/settings/connection");
        await user.click(
            await screen.findByRole("button", {
                name: "Make Rack the default",
            }),
        );
        await waitFor(() =>
            expect(
                screen.queryByRole("button", { name: "Make Rack the default" }),
            ).toBeNull(),
        );
        expect(writes()).toEqual([
            {
                method: "POST",
                path: "/app/api/v1/pikvms/rack/default",
                body: undefined,
            },
        ]);
        expect(reload).not.toHaveBeenCalled();
    });
});

describe("account", () => {
    it("is absent from the list when the host does not sign users in", async () => {
        server.session = { signIn: false };
        renderApp("/settings", { compact: true });
        await screen.findByRole("link", { name: "About" });
        await waitFor(() =>
            expect(requests.some((r) => r.path === "/app/api/v1/session")).toBe(
                true,
            ),
        );
        expect(screen.queryByRole("link", { name: "Account" })).toBeNull();
    });

    it.each([
        ["token", "access token", "With the access token."],
        ["password", "admin", "With your password."],
        ["oidc", "sub-123", "Through your identity provider."],
        ["bearer", "access token", "With a header credential."],
        ["basic", "admin", "With a header credential."],
    ] as const)(
        "shows who is signed in and how, for %s",
        async (method, subject, wording) => {
            server.session = {
                signIn: true,
                method,
                subject,
                canSignOut: method !== "bearer" && method !== "basic",
            };
            const user = userEvent.setup();
            renderApp("/settings", { compact: true });
            await user.click(
                await screen.findByRole("link", { name: "Account" }),
            );
            expect(
                await screen.findByText(`Signed in as ${subject}`),
            ).toBeInTheDocument();
            expect(screen.getByText(wording)).toBeInTheDocument();
        },
    );

    it("links Sign out to the app's logout when the session can end", async () => {
        server.session = {
            signIn: true,
            method: "password",
            subject: "admin",
            canSignOut: true,
        };
        const user = userEvent.setup();
        renderApp("/settings", { compact: true });
        await user.click(await screen.findByRole("link", { name: "Account" }));
        const signOut = await screen.findByRole("link", { name: "Sign out" });
        expect(signOut).toHaveAttribute("href", "/app/logout");
    });

    it("offers no sign-out when the sign-in has no session to end", async () => {
        server.session = {
            signIn: true,
            method: "bearer",
            subject: "access token",
            canSignOut: false,
        };
        const user = userEvent.setup();
        renderApp("/settings", { compact: true });
        await user.click(await screen.findByRole("link", { name: "Account" }));
        expect(
            await screen.findByText("This sign-in has no session to end."),
        ).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Sign out" })).toBeNull();
    });

    it("never asks the proxy paths for anything", async () => {
        server.session = {
            signIn: true,
            method: "token",
            subject: "access token",
            canSignOut: true,
        };
        const user = userEvent.setup();
        renderApp("/settings", { compact: true });
        await user.click(await screen.findByRole("link", { name: "Account" }));
        await screen.findByRole("link", { name: "Sign out" });
        expect(requests.some((r) => r.path.startsWith("/oauth2"))).toBe(false);
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
    const device = (
        kind: MediaDeviceKind,
        deviceId: string,
        label: string,
    ): MediaDeviceInfo => ({
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
    const trigger = (name: string) =>
        screen.findByRole("button", { name: new RegExp(`^${name}:`) });
    const choices = () =>
        [...document.querySelectorAll("[role^=menuitem]")].map(
            (item) => item.textContent,
        );

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
        expect(mic).toHaveAccessibleName(
            "Microphone: Follow the system default",
        );
        await user.click(mic);
        await screen.findByRole("menuitem", { name: "USB microphone" });
        expect(choices()).toEqual([
            "Follow the system default",
            "USB microphone",
        ]);

        await user.click(
            screen.getByRole("menuitem", { name: "USB microphone" }),
        );
        expect(
            JSON.parse(
                localStorage.getItem("pikvm-console-mic-device") ?? "null",
            ),
        ).toEqual({
            id: "mic-1",
            label: "USB microphone",
        });
        expect(await trigger("Microphone")).toHaveAccessibleName(
            "Microphone: USB microphone",
        );

        await user.click(await trigger("Microphone"));
        await user.click(
            await screen.findByRole("menuitem", {
                name: "Follow the system default",
            }),
        );
        expect(localStorage.getItem("pikvm-console-mic-device")).toBeNull();
        expect(
            apiRequests().filter((request) => request.method !== "GET"),
        ).toHaveLength(0);
    });

    it("names a chosen device that is no longer connected instead of showing another", async () => {
        const user = userEvent.setup();
        localStorage.setItem(
            "pikvm-console-mic-device",
            JSON.stringify({ id: "gone", label: "Headset" }),
        );
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
        expect(
            await screen.findByRole("button", { name: "Allow access" }),
        ).toBeInTheDocument();
    });
});

describe("settings navigation", () => {
    it("shows only the list on a phone, then the page with a way back", async () => {
        const user = userEvent.setup();
        renderApp("/settings", { compact: true });
        await user.click(await screen.findByRole("link", { name: "Keyboard" }));
        expect(
            await screen.findByRole("heading", { level: 1, name: "Keyboard" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("heading", { level: 1, name: "Settings" }),
        ).toBeNull();

        await user.click(
            screen.getByRole("button", { name: "Back to settings" }),
        );
        expect(
            await screen.findByRole("heading", { level: 1, name: "Settings" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Back to settings" }),
        ).toBeNull();
    });

    it("opens the first page beside the list on a wide screen", async () => {
        const { router } = renderApp("/settings", { compact: false });
        await waitFor(() =>
            expect(router.state.location.pathname).toBe("/settings/connection"),
        );
        expect(
            screen.getByRole("heading", { level: 1, name: "Settings" }),
        ).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", {
                level: 1,
                name: "Connection",
            }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Back to settings" }),
        ).toBeNull();
    });

    it("says so for an unknown settings page", async () => {
        renderApp("/settings/nope", { compact: true });
        expect(await screen.findByText("Page not found")).toBeInTheDocument();
    });

    it("17: takes the slide's direction off <html> once a page has opened from the list", async () => {
        const user = userEvent.setup();
        const transition = (update?: () => void) => {
            update?.();
            const done = Promise.resolve();
            return {
                finished: done,
                ready: done,
                updateCallbackDone: done,
                skipTransition: () => undefined,
            };
        };
        Object.defineProperty(document, "startViewTransition", {
            configurable: true,
            value: transition,
        });
        try {
            renderApp("/settings", { compact: true });
            await user.click(
                await screen.findByRole("link", { name: "Keyboard" }),
            );
            expect(
                await screen.findByRole("heading", {
                    level: 1,
                    name: "Keyboard",
                }),
            ).toBeInTheDocument();
            await waitFor(
                () =>
                    expect(
                        document.documentElement.hasAttribute(
                            "data-settings-nav",
                        ),
                    ).toBe(false),
                { timeout: 2000 },
            );
        } finally {
            Reflect.deleteProperty(document, "startViewTransition");
            document.documentElement.removeAttribute("data-settings-nav");
        }
    });
});
