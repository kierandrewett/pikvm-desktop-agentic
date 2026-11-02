/**
 * What the engine sends to and reads from kvmd's event socket (`/api/ws`).
 *
 * These are deliberately lenient structural types, not Schemas. console.js probes every
 * event defensively because kvmd's shapes vary by version (LEDs sit under `keyboard.leds` on
 * new builds and at the top level on old ones, `hid_keymaps.available` is a MAP of name to
 * details but a list of names is accepted too), and a strict decode that rejected one odd
 * frame would silence a whole subsystem. The Effect Schemas in @pikvm/contracts describe the
 * canonical protocol; this file is the tolerant reader the HID path actually runs on.
 */

export type MouseButton = "left" | "right" | "middle";

/** A frame as kvmd sends it, before any event-specific reading. */
export interface WireFrame {
    readonly event_type?: unknown;
    readonly event?: unknown;
}

/** Client -> kvmd. */
export type HidCommand =
    | { readonly event_type: "key"; readonly event: { readonly key: string; readonly state: boolean } }
    | {
          readonly event_type: "mouse_move";
          readonly event: { readonly to: { readonly x: number; readonly y: number } };
      }
    | { readonly event_type: "mouse_button"; readonly event: { readonly button: MouseButton; readonly state: boolean } }
    | {
          readonly event_type: "mouse_wheel";
          readonly event: { readonly delta: { readonly x: number; readonly y: number } };
      }
    | {
          readonly event_type: "mouse_relative";
          readonly event: { readonly delta: { readonly x: number; readonly y: number }; readonly squash: boolean };
      }
    | { readonly event_type: "ping"; readonly event: Record<string, never> };

/**
 * A key or button going UP is never dropped, however old.
 *
 * If the down went out before the socket died and the up is dropped as stale, the target
 * holds that key forever, which is far worse than losing a character.
 */
export function isRelease(command: HidCommand): boolean {
    return (command.event_type === "key" || command.event_type === "mouse_button") && command.event.state === false;
}

/** kvmd's keymap set: `available` is a map of name -> details, or (tolerated) a list of names. */
export interface KvmdKeymaps {
    readonly default?: string;
    readonly available?: Readonly<Record<string, unknown>> | readonly string[];
}

/** `{enabled, busy, leds:{power, hdd}}`; absent until the Pi says. */
export interface AtxState {
    readonly enabled?: boolean;
    readonly busy?: boolean;
    readonly leds: Readonly<Record<string, unknown>>;
}

export interface MsdStorage {
    readonly parts?: unknown;
    readonly images?: unknown;
    readonly uploading?: unknown;
    readonly downloading?: unknown;
}

export interface MsdState {
    readonly enabled?: boolean;
    readonly online?: boolean;
    readonly busy?: boolean;
    readonly drive?: unknown;
    readonly storage: MsdStorage;
}

export interface GpioState {
    readonly model: unknown;
    readonly state: unknown;
}

/** `info` event: versions, hostname, throttling, fan. Opaque pieces are rendered as sent. */
export interface InfoState {
    readonly health?: unknown;
    readonly fan?: unknown;
    readonly system?: unknown;
    readonly node?: unknown;
}

/** The HID gadget's own flags, from the `hid` event. */
export interface HidStatus {
    readonly online?: boolean;
    readonly connected?: boolean;
    readonly busy?: boolean;
}

export interface StreamerSettings {
    readonly features: unknown;
    readonly limits: unknown;
    readonly applied: unknown;
}

export interface OcrStatus {
    readonly enabled: boolean;
    readonly langs: unknown;
}

/** Target mouse mode. `absolute` is null until the Pi has said. */
export interface MouseStatus {
    readonly absolute: boolean | null;
    /** Available outputs, e.g. `["usb", "usb_rel"]`. */
    readonly outputs: readonly string[];
}
