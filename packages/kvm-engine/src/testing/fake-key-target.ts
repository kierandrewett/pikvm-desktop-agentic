import type { KeyboardTarget } from "../input/keyboard/keyboard";

/**
 * A stand-in for the kvmd link as the keyboard sees it: records every HID key write in order
 * (with the time it happened) and models the target's Caps Lock the way the link does.
 */
export class FakeKeyTarget implements KeyboardTarget {
    /** `"KeyA:down"` / `"KeyA:up"` in send order. */
    readonly events: string[] = [];
    readonly times: number[] = [];
    known = true;
    on = false;
    pending = false;
    toggles = 0;

    constructor(private readonly now: () => number = () => 0) {}

    key(code: string, down: boolean): void {
        this.events.push(`${code}:${down ? "down" : "up"}`);
        this.times.push(this.now());
    }

    capsKnown(): boolean {
        return this.known;
    }

    capsOn(): boolean {
        return this.on;
    }

    capsPending(): boolean {
        return this.pending;
    }

    noteCapsToggle(): void {
        this.toggles++;
        if (!this.known) return;
        this.on = !this.on;
        this.pending = true;
    }

    /** The Pi's LED report arrives. */
    reportCaps(on: boolean): void {
        this.known = true;
        this.on = on;
        this.pending = false;
    }

    clear(): void {
        this.events.length = 0;
        this.times.length = 0;
    }
}
