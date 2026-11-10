/**
 * The desktop toolbar: the same actions as the phone dock, in the desktop app's titlebar
 * language (a slim bar, flat round icon buttons in muted ink, blue only for what is on). On the
 * left the connection; on the right the pinned macros, then Send keys, Power, the audio pair,
 * zoom-out and the ⋯ menu.
 */

import { useEffect, useRef } from "react";
import { useMacros } from "../api/queries";
import { SHORTCUTS, type ActionSections } from "./actions";
import type { DialogName } from "./dialog-seam";
import { useStatusChip } from "./first-run";
import {
    ArrowsIn,
    CaretDown,
    DotsThree,
    Keyboard,
    MagnifyingGlassMinus,
    Microphone,
    Power,
    SpeakerHigh,
    SpeakerSimpleNone,
} from "@pikvm/icons";
import { audioDevicesSupported, speakerSelectionSupported, useAudioDevices } from "../settings/pages/audio-devices";
import { MIC_DEVICE_KEY, OUT_DEVICE_KEY, readDeviceChoice, writeDeviceChoice } from "../settings/local-prefs";
import { emitAudioDevicesChanged } from "./audio-devices-event";
import { CameraMenu, CameraToggle } from "./camera-control";
import { HealthButton } from "./health-button";
import { MacroStrip, runnable, useMacroBlocked } from "./macro-buttons";
import { MenuButton, type MenuEntry } from "./menu-button";
import { RecordButton } from "./recorder/record-button";
import type { PictureController } from "./picture-controller";
import { usePictureState } from "./picture";
import { isDesktopApp } from "./platform";
import { useKvmSession, useTarget } from "./session";

export interface ToolbarProps {
    readonly controller: PictureController | null;
    readonly actions: ActionSections;
    readonly openDialog: (name: DialogName) => void;
    readonly keysOpen: boolean;
    readonly onKeys: (open: boolean) => void;
    /** Size the window to the target's native resolution. Null outside the desktop app or before a picture. */
    readonly onFit?: (() => void) | null;
}

type DeviceMenuKind = "audio" | "mic";

const DEVICE_MENU = {
    audio: { key: OUT_DEVICE_KEY, noun: "audio output", item: "Output" },
    mic: { key: MIC_DEVICE_KEY, noun: "microphone", item: "Microphone" },
} as const;

/**
 * The device popout beside a toggle: a shortcut to the choice the Audio devices dialog makes, and
 * its own control because the toggle has to keep meaning on/off. "System default" is first, and a
 * pinned device that has gone still appears, and says so, so the choice is never silently lost.
 */
function DeviceMenu({ kind }: { readonly kind: DeviceMenuKind }) {
    const devices = useAudioDevices();
    const { key, noun, item } = DEVICE_MENU[kind];
    const list = kind === "mic" ? devices.inputs : devices.outputs;
    const current = readDeviceChoice(key);
    const pick = (id: string, label: string): void => {
        writeDeviceChoice(key, { id, label });
        emitAudioDevicesChanged();
    };
    const entries: MenuEntry[] = [
        { id: "default", label: "Follow the system default", checked: current.id === "", run: () => pick("", "") },
        ...list.map((device, i) => ({
            id: device.id,
            label: device.label || `${item} ${i + 1}`,
            checked: device.id === current.id,
            run: () => pick(device.id, device.label),
        })),
    ];
    if (current.id && !list.some((d) => d.id === current.id)) {
        entries.push({ id: current.id, label: `${current.label || "Chosen device"} (not connected)`, checked: true, run: () => {} });
    }
    return <MenuButton label={`Choose ${noun}`} icon={<CaretDown />} entries={entries} className="kvm-tb-btn kvm-tb-dev" />;
}

export function Toolbar({ controller, actions, openDialog, keysOpen, onKeys, onFit = null }: ToolbarProps) {
    const session = useKvmSession();
    const picture = usePictureState(controller);
    const inputOpen = useTarget((s) => s.link.open);
    const atxOn = useTarget((s) => s.device.atx?.leds["power"] === true);
    const atxBusy = useTarget((s) => s.device.atx?.busy === true);
    const macros = useMacros();
    const blocked = useMacroBlocked();
    const audioButton = useRef<HTMLButtonElement>(null);
    const micButton = useRef<HTMLButtonElement>(null);
    const { audio } = picture;

    useEffect(() => {
        const offA = controller?.bindMeter("audio", audioButton.current);
        const offM = controller?.bindMeter("mic", micButton.current);
        return () => {
            offA?.();
            offM?.();
        };
    }, [controller, audio.available]);

    const { tone, label } = useStatusChip(picture.signal, inputOpen);

    const sendKeys: MenuEntry[] = [
        { id: "keys", label: "Show on-screen keys", checked: keysOpen, run: () => onKeys(!keysOpen) },
        { id: "paste", label: "Paste text", run: () => openDialog("paste") },
    ];
    const all = macros.data ?? [];
    if (all.length > 0) {
        sendKeys.push({ type: "separator" });
        for (const macro of all) {
            sendKeys.push({
                id: `macro:${macro.id}`,
                label: macro.label,
                disabled: blocked(macro),
                run: () => void session.macros.run(runnable(macro)),
            });
        }
    }
    sendKeys.push({ type: "separator" });
    for (const shortcut of SHORTCUTS) {
        sendKeys.push({
            id: `kb:${shortcut.id}`,
            label: shortcut.label,
            run: () => session.keyboard.sendChord(shortcut.mods, shortcut.code, false),
        });
    }

    const toEntries = (list: readonly ActionSections["tools"][number][]): MenuEntry[] =>
        list.map((a) => ({
            id: a.id,
            label: a.label,
            run: a.run,
            ...(a.disabled !== undefined ? { disabled: a.disabled } : {}),
            ...(a.checked !== undefined ? { checked: a.checked } : {}),
        }));
    const more: MenuEntry[] = [];
    if (audio.available) more.push({ id: "audio-devices", label: "Audio devices", run: () => openDialog("audio-devices") });
    more.push({ type: "separator" });
    more.push(...toEntries(actions.tools), { type: "separator" }, ...toEntries(actions.view));

    const powerLabel = actions.power.length === 0 ? "Power" : atxBusy ? "Power: busy" : atxOn ? "Power: target is on" : "Power: target is off";

    return (
        <div className="kvm-toolbar" data-desktop-app={isDesktopApp()}>
            <div className="kvm-tb-left">
                <span className={`kvm-dot ${tone}`} title={label} role="img" aria-label={label} />
                <span className="kvm-status">{label}</span>
            </div>
            <div className="kvm-tb-right">
                <HealthButton className="kvm-tb-btn" openDialog={openDialog} />
                <MacroStrip />
                <MenuButton label="Send keys" icon={<Keyboard />} entries={sendKeys} testId="send-keys" />
                {actions.power.length > 0 ? (
                    <MenuButton
                        label={powerLabel}
                        icon={<Power />}
                        entries={toEntries(actions.power)}
                        className={`kvm-tb-btn${atxBusy ? " atx-busy" : atxOn ? " atx-on" : ""}`}
                        testId="power"
                    />
                ) : null}
                <span className="kvm-tb-sep" />
                {audio.available ? (
                    <>
                        <button
                            ref={audioButton}
                            type="button"
                            className={`kvm-tb-btn kvm-av${audio.audioOn && !audio.blocked ? " on" : ""}`}
                            data-tb="audio"
                            {...(audio.blocked ? { "data-waiting": "true" } : {})}
                            aria-pressed={audio.audioOn && !audio.blocked}
                            aria-label="Audio output"
                            title={audio.blocked ? "Tap to turn on sound" : "Audio output"}
                            onClick={() => controller?.toggleAudio()}
                        >
                            {audio.audioOn && !audio.blocked ? <SpeakerHigh weight="fill" /> : <SpeakerSimpleNone />}
                        </button>
                        {audioDevicesSupported() && speakerSelectionSupported() ? <DeviceMenu kind="audio" /> : null}
                        <button
                            ref={micButton}
                            type="button"
                            className={`kvm-tb-btn kvm-av${audio.micOn ? " on" : ""}${audio.micWarn ? " warn" : ""}`}
                            data-tb="mic"
                            aria-pressed={audio.micOn}
                            aria-label="Microphone"
                            title={audio.micWarn ? audio.micLabel : "Microphone"}
                            onClick={() => controller?.toggleMic()}
                        >
                            <Microphone weight={audio.micOn ? "fill" : "regular"} />
                        </button>
                        {audioDevicesSupported() ? <DeviceMenu kind="mic" /> : null}
                    </>
                ) : null}
                {/* Always drawn: a camera the Pi or the picture cannot take is disabled with its reason, not hidden. */}
                <CameraToggle controller={controller} variant="toolbar" />
                <CameraMenu controller={controller} />
                <RecordButton controller={controller} variant="toolbar" />
                {picture.scale > 1 ? (
                    <button
                        type="button"
                        className="kvm-tb-btn"
                        data-testid="zoom-reset"
                        title="Zoom out to the whole screen"
                        aria-label="Zoom out to the whole screen"
                        onClick={() => controller?.resetZoom()}
                    >
                        <MagnifyingGlassMinus />
                    </button>
                ) : null}
                {onFit ? (
                    <button
                        type="button"
                        className="kvm-tb-btn"
                        data-testid="fit-window"
                        title="Resize the window to the native resolution"
                        aria-label="Resize the window to the native resolution"
                        onClick={onFit}
                    >
                        <ArrowsIn />
                    </button>
                ) : null}
                <span className="kvm-tb-sep" />
                <MenuButton label="More" icon={<DotsThree weight="bold" />} entries={more} testId="more" />
            </div>
        </div>
    );
}
