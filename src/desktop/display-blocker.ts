/** One display blocker per window, held while the page asks for it and gone with the window. No Electron import,
 *  so it is unit-tested; the caller passes powerSaveBlocker. */
const blockers = new Map<number, number>();

export interface PowerBlocker {
    start(type: "prevent-display-sleep"): number;
    stop(id: number): void;
}

export function setDisplayBlocker(windowId: number, on: boolean, blocker: PowerBlocker): void {
    const held = blockers.get(windowId);
    if (on && held === undefined) blockers.set(windowId, blocker.start("prevent-display-sleep"));
    else if (!on && held !== undefined) {
        blocker.stop(held);
        blockers.delete(windowId);
    }
}
