// The machine plus a clock: stamps inputs with the time, fulfils the machine's
// timer and frame requests, and forwards everything else to a sink.
//
// The only side effect in the pointer path that is not a command is time itself, and
// it comes through the engine's Clock port, so tests run whole gestures on a manual
// clock with no real timers.

import type { CancelTimer, Clock } from "../clock";
import { IDENTITY_VIEW } from "../view/transform";
import type { ViewTransform } from "../view/transform";
import { PointerMachine } from "./machine";
import type { PointerMachineOptions } from "./machine";
import { DEFAULT_ENV, FRAME_MS } from "./types";
import type { OutputCommand, PointerCommand, PointerEnv, PointerInputInit } from "./types";

export interface PointerDriverOptions extends PointerMachineOptions {
    readonly clock: Clock;
    /** Receives every command that is not a timer or frame request, in order. */
    readonly sink: (command: OutputCommand) => void;
    readonly env?: PointerEnv;
    readonly view?: ViewTransform;
}

export interface PointerDriver {
    readonly machine: PointerMachine;
    /** Feed one input; returns whether the DOM event's default action must be prevented. */
    send(input: PointerInputInit): { readonly preventDefault: boolean };
    /** Cancel every pending timer. */
    dispose(): void;
}

export function createPointerDriver(opts: PointerDriverOptions): PointerDriver {
    const { clock, sink } = opts;
    const machine = new PointerMachine(opts.env ?? DEFAULT_ENV, opts.view ?? IDENTITY_VIEW, opts);
    const timers = new Map<string, CancelTimer>();
    let disposed = false;
    let frame: CancelTimer | null = null;

    const cancel = (id: string): void => {
        const c = timers.get(id);
        if (!c) return;
        timers.delete(id);
        c();
    };

    const run = (command: PointerCommand): void => {
        switch (command.type) {
            case "startTimer": {
                cancel(command.id);
                const id = command.id;
                timers.set(
                    id,
                    clock.setTimeout(() => {
                        timers.delete(id);
                        send({ type: "timer", id });
                    }, command.ms),
                );
                return;
            }
            case "cancelTimer":
                cancel(command.id);
                return;
            case "requestFrame":
                if (frame) return;
                frame = clock.setTimeout(() => {
                    frame = null;
                    send({ type: "frame" });
                }, FRAME_MS);
                return;
            default:
                sink(command);
        }
    };

    function send(input: PointerInputInit): { readonly preventDefault: boolean } {
        if (disposed) return { preventDefault: false };
        const out = machine.handle({ ...input, t: clock.now() } as Parameters<PointerMachine["handle"]>[0]);
        for (const c of out.commands) run(c);
        return { preventDefault: out.preventDefault };
    }

    return {
        machine,
        send,
        dispose() {
            disposed = true;
            for (const c of timers.values()) c();
            timers.clear();
            if (frame) frame();
            frame = null;
        },
    };
}
