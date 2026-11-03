import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// The first test in a file pays for the router, the schemas and the lazy routes, and with the
// whole suite running in parallel that took 2.5 s against the library's 1 s default. A wait that
// is going to pass should not lose to a busy machine; one that is going to fail still fails.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
    cleanup();
    localStorage.clear();
});

// jsdom does not implement scrolling; the router asks for it on every navigation.
window.scrollTo = () => {};
// ... nor does it scroll elements: the settings column returns to the top for each page.
Element.prototype.scrollTo = () => {};
// ... nor measures: Radix (menus, dialogs, switches) watches the size of what it positions.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

/* The conversation pane has its own component tests in packages/chat-web, against a fake chat server. In the
   app's tests it is a stub that shows what the app gave it: whether its tab is in front, and which page it is. */
vi.mock("@pikvm/chat-web", async () => {
    const { createElement } = await import("react");
    const page = (name: string) => () => createElement("div", { "data-testid": `chat-page-${name}` });
    return {
        ChatScope: ({ active, children }: { active?: boolean; children: ReactNode }) =>
            createElement("div", { className: "chat-scope", "data-active": String(active ?? true) }, children),
        ChatPane: () => createElement("section", { "aria-label": "Conversation" }),
        ProvidersPage: page("providers"),
        ModelsPage: page("models"),
        AgentPage: page("agent"),
        // The run-end signal the app listens to (the icon badge): a stub that never fires.
        onRunFinished: () => () => {},
    };
});
