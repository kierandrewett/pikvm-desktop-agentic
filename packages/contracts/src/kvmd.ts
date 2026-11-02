/**
 * Messages on kvmd's event socket (`/api/ws`).
 *
 * One WebSocket carries both directions. Client -> server are HID commands,
 * `{event_type, event}` JSON text frames; server -> client are state events in
 * the same envelope. The console already speaks this protocol (src/views/console.js,
 * the `hid` object); these schemas are the typed form the app rebuild imports.
 *
 * What is written down here is what the app reads or sends, not all of kvmd.
 * Behaviour notes cite either the console code that depends on it or
 * agent/docs/PIKVM_API.md, which records what the harness learnt from the Pi.
 */

import { Schema } from "effect";

/* ------------------------------------------------------------------ */
/* Client -> kvmd: HID commands                                        */
/* ------------------------------------------------------------------ */

/** A JS `KeyboardEvent.code` such as `KeyA`, `Digit1`, `ControlLeft`.
 *
 *  kvmd maps physical codes to USB usages itself, so the target's keymap (not
 *  ours) decides the glyph (PIKVM_API.md, "Layout"). The shape check is the
 *  one the macro store applies to stored chords: letters and digits only. */
export const KeyCode = Schema.String.pipe(Schema.pattern(/^[A-Za-z][A-Za-z0-9]{0,23}$/), Schema.brand("KeyCode"));
export type KeyCode = typeof KeyCode.Type;

/** kvmd's absolute pointer range. Fractions of the picture are mapped onto it
 *  as `round(frac * 65534) - 32767` (console.js `fracToNorm`, PIKVM_API.md "Mouse"). */
const AbsoluteCoord = Schema.Int.pipe(Schema.between(-32768, 32767));

/** Per-report relative delta. console.js clamps to +-127 before sending because
 *  that is what kvmd takes in one report (its own UI clamps the same way). */
const RelativeDelta = Schema.Int.pipe(Schema.between(-127, 127));

/** `key`: press (`state: true`) or release one physical key.
 *  Releases must always reach kvmd: a lost release leaves the key held on the
 *  target, so the console never drops them when its offline queue ages out. */
export const KeyCommand = Schema.Struct({
    event_type: Schema.Literal("key"),
    event: Schema.Struct({ key: KeyCode, state: Schema.Boolean }),
});

/** `mouse_move`: absolute pointer position. Only meaningful while the Pi
 *  reports `mouse.absolute === true` (see {@link HidState}). */
export const MouseMoveCommand = Schema.Struct({
    event_type: Schema.Literal("mouse_move"),
    event: Schema.Struct({ to: Schema.Struct({ x: AbsoluteCoord, y: AbsoluteCoord }) }),
});

/** `mouse_button`: press or release a button. Same stuck-key rule as `key`. */
export const MouseButtonCommand = Schema.Struct({
    event_type: Schema.Literal("mouse_button"),
    event: Schema.Struct({
        button: Schema.Literal("left", "right", "middle"),
        state: Schema.Boolean,
    }),
});

/** `mouse_wheel`: scroll. Convention recorded by the harness: `y > 0` scrolls
 *  up and `x > 0` scrolls right (PIKVM_API.md "Mouse"). */
export const MouseWheelCommand = Schema.Struct({
    event_type: Schema.Literal("mouse_wheel"),
    event: Schema.Struct({ delta: Schema.Struct({ x: Schema.Int, y: Schema.Int }) }),
});

/** `mouse_relative`: relative pointer move, for the touch trackpad when the Pi
 *  is in relative mode and for the nudge that wakes a sleeping display, where
 *  an absolute report alone often does not. `squash` lets kvmd merge a burst of
 *  moves into one report; the console always sets it. */
export const MouseRelativeCommand = Schema.Struct({
    event_type: Schema.Literal("mouse_relative"),
    event: Schema.Struct({
        delta: Schema.Struct({ x: RelativeDelta, y: RelativeDelta }),
        squash: Schema.Boolean,
    }),
});

/** `ping`: heartbeat. kvmd answers `pong`; the console pings every 10 s and
 *  treats 25 s of silence from the Pi as a dead socket (console.js `PING_MS`,
 *  `DEAD_MS`), because a phone that slept can leave a socket that reads open
 *  and carries nothing. */
export const PingCommand = Schema.Struct({
    event_type: Schema.Literal("ping"),
    event: Schema.Struct({}),
});

/** Everything the app may send on the event socket. */
export const HidCommand = Schema.Union(
    KeyCommand,
    MouseMoveCommand,
    MouseButtonCommand,
    MouseWheelCommand,
    MouseRelativeCommand,
    PingCommand,
);
export type HidCommand = typeof HidCommand.Type;

/** A release (key up / button up) is the one kind of command that must survive
 *  an offline queue's staleness cutoff. */
export function isRelease(command: HidCommand): boolean {
    return (command.event_type === "key" || command.event_type === "mouse_button") && command.event.state === false;
}

/* ------------------------------------------------------------------ */
/* kvmd -> client: state events                                        */
/* ------------------------------------------------------------------ */

/* kvmd sends the full state of each subsystem when the socket opens and
 * afterwards only what changed, so every field of every event is optional and
 * a consumer merges rather than replaces (console.js comments on `atx` and
 * `hid`: "Deltas are partial"). kvmd marks the end of the initial bundle with
 * a `loop` event (PIKVM_API.md). Fields not listed are ignored on decode. */

const optional = Schema.optional;

/** A set of names as kvmd sends it: a MAP of name -> details (the console's
 *  `fillKeymaps` records that a list was assumed once and broke the keymap
 *  picker), though a plain list is tolerated. The names are the keys or items. */
const NameSet = Schema.Union(Schema.Array(Schema.String), Schema.Record({ key: Schema.String, value: Schema.Unknown }));

const Leds = Schema.Struct({
    caps: optional(Schema.Boolean),
    scroll: optional(Schema.Boolean),
    num: optional(Schema.Boolean),
});

/** `hid`: keyboard LEDs and mouse mode. The console reads the caps LED to keep
 *  its case handling in step with the target, and `mouse.absolute` plus
 *  `mouse.outputs` to choose between absolute and relative pointer commands.
 *  Older kvmd versions put `leds` at the top level instead of under `keyboard`;
 *  the console probes both, so both are modelled. */
export const HidState = Schema.Struct({
    online: optional(Schema.Boolean),
    busy: optional(Schema.Boolean),
    connected: optional(Schema.Boolean),
    keyboard: optional(
        Schema.Struct({
            online: optional(Schema.Boolean),
            leds: optional(Leds),
        }),
    ),
    leds: optional(Leds),
    mouse: optional(
        Schema.Struct({
            online: optional(Schema.Boolean),
            /** false means the Pi is in relative mode. */
            absolute: optional(Schema.Boolean),
            outputs: optional(
                Schema.Struct({
                    /** `usb` (absolute) and/or `usb_rel` (relative). */
                    available: optional(Schema.Array(Schema.String)),
                    active: optional(Schema.String),
                }),
            ),
        }),
    ),
});
export type HidState = typeof HidState.Type;

/** `hid_keymaps`: the layouts kvmd can type with. `POST /api/hid/print` takes
 *  one of these by name, which is why paste uses this list and not our own
 *  US/UK send-side layout. kvmd sends it on every connection. */
export const HidKeymapsState = Schema.Struct({
    keymaps: optional(
        Schema.Struct({
            default: optional(Schema.String),
            available: optional(NameSet),
        }),
    ),
});
export type HidKeymapsState = typeof HidKeymapsState.Type;

/** `atx`: power-control state. */
export const AtxState = Schema.Struct({
    enabled: optional(Schema.Boolean),
    busy: optional(Schema.Boolean),
    leds: optional(Schema.Struct({ power: optional(Schema.Boolean), hdd: optional(Schema.Boolean) })),
});
export type AtxState = typeof AtxState.Type;

/** `streamer`: picture source and the settings dialog's inputs. `features`,
 *  `limits` and `applied` are opaque here: the stream dialog renders whatever
 *  kvmd offers, and kvmd emits a streamer event only when something really
 *  changes (console.js `revertStreamControls`). */
export const StreamerState = Schema.Struct({
    features: optional(Schema.Unknown),
    limits: optional(Schema.Unknown),
    applied: optional(Schema.Unknown),
    streamer: optional(
        Schema.Struct({
            source: optional(
                Schema.Struct({
                    online: optional(Schema.Boolean),
                    resolution: optional(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
                    captured_fps: optional(Schema.Number),
                }),
            ),
        }),
    ),
});
export type StreamerState = typeof StreamerState.Type;

/** `info`: versions, hostname and Pi health (throttling, fan). */
export const InfoState = Schema.Struct({
    health: optional(Schema.Unknown),
    fan: optional(Schema.Unknown),
    system: optional(Schema.Unknown),
    node: optional(Schema.Unknown),
});
export type InfoState = typeof InfoState.Type;

/** `msd`: mass-storage drive. The console hides the whole feature unless
 *  `enabled`. The nested storage and drive objects are rendered as sent. */
export const MsdState = Schema.Struct({
    enabled: optional(Schema.Boolean),
    online: optional(Schema.Boolean),
    busy: optional(Schema.Boolean),
    storage: optional(Schema.Unknown),
    drive: optional(Schema.Unknown),
    features: optional(Schema.Unknown),
});
export type MsdState = typeof MsdState.Type;

/** `gpio`: user GPIO channels (`model`) and their live state (`state`). */
export const GpioState = Schema.Struct({
    model: optional(Schema.Unknown),
    state: optional(Schema.Unknown),
});
export type GpioState = typeof GpioState.Type;

/** `ocr`: whether kvmd can read text off the picture, and in which languages. */
export const OcrState = Schema.Struct({
    enabled: optional(Schema.Boolean),
    langs: optional(
        Schema.Struct({
            default: optional(Schema.Array(Schema.String)),
            available: optional(NameSet),
        }),
    ),
});
export type OcrState = typeof OcrState.Type;

const event = <T extends string, S extends Schema.Schema.Any>(type: T, schema: S) =>
    Schema.Struct({ event_type: Schema.Literal(type), event: schema });

/** The events the app reads, as a union discriminated by `event_type`.
 *  `pong` answers `ping`: any frame from the Pi counts as life, this one
 *  exists so an otherwise quiet socket still has something to say. `loop` ends
 *  the initial state bundle. */
export const KvmdEvent = Schema.Union(
    event("hid", HidState),
    event("hid_keymaps", HidKeymapsState),
    event("atx", AtxState),
    event("streamer", StreamerState),
    event("info", InfoState),
    event("msd", MsdState),
    event("gpio", GpioState),
    event("ocr", OcrState),
    event("pong", Schema.Struct({})),
    event("loop", Schema.Struct({})),
);
export type KvmdEvent = typeof KvmdEvent.Type;

/** The envelope alone, for frames whose `event_type` the app does not model:
 *  kvmd sends more subsystems than the console reads, and an unknown one must
 *  be skipped, not treated as a protocol error. */
export const KvmdEnvelope = Schema.Struct({
    event_type: Schema.String,
    event: Schema.Unknown,
});
export type KvmdEnvelope = typeof KvmdEnvelope.Type;

/** Decode one text frame from the socket: a modelled event, or `null` for any
 *  other well-formed frame or for garbage. Never throws. */
export function decodeKvmdFrame(text: string): KvmdEvent | null {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return null;
    }
    const decoded = Schema.decodeUnknownOption(KvmdEvent)(json);
    return decoded._tag === "Some" ? decoded.value : null;
}
