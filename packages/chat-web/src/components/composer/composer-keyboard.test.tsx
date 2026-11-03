/**
 * What the composer tells the phone's keyboard, and what Return does.
 *
 * Failure modes:
 *  K1. The return key does not say "send" (and the field does not capitalise sentences, correct, and spell-check), so
 *      typing a message on the phone feels like filling in a form.
 *  K2. The key says "send" and inserts a newline anyway (a touch keyboard used to), or sends on shift+Return.
 *  K3. With "Enter sends" switched off the key still says "send".
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetSession, queryClient } from "../../lib/queries";
import { ChatPane } from "../../pane/chat-pane";
import { ChatScope } from "../../pane/chat-scope";
import { bootstrap, installFakeServer } from "../../test/fake-server";

function routes(enterToSend: boolean) {
    return {
        "/bootstrap": bootstrap,
        "/settings": { settings: [{ key: "ui.composer.enterToSend", value: enterToSend }], free: [] },
        "/conversations": { conversations: [] },
        "/models": { models: [], defaultModel: null },
    };
}

/** A phone: a coarse pointer and no hover. */
function phone(): void {
    window.matchMedia = ((query: string) =>
        ({
            matches: /pointer:\s*coarse|max-width/.test(query),
            media: query,
            addEventListener() {},
            removeEventListener() {},
        }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

beforeEach(() => {
    queryClient.clear();
    forgetSession();
    phone();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

async function composer(enterToSend = true): Promise<HTMLTextAreaElement> {
    installFakeServer(routes(enterToSend));
    render(
        <ChatScope>
            <ChatPane />
        </ChatScope>,
    );
    return (await screen.findByRole("textbox", { name: /message/i })) as HTMLTextAreaElement;
}

describe("K1: the phone keyboard's hints", () => {
    it("the return key says send; sentences are capitalised, corrected and spell-checked", async () => {
        const field = await composer();
        expect(field.getAttribute("enterkeyhint")).toBe("send");
        expect(field.getAttribute("autocapitalize")).toBe("sentences");
        expect(field.getAttribute("autocorrect")).toBe("on");
        expect(field.getAttribute("spellcheck")).toBe("true");
    });
});

describe("K2: Return on a touch keyboard", () => {
    it("is taken by the composer (no newline), and shift+Return is left to insert one", async () => {
        const field = await composer();
        fireEvent.change(field, { target: { value: "" } });
        // Nothing to send: Return is still the composer's, not a newline in an empty field.
        expect(fireEvent.keyDown(field, { key: "Enter" })).toBe(false);
        expect(fireEvent.keyDown(field, { key: "Enter", shiftKey: true })).toBe(true);
    });
});

describe("K3: Enter sends switched off", () => {
    it("the key says return, and Return is left to insert a newline", async () => {
        const field = await composer(false);
        await waitFor(() => expect(field.getAttribute("enterkeyhint")).toBe("enter"));
        expect(fireEvent.keyDown(field, { key: "Enter" })).toBe(true);
    });
});
