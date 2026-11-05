// First run: the KVM screen when the app has no PiKVM to connect to.
//
// FAILURE MODES (written before the tests)
//  1. The welcome shows where it must not: while the lists load, after they fail to load, with a PiKVM saved, on a
//     host that pins its PiKVM or its state, or with a server in use (the server keeps its own list).
//  2. A failed load is drawn as an empty welcome, so a transient error asks the user to set up what is already set up.
//  3. A save adds the PiKVM but does not make it the one in use, or does not reload onto it.
//  4. A refused save shows nothing, or loses what was typed, or leaves the form locked.
//  5. The status chip says "Screen unavailable" in red when the truth is that there is no PiKVM.

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    defaultServer,
    type FakePikvm,
    type FakeServer,
    installFakeServer,
    installMatchMedia,
    installViewport,
    type RecordedRequest,
    type ServerState,
} from "../test/harness";
import { KvmScreen } from "./kvm-screen";
import { openRig, renderWithSession } from "./test-support";

// jsdom cannot reload; a save calls this once the PiKVM is the one in use.
const reload = vi.hoisted(() => vi.fn());
vi.mock("../host/reload", () => ({ reloadApp: reload }));

let server: ServerState;
let requests: RecordedRequest[];
beforeEach(() => {
    server = defaultServer();
    requests = installFakeServer(server);
    installViewport();
    installMatchMedia({});
    reload.mockClear();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

const INPUT = { selector: "input" };

const desk = (): FakePikvm => ({
    id: "desk",
    name: "Desk",
    origin: "https://pikvm.example/",
    username: "admin",
    passwordSet: true,
    isDefault: true,
    active: true,
});
const garage = (): FakeServer => ({
    id: "garage",
    name: "garage.lan",
    origin: "https://garage.lan/",
    tokenSet: true,
    active: true,
    state: "ok",
});

/** The desktop app's server: it lets the app keep its own PiKVMs and servers. */
const editable = (...items: FakePikvm[]) => {
    server.pikvms = { editable: true, items };
    server.servers = { ...server.servers, editable: true, items: [], localActive: true };
};

/** The url a fetch was made to, whether it was given a string, a URL or a Request. */
const urlOf = (input: string | URL | Request): string => (input instanceof Request ? input.url : String(input));

/** Answers for the PiKVM list come from `answer` instead of the fake server; everything else is untouched. */
function interceptPikvmList(answer: (real: () => Promise<Response>) => Promise<Response>): void {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        const isList = new URL(urlOf(input), "http://localhost").pathname === "/app/api/v1/pikvms" && (init?.method ?? "GET") === "GET";
        return isList ? answer(() => real(input, init)) : real(input, init);
    });
}

async function mount() {
    const rig = await openRig();
    const view = renderWithSession(rig, <KvmScreen />);
    await act(async () => {
        await rig.clock.settle();
    });
    return view;
}

const welcome = () => screen.queryByRole("heading", { name: "Welcome to PiKVM" });
const writes = (path: string) => requests.filter((r) => r.path === path && r.method !== "GET");

/** Both lists have answered, so what the screen decided is final. */
async function listsLoaded(queryClient: Awaited<ReturnType<typeof mount>>["queryClient"]) {
    await waitFor(() => {
        expect(queryClient.getQueryState(["pikvms"])?.status).not.toBe("pending");
        expect(queryClient.getQueryState(["servers"])?.status).not.toBe("pending");
    });
}

describe("when it shows", () => {
    it("is the stage with no PiKVM saved, in place of the picture, and the chip says so", async () => {
        editable();
        await mount();
        expect(await screen.findByRole("heading", { name: "Welcome to PiKVM" })).toBeInTheDocument();
        expect(screen.queryByTestId("kvm-pane")).toBeNull();
        expect(screen.getByRole("img", { name: "No PiKVM yet" })).toBeInTheDocument();
        expect(screen.getByText("No PiKVM yet")).toBeInTheDocument();
        expect(screen.queryByText(/Screen unavailable/)).toBeNull();
        // The cursor is already in the first field.
        expect(screen.getByLabelText("Name", INPUT)).toHaveFocus();
    });

    it("is not shown while the lists load", async () => {
        editable();
        interceptPikvmList(() => new Promise<Response>(() => {}));
        await mount();
        expect(screen.getByTestId("kvm-pane")).toBeInTheDocument();
        expect(welcome()).toBeNull();
        expect(screen.getByRole("img", { name: "Connecting" })).toBeInTheDocument();
    });

    it("is not shown when the lists fail to load: the error says so and Try again asks again", async () => {
        editable();
        let failing = true;
        interceptPikvmList((real) =>
            failing
                ? Promise.resolve(new Response(JSON.stringify({ error: "The app is not answering." }), { status: 500 }))
                : real(),
        );
        const user = userEvent.setup();
        await mount();
        expect(await screen.findByText(/Could not load: The app is not answering\./)).toBeInTheDocument();
        expect(welcome()).toBeNull();
        expect(screen.getByTestId("kvm-pane")).toBeInTheDocument();

        failing = false;
        await user.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByRole("heading", { name: "Welcome to PiKVM" })).toBeInTheDocument();
        expect(screen.queryByText(/Could not load/)).toBeNull();
    });

    it.each([
        ["a PiKVM is saved", () => editable(desk())],
        [
            "the host pins its PiKVM",
            () => {
                server.pikvms = { editable: false, items: [] };
            },
        ],
        [
            "the host pins its state",
            () => {
                editable();
                server.servers.editable = false;
            },
        ],
        [
            "a server is in use",
            () => {
                editable();
                server.servers = { ...server.servers, items: [garage()], localActive: false };
            },
        ],
    ])("is not shown when %s", async (_name, setup) => {
        setup();
        const { queryClient } = await mount();
        await listsLoaded(queryClient);
        expect(welcome()).toBeNull();
        expect(screen.getByTestId("kvm-pane")).toBeInTheDocument();
        expect(screen.queryByText("No PiKVM yet")).toBeNull();
    });
});

describe("saving a PiKVM", () => {
    const fill = async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(await screen.findByLabelText("Name", INPUT), "Desk");
        await user.type(screen.getByLabelText("Address", INPUT), "https://pikvm.lan/");
        await user.type(screen.getByLabelText("User name", INPUT), "admin");
        await user.type(screen.getByLabelText("Password", INPUT), "s3cret");
    };

    it("adds it, makes it the one in use and reloads onto it", async () => {
        editable();
        const user = userEvent.setup();
        await mount();
        await fill(user);
        await user.click(screen.getByRole("button", { name: "Connect" }));
        await waitFor(() => expect(reload).toHaveBeenCalled());
        expect(writes("/app/api/v1/pikvms")).toEqual([
            {
                method: "POST",
                path: "/app/api/v1/pikvms",
                body: { name: "Desk", origin: "https://pikvm.lan/", username: "admin", password: "s3cret" },
            },
        ]);
        expect(server.pikvms.items.map((item) => [item.name, item.active])).toEqual([["Desk", true]]);
    });

    it("locks the form while it saves", async () => {
        editable();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        const real = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
            if ((init?.method ?? "GET") === "POST") await gate;
            return real(input, init);
        });
        const user = userEvent.setup();
        await mount();
        await fill(user);
        await user.click(screen.getByRole("button", { name: "Connect" }));
        await waitFor(() => expect(screen.getByLabelText("Name", INPUT)).toBeDisabled());
        expect(screen.getByLabelText("Address", INPUT)).toBeDisabled();
        expect(screen.getByLabelText("Password", INPUT)).toBeDisabled();
        expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
        // Switching to the server form now would drop this save's answer, and with it the reload.
        expect(screen.getByRole("button", { name: "Use a server instead" })).toBeDisabled();
        release();
        await waitFor(() => expect(reload).toHaveBeenCalled());
    });

    it("shows why a save was refused, keeps what was typed and can be sent again", async () => {
        editable();
        server.pikvmWriteStatus = 502;
        server.pikvmWriteError = "Nothing answered at that address.";
        const user = userEvent.setup();
        await mount();
        await fill(user);
        await user.click(screen.getByRole("button", { name: "Connect" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Could not save: Nothing answered at that address.");
        expect(screen.getByLabelText("Name", INPUT)).toHaveValue("Desk");
        expect(screen.getByLabelText("Address", INPUT)).toHaveValue("https://pikvm.lan/");
        expect(screen.getByLabelText("User name", INPUT)).toHaveValue("admin");
        expect(screen.getByLabelText("Password", INPUT)).toHaveValue("s3cret");
        expect(screen.getByLabelText("Name", INPUT)).toBeEnabled();
        expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
        expect(reload).not.toHaveBeenCalled();

        server.pikvmWriteStatus = 200;
        await user.click(screen.getByRole("button", { name: "Connect" }));
        await waitFor(() => expect(reload).toHaveBeenCalled());
    });
});

describe("using a server instead", () => {
    it("asks for its address and token, in place of the PiKVM form, and a way back", async () => {
        editable();
        const user = userEvent.setup();
        await mount();
        await user.click(await screen.findByRole("button", { name: "Use a server instead" }));
        expect(screen.queryByLabelText("User name", INPUT)).toBeNull();
        expect(screen.getByLabelText("Address", INPUT)).toHaveFocus();

        await user.type(screen.getByLabelText("Address", INPUT), "https://garage.lan/");
        await user.type(screen.getByLabelText("Access token", INPUT), "tok-123");
        await user.click(screen.getByRole("button", { name: "Connect" }));
        await waitFor(() => expect(reload).toHaveBeenCalled());
        expect(writes("/app/api/v1/servers")).toEqual([
            { method: "POST", path: "/app/api/v1/servers", body: { origin: "https://garage.lan/", token: "tok-123" } },
        ]);
        expect(writes("/app/api/v1/servers/srv-1/use")).toHaveLength(1);
        expect(server.servers.localActive).toBe(false);
    });

    it("goes back to the PiKVM form", async () => {
        editable();
        const user = userEvent.setup();
        await mount();
        await user.click(await screen.findByRole("button", { name: "Use a server instead" }));
        await user.click(screen.getByRole("button", { name: "Use a PiKVM instead" }));
        expect(within(screen.getByRole("region", { name: "Welcome to PiKVM" })).getByLabelText("Name", INPUT)).toHaveFocus();
    });
});
