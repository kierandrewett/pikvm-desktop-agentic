/**
 * Failure mode: the settings model picker opens its popover in <body>, outside Chat's scope, so it loses the tokens that
 * give it a background, a border and a width, and draws as bare text over the page. It must open inside the scope's layer,
 * like the composer's picker does.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L10nProvider } from "../../l10n/provider";
import { forgetSession, queryClient } from "../../lib/queries";
import { ChatScope } from "../../pane/chat-scope";
import { bootstrap, installFakeServer } from "../../test/fake-server";
import { ModelSelect } from "./models";

const model = {
    id: "acme/one",
    provider: "acme",
    providerName: "Acme",
    modelId: "one",
    name: "Model One",
    logo: "",
    reasoning: false,
    efforts: [],
    input: ["text"],
    toolCall: true,
    legacy: false,
    features: {},
};

/** A desktop (a fine pointer, a wide window: a popover, not a sheet) that asks for reduced motion, which jsdom has no animations for. */
function desktop(): void {
    window.matchMedia = ((query: string) =>
        ({ matches: /prefers-reduced-motion/.test(query), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

beforeEach(() => {
    queryClient.clear();
    forgetSession();
    desktop();
    installFakeServer({ "/bootstrap": bootstrap, "/models": { models: [model], defaultModel: "acme/one", errors: [] } });
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe("the settings model picker", () => {
    it("opens its popover inside Chat's scope, so the tokens that style it apply", async () => {
        render(
            <QueryClientProvider client={queryClient}>
                <L10nProvider>
                    <ChatScope>
                        <ModelSelect value="acme/one" onChange={() => undefined} label="Default model" />
                    </ChatScope>
                </L10nProvider>
            </QueryClientProvider>,
        );
        fireEvent.click(await screen.findByRole("button", { name: /Default model/ }));
        const surface = await waitFor(() => {
            const found = document.querySelector("[data-model-picker-surface]");
            if (!found) throw new Error("the popover is not open");
            return found;
        });
        expect(surface.closest(".chat-scope")).not.toBeNull();
    });
});
