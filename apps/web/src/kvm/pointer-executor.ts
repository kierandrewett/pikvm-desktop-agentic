/**
 * Turns the pointer machine's commands into things that happen: HID writes on the link, view
 * changes, cursor and lens painting, notices. The machine decides; this obeys, and holds none
 * of the gesture state.
 */

import { CLICK_HOLD_MS, type Clock, type Keyboard, type Notify, type OutputCommand, type TargetLink, type ViewTransform } from "@pikvm/kvm-engine";
import type { Painter } from "./cursor-lens";

export interface ExecutorDeps {
    readonly link: TargetLink;
    readonly keyboard: Keyboard;
    readonly clock: Clock;
    readonly notify: Notify;
    readonly painter: Painter;
    /** The view changed: transform the picture elements and tell whoever draws the zoom button. */
    readonly applyView: (view: ViewTransform) => void;
    /** The hold cue came on: moving now drags, lifting now right-clicks. */
    readonly cue?: () => void;
}

export function createPointerExecutor(deps: ExecutorDeps): (command: OutputCommand) => void {
    const { link, keyboard, clock, painter } = deps;

    return (c) => {
        switch (c.type) {
            case "button":
                link.button(c.button, c.down);
                return;
            case "click":
                // A tap is the only way to Ctrl+click on a phone, so armed sticky modifiers go
                // down first and come up after the button.
                keyboard.withArmedModifiers((release) => {
                    link.button(c.button, true);
                    clock.setTimeout(() => {
                        link.button(c.button, false);
                        release();
                    }, CLICK_HOLD_MS);
                });
                return;
            case "key":
                link.key(c.key, c.down);
                return;
            case "move":
                link.move(c.x, c.y);
                return;
            case "relative":
                link.relative(c.dx, c.dy);
                return;
            case "wheel": {
                if (!c.withMod) {
                    link.wheel(c.dx, c.dy);
                    return;
                }
                // Bare modifiers are never forwarded, so the modifier is wrapped around the wheel.
                // owned(): one the user is physically holding is already down, and releasing it
                // here would drop it under their finger.
                const mine = keyboard.modifiers.owned([c.withMod]);
                for (const m of mine) link.key(m, true);
                link.wheel(c.dx, c.dy);
                for (let i = mine.length - 1; i >= 0; i--) link.key(mine[i] as string, false);
                return;
            }
            case "setMouseOutput":
                link.setMouseOutput(c.absolute);
                return;
            case "view":
                deps.applyView(c.view);
                return;
            case "holdCue":
                // The class itself is toggled by the DOM sink (which vibrates where it can).
                if (c.on) deps.cue?.();
                return;
            case "mouseCursor":
                painter.mouse(c.x, c.y, c.dragging);
                return;
            case "mouseCursorHide":
                painter.hideMouse();
                return;
            case "trackpadCursor":
                painter.trackpad();
                return;
            case "lens":
                painter.lens("distance" in c ? c.distance : undefined);
                return;
            case "capture":
            case "focus":
                // Owned by the DOM sink (it holds the pane and the hidden field).
                return;
            case "notice":
                deps.notify({ text: c.message, error: c.error });
                return;
        }
    };
}
