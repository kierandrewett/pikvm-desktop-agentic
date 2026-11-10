/**
 * The camera control in the three places the speaker and microphone live: a round button with a state pip and a menu
 * beside it in the desktop toolbar, a round button in the phone dock, and a row with a pip and an unfolding menu in
 * the phone sheet. It is always drawn: a camera the Pi cannot take is disabled with its reason in the title and the
 * menu, not hidden (K53). All three read the same view (camera.ts), so they agree.
 */

import { CaretDown, Webcam, WebcamSlash } from "@pikvm/icons";
import { useId, useState } from "react";
import { cameraOpenable, cameraView, type CameraView } from "./camera";
import { CameraPanel } from "./camera-panel";
import { MenuButton } from "./menu-button";
import { usePictureState } from "./picture";
import type { AudioState, PictureController } from "./picture-controller";
import "./camera.css";

interface CameraControlProps {
    readonly controller: PictureController | null;
}

function useCameraControl(controller: PictureController | null): { readonly view: CameraView; readonly audio: AudioState } {
    const { audio, webrtc } = usePictureState(controller);
    const view = cameraView({
        browser: cameraOpenable(),
        webrtc,
        support: audio.camSupport,
        devices: audio.camDevices,
        on: audio.camOn,
        label: audio.camLabel,
        warn: audio.camWarn,
    });
    return { view, audio };
}

/** `data-state` is what a person would call it, so a screenshot or a test can say what the button means. */
function stateOf(view: CameraView, audio: AudioState): string {
    if (view.blocked) return "unavailable";
    if (audio.camOn) return "on";
    return view.warn ? "warning" : "off";
}

/** The round camera button, in the toolbar (`toolbar`) or the dock (`dock`). A press it cannot honour explains itself. */
export function CameraToggle({ controller, variant }: CameraControlProps & { readonly variant: "toolbar" | "dock" }) {
    const { view, audio } = useCameraControl(controller);
    const base = variant === "toolbar" ? "kvm-tb-btn" : "kvm-ibtn";
    return (
        <button
            type="button"
            className={`${base} kvm-av${view.on ? " on" : ""}${view.warn ? " warn" : ""}`}
            data-tb="cam"
            data-state={stateOf(view, audio)}
            aria-pressed={view.on}
            // Not `disabled`: a disabled button takes no focus and no tap, and the tap is how a phone is told why.
            aria-disabled={view.blocked ? true : undefined}
            aria-label="Camera"
            title={view.title}
            onClick={() => controller?.toggleCam()}
        >
            {view.blocked ? <WebcamSlash /> : <Webcam weight={view.on ? "fill" : "regular"} />}
        </button>
    );
}

/** The arrow beside the toolbar's camera button: the preview, the cameras, the quality. It works whatever the Pi says. */
export function CameraMenu({ controller }: CameraControlProps) {
    const { view, audio } = useCameraControl(controller);
    return (
        <MenuButton
            label="Choose camera"
            icon={<CaretDown />}
            entries={[]}
            panel={<CameraPanel view={view} audio={audio} variant="menu" />}
            className="kvm-tb-btn kvm-tb-dev"
            menuClassName="kvm-cam-menu"
            testId="camera-menu"
        />
    );
}

/** The sheet's camera row: the toggle with its pip, and an arrow that unfolds the same options under it. */
export function CameraSheetItem({ controller }: CameraControlProps) {
    const { view, audio } = useCameraControl(controller);
    const [open, setOpen] = useState(false);
    const id = useId();
    return (
        <>
            <div className="kvm-split">
                <button
                    type="button"
                    className={`kvm-item toggle${view.on ? " on" : ""}${view.warn ? " warn" : ""}`}
                    data-setting="cam"
                    data-state={stateOf(view, audio)}
                    aria-pressed={view.on}
                    aria-disabled={view.blocked ? true : undefined}
                    title={view.title}
                    onClick={() => controller?.toggleCam()}
                >
                    <span>Camera</span>
                    <span className="kvm-pip">{view.label}</span>
                </button>
                <button
                    type="button"
                    className="kvm-item kvm-split-more"
                    data-setting="cam-options"
                    aria-label="Camera options"
                    aria-expanded={open}
                    aria-controls={id}
                    onClick={() => setOpen(!open)}
                >
                    <CaretDown />
                </button>
            </div>
            {open ? (
                <div id={id} className="kvm-cam-inline">
                    <CameraPanel view={view} audio={audio} variant="inline" />
                </div>
            ) : null}
        </>
    );
}
