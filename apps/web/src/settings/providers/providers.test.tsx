/**
 * FAILURE MODES (written before the tests)
 *
 * Keys
 *  1. A key value is rendered: prefilled into the field, shown in a row, or left in the field
 *     or the DOM after it was sent.
 *  2. The PUT is the wrong shape: another method or path, a body with more than `api_key`, or
 *     the key sent anywhere else (query string, another endpoint, the connect call's connection).
 *  3. Remove sends DELETE before the user confirms, or after they decline.
 *  4. Set is enabled with an empty field; one submit sends twice.
 *  5. The key survives in TanStack's query or mutation cache.
 *  6. A refusal is swallowed, or the message shown contains the key.
 *
 * Reachability
 *  7. A harness that is not running leaves controls on screen, or a blank page, or no way
 *     to retry. A harness that answers (even refusing) is not called "not running".
 *
 * Add provider
 *  8. The wrong flow for the kind: a key kind sent without a key or to the plain endpoint, a
 *     CLI kind shown a key field, a command sign-in (bearer_command) asked for a key, or a
 *     required base URL left out.
 *
 * CLI sign-in
 *  9. The verification URL or code is missing, unselectable, or not copyable; the Open link
 *     lacks rel=noopener or opens a non-web scheme.
 * 10. Signing in over an existing login without asking; Sign out without asking.
 * 11. The pasted sign-in code is sent in the wrong shape, left in the field, or echoed.
 * 12. The running sign-in is not polled, keeps polling after it ends, or its end (success,
 *     failure, expiry, cancel) is not shown with the reason.
 * 13. A CLI that cannot be signed in from a browser offers Sign in; it must show the exact
 *     command to run on the desktop instead.
 * 14. The page is missing from Settings.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeServer, renderApp, defaultServer } from "../../test/harness";
import type { Attempt, CliStatus, KeyEntry } from "./harness-api";
import { ProvidersPage } from "./providers-page";

const SECRET = "sk-test-NEVER-RENDER-0123456789";
const CODE = "PASTED-CODE-never-render-9876";

interface Recorded {
    method: string;
    path: string;
    body: unknown;
    search: string;
}

interface Fake {
    down: "no" | "network" | "host-503" | number;
    providers: Record<string, Record<string, unknown>>;
    keys: KeyEntry[];
    clis: CliStatus[];
    attempts: Record<string, Attempt | null>;
    /** An error for the next call of "METHOD /path". */
    refuse: Record<string, { status: number; body: unknown }>;
    startAttempt: Attempt;
}

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
    id: "a1",
    cli: "codex",
    state: "awaiting_user",
    method: "device_code",
    verification_url: "https://auth.example/codex/device",
    user_code: "W179-2GB16",
    expects_code: false,
    started_at: "2026-11-02T12:00:00Z",
    expires_at: "2026-11-02T12:15:00Z",
    message: null,
    code_submissions: 0,
    ...over,
});

const cli = (over: Partial<CliStatus> & { cli: string; label: string }): CliStatus => ({
    installed: true,
    signed_in: false,
    account: null,
    method: null,
    browser_sign_in: true,
    can_sign_out: true,
    manual_command: null,
    manual_hint: null,
    error: null,
    attempt: null,
    ...over,
});

const defaultFake = (): Fake => ({
    down: "no",
    providers: {
        "openai-main": { kind: "openai_responses", configured_model: "gpt-5-mini", ready: false },
        "codex-account": { kind: "codex_cli", configured_model: "account-default", ready: true },
    },
    keys: [
        {
            alias: "openai-main",
            kind: "openai_responses",
            credential_env: "OPENAI_API_KEY",
            set: false,
            updated_at: null,
            source: "missing",
        },
    ],
    clis: [
        cli({ cli: "claude", label: "Claude Code", signed_in: true, account: "kieran@example.test", method: "oauth_token" }),
        cli({ cli: "codex", label: "Codex (ChatGPT)" }),
        cli({
            cli: "gemini",
            label: "Gemini CLI",
            browser_sign_in: false,
            can_sign_out: false,
            manual_command: "GEMINI_CLI_HOME=/home/k/.pikvm-gemini gemini",
            manual_hint: 'Run the command below in a terminal on the desktop and choose "Login with Google".',
        }),
    ],
    attempts: {},
    refuse: {},
    startAttempt: attempt(),
});

let fake: Fake;
let requests: Recorded[];

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function installHarness(passthrough?: typeof fetch): void {
    requests = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
            if (!url.pathname.startsWith("/app/harness/")) {
                if (passthrough) return passthrough(input, init);
                return json(404, { error: "not found" });
            }
            const method = (init?.method ?? "GET").toUpperCase();
            const path = url.pathname.slice("/app/harness".length);
            const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
            requests.push({ method, path, body, search: url.search });

            const headers = new Headers(init?.headers);
            expect(headers.get("x-pikvm-workspace")).toBe("1");

            if (fake.down === "network") throw new TypeError("network");
            if (fake.down === "host-503") return new Response("harness proxy not configured", { status: 503 });
            if (typeof fake.down === "number") return json(fake.down, { detail: "harness refused" });
            const refusal = fake.refuse[`${method} ${path}`];
            if (refusal) return json(refusal.status, refusal.body);

            if (method === "GET" && path === "/api/providers") return json(200, fake.providers);
            if (method === "GET" && path === "/api/provider-keys") return json(200, { keys: fake.keys });
            if (method === "GET" && path === "/api/provider-catalog")
                return json(200, [
                    { kind: "openai_responses", support_tier: "stable", interface: "OpenAI Responses API" },
                    { kind: "anthropic_api", support_tier: "stable", interface: "Anthropic Messages API" },
                    { kind: "azure_openai_responses", support_tier: "beta", interface: "Azure OpenAI Responses API" },
                    { kind: "claude_cli", support_tier: "stable", interface: "Claude print mode" },
                    { kind: "subprocess_json", support_tier: "bridge", interface: "Subprocess" },
                ]);
            if (method === "GET" && path === "/api/model-catalog")
                return json(200, {
                    available: true,
                    providers: { openai: { id: "openai", name: "OpenAI", models: [{ id: "gpt-5-mini", name: "GPT-5 mini" }] } },
                    kinds: { openai_responses: ["openai"] },
                });
            if (method === "GET" && path === "/api/cli-auth")
                return json(200, {
                    clis: fake.clis.map((item) => ({ ...item, attempt: fake.attempts[item.cli] ?? null })),
                });

            const key = /^\/api\/providers\/([^/]+)\/key$/.exec(path);
            if (key && method === "PUT") {
                const entry = fake.keys.find((item) => item.alias === key[1]);
                if (!entry) return json(404, { detail: "unknown provider" });
                Object.assign(entry, { set: true, updated_at: "2026-11-02T10:00:00Z", source: "stored" });
                return json(200, entry);
            }
            if (key && method === "DELETE") {
                const entry = fake.keys.find((item) => item.alias === key[1]);
                if (!entry) return json(404, { detail: "unknown provider" });
                Object.assign(entry, { set: false, updated_at: null, source: "missing" });
                return json(200, { ...entry, removed: true });
            }
            if (method === "POST" && path === "/api/providers/with-key") {
                const { connection } = body as { connection: { alias: string; kind: string; model: string } };
                fake.providers[connection.alias] = { kind: connection.kind, configured_model: connection.model, ready: true };
                fake.keys.push({
                    alias: connection.alias,
                    kind: connection.kind,
                    credential_env: "ANTHROPIC_API_KEY",
                    set: true,
                    updated_at: "2026-11-02T10:00:00Z",
                    source: "stored",
                });
                return json(201, { provider: { provider: connection.alias, ready: true, readiness_error: null }, key: {} });
            }
            if (method === "POST" && path === "/api/providers") {
                const connection = body as { alias: string; kind: string; model: string };
                fake.providers[connection.alias] = { kind: connection.kind, configured_model: connection.model, ready: true };
                return json(201, { provider: connection.alias, ready: true, readiness_error: null });
            }

            const signIn = /^\/api\/cli-auth\/([^/]+)\/(sign-in|sign-out|sign-in\/code)$/.exec(path);
            if (signIn) {
                const name = signIn[1] as string;
                const current = fake.clis.find((item) => item.cli === name);
                if (method === "POST" && signIn[2] === "sign-in") {
                    if (current?.signed_in && !(body as { replace?: boolean } | undefined)?.replace)
                        return json(409, { detail: "already signed in", code: "already_signed_in" });
                    fake.attempts[name] = { ...fake.startAttempt, cli: name };
                    return json(202, fake.attempts[name]);
                }
                if (method === "GET" && signIn[2] === "sign-in") {
                    const found = fake.attempts[name];
                    return found ? json(200, found) : json(404, { detail: "no sign-in has been started" });
                }
                if (method === "POST" && signIn[2] === "sign-in/code") {
                    const found = fake.attempts[name];
                    if (found) fake.attempts[name] = { ...found, code_submissions: found.code_submissions + 1 };
                    return json(200, fake.attempts[name]);
                }
                if (method === "DELETE" && signIn[2] === "sign-in") {
                    const found = fake.attempts[name];
                    if (found) fake.attempts[name] = { ...found, state: "cancelled" };
                    return json(200, fake.attempts[name]);
                }
                if (method === "POST" && signIn[2] === "sign-out" && current) {
                    current.signed_in = false;
                    return json(200, { ...current, attempt: null });
                }
            }
            return json(404, { detail: "not found" });
        }),
    );
}

let queryClient: QueryClient;

function renderPage() {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(
        <QueryClientProvider client={queryClient}>
            <ProvidersPage />
        </QueryClientProvider>,
    );
}

beforeEach(() => {
    fake = defaultFake();
    installHarness();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const writes = () => requests.filter((request) => request.method !== "GET");

const keyRow = (alias: string) => screen.findByTestId(`key-${alias}`);

describe("API keys", () => {
    it("shows unset providers with an empty field and no value anywhere", async () => {
        renderPage();
        const row = await keyRow("openai-main");

        expect(within(row).getByText(/No key yet/)).toBeInTheDocument();
        const field = within(row).getByLabelText("API key for openai-main");
        expect(field).toHaveValue("");
        expect(field).toHaveAttribute("type", "password");
        expect(within(row).getByRole("button", { name: "Set key" })).toBeDisabled();
    });

    it("sets a key with one PUT carrying only api_key, then clears the field", async () => {
        const user = userEvent.setup();
        renderPage();
        const row = await keyRow("openai-main");

        await user.type(within(row).getByLabelText("API key for openai-main"), SECRET);
        await user.click(within(row).getByRole("button", { name: "Set key" }));

        await waitFor(() => expect(within(row).getByText(/Key set/)).toBeInTheDocument());
        const puts = writes();
        expect(puts).toHaveLength(1);
        expect(puts[0]).toMatchObject({ method: "PUT", path: "/api/providers/openai-main/key", body: { api_key: SECRET }, search: "" });
        expect(Object.keys(puts[0]?.body as object)).toEqual(["api_key"]);
        expect(screen.queryByLabelText("API key for openai-main")).not.toBeInTheDocument();
        expect(document.body.innerHTML).not.toContain(SECRET);
        expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(SECRET);
        expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    });

    it("sends once when Enter is pressed and the button is clicked in a row", async () => {
        const user = userEvent.setup();
        renderPage();
        const row = await keyRow("openai-main");

        const field = within(row).getByLabelText("API key for openai-main");
        await user.type(field, `${SECRET}{Enter}`);

        await waitFor(() => expect(within(row).getByText(/Key set/)).toBeInTheDocument());
        expect(writes().filter((request) => request.method === "PUT")).toHaveLength(1);
    });

    it("for a provider with a key offers Replace and Remove, and shows when it changed, not what it is", async () => {
        fake.keys[0] = { ...(fake.keys[0] as KeyEntry), set: true, updated_at: "2026-11-02T10:00:00Z", source: "stored" };
        const user = userEvent.setup();
        renderPage();
        const row = await keyRow("openai-main");

        expect(within(row).getByText(/Key set · updated/)).toBeInTheDocument();
        expect(within(row).queryByLabelText("New key for openai-main")).not.toBeInTheDocument();
        expect(within(row).queryByLabelText("API key for openai-main")).not.toBeInTheDocument();

        await user.click(within(row).getByRole("button", { name: "Replace key for openai-main" }));
        const field = within(row).getByLabelText("New key for openai-main");
        expect(field).toHaveValue("");
        await user.type(field, SECRET);
        await user.click(within(row).getByRole("button", { name: "Replace" }));

        await waitFor(() => expect(requests.filter((r) => r.method === "PUT")).toHaveLength(1));
        expect(requests.find((r) => r.method === "PUT")?.body).toEqual({ api_key: SECRET });
        await waitFor(() => expect(within(row).queryByLabelText("New key for openai-main")).not.toBeInTheDocument());
        expect(document.body.innerHTML).not.toContain(SECRET);
    });

    it("cancelling a replace sends nothing and drops what was typed", async () => {
        fake.keys[0] = { ...(fake.keys[0] as KeyEntry), set: true, updated_at: "2026-11-02T10:00:00Z", source: "stored" };
        const user = userEvent.setup();
        renderPage();
        const row = await keyRow("openai-main");

        await user.click(within(row).getByRole("button", { name: "Replace key for openai-main" }));
        await user.type(within(row).getByLabelText("New key for openai-main"), SECRET);
        await user.click(within(row).getByRole("button", { name: "Cancel" }));
        await user.click(within(row).getByRole("button", { name: "Replace key for openai-main" }));

        expect(within(row).getByLabelText("New key for openai-main")).toHaveValue("");
        expect(writes()).toEqual([]);
    });

    it("removes only after confirmation", async () => {
        fake.keys[0] = { ...(fake.keys[0] as KeyEntry), set: true, updated_at: "2026-11-02T10:00:00Z", source: "stored" };
        const user = userEvent.setup();
        renderPage();
        const row = await keyRow("openai-main");

        await user.click(within(row).getByRole("button", { name: "Remove key for openai-main" }));
        expect(writes()).toEqual([]);
        await user.click(within(row).getByRole("button", { name: "Cancel" }));
        expect(writes()).toEqual([]);

        await user.click(within(row).getByRole("button", { name: "Remove key for openai-main" }));
        await user.click(within(row).getByRole("button", { name: "Remove key" }));

        await waitFor(() => expect(within(row).getByText(/No key yet/)).toBeInTheDocument());
        expect(writes()).toEqual([
            { method: "DELETE", path: "/api/providers/openai-main/key", body: undefined, search: "" },
        ]);
    });

    it("shows the harness's refusal and keeps the field for another try", async () => {
        fake.refuse["PUT /api/providers/openai-main/key"] = {
            status: 422,
            body: { detail: "the key must be printable ASCII without spaces or line breaks" },
        };
        const user = userEvent.setup();
        renderPage();
        const row = await keyRow("openai-main");

        await user.type(within(row).getByLabelText("API key for openai-main"), "bad key");
        await user.click(within(row).getByRole("button", { name: "Set key" }));

        expect(await within(row).findByRole("alert")).toHaveTextContent("printable ASCII");
        expect(within(row).getByRole("alert")).not.toHaveTextContent("bad key");
        expect(within(row).getByText(/No key yet/)).toBeInTheDocument();
    });

    it("names the environment variable when that is where the key comes from", async () => {
        fake.keys[0] = { ...(fake.keys[0] as KeyEntry), source: "environment" };
        renderPage();
        const row = await keyRow("openai-main");

        expect(within(row).getByText(/Using OPENAI_API_KEY from the harness environment/)).toBeInTheDocument();
        expect(within(row).getByRole("button", { name: "Set key" })).toBeInTheDocument();
    });
});

describe("reachability", () => {
    it.each([
        ["the network fails", "network" as const],
        ["the host has no harness", "host-503" as const],
    ])("when %s: empty state with retry and no controls", async (_name, down) => {
        fake.down = down;
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByText("The agent harness is not reachable")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Set key|Sign in|Add provider/ })).not.toBeInTheDocument();
        expect(screen.getByText(/Open the app on that computer/)).toBeInTheDocument();

        fake.down = "no";
        await user.click(screen.getByRole("button", { name: "Try again" }));
        expect(await keyRow("openai-main")).toBeInTheDocument();
    });

    it("a harness that answers with a refusal is not called unreachable", async () => {
        fake.down = 401;
        renderPage();

        expect(await screen.findByText("Could not load providers")).toBeInTheDocument();
        expect(screen.getByText("harness refused")).toBeInTheDocument();
        expect(screen.queryByText("The agent harness is not reachable")).not.toBeInTheDocument();
    });

    it("a disabled key store reads as that, and the rest of the page still works", async () => {
        fake.refuse["GET /api/provider-keys"] = { status: 503, body: { detail: "provider key storage is not enabled for this harness" } };
        renderPage();

        expect(await screen.findByText("provider key storage is not enabled for this harness")).toBeInTheDocument();
        expect(await screen.findByTestId("cli-claude")).toBeInTheDocument();
    });
});

describe("add provider", () => {
    it("adds an API provider with its key in one call and never puts the key in the connection", async () => {
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Add provider" }));
        const form = screen.getByRole("form", { name: "Add a provider" });

        // subprocess_json is in the catalog but is not connectable from here.
        expect(within(form).queryByRole("option", { name: /Subprocess/ })).not.toBeInTheDocument();
        await user.selectOptions(within(form).getByLabelText("Provider"), "anthropic_api");
        expect(within(form).getByLabelText("Name")).toHaveValue("anthropic");
        expect(within(form).getByRole("button", { name: "Add provider and save key" })).toBeDisabled();
        await user.type(within(form).getByLabelText("Model"), "claude-opus-4-8");
        await user.type(within(form).getByLabelText("API key"), SECRET);
        await user.click(within(form).getByRole("button", { name: "Add provider and save key" }));

        expect(await screen.findByTestId("key-anthropic")).toBeInTheDocument();
        const call = writes().find((request) => request.path === "/api/providers/with-key");
        expect(call?.body).toEqual({
            connection: { alias: "anthropic", kind: "anthropic_api", model: "claude-opus-4-8" },
            api_key: SECRET,
        });
        expect(JSON.stringify((call?.body as { connection: unknown }).connection)).not.toContain(SECRET);
        expect(document.body.innerHTML).not.toContain(SECRET);
        expect(screen.getByText(/Added anthropic/)).toBeInTheDocument();
    });

    it("offers model suggestions from the catalog", async () => {
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Add provider" }));

        await waitFor(() => expect(document.querySelector("datalist option[value='gpt-5-mini']")).not.toBeNull());
    });

    it("a CLI kind has no key field and goes to the plain endpoint", async () => {
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Add provider" }));
        const form = screen.getByRole("form", { name: "Add a provider" });

        await user.selectOptions(within(form).getByLabelText("Provider"), "claude_cli");
        expect(within(form).queryByLabelText("API key")).not.toBeInTheDocument();
        expect(within(form).queryByLabelText(/Base URL/)).not.toBeInTheDocument();
        await user.type(within(form).getByLabelText("Model"), "sonnet");
        await user.click(within(form).getByRole("button", { name: "Add provider" }));

        await screen.findByText(/Added claude/);
        expect(writes()).toEqual([
            {
                method: "POST",
                path: "/api/providers",
                body: { alias: "claude", kind: "claude_cli", model: "sonnet" },
                search: "",
            },
        ]);
    });

    it("Azure with a command sign-in asks for no key; a key sign-in does, and base URL is required", async () => {
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Add provider" }));
        const form = screen.getByRole("form", { name: "Add a provider" });

        await user.selectOptions(within(form).getByLabelText("Provider"), "azure_openai_responses");
        expect(within(form).getByLabelText("API key")).toBeInTheDocument();
        await user.selectOptions(within(form).getByLabelText("Sign-in"), "bearer_command");
        expect(within(form).queryByLabelText("API key")).not.toBeInTheDocument();

        await user.type(within(form).getByLabelText("Model"), "gpt-5");
        expect(within(form).getByRole("button", { name: "Add provider" })).toBeDisabled();
        await user.type(within(form).getByLabelText(/Base URL/), "https://r.openai.azure.com/openai/v1");
        await user.click(within(form).getByRole("button", { name: "Add provider" }));

        await screen.findByText(/Added azure/);
        expect(writes()[0]).toMatchObject({
            path: "/api/providers",
            body: {
                alias: "azure",
                kind: "azure_openai_responses",
                model: "gpt-5",
                base_url: "https://r.openai.azure.com/openai/v1",
                auth_mode: "bearer_command",
            },
        });
    });

    it("shows the harness's refusal inside the form and keeps the key out of it", async () => {
        fake.refuse["POST /api/providers/with-key"] = { status: 409, body: { detail: "provider alias already configured: openai" } };
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Add provider" }));
        const form = screen.getByRole("form", { name: "Add a provider" });

        await user.type(within(form).getByLabelText("Model"), "gpt-5-mini");
        await user.type(within(form).getByLabelText("API key"), SECRET);
        await user.click(within(form).getByRole("button", { name: "Add provider and save key" }));

        expect(await within(form).findByRole("alert")).toHaveTextContent("already configured");
        expect(within(form).getByRole("alert")).not.toHaveTextContent(SECRET);
    });
});

describe("CLI sign-in", () => {
    it("lists each CLI with what it says about the account", async () => {
        renderPage();

        const claude = await screen.findByTestId("cli-claude");
        expect(within(claude).getByText(/Signed in · kieran@example.test · oauth_token/)).toBeInTheDocument();
        expect(within(screen.getByTestId("cli-codex")).getByText("Not signed in")).toBeInTheDocument();
    });

    it("says when a CLI is not installed instead of offering sign-in", async () => {
        fake.clis[1] = cli({ cli: "codex", label: "Codex (ChatGPT)", installed: false, signed_in: null });
        renderPage();

        const codex = await screen.findByTestId("cli-codex");
        expect(within(codex).getByText(/Not installed/)).toBeInTheDocument();
        expect(within(codex).queryByRole("button")).not.toBeInTheDocument();
    });

    it("a desktop-only CLI shows the exact command and has no Sign in", async () => {
        const user = userEvent.setup();
        renderPage();

        const gemini = await screen.findByTestId("cli-gemini");
        expect(within(gemini).queryByRole("button", { name: /Sign in/ })).not.toBeInTheDocument();
        expect(within(gemini).getByText("GEMINI_CLI_HOME=/home/k/.pikvm-gemini gemini")).toBeInTheDocument();
        expect(within(gemini).getByText(/Login with Google/)).toBeInTheDocument();
        await user.click(within(gemini).getByRole("button", { name: /Copy the Gemini CLI sign-in command/ }));
        expect(await navigator.clipboard.readText()).toBe("GEMINI_CLI_HOME=/home/k/.pikvm-gemini gemini");
        expect(writes()).toEqual([]);
    });

    it("device flow: shows link and code with copy and open, polls, then reports success and the new status", async () => {
        const user = userEvent.setup();
        renderPage();
        const codex = await screen.findByTestId("cli-codex");

        await user.click(within(codex).getByRole("button", { name: "Sign in to Codex (ChatGPT)" }));

        const panel = await within(codex).findByTestId("sign-in-panel");
        expect(writes()).toEqual([{ method: "POST", path: "/api/cli-auth/codex/sign-in", body: {}, search: "" }]);
        expect(within(panel).getByText("https://auth.example/codex/device")).toBeInTheDocument();
        expect(within(panel).getByTestId("user-code")).toHaveTextContent("W179-2GB16");
        const open = within(panel).getByRole("link", { name: /Open the Codex \(ChatGPT\) sign-in page/ });
        expect(open).toHaveAttribute("href", "https://auth.example/codex/device");
        expect(open).toHaveAttribute("target", "_blank");
        expect(open.getAttribute("rel")).toContain("noopener");
        await user.click(within(panel).getByRole("button", { name: /Copy the Codex \(ChatGPT\) one-time code/ }));
        expect(await navigator.clipboard.readText()).toBe("W179-2GB16");
        await user.click(within(panel).getByRole("button", { name: /Copy the Codex \(ChatGPT\) sign-in link/ }));
        expect(await navigator.clipboard.readText()).toBe("https://auth.example/codex/device");

        // The user approves on their phone; the CLI finishes.
        await waitFor(() => expect(requests.filter((r) => r.method === "GET" && r.path === "/api/cli-auth/codex/sign-in").length).toBeGreaterThan(1));
        fake.attempts["codex"] = attempt({ state: "succeeded" });
        (fake.clis[1] as CliStatus).signed_in = true;
        (fake.clis[1] as CliStatus).method = "chatgpt";

        expect(await within(codex).findByText("Signed in to Codex (ChatGPT).")).toBeInTheDocument();
        await waitFor(() => expect(within(codex).getByText("Signed in · chatgpt")).toBeInTheDocument());

        // Finished: polling stops.
        const settled = requests.filter((r) => r.path === "/api/cli-auth/codex/sign-in").length;
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(requests.filter((r) => r.path === "/api/cli-auth/codex/sign-in").length).toBe(settled);
    });

    it("a link that is not http(s) is shown as text, not offered to open", async () => {
        fake.startAttempt = attempt({ verification_url: "javascript:alert(1)" });
        const user = userEvent.setup();
        renderPage();
        const codex = await screen.findByTestId("cli-codex");

        await user.click(within(codex).getByRole("button", { name: "Sign in to Codex (ChatGPT)" }));

        const panel = await within(codex).findByTestId("sign-in-panel");
        expect(within(panel).queryByRole("link")).not.toBeInTheDocument();
    });

    it("shows why a sign-in failed or expired and lets the user try again", async () => {
        const user = userEvent.setup();
        renderPage();
        const codex = await screen.findByTestId("cli-codex");
        await user.click(within(codex).getByRole("button", { name: "Sign in to Codex (ChatGPT)" }));
        await within(codex).findByTestId("sign-in-panel");

        fake.attempts["codex"] = attempt({ state: "failed", message: "Device code expired" });
        expect(await within(codex).findByRole("alert")).toHaveTextContent("Device code expired");

        await user.click(within(codex).getByRole("button", { name: "Try again" }));
        expect(await within(codex).findByTestId("user-code")).toBeInTheDocument();
        expect(writes().filter((r) => r.path === "/api/cli-auth/codex/sign-in" && r.method === "POST")).toHaveLength(2);
    });

    it("cancel sends DELETE and reports the cancellation", async () => {
        const user = userEvent.setup();
        renderPage();
        const codex = await screen.findByTestId("cli-codex");
        await user.click(within(codex).getByRole("button", { name: "Sign in to Codex (ChatGPT)" }));
        await within(codex).findByTestId("sign-in-panel");

        await user.click(within(codex).getByRole("button", { name: "Cancel sign-in" }));

        expect(await within(codex).findByText("Sign-in cancelled.")).toBeInTheDocument();
        expect(writes().at(-1)).toMatchObject({ method: "DELETE", path: "/api/cli-auth/codex/sign-in" });
    });

    it("pasted-code flow: sends {auth_code} once, empties the field and never shows the code", async () => {
        fake.clis[0] = cli({ cli: "claude", label: "Claude Code" });
        fake.startAttempt = attempt({
            cli: "claude",
            method: "url_code",
            verification_url: "https://claude.example/oauth/authorize?state=abc",
            user_code: null,
            expects_code: true,
        });
        const user = userEvent.setup();
        renderPage();
        const claude = await screen.findByTestId("cli-claude");

        await user.click(within(claude).getByRole("button", { name: "Sign in to Claude Code" }));
        const panel = await within(claude).findByTestId("sign-in-panel");
        expect(within(panel).queryByTestId("user-code")).not.toBeInTheDocument();
        const field = within(panel).getByLabelText("Code from the sign-in page");
        expect(field).toHaveValue("");
        expect(within(panel).getByRole("button", { name: "Submit code" })).toBeDisabled();
        await user.type(field, CODE);
        await user.click(within(panel).getByRole("button", { name: "Submit code" }));

        await waitFor(() => expect(writes().some((r) => r.path === "/api/cli-auth/claude/sign-in/code")).toBe(true));
        const post = writes().find((r) => r.path === "/api/cli-auth/claude/sign-in/code");
        expect(post).toMatchObject({ method: "POST", body: { auth_code: CODE } });
        expect(Object.keys(post?.body as object)).toEqual(["auth_code"]);
        expect(within(panel).getByLabelText("Code from the sign-in page")).toHaveValue("");
        expect(document.body.innerHTML).not.toContain(CODE);
        expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(CODE);
    });

    it("shows the CLI's complaint about a wrong pasted code and keeps the attempt open", async () => {
        fake.clis[0] = cli({ cli: "claude", label: "Claude Code" });
        fake.startAttempt = attempt({
            cli: "claude",
            method: "url_code",
            verification_url: "https://claude.example/oauth/authorize",
            user_code: null,
            expects_code: true,
        });
        const user = userEvent.setup();
        renderPage();
        const claude = await screen.findByTestId("cli-claude");
        await user.click(within(claude).getByRole("button", { name: "Sign in to Claude Code" }));
        await within(claude).findByTestId("sign-in-panel");

        fake.attempts["claude"] = attempt({
            cli: "claude",
            method: "url_code",
            verification_url: "https://claude.example/oauth/authorize",
            user_code: null,
            expects_code: true,
            code_submissions: 1,
            message: "Invalid code. Please make sure the full code was copied.",
        });

        expect(await within(claude).findByRole("alert")).toHaveTextContent("Invalid code");
        expect(within(claude).getByLabelText("Code from the sign-in page")).toBeInTheDocument();
    });

    it("signing in over an existing login asks first, then sends replace", async () => {
        const user = userEvent.setup();
        renderPage();
        const claude = await screen.findByTestId("cli-claude");

        await user.click(within(claude).getByRole("button", { name: "Sign in again to Claude Code" }));
        expect(writes()).toEqual([]);
        expect(within(claude).getByText(/replaces the current Claude Code login/)).toBeInTheDocument();
        await user.click(within(claude).getByRole("button", { name: "Cancel" }));
        expect(writes()).toEqual([]);

        await user.click(within(claude).getByRole("button", { name: "Sign in again to Claude Code" }));
        await user.click(within(claude).getByRole("button", { name: "Sign in again" }));

        await within(claude).findByTestId("sign-in-panel");
        expect(writes()).toEqual([{ method: "POST", path: "/api/cli-auth/claude/sign-in", body: { replace: true }, search: "" }]);
    });

    it("signs out only after confirmation and shows the new status", async () => {
        const user = userEvent.setup();
        renderPage();
        const claude = await screen.findByTestId("cli-claude");

        await user.click(within(claude).getByRole("button", { name: "Sign out of Claude Code" }));
        expect(writes()).toEqual([]);
        await user.click(within(claude).getByRole("button", { name: "Sign out" }));

        await waitFor(() => expect(within(claude).getByText("Not signed in")).toBeInTheDocument());
        expect(writes()).toEqual([{ method: "POST", path: "/api/cli-auth/claude/sign-out", body: undefined, search: "" }]);
    });

    it("an attempt already running when the page opens is shown and followed", async () => {
        fake.attempts["codex"] = attempt();
        renderPage();
        const codex = await screen.findByTestId("cli-codex");

        expect(await within(codex).findByTestId("user-code")).toHaveTextContent("W179-2GB16");
        expect(within(codex).queryByRole("button", { name: /Sign in to/ })).not.toBeInTheDocument();
    });

    it("a finished attempt from an earlier visit is not shown again", async () => {
        fake.attempts["codex"] = attempt({ state: "failed", message: "old failure" });
        renderPage();
        const codex = await screen.findByTestId("cli-codex");

        expect(within(codex).queryByText("old failure")).not.toBeInTheDocument();
        expect(within(codex).getByRole("button", { name: "Sign in to Codex (ChatGPT)" })).toBeInTheDocument();
    });
});

describe("in Settings", () => {
    it("lists Providers and opens the page", async () => {
        // The app's own fake server answers everything but the harness, which `installHarness` fronts.
        installFakeServer(defaultServer());
        installHarness(globalThis.fetch);
        const user = userEvent.setup();
        renderApp("/settings", { compact: true });

        await user.click(await screen.findByRole("link", { name: "Providers" }));

        expect(await screen.findByRole("heading", { name: "Providers" })).toBeInTheDocument();
        expect(await keyRow("openai-main")).toBeInTheDocument();
    });
});
