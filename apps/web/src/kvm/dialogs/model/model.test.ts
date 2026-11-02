import { applyFrame, initialDeviceState, type DeviceState } from "@pikvm/kvm-engine";
import { describe, expect, it } from "vitest";
import { humanBytes } from "./guards";
import {
    aboutLine,
    anythingReported,
    ATX_COPY,
    atxView,
    gpioConfirmation,
    gpioLabel,
    gpioOutputs,
    healthProblems,
    healthSummary,
    hidView,
} from "./health";
import { capLog, LOG_MAX_LINES, logPath } from "./log";
import {
    fromStored,
    isPinned,
    macroWouldPersist,
    moveStep,
    newMacro,
    newStep,
    persistable,
    removeStep,
    stepWouldPersist,
    toggleMod,
    unsavedNote,
    type DraftMacro,
} from "./macros";
import { msdControls, msdFree, msdImages, msdSummary, msdTransfer } from "./msd";
import { streamParamPath, streamView } from "./stream";

// Failure modes in ../FAILURE_MODES.md (numbers in the describe titles).

function device(...frames: Array<[string, unknown]>): DeviceState {
    return frames.reduce((s, [type, event]) => applyFrame(s, { event_type: type, event }, 0), initialDeviceState);
}

const info = (health: unknown, extra: Record<string, unknown> = {}) => ["info", { health, ...extra }] as [string, unknown];

describe("health problems (17, 18)", () => {
    const open = { everSettled: true, inputOpen: true };

    it("is empty and says 'nothing reported' until the Pi has said anything", () => {
        const d = device();
        expect(healthProblems({ device: d, ...open })).toEqual([]);
        expect(anythingReported(d)).toBe(false);
        expect(healthSummary([], anythingReported(d))).toBe("Nothing reported from the PiKVM yet.");
    });

    it("says everything is fine only once something was reported and nothing is wrong", () => {
        const d = device(["hid", { online: true, connected: true }]);
        expect(healthSummary(healthProblems({ device: d, ...open }), anythingReported(d))).toBe("Everything looks fine.");
    });

    it("lists input not reaching the Pi first, only once the socket has settled and is down", () => {
        const d = device(["streamer", { streamer: { source: { online: false } } }]);
        expect(healthProblems({ device: d, everSettled: false, inputOpen: false }).map((p) => p.text)).toEqual([
            "No video signal from the target",
        ]);
        expect(healthProblems({ device: d, everSettled: true, inputOpen: false }).map((p) => p.text)).toEqual([
            "Keyboard and mouse input is not reaching the PiKVM",
            "No video signal from the target",
        ]);
    });

    it("reads detached before offline for the HID, and undervoltage now as an error but past as a warning", () => {
        const throttling = (now: boolean, past: boolean) => ({
            throttling: {
                parsed_flags: { undervoltage: { now, past }, freq_capped: { now: false, past: true } },
                ignore_past: false,
            },
        });
        const now = device(["hid", { connected: false, online: false }], info(throttling(true, true)));
        expect(healthProblems({ device: now, ...open })).toEqual([
            { level: "error", text: "Keyboard and mouse are detached from the target" },
            { level: "error", text: "The Pi is undervolted \u2014 check the power supply and cable" },
            { level: "warn", text: "The Pi was throttled by heat recently" },
        ]);
        const past = device(info(throttling(false, true)));
        expect(healthProblems({ device: past, ...open })[0]).toEqual({ level: "warn", text: "The Pi was undervolted recently" });
        const offline = device(["hid", { online: false }]);
        expect(healthProblems({ device: offline, ...open })[0]?.text).toBe("The Pi's USB keyboard/mouse is offline");
    });

    it("ignores the past when kvmd says to", () => {
        const d = device(
            info({ throttling: { parsed_flags: { undervoltage: { now: false, past: true } }, ignore_past: true } }),
        );
        expect(healthProblems({ device: d, ...open })).toEqual([]);
    });

    it("reports a failed and an earlier-failed fan", () => {
        const fan = (ok: boolean, last: number) => ({
            fan: { monitored: true, state: { fan: { ok, last_fail_ts: last } } },
        });
        expect(healthProblems({ device: device(["info", fan(false, 5)]), ...open })[0]).toEqual({
            level: "error",
            text: "The Pi's fan has failed",
        });
        expect(healthProblems({ device: device(["info", fan(true, 5)]), ...open })[0]).toEqual({
            level: "warn",
            text: "The Pi's fan failed earlier",
        });
        expect(healthProblems({ device: device(["info", fan(true, -1)]), ...open })).toEqual([]);
    });
});

describe("keyboard and mouse state (19)", () => {
    it("an online gadget with no attach flag is attached", () => {
        expect(hidView({ online: true, connected: undefined as never })).toMatchObject({ known: true, attached: true });
        expect(hidView(device(["hid", { online: true }]).hid)).toMatchObject({ attached: true, text: "attached" });
    });

    it("unknown only when the Pi says nothing; detached and busy are said", () => {
        expect(hidView(null)).toMatchObject({ known: false, text: "state unknown" });
        expect(hidView({ connected: false })).toMatchObject({ known: true, attached: false, text: "detached" });
        expect(hidView({ connected: true, busy: true }).text).toBe("attached  \u00b7  busy");
    });
});

describe("About line", () => {
    it("joins what the Pi reports and says nothing for no info", () => {
        expect(aboutLine(null)).toBe("");
        const d = device([
            "info",
            {
                node: { hostname: "kvm1" },
                system: { kvmd: { version: "4.1" }, streamer: { app: "ustreamer", version: "6.0" } },
                health: { temp: { cpu: 45.4 } },
            },
        ]);
        expect(aboutLine(d.info)).toBe("kvm1  \u00b7  kvmd 4.1  \u00b7  ustreamer 6.0  \u00b7  45\u00b0C");
    });
});

describe("GPIO (20, 21)", () => {
    const gpioDevice = (state: Record<string, unknown>) =>
        device([
            "gpio",
            {
                model: {
                    scheme: {
                        outputs: {
                            relay0: { switch: true, pulse: { max_delay: 10 } },
                            __v3_usb_breaker__: { switch: true, pulse: { max_delay: 0 } },
                            __v4_locator__: { switch: true },
                        },
                    },
                },
                state: { outputs: state },
            },
        ]);

    it("labels built-ins by name and user channels from their id", () => {
        expect(gpioLabel("__v3_usb_breaker__")).toBe("USB power to the target");
        expect(gpioLabel("rack_pdu_1")).toBe("rack pdu 1");
        expect(gpioLabel("__odd_one__")).toBe("odd one");
    });

    it("reads capabilities and says offline or busy, which both disable the row", () => {
        const outs = gpioOutputs(
            gpioDevice({ relay0: { online: true, state: true }, __v3_usb_breaker__: { online: false }, __v4_locator__: { busy: true } }).gpio,
        );
        expect(outs.map((o) => [o.name, o.canSwitch, o.canPulse, o.on, o.note])).toEqual([
            ["relay0", true, true, true, ""],
            ["__v3_usb_breaker__", true, false, false, "offline"],
            ["__v4_locator__", true, false, false, "busy"],
        ]);
    });

    it("no model means no outputs", () => {
        expect(gpioOutputs(initialDeviceState.gpio)).toEqual([]);
    });

    it("asks before every channel except the locator, with the USB breaker's own warning", () => {
        const [relay, breaker, locator] = gpioOutputs(gpioDevice({}).gpio);
        expect(gpioConfirmation(locator!, "switch", true)).toBeNull();
        expect(gpioConfirmation(relay!, "pulse", false)?.body).toContain("press of it");
        expect(gpioConfirmation(relay!, "switch", true)).toMatchObject({
            title: "Turn \u201crelay0\u201d on?",
            confirm: "Turn on",
        });
        expect(gpioConfirmation(breaker!, "switch", false)?.body).toContain("keyboard, mouse and any mounted image");
    });
});

describe("ATX (6, 22)", () => {
    it("every action has a consequence in words", () => {
        expect(Object.keys(ATX_COPY)).toEqual(["power", "power_long", "reset"]);
        for (const copy of Object.values(ATX_COPY)) {
            expect(copy.title.endsWith("?")).toBe(true);
            expect(copy.body.length).toBeGreaterThan(20);
        }
        expect(ATX_COPY.power_long.body).toContain("Unsaved work will be lost");
    });

    it("reads the LEDs as text and is unavailable without wiring", () => {
        expect(atxView(null)).toMatchObject({ available: false, text: "Power unknown" });
        const d = device(["atx", { enabled: true, busy: false, leds: { power: true, hdd: false } }]);
        expect(atxView(d.atx)).toMatchObject({ available: true, powered: true, text: "Power on  \u00b7  Drive idle" });
        expect(atxView(device(["atx", { enabled: true, busy: true, leds: { power: false } }]).atx).text).toBe(
            "Power off  \u00b7  busy",
        );
    });
});

describe("mass storage (23, 24)", () => {
    const base = {
        enabled: true,
        online: true,
        busy: false,
        drive: { image: { name: "a.iso", size: 1024 ** 3, in_storage: true, removable: true }, cdrom: true, rw: false, connected: false },
        storage: {
            parts: { "": { size: 8 * 1024 ** 3, free: 7 * 1024 ** 3 } },
            images: { "a.iso": { size: 100, mod_ts: 1 }, "b.iso": { size: 2048, mod_ts: 2 } },
        },
    };

    it("does not claim there is no drive before the first event", () => {
        expect(msdSummary(null)).toBe("Checking the drive\u2026");
        expect(msdSummary(device(["msd", { enabled: false }]).msd)).toBe("This PiKVM has no mass storage.");
        expect(msdSummary(device(["msd", { enabled: true, online: false }]).msd)).toBe("The drive is offline.");
    });

    it("says what is selected, mounted and busy", () => {
        expect(msdSummary(device(["msd", base]).msd)).toBe("Ready to mount a.iso (1.0 GB).");
        const mounted = device(["msd", { ...base, drive: { ...base.drive, connected: true, rw: true, cdrom: false } }]);
        expect(msdSummary(mounted.msd)).toBe("Mounted on the target: a.iso as a flash drive, writable.");
        expect(msdSummary(device(["msd", { ...base, busy: true }]).msd)).toContain("The drive is busy");
        expect(msdSummary(device(["msd", { ...base, drive: { image: null, connected: false } }]).msd)).toBe("No image selected.");
    });

    it("accepts a bare image name, lists newest first and finds the free space", () => {
        const d = device(["msd", { ...base, drive: { image: "a.iso", cdrom: true, connected: false } }]);
        expect(msdSummary(d.msd)).toBe("Ready to mount a.iso.");
        expect(msdImages(d.msd).map((i) => i.name)).toEqual(["b.iso", "a.iso"]);
        expect(msdFree(d.msd)).toBe(7 * 1024 ** 3);
        expect(msdFree(null)).toBeNull();
    });

    it("disables every change while mounted, busy or uploading, and mount during an upload", () => {
        const idle = msdControls(device(["msd", base]).msd, false);
        expect(idle).toMatchObject({ settable: true, canConnect: true, canDisconnect: false, canRemove: true, canReset: true, writableApplies: false });
        const uploading = msdControls(device(["msd", base]).msd, true);
        expect(uploading).toMatchObject({ settable: false, canConnect: false, canRemove: false, canReset: false });
        const mounted = msdControls(device(["msd", { ...base, drive: { ...base.drive, connected: true } }]).msd, false);
        expect(mounted).toMatchObject({ settable: false, canConnect: false, canDisconnect: true });
        const busy = msdControls(device(["msd", { ...base, busy: true }]).msd, false);
        expect(busy).toMatchObject({ settable: false, canDisconnect: false, canReset: false });
        const flash = msdControls(device(["msd", { ...base, drive: { ...base.drive, cdrom: false } }]).msd, false);
        expect(flash.writableApplies).toBe(true);
        expect(msdControls(null, false).present).toBe(false);
    });

    it("reads a transfer the Pi runs, and nothing when it gives no two usable numbers (25)", () => {
        const withDownload = (downloading: unknown) => device(["msd", { ...base, storage: { ...base.storage, downloading } }]).msd;
        expect(msdTransfer(withDownload({ name: "x.iso", written: 25, size: 100 }))).toEqual({ name: "x.iso", written: 25, size: 100 });
        expect(msdTransfer(withDownload({ current: 5, total: 10 }))).toMatchObject({ written: 5, size: 10 });
        expect(msdTransfer(withDownload({ written: 5 }))).toBeNull();
        expect(msdTransfer(withDownload({ written: 5, size: 0 }))).toBeNull();
        expect(msdTransfer(withDownload(null))).toBeNull();
    });

    it("humanBytes", () => {
        expect(humanBytes(0)).toBe("0 B");
        expect(humanBytes(1536)).toBe("1.5 KB");
        expect(humanBytes(50 * 1024 ** 2)).toBe("50 MB");
        expect(humanBytes("x")).toBe("");
    });
});

describe("stream view (13-15)", () => {
    const streamer = (features: unknown, limits: unknown, applied: unknown) => device(["streamer", { features, limits, applied }]).streamer;

    it("shows only the rows the Pi supports, with its ranges and applied values", () => {
        const view = streamView(
            streamer(
                { quality: true, resolution: true, h264: true },
                {
                    desired_fps: { min: 0, max: 70 },
                    h264_bitrate: { min: 25, max: 20000 },
                    h264_gop: { min: 0, max: 60 },
                    available_resolutions: ["640x360", "1280x720"],
                },
                { quality: 80, desired_fps: 30, resolution: "1280x720", h264_bitrate: 5000, h264_gop: 30 },
            ),
        );
        expect(view.empty).toBe(false);
        expect(view.resolutions).toEqual(["640x360", "1280x720"]);
        expect(view.resolution).toBe("1280x720");
        expect(view.sliders.map((s) => [s.spec.param, s.min, s.max, s.value])).toEqual([
            ["quality", 5, 100, 80],
            ["desired_fps", 0, 70, 30],
            ["h264_bitrate", 25, 20000, 5000],
            ["h264_gop", 0, 60, 30],
        ]);
    });

    it("hides what is not supported and reports an empty form", () => {
        expect(streamView(initialDeviceState.streamer).empty).toBe(true);
        const noH264 = streamView(streamer({ quality: true }, {}, { quality: 50, desired_fps: 10 }));
        expect(noH264.sliders.map((s) => s.spec.param)).toEqual(["quality", "desired_fps"]);
        expect(noH264.resolutions).toEqual([]);
    });

    it("a resolution list without the feature, or the feature without a list, is not shown", () => {
        expect(streamView(streamer({ resolution: true }, {}, { resolution: "a" })).resolutions).toEqual([]);
        expect(streamView(streamer({}, { available_resolutions: ["a"] }, {})).resolutions).toEqual([]);
    });

    it("formats values the way the label and the screen reader both say them", () => {
        const view = streamView(streamer({ quality: true }, {}, { quality: 80, desired_fps: 0 }));
        expect(view.sliders[0]?.spec.format(80)).toBe("80%");
        expect(view.sliders[1]?.spec.format(0)).toBe("unlimited");
        expect(view.sliders[1]?.spec.format(30)).toBe("30 fps");
    });

    it("builds the request path in one place, encoded", () => {
        expect(streamParamPath("quality", 60)).toBe("/api/streamer/set_params?quality=60");
        expect(streamParamPath("resolution", "1280x720")).toBe("/api/streamer/set_params?resolution=1280x720");
    });
});

describe("log (27-29)", () => {
    it("keeps short logs whole and says how many lines of a long one were dropped", () => {
        expect(capLog("a\nb")).toBe("a\nb");
        expect(capLog("")).toBe("");
        const lines = Array.from({ length: LOG_MAX_LINES + 20 }, (_, i) => `line ${i}`);
        const capped = capLog(lines.join("\n"));
        expect(capped.startsWith("\u2026 20 earlier lines not shown.")).toBe(true);
        expect(capped.endsWith(`line ${LOG_MAX_LINES + 19}`)).toBe(true);
        expect(capped).not.toContain("line 19\n");
    });

    it("asks for a snapshot, not a stream", () => {
        expect(logPath("3600")).toBe("/api/log?seek=3600&follow=0");
    });
});

describe("macro draft (32, 36, 37, 39, 40)", () => {
    const chord = (code: string, mods: string[] = []) => ({ type: "chord" as const, mods, code });

    it("a new macro is a draft: it has no usable step, so it would not persist", () => {
        const m = newMacro(1);
        expect(stepWouldPersist(m.steps[0])).toBe(false);
        expect(macroWouldPersist(m)).toBe(false);
        expect(persistable([m])).toEqual([]);
    });

    it("only usable steps and macros are PUT, in order, others stay in the draft", () => {
        const keep: DraftMacro = { id: "a", label: "Keep", steps: [chord(""), { type: "text", text: "hi" }, chord("Enter", ["ControlLeft"])] };
        const drop: DraftMacro = { id: "b", label: "Drop", steps: [{ type: "text", text: "" }] };
        expect(persistable([keep, drop])).toEqual([
            { id: "a", label: "Keep", steps: [{ type: "text", text: "hi" }, chord("Enter", ["ControlLeft"])] },
        ]);
        // the draft itself is untouched
        expect(keep.steps).toHaveLength(3);
    });

    it("clamps what the server would reject: delay range, text length, label length, step and macro counts", () => {
        const long: DraftMacro = {
            id: "x",
            label: "L".repeat(80),
            steps: [
                { type: "delay", ms: 99_999 },
                { type: "delay", ms: 0.2 },
                { type: "text", text: "t".repeat(5000) },
                ...Array.from({ length: 50 }, () => chord("KeyA")),
            ],
        };
        const [out] = persistable([long]);
        expect(out?.label).toHaveLength(60);
        expect(out?.steps).toHaveLength(40);
        expect(out?.steps[0]).toEqual({ type: "delay", ms: 10_000 });
        expect(out?.steps.find((s) => s.type === "delay" && s.ms === 0)).toBeUndefined();
        const text = out?.steps.find((s) => s.type === "text");
        expect(text?.type === "text" && text.text.length).toBe(4000);
        const many = Array.from({ length: 70 }, (_, i) => ({ id: String(i), label: "m", steps: [chord("KeyA")] }));
        expect(persistable(many)).toHaveLength(60);
    });

    it("pinned unless turned off", () => {
        expect(isPinned({})).toBe(true);
        expect(isPinned({ pinned: true })).toBe(true);
        expect(isPinned({ pinned: false })).toBe(false);
    });

    it("notes how many steps are empty", () => {
        const m = (steps: DraftMacro["steps"]): DraftMacro => ({ id: "a", label: "A", steps });
        expect(unsavedNote(m([chord("KeyA")]))).toBeNull();
        expect(unsavedNote(m([chord("")]))).toContain("Not saved yet");
        expect(unsavedNote(m([chord("KeyA"), chord("")]))).toBe("One step is still empty; it will be dropped when saved.");
        expect(unsavedNote(m([chord("KeyA"), chord(""), { type: "text", text: "" }]))).toBe(
            "2 steps are still empty; they will be dropped when saved.",
        );
    });

    it("toggles modifiers, moves and removes steps, never leaving a macro empty", () => {
        const step = chord("KeyA", ["ControlLeft"]);
        expect(toggleMod(step, "AltLeft")).toEqual(chord("KeyA", ["ControlLeft", "AltLeft"]));
        expect(toggleMod(step, "ControlLeft")).toEqual(chord("KeyA", []));
        const m: DraftMacro = { id: "a", label: "A", steps: [chord("KeyA"), chord("KeyB"), chord("KeyC")] };
        expect(moveStep(m, 0, 1).steps.map((s) => s.type === "chord" && s.code)).toEqual(["KeyB", "KeyA", "KeyC"]);
        expect(moveStep(m, 0, -1)).toBe(m);
        expect(moveStep(m, 2, 1)).toBe(m);
        expect(removeStep(m, 1).steps).toHaveLength(2);
        expect(removeStep({ ...m, steps: [chord("KeyA")] }, 0).steps).toEqual([newStep("chord")]);
        expect(newStep("delay")).toEqual({ type: "delay", ms: 200 });
    });

    it("round-trips what the server stores", () => {
        const draft = fromStored([
            { id: "a", label: "A", icon: "power", pinned: false, steps: [{ type: "chord", mods: ["ControlLeft"], code: "KeyA" }, { type: "delay", ms: 5 }] },
            { id: "b", label: "B", steps: [{ type: "text", text: "x" }] },
        ]);
        expect(draft[1]).toEqual({ id: "b", label: "B", steps: [{ type: "text", text: "x" }] });
        expect(persistable(draft)[0]).toMatchObject({ id: "a", icon: "power", pinned: false });
    });
});
