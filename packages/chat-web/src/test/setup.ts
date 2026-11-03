import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// The first render pays for lazy chunks (markdown, highlighting) that a busy machine delays.
configure({ asyncUtilTimeout: 8000 });

afterEach(() => {
    cleanup();
    localStorage.clear();
});

// jsdom lacks these; the thread and composer observe sizes and visibility.
class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
        return [];
    }
}
Object.assign(globalThis, { ResizeObserver: Observer, IntersectionObserver: Observer });
window.scrollTo = () => {};
Element.prototype.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};
Element.prototype.getAnimations = () => [];
document.getAnimations = () => [];
// Desktop by default: no query matches. A test that needs the phone layout replaces matchMedia.
window.matchMedia = ((query: string) =>
    ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
