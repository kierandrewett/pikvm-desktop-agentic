import "@testing-library/jest-dom/vitest";
import { installDomStubs } from "@pikvm/chat-ui/testing";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

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

// The chat route renders the real conversation, which needs the observers jsdom lacks.
installDomStubs();
