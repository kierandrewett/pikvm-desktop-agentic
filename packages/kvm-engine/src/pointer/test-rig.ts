// Test support for the pointer machine: a manual clock, a recording sink and a
// compact text form of commands so gesture tables read like the gesture.

import { createManualClock } from "../clock";
import type { ManualClock } from "../clock";
import type { ViewTransform } from "../view/transform";
import { createPointerDriver } from "./driver";
import type { PointerDriver } from "./driver";
import { DEFAULT_ENV } from "./types";
import type { OutputCommand, PointerEnv, PointerKind } from "./types";

/** Commands that carry HID meaning, as short strings. UI-only commands are omitted (null). */
export function fmt(c: OutputCommand): string | null {
    switch (c.type) {
        case "button":
            return `${c.down ? "down" : "up"}:${c.button}`;
        case "click":
            return `click:${c.button}`;
        case "key":
            return `key${c.down ? "+" : "-"}:${c.key}`;
        case "move":
            return `move:${c.x},${c.y}`;
        case "relative":
            return `rel:${c.dx},${c.dy}`;
        case "wheel":
            return `wheel:${c.dx},${c.dy}${c.withMod ? `+${c.withMod}` : ""}`;
        case "setMouseOutput":
            return `out:${c.absolute ? "abs" : "rel"}`;
        case "notice":
            return `notice:${c.message}`;
        default:
            return null;
    }
}

export interface Rig {
    readonly clock: ManualClock;
    readonly driver: PointerDriver;
    readonly raw: OutputCommand[];
    down(id: number, x: number, y: number, kind?: PointerKind, opts?: { button?: number; clickMods?: string[] }): { preventDefault: boolean };
    move(id: number, x: number, y: number, kind?: PointerKind, buttons?: number): { preventDefault: boolean };
    up(id: number, kind?: PointerKind, opts?: { button?: number; cancelled?: boolean }): void;
    wheel(deltaY: number, modifier?: "none" | "control" | "meta", x?: number, y?: number): void;
    env(patch: Partial<PointerEnv>): void;
    mode(mode: PointerEnv["mouseMode"]): void;
    blur(): void;
    view(v: ViewTransform): void;
    /** The shared cursor moved to this point of the picture in kvmd units; `own` is this client's own move coming back. */
    remote(x: number, y: number, own?: boolean): void;
    /** Advance time by one display frame. */
    frame(): void;
    advance(ms: number): void;
    /** HID-meaningful commands since the last take, formatted. Output-mode requests are hidden unless asked for. */
    take(opts?: { outputs?: boolean }): string[];
    /** Raw commands of one type since the last take (does not clear). */
    ofType<T extends OutputCommand["type"]>(type: T): Extract<OutputCommand, { type: T }>[];
    clear(): void;
}

export function createRig(init: { env?: Partial<PointerEnv>; view?: ViewTransform; coarse?: boolean } = {}): Rig {
    const clock = createManualClock(1000);
    const raw: OutputCommand[] = [];
    const driver = createPointerDriver({
        clock,
        sink: (c) => raw.push(c),
        env: { ...DEFAULT_ENV, ...init.env },
        ...(init.view ? { view: init.view } : {}),
        coarsePointer: init.coarse ?? true,
    });
    return {
        clock,
        driver,
        raw,
        down: (id, x, y, kind = "touch", opts = {}) =>
            driver.send({ type: "down", id, kind, x, y, button: opts.button ?? 0, ...(opts.clickMods ? { clickMods: opts.clickMods } : {}) }),
        move: (id, x, y, kind = "touch", buttons = 0) => driver.send({ type: "move", id, kind, x, y, buttons }),
        up: (id, kind = "touch", opts = {}) => {
            driver.send({ type: "up", id, kind, button: opts.button ?? 0, ...(opts.cancelled ? { cancelled: true } : {}) });
        },
        wheel: (deltaY, modifier = "none", x = 400, y = 225) => {
            driver.send({ type: "wheel", x, y, deltaY, modifier });
        },
        env: (patch) => {
            driver.send({ type: "env", env: patch });
        },
        mode: (mode) => {
            driver.send({ type: "mouseMode", mode });
        },
        blur: () => {
            driver.send({ type: "blur" });
        },
        view: (v) => {
            driver.send({ type: "view", view: v });
        },
        remote: (x, y, own = false) => {
            driver.send({ type: "remote", x, y, own });
        },
        frame: () => clock.advance(16),
        advance: (ms) => clock.advance(ms),
        take: (opts = {}) => {
            const out = raw
                .map(fmt)
                .filter((s): s is string => s !== null && (opts.outputs === true || !s.startsWith("out:")));
            raw.length = 0;
            return out;
        },
        ofType: <T extends OutputCommand["type"]>(type: T) => raw.filter((c): c is Extract<OutputCommand, { type: T }> => c.type === type),
        clear: () => {
            raw.length = 0;
        },
    };
}
