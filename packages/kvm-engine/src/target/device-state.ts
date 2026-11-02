import { isRecord, type Rec } from "../guards";
import type {
    AtxState,
    GpioState,
    HidStatus,
    InfoState,
    KvmdKeymaps,
    MouseStatus,
    MsdState,
    OcrStatus,
    StreamerSettings,
} from "./wire";

/**
 * The target's state as the event socket reports it: one pure reducer, `applyFrame`.
 *
 * kvmd sends each subsystem whole when the socket opens and then only deltas, so almost
 * every branch MERGES into what is already known rather than replacing it. The merge rules
 * are the ones console.js's atx/msd/health/gpio modules apply, field for field, because a
 * replace where a merge was meant silently blanks fields the Pi did not repeat (an `atx`
 * delta carrying only `busy` must not forget `enabled`).
 *
 * Nothing here reads the clock: the one time-dependent rule (the Caps Lock pending window)
 * takes `now` as an argument.
 */

/** A Caps Lock press is in flight until the LED report confirms it; reports disagreeing in that window are stale. */
export const CAPS_PENDING_MS = 1200;

export interface CapsState {
    /** False until the Pi reports the LED at least once; `on` is then a guess (treated as off). */
    readonly known: boolean;
    readonly on: boolean;
    /** Time (clock ms) until which a disagreeing LED report is the pre-toggle one. 0 when none in flight. */
    readonly pendingUntil: number;
}

export interface DeviceState {
    readonly atx: AtxState | null;
    readonly msd: MsdState | null;
    readonly gpio: GpioState;
    readonly info: InfoState | null;
    /** The HID gadget's flags (`online`, `connected`, `busy`), null until a `hid` event. */
    readonly hid: HidStatus | null;
    /** `streamer.source` of the last streamer event that carried one; the one source/no-signal flag. */
    readonly streamerSource: unknown;
    readonly streamer: StreamerSettings;
    readonly ocr: OcrStatus | null;
    readonly keymaps: KvmdKeymaps | null;
    readonly caps: CapsState;
    /** Num and Scroll Lock LEDs, null until reported. Caps lives in `caps`, which reconciles toggles in flight. */
    readonly leds: { readonly num: boolean | null; readonly scroll: boolean | null };
    readonly mouse: MouseStatus;
}

export const initialDeviceState: DeviceState = {
    atx: null,
    msd: null,
    gpio: { model: null, state: null },
    info: null,
    hid: null,
    streamerSource: null,
    streamer: { features: null, limits: null, applied: null },
    ocr: null,
    keymaps: null,
    caps: { known: false, on: false, pendingUntil: 0 },
    leds: { num: null, scroll: null },
    mouse: { absolute: null, outputs: [] },
};

/** True while a Caps Lock press is awaiting its LED report. */
export function capsPending(state: DeviceState, now: number): boolean {
    return now < state.caps.pendingUntil;
}

/**
 * A Caps Lock press just went out: flip the expected state now, so letters queued behind it
 * resolve their case against the state they will meet. Only from a KNOWN state: toggling an
 * unknown one gives an unknown one, and the LED report that follows is what makes it known.
 */
export function noteCapsToggle(state: DeviceState, now: number): DeviceState {
    if (!state.caps.known) return state;
    return { ...state, caps: { known: true, on: !state.caps.on, pendingUntil: now + CAPS_PENDING_MS } };
}

function applyAtx(state: DeviceState, ed: unknown): DeviceState {
    // A frame with no body resets the module, like console.js's `atx.setState(null)`.
    if (!isRecord(ed)) return { ...state, atx: null };
    const prev = state.atx;
    const next: { enabled?: boolean; busy?: boolean; leds: Rec } = { ...(prev ?? { leds: {} }) };
    if (ed["enabled"] !== undefined) next.enabled = ed["enabled"] as boolean;
    if (ed["busy"] !== undefined) next.busy = ed["busy"] as boolean;
    if (ed["leds"] !== undefined) next.leds = isRecord(ed["leds"]) ? ed["leds"] : {};
    return { ...state, atx: next };
}

function applyMsd(state: DeviceState, ed: unknown): DeviceState {
    if (!isRecord(ed)) return { ...state, msd: null };
    const prev = state.msd;
    const next: { -readonly [K in keyof MsdState]: MsdState[K] } = { ...(prev ?? { storage: {} }) };
    if (ed["enabled"] !== undefined) next.enabled = ed["enabled"] as boolean;
    if (ed["online"] !== undefined) next.online = ed["online"] as boolean;
    if (ed["busy"] !== undefined) next.busy = ed["busy"] as boolean;
    if (ed["drive"]) next.drive = ed["drive"];
    const storage = ed["storage"];
    if (isRecord(storage)) {
        const merged: { -readonly [K in keyof MsdState["storage"]]: MsdState["storage"][K] } = { ...next.storage };
        if (storage["parts"] !== undefined) merged.parts = storage["parts"];
        if (storage["images"] !== undefined) merged.images = storage["images"];
        if (storage["uploading"] !== undefined) merged.uploading = storage["uploading"];
        if (storage["downloading"] !== undefined) merged.downloading = storage["downloading"];
        next.storage = merged;
    }
    return { ...state, msd: next };
}

function applyInfo(state: DeviceState, ed: unknown): DeviceState {
    if (!isRecord(ed)) return state;
    const next: { -readonly [K in keyof InfoState]: InfoState[K] } = { ...(state.info ?? {}) };
    if (ed["health"] !== undefined) next.health = ed["health"];
    if (ed["fan"] !== undefined) next.fan = ed["fan"];
    if (ed["system"] !== undefined) next.system = ed["system"];
    if (ed["node"] !== undefined) next.node = ed["node"];
    return { ...state, info: next };
}

function applyHidStatus(state: DeviceState, ed: unknown): DeviceState {
    if (!isRecord(ed)) return state;
    const next: { -readonly [K in keyof HidStatus]: HidStatus[K] } = { ...(state.hid ?? {}) };
    if (ed["online"] !== undefined) next.online = ed["online"] as boolean;
    if (ed["connected"] !== undefined) next.connected = ed["connected"] as boolean;
    // `busy` arrives in every hid event; dropping it hid that the Pi was mid-reset.
    if (ed["busy"] !== undefined) next.busy = ed["busy"] as boolean;
    return { ...state, hid: next };
}

function applyGpio(state: DeviceState, ed: unknown): DeviceState {
    if (!isRecord(ed)) return state;
    return {
        ...state,
        gpio: {
            model: ed["model"] !== undefined ? ed["model"] : state.gpio.model,
            state: ed["state"] !== undefined ? ed["state"] : state.gpio.state,
        },
    };
}

function applyStreamer(state: DeviceState, ed: unknown): DeviceState {
    if (!isRecord(ed)) return state;
    let streamer = state.streamer;
    if (ed["features"] !== undefined) {
        // kvmd sends limits together with features, so a features update with no limits clears them.
        streamer = { ...streamer, features: ed["features"], limits: ed["limits"] ?? null };
    }
    if (ed["applied"] !== undefined) streamer = { ...streamer, applied: ed["applied"] };
    let next = streamer === state.streamer ? state : { ...state, streamer };
    const inner = ed["streamer"];
    if (isRecord(inner)) next = { ...next, streamerSource: inner["source"] || null };
    return next;
}

function applyOcr(state: DeviceState, ed: unknown): DeviceState {
    if (!isRecord(ed)) return state;
    return { ...state, ocr: { enabled: !!ed["enabled"], langs: ed["langs"] || null } };
}

function applyKeymaps(state: DeviceState, ed: unknown): DeviceState {
    if (!isRecord(ed) || !ed["keymaps"]) return state;
    return { ...state, keymaps: ed["keymaps"] as KvmdKeymaps };
}

/** LEDs and mouse mode are probed on EVERY frame's body, not just `hid`: kvmd versions disagree about where they appear. */
function applyLeds(state: DeviceState, ed: Rec, now: number): DeviceState {
    const keyboard = ed["keyboard"];
    const fromKeyboard = isRecord(keyboard) ? keyboard["leds"] : undefined;
    const leds = fromKeyboard || ed["leds"];
    if (!isRecord(leds)) return state;
    let next = state;
    const caps = leds["caps"];
    if (typeof caps === "boolean") {
        // A report that disagrees with a toggle still in flight is the one from before it;
        // the one after it is on its way.
        const stale = now < state.caps.pendingUntil && caps !== state.caps.on;
        if (!stale) {
            const pendingUntil = caps === state.caps.on ? 0 : state.caps.pendingUntil;
            if (!state.caps.known || state.caps.on !== caps || state.caps.pendingUntil !== pendingUntil) {
                next = { ...next, caps: { known: true, on: caps, pendingUntil } };
            }
        }
    }
    const num = leds["num"];
    const scroll = leds["scroll"];
    const newNum = typeof num === "boolean" ? num : next.leds.num;
    const newScroll = typeof scroll === "boolean" ? scroll : next.leds.scroll;
    if (newNum !== next.leds.num || newScroll !== next.leds.scroll) {
        next = { ...next, leds: { num: newNum, scroll: newScroll } };
    }
    return next;
}

function applyMouse(state: DeviceState, ed: Rec): DeviceState {
    const mouse = ed["mouse"];
    if (!isRecord(mouse)) return state;
    let absolute = state.mouse.absolute;
    let outputs = state.mouse.outputs;
    if (typeof mouse["absolute"] === "boolean") absolute = mouse["absolute"];
    const o = mouse["outputs"];
    if (isRecord(o)) {
        const available = o["available"];
        if (Array.isArray(available)) outputs = available.filter((x): x is string => typeof x === "string");
        // Fall back to the active-output name when `absolute` is not reported.
        if (absolute === null && typeof o["active"] === "string") absolute = o["active"] === "usb";
    }
    if (absolute === state.mouse.absolute && outputs === state.mouse.outputs) return state;
    return { ...state, mouse: { absolute, outputs } };
}

/** Fold one decoded socket frame into the state. Unknown or malformed frames change nothing. */
export function applyFrame(state: DeviceState, frame: unknown, now: number): DeviceState {
    if (!isRecord(frame)) return state;
    const type = frame["event_type"];
    const ed = frame["event"];
    let next = state;
    if (type === "atx") next = applyAtx(next, ed);
    else if (type === "hid_keymaps") next = applyKeymaps(next, ed);
    else if (type === "streamer") next = applyStreamer(next, ed);
    else if (type === "info") next = applyInfo(next, ed);
    else if (type === "hid") next = applyHidStatus(next, ed);
    else if (type === "msd") next = applyMsd(next, ed);
    else if (type === "gpio") next = applyGpio(next, ed);
    else if (type === "ocr") next = applyOcr(next, ed);
    if (isRecord(ed)) {
        next = applyLeds(next, ed, now);
        next = applyMouse(next, ed);
    }
    return next;
}
