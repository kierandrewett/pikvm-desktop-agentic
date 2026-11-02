/**
 * What the System dialog says, worked out from the target's reported state: the problem list,
 * the keyboard-and-mouse state, the About line and the GPIO rows. Pure, so every wording and
 * every "unknown is not fine" rule is pinned by a test.
 */

import type { DeviceState } from "@pikvm/kvm-engine";
import { asNumber, asRecord, asString, type Rec } from "./guards";

export interface Problem {
    readonly level: "error" | "warn";
    readonly text: string;
}

function throttleFlag(flags: Rec, name: string, ignorePast: boolean): "now" | "past" | null {
    const flag = asRecord(flags[name]);
    if (!flag) return null;
    if (flag["now"]) return "now";
    if (flag["past"] && !ignorePast) return "past";
    return null;
}

export interface HealthInput {
    readonly device: Pick<DeviceState, "info" | "hid" | "streamerSource">;
    /** The HID socket has reached an outcome (opened or failed) at least once. */
    readonly everSettled: boolean;
    readonly inputOpen: boolean;
}

/** Everything currently wrong, worst first. Empty means nothing to say (not that all is known). */
export function healthProblems({ device, everSettled, inputOpen }: HealthInput): Problem[] {
    const out: Problem[] = [];
    // A fact about this client rather than the Pi: first, because it is the most actionable.
    if (everSettled && !inputOpen) {
        out.push({ level: "error", text: "Keyboard and mouse input is not reaching the PiKVM" });
    }
    const source = asRecord(device.streamerSource);
    if (source && source["online"] === false) out.push({ level: "error", text: "No video signal from the target" });
    const hid = device.hid;
    if (hid && hid.connected === false) {
        out.push({ level: "error", text: "Keyboard and mouse are detached from the target" });
    } else if (hid && hid.online === false) {
        out.push({ level: "error", text: "The Pi's USB keyboard/mouse is offline" });
    }
    const throttling = asRecord(asRecord(asRecord(device.info)?.["health"])?.["throttling"]);
    const flags = asRecord(throttling?.["parsed_flags"]);
    if (throttling && flags) {
        const ignorePast = throttling["ignore_past"] === true;
        const undervolt = throttleFlag(flags, "undervoltage", ignorePast);
        if (undervolt) {
            out.push({
                level: undervolt === "now" ? "error" : "warn",
                text:
                    undervolt === "now"
                        ? "The Pi is undervolted \u2014 check the power supply and cable"
                        : "The Pi was undervolted recently",
            });
        }
        const capped = throttleFlag(flags, "freq_capped", ignorePast);
        if (capped) {
            out.push({
                level: capped === "now" ? "error" : "warn",
                text:
                    capped === "now"
                        ? "The Pi is overheating and has been throttled"
                        : "The Pi was throttled by heat recently",
            });
        }
    }
    const fan = asRecord(asRecord(device.info)?.["fan"]);
    const fanState = asRecord(asRecord(fan?.["state"])?.["fan"]);
    if (fan && fan["monitored"] && fanState) {
        if (!fanState["ok"]) out.push({ level: "error", text: "The Pi's fan has failed" });
        else if ((asNumber(fanState["last_fail_ts"]) ?? -1) >= 0) out.push({ level: "warn", text: "The Pi's fan failed earlier" });
    }
    return out;
}

/** The empty problem list means two things: nothing wrong, or nothing known. */
export function anythingReported(device: Pick<DeviceState, "info" | "hid" | "streamerSource">): boolean {
    return !!(device.info || device.hid || device.streamerSource);
}

export function healthSummary(problems: readonly Problem[], reported: boolean): string | null {
    if (problems.length > 0) return null;
    return reported ? "Everything looks fine." : "Nothing reported from the PiKVM yet.";
}

export interface HidView {
    readonly known: boolean;
    readonly attached: boolean;
    readonly busy: boolean;
    /** "attached", "detached" or "state unknown", with "  ·  busy" appended while the Pi works on it. */
    readonly text: string;
}

/**
 * A board reporting `connected: null` and `online: true` simply publishes no attach flag; an
 * online gadget IS attached as far as the target is concerned. "Unknown" is for boards that
 * say nothing at all.
 */
export function hidView(hid: DeviceState["hid"]): HidView {
    const connected = hid?.connected ?? null;
    const online = hid?.online ?? null;
    const attached = connected === true || (connected === null && online === true);
    const known = connected !== null || online !== null;
    const busy = !!hid?.busy;
    const word = !known ? "state unknown" : attached ? "attached" : "detached";
    return { known, attached, busy, text: busy ? `${word}  \u00b7  busy` : word };
}

/** One line of "what is this Pi": host, board, versions, temperature, fan. */
export function aboutLine(info: DeviceState["info"]): string {
    const root = asRecord(info);
    if (!root) return "";
    const bits: string[] = [];
    const node = asRecord(root["node"]);
    const system = asRecord(root["system"]);
    const host = asString(node?.["host"]) ?? asString(node?.["hostname"]);
    if (host) bits.push(host);
    const model = asString(asRecord(system?.["platform"])?.["model"]);
    if (model) bits.push(`PiKVM ${model}`);
    const kvmd = asString(asRecord(system?.["kvmd"])?.["version"]);
    if (kvmd) bits.push(`kvmd ${kvmd}`);
    const streamer = asRecord(system?.["streamer"]);
    const streamerVersion = asString(streamer?.["version"]);
    if (streamerVersion) bits.push(`${asString(streamer?.["app"]) ?? "streamer"} ${streamerVersion}`);
    const cpu = asNumber(asRecord(asRecord(root["health"])?.["temp"])?.["cpu"]);
    if (cpu !== null) bits.push(`${cpu.toFixed(0)}\u00b0C`);
    const fan = asRecord(root["fan"]);
    const hall = asRecord(asRecord(fan?.["state"])?.["hall"]);
    if (fan?.["monitored"] && hall?.["available"]) bits.push(`${asNumber(hall["rpm"]) ?? 0} rpm`);
    return bits.join("  \u00b7  ");
}

/* ---- GPIO ------------------------------------------------------------ */

const GPIO_LABELS: Readonly<Record<string, string>> = {
    __v3_usb_breaker__: "USB power to the target",
    __v4_locator__: "Locator LED",
};

/** kvmd wraps its built-ins in double underscores; a user channel is plain. */
export function gpioLabel(name: string): string {
    return GPIO_LABELS[name] ?? name.replace(/^__|__$/g, "").replace(/_/g, " ");
}

export interface GpioOutput {
    readonly name: string;
    readonly label: string;
    readonly canSwitch: boolean;
    readonly canPulse: boolean;
    readonly online: boolean;
    readonly on: boolean;
    readonly busy: boolean;
    /** "offline", "busy" or "": the two disable the row alike but only one clears itself. */
    readonly note: string;
}

export function gpioOutputs(gpio: DeviceState["gpio"]): GpioOutput[] {
    const scheme = asRecord(asRecord(asRecord(gpio.model)?.["scheme"])?.["outputs"]);
    if (!scheme) return [];
    const states = asRecord(asRecord(gpio.state)?.["outputs"]);
    return Object.keys(scheme).map((name) => {
        const channel = asRecord(scheme[name]);
        const st = asRecord(states?.[name]);
        const pulse = asRecord(channel?.["pulse"]);
        const online = st?.["online"] !== false;
        const busy = !!st?.["busy"];
        return {
            name,
            label: gpioLabel(name),
            canSwitch: !!channel?.["switch"],
            canPulse: (asNumber(pulse?.["max_delay"]) ?? 0) > 0,
            online,
            on: !!st?.["state"],
            busy,
            note: !online ? "offline" : busy ? "busy" : "",
        };
    });
}

/** Outputs whose stray click costs nothing: they live on the PiKVM and control nothing on the target. */
const GPIO_NO_CONFIRM: Readonly<Record<string, true>> = { __v4_locator__: true };

const GPIO_WARNINGS: Readonly<Record<string, string>> = {
    __v3_usb_breaker__: "The keyboard, mouse and any mounted image disconnect.",
};

export interface Confirmation {
    readonly title: string;
    readonly body: string;
    readonly confirm: string;
}

/**
 * The question before a GPIO action, or null when none is needed. The default is to ASK: an
 * output the console cannot identify is usually a relay on a power or reset button.
 */
export function gpioConfirmation(output: GpioOutput, action: "pulse" | "switch", turningOn: boolean): Confirmation | null {
    if (GPIO_NO_CONFIRM[output.name]) return null;
    const warning = GPIO_WARNINGS[output.name];
    if (action === "pulse") {
        return {
            title: `Pulse \u201c${output.label}\u201d?`,
            body:
                warning ??
                "A pulse is a momentary contact closure. On a relay wired to a power button, that is a press of it.",
            confirm: "Pulse",
        };
    }
    return {
        title: `Turn \u201c${output.label}\u201d ${turningOn ? "on" : "off"}?`,
        body: warning ?? "The console cannot tell what this output is wired to.",
        confirm: turningOn ? "Turn on" : "Turn off",
    };
}

/* ---- ATX ------------------------------------------------------------- */

export type AtxButton = "power" | "power_long" | "reset";

export interface AtxCopy extends Confirmation {
    readonly button: AtxButton;
    readonly label: string;
}

/** The three actions, in the order the real PiKVM UI lists them. Every one can cost unsaved work. */
export const ATX_COPY: Readonly<Record<AtxButton, AtxCopy>> = {
    power: {
        button: "power",
        label: "Power button",
        title: "Press the power button?",
        body: "The target will start up, or shut down cleanly if it is running.",
        confirm: "Press power",
    },
    power_long: {
        button: "power_long",
        label: "Power button (hold 5s)",
        title: "Hold the power button for 5 seconds?",
        body: "This cuts the power without asking the OS. Unsaved work will be lost.",
        confirm: "Hold power",
    },
    reset: {
        button: "reset",
        label: "Reset",
        title: "Press the reset button?",
        body: "The target restarts immediately. Unsaved work will be lost.",
        confirm: "Reset",
    },
};

export interface AtxView {
    readonly available: boolean;
    readonly busy: boolean;
    /** The target's power LED; null when the Pi does not say. */
    readonly powered: boolean | null;
    readonly hdd: boolean | null;
    readonly text: string;
}

export function atxView(atx: DeviceState["atx"]): AtxView {
    const leds = atx?.leds ?? {};
    const powered = typeof leds["power"] === "boolean" ? leds["power"] : null;
    const hdd = typeof leds["hdd"] === "boolean" ? leds["hdd"] : null;
    const bits: string[] = [];
    bits.push(powered === null ? "Power unknown" : powered ? "Power on" : "Power off");
    if (hdd !== null) bits.push(hdd ? "Drive active" : "Drive idle");
    if (atx?.busy) bits.push("busy");
    return { available: !!atx?.enabled, busy: !!atx?.busy, powered, hdd, text: bits.join("  \u00b7  ") };
}
