/**
 * What jsdom lacks and the conversation's primitives reach for. assistant-ui's viewport
 * observes its content size and scrolls itself; there is no layout here, so an observer
 * that never fires is the honest equivalent.
 */

class NoopObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
        return [];
    }
}

export function installDomStubs(): void {
    // Pure-logic test files run without a DOM; there is nothing to stub there.
    if (typeof Element === "undefined") return;
    if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: NoopObserver });
    if (!("IntersectionObserver" in globalThis)) Object.assign(globalThis, { IntersectionObserver: NoopObserver });
    // Base UI's scroll area waits on animations before measuring; none run here.
    if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
}
