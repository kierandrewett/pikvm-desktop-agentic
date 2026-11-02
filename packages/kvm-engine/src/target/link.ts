import { Deferred, Duration, Effect, Fiber, Schedule } from "effect";
import { systemClock, toEffectClock, type Clock } from "../clock/index";
import type { HttpPort } from "../http";
import { createStore, type ReadableStore } from "../store";
import {
    applyFrame,
    capsPending,
    initialDeviceState,
    noteCapsToggle as deviceNoteCapsToggle,
    type DeviceState,
} from "./device-state";
import { createOutboundQueue } from "./outbound-queue";
import type { KvmSocket, SocketFactory } from "./ports";
import type { HidCommand, MouseButton } from "./wire";

/**
 * The kvmd link: one event socket, the single source of truth for device state and the only
 * way HID commands leave the engine.
 *
 * Plain on the outside (`start`, `send`, `store.subscribe`), Effect on the inside. The
 * lifetime of each socket is a Scope (its finalizer closes the socket, so interrupting a
 * session can never leak one), the reconnect wait is a Schedule driver, and the heartbeat is
 * a scoped fiber that dies with its socket.
 *
 * Everything about a connection is guarded by the ATTEMPT that owns it. A socket that was
 * abandoned because it looked open but was dead can deliver its close after its replacement
 * is up; acted on, that close would mark the live socket closed and start a pointless
 * retry. Handlers therefore check they still belong to the current attempt before touching
 * anything.
 */

export interface LinkTiming {
    /** Backoff before the next attempt after a failed or dropped one: first wait. */
    readonly retryMinMs: number;
    /** ...growth per consecutive failure. */
    readonly retryFactor: number;
    /** ...ceiling. The console is the only way to drive the target, so recovery beats Pi load. */
    readonly retryMaxMs: number;
    /** Heartbeat period; kvmd answers `ping` with `pong`. */
    readonly pingMs: number;
    /** Silence (no frame of any kind) after which the socket is declared dead and replaced. */
    readonly deadMs: number;
    /** Minimum gap between mouse-output switch requests while one applies. */
    readonly outputSwitchMs: number;
}

export const defaultLinkTiming: LinkTiming = {
    retryMinMs: 1200,
    retryFactor: 1.7,
    retryMaxMs: 5000,
    pingMs: 10_000,
    deadMs: 25_000,
    outputSwitchMs: 1500,
};

export interface LinkStatus {
    readonly open: boolean;
    /** A socket exists and has not yet opened or failed. */
    readonly connecting: boolean;
    /**
     * Whether any attempt has ever reached a definite outcome (opened, refused or dropped).
     * "Not open" means two different things: still making the very first connection, which
     * is normal and already has a "Connecting" overlay, or an attempt that has actually
     * resolved. Only the second is worth reporting, and input is equally dead either way.
     */
    readonly everSettled: boolean;
}

export interface TargetState {
    readonly link: LinkStatus;
    readonly device: DeviceState;
}

export interface TargetLinkOptions {
    readonly url: string | (() => string);
    readonly socket: SocketFactory;
    readonly http: HttpPort;
    readonly clock?: Clock;
    readonly timing?: Partial<LinkTiming>;
}

export interface TargetLink {
    readonly store: ReadableStore<TargetState>;
    /** Begin connecting and keep connected. Idempotent. */
    start(): void;
    /** Close the socket and stop reconnecting for good. */
    stop(): Promise<void>;
    /** Connect now if not open or connecting (backoff is cut short, not reset). */
    connect(): void;
    /**
     * Drop the current socket and connect afresh, backoff reset. For a page coming back from
     * the background: iOS can keep a socket that still reads open but carries nothing, and
     * taps sent into it vanish until its timeout, a minute on.
     */
    kick(): void;
    isOpen(): boolean;
    send(command: HidCommand): void;
    key(code: string, down: boolean): void;
    move(x: number, y: number): void;
    button(button: MouseButton, down: boolean): void;
    wheel(dx: number, dy: number): void;
    /** Relative move, clamped to kvmd's per-report range; (0, 0) sends nothing. */
    relative(dx: number, dy: number): void;
    capsOn(): boolean;
    /** Whether the Pi has ever reported the Caps LED (so `capsOn` can be trusted). */
    capsKnown(): boolean;
    /** True between sending a Caps Lock press and the LED report confirming it. */
    capsPending(): boolean;
    noteCapsToggle(): void;
    isAbsolute(): boolean;
    isRelative(): boolean;
    relativeAvailable(): boolean;
    /**
     * Switch the Pi's mouse output to absolute ("usb") or relative ("usb_rel"). A no-op while
     * the mode is unknown, already right, or the output does not exist, and at most one
     * request per `outputSwitchMs` while a change applies (the hid event that follows flips
     * the mode), so every caller can ask on every move without flooding the Pi.
     */
    setMouseOutput(wantAbsolute: boolean): void;
}

type End = "closed" | "dead";
type WakeKind = "kick" | "connect";

interface Attempt {
    socket: KvmSocket | null;
    lastRx: number;
    opened: boolean;
    readonly ended: Deferred.Deferred<End>;
    readonly openSignal: Deferred.Deferred<void>;
}

/**
 * Wake-ups for the reconnect loop. A request posted while the loop is between awaits (no
 * waiter registered) is kept as pending rather than lost; a kick outranks a connect.
 */
class Wake {
    private pending: WakeKind | null = null;
    private waiter: { deferred: Deferred.Deferred<WakeKind>; accepts: (k: WakeKind) => boolean } | null = null;

    post(kind: WakeKind): void {
        const w = this.waiter;
        if (w?.accepts(kind)) {
            this.waiter = null;
            Deferred.unsafeDone(w.deferred, Effect.succeed(kind));
            return;
        }
        if (this.pending !== "kick") this.pending = kind;
    }

    /** Forget a connect request made while an attempt was already being started. */
    dropConnect(): void {
        if (this.pending === "connect") this.pending = null;
    }

    wait(accepts: (k: WakeKind) => boolean): Effect.Effect<WakeKind> {
        return Effect.suspend(() => {
            if (this.pending !== null && accepts(this.pending)) {
                const kind = this.pending;
                this.pending = null;
                return Effect.succeed(kind);
            }
            return Effect.flatMap(Deferred.make<WakeKind>(), (deferred) =>
                Effect.suspend(() => {
                    this.waiter = { deferred, accepts };
                    return Deferred.await(deferred);
                }).pipe(Effect.ensuring(Effect.sync(() => (this.waiter = null)))),
            );
        });
    }
}

const PING: HidCommand = { event_type: "ping", event: {} };

export function createTargetLink(options: TargetLinkOptions): TargetLink {
    const timing: LinkTiming = { ...defaultLinkTiming, ...options.timing };
    const clock = options.clock ?? systemClock;
    const store = createStore<TargetState>({
        link: { open: false, connecting: false, everSettled: false },
        device: initialDeviceState,
    });
    const queue = createOutboundQueue();
    const wake = new Wake();

    let current: Attempt | null = null;
    let fiber: Fiber.RuntimeFiber<void> | null = null;
    let stopped = false;

    let outputSwitchAt = Number.NEGATIVE_INFINITY;
    let outputSwitchBusy = false;

    const link = (): LinkStatus => store.getState().link;
    const patchLink = (patch: Partial<LinkStatus>): void => {
        const prev = store.getState();
        const next = { ...prev.link, ...patch };
        if (next.open === prev.link.open && next.connecting === prev.link.connecting && next.everSettled === prev.link.everSettled) {
            return;
        }
        store.setState({ ...prev, link: next });
    };
    const patchDevice = (update: (d: DeviceState) => DeviceState): void => {
        const prev = store.getState();
        const device = update(prev.device);
        if (device !== prev.device) store.setState({ ...prev, device });
    };

    const raw = (attempt: Attempt, command: HidCommand): void => {
        try {
            attempt.socket?.send(JSON.stringify(command));
        } catch {
            // A send into a socket that just died is lost by definition; the close will follow.
        }
    };

    const resolveUrl = (): string => (typeof options.url === "function" ? options.url() : options.url);

    const openSocket = (attempt: Attempt): void => {
        const live = (): boolean => current === attempt;
        try {
            attempt.socket = options.socket(resolveUrl(), {
                open() {
                    if (!live()) return;
                    attempt.opened = true;
                    attempt.lastRx = clock.now();
                    patchLink({ open: true, connecting: false, everSettled: true });
                    Deferred.unsafeDone(attempt.openSignal, Effect.void);
                    for (const command of queue.drain(clock.now())) raw(attempt, command);
                },
                message(data) {
                    if (!live()) return;
                    attempt.lastRx = clock.now();
                    let frame: unknown;
                    try {
                        frame = JSON.parse(data);
                    } catch {
                        return;
                    }
                    patchDevice((d) => applyFrame(d, frame, clock.now()));
                },
                close() {
                    if (!live()) return;
                    // A refused connection closes too, which is exactly the signal wanted: the
                    // attempt resolved, and the answer was no.
                    patchLink({ open: false, connecting: false, everSettled: true });
                    Deferred.unsafeDone(attempt.ended, Effect.succeed("closed"));
                },
                error() {
                    if (!live()) return;
                    try {
                        attempt.socket?.close();
                    } catch {
                        // already gone
                    }
                },
            });
        } catch {
            // The constructor refused (bad URL, blocked scheme): an attempt that failed
            // before it began, retried on the backoff like any other.
            if (!live()) return;
            patchLink({ connecting: false });
            Deferred.unsafeDone(attempt.ended, Effect.succeed("closed"));
        }
    };

    /** A socket can die without closing (a phone that slept, a path change, a proxy that drops idle connections). */
    const heartbeat = (attempt: Attempt): Effect.Effect<void> =>
        Effect.gen(function* () {
            yield* Deferred.await(attempt.openSignal);
            for (;;) {
                yield* Effect.sleep(Duration.millis(timing.pingMs));
                if (clock.now() - attempt.lastRx > timing.deadMs) {
                    Deferred.unsafeDone(attempt.ended, Effect.succeed("dead"));
                    return;
                }
                raw(attempt, PING);
            }
        });

    const session = (attempt: Attempt): Effect.Effect<End> =>
        Effect.scoped(
            Effect.gen(function* () {
                yield* Effect.acquireRelease(Effect.sync(() => openSocket(attempt)), () =>
                    Effect.sync(() => {
                        try {
                            attempt.socket?.close();
                        } catch {
                            // already gone
                        }
                    }),
                );
                yield* Effect.forkScoped(heartbeat(attempt));
                return yield* Deferred.await(attempt.ended);
            }),
        );

    const backoff = Schedule.exponential(Duration.millis(timing.retryMinMs), timing.retryFactor).pipe(
        // Rounded like the console's own curve, then capped.
        Schedule.modifyDelay((_out, delay) => Duration.millis(Math.min(Math.round(Duration.toMillis(delay)), timing.retryMaxMs))),
    );

    const program = Effect.gen(function* () {
        const driver = yield* Schedule.driver(backoff);
        for (;;) {
            wake.dropConnect();
            const attempt: Attempt = {
                socket: null,
                lastRx: clock.now(),
                opened: false,
                ended: yield* Deferred.make<End>(),
                openSignal: yield* Deferred.make<void>(),
            };
            current = attempt;
            patchLink({ connecting: true });
            const result = yield* Effect.raceFirst(
                session(attempt),
                Effect.map(
                    wake.wait((k) => k === "kick"),
                    () => "kick" as const,
                ),
            );
            current = null;
            // Whatever ended it, nothing is open and nothing is connecting now.
            patchLink({ open: false, connecting: false });
            if (result !== "closed") {
                // Replaced on purpose (kicked, or silent for too long): straight back, backoff reset.
                yield* driver.reset;
                continue;
            }
            if (attempt.opened) yield* driver.reset;
            const woke = yield* Effect.raceFirst(
                Effect.map(Effect.ignore(driver.next(undefined)), () => "timer" as const),
                wake.wait(() => true),
            );
            if (woke === "kick") yield* driver.reset;
        }
    });

    const start = (): void => {
        if (fiber || stopped) return;
        fiber = Effect.runFork(program.pipe(Effect.withClock(toEffectClock(clock))));
    };

    const connect = (): void => {
        if (stopped) return;
        const status = link();
        if (status.open || status.connecting) return;
        if (!fiber) start();
        else wake.post("connect");
    };

    const send = (command: HidCommand): void => {
        const attempt = current;
        if (link().open && attempt?.socket?.isOpen()) {
            raw(attempt, command);
            return;
        }
        queue.push(command, clock.now());
        connect();
    };

    return {
        store,
        start,
        async stop() {
            stopped = true;
            const running = fiber;
            fiber = null;
            if (running) await Effect.runPromise(Fiber.interrupt(running));
            current = null;
            patchLink({ open: false, connecting: false });
        },
        connect,
        kick() {
            if (stopped) return;
            if (!fiber) start();
            else wake.post("kick");
        },
        isOpen: () => link().open,
        send,
        key: (code, down) => send({ event_type: "key", event: { key: code, state: !!down } }),
        move: (x, y) => send({ event_type: "mouse_move", event: { to: { x, y } } }),
        button: (button, down) => send({ event_type: "mouse_button", event: { button, state: !!down } }),
        wheel: (dx, dy) => send({ event_type: "mouse_wheel", event: { delta: { x: dx, y: dy } } }),
        relative(dx, dy) {
            // kvmd takes -127..127 per report; `squash` lets it merge a burst.
            const x = Math.max(-127, Math.min(127, Math.round(dx)));
            const y = Math.max(-127, Math.min(127, Math.round(dy)));
            if (!x && !y) return;
            send({ event_type: "mouse_relative", event: { delta: { x, y }, squash: true } });
        },
        capsOn: () => store.getState().device.caps.on,
        capsKnown: () => store.getState().device.caps.known,
        capsPending: () => capsPending(store.getState().device, clock.now()),
        noteCapsToggle: () => patchDevice((d) => deviceNoteCapsToggle(d, clock.now())),
        isAbsolute: () => store.getState().device.mouse.absolute === true,
        isRelative: () => store.getState().device.mouse.absolute === false,
        relativeAvailable: () => store.getState().device.mouse.outputs.includes("usb_rel"),
        setMouseOutput(wantAbsolute) {
            const { absolute, outputs } = store.getState().device.mouse;
            if (absolute === null || absolute === wantAbsolute) return;
            const output = wantAbsolute ? "usb" : "usb_rel";
            if (!outputs.includes(output)) return;
            const now = clock.now();
            if (outputSwitchBusy || now - outputSwitchAt < timing.outputSwitchMs) return;
            outputSwitchAt = now;
            outputSwitchBusy = true;
            options.http
                .request({ method: "POST", path: `/api/hid/set_params?mouse_output=${output}` })
                .catch(() => undefined)
                .then(() => {
                    outputSwitchBusy = false;
                });
        },
    };
}
