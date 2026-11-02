/**
 * Mass storage (kvmd `api/msd/*`): put an ISO on the target as a virtual CD/DVD or flash drive.
 * Everything is gated on the Pi's own state: an image cannot be changed while the drive is
 * connected, busy or being written to.
 *
 * Uploads use XMLHttpRequest because fetch still cannot report upload progress, and an ISO is
 * big enough that a bar is the difference between "working" and "frozen". `remove_incomplete=1`
 * so an aborted upload does not leave a half image in storage pretending to be bootable.
 * Closing the dialog is not an abort.
 */

import { useEffect, useRef, useState } from "react";
import type { DialogProps } from "../dialog-seam";
import type { KvmSession } from "../session";
import { useTarget } from "../session";
import { failureLine, kvmdPost } from "./kvmd";
import { humanBytes } from "./model/guards";
import { msdControls, msdDrive, msdFree, msdImages, msdSummary, msdTransfer } from "./model/msd";
import { Btn, DialogShell, Note, Rule, useConfirm } from "./shell";

interface Upload {
    readonly xhr: XMLHttpRequest;
    readonly remote: boolean;
}

interface Progress {
    /** null: working with no measurement (the Pi is fetching a URL). */
    readonly pct: number | null;
    readonly label: string;
}

/** One drive change; the control repaints from the Pi's own state, so a refusal needs no manual revert. */
async function setDriveParam(session: KvmSession, name: string, value: string | number): Promise<void> {
    const result = await kvmdPost(session, `/api/msd/set_params?${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    if (!result.ok) {
        session.notices.notify({
            text:
                result.status !== null
                    ? `Could not set the drive ${name} (${result.status})`
                    : `Mass storage: ${result.message}`,
            error: true,
        });
    }
}

export function MsdDialog({ session, onClose }: DialogProps) {
    const msd = useTarget((s) => s.device.msd);
    const confirm = useConfirm();
    const [upload, setUpload] = useState<Upload | null>(null);
    const [progress, setProgress] = useState<Progress | null>(null);
    const [file, setFile] = useState<File | null>(null);
    const [url, setUrl] = useState("");
    const [mountPending, setMountPending] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);

    const piUploading = msd?.storage.uploading != null && msd.storage.uploading !== false;
    const controls = msdControls(msd, upload !== null || piUploading);
    const drive = msdDrive(msd);
    const images = msdImages(msd);
    const free = msdFree(msd);

    // A remote download's progress belongs to the Pi and arrives on the msd event. Only while OUR
    // remote upload is in flight; no usable numbers leaves the bar indeterminate.
    const transfer = msdTransfer(msd);
    useEffect(() => {
        if (!upload?.remote) return;
        if (transfer) {
            const pct = Math.max(0, Math.min(100, Math.round((transfer.written / transfer.size) * 100)));
            setProgress({ pct, label: `${pct}%  \u00b7  ${humanBytes(transfer.written)} of ${humanBytes(transfer.size)}` });
        } else {
            setProgress({ pct: null, label: "the Pi is downloading it\u2026" });
        }
    }, [upload, transfer?.written, transfer?.size]);

    const startUpload = (): void => {
        const remote = url.trim();
        const picked = file;
        if (!picked && !remote) return;
        const isRemote = !picked && remote !== "";
        const xhr = new XMLHttpRequest();
        setUpload({ xhr, remote: isRemote });
        setProgress(isRemote ? { pct: null, label: "starting\u2026" } : { pct: 0, label: "0%" });

        const done = (ok: string | null, error: string | null): void => {
            setUpload(null);
            setProgress(null);
            setFile(null);
            setUrl("");
            if (fileInput.current) fileInput.current.value = "";
            if (error) session.notices.notify({ text: error, error: true });
            else if (ok) session.notices.notify({ text: ok });
        };

        if (isRemote) {
            xhr.open("POST", `/api/msd/write_remote?url=${encodeURIComponent(remote)}&remove_incomplete=1`, true);
            setProgress({ pct: null, label: "the Pi is downloading it\u2026" });
        } else if (picked) {
            xhr.open("POST", `/api/msd/write?image=${encodeURIComponent(picked.name)}&remove_incomplete=1`, true);
            xhr.upload.onprogress = (e) => {
                if (!e.lengthComputable) return;
                const pct = Math.round((e.loaded / e.total) * 100);
                setProgress({ pct, label: `${pct}%  \u00b7  ${humanBytes(e.loaded)} of ${humanBytes(e.total)}` });
            };
        }
        xhr.onload = () => {
            if (xhr.status === 200) done(isRemote ? "Image downloaded to the Pi" : `Uploaded ${picked?.name ?? "image"}`, null);
            else done(null, `Upload failed (${xhr.status})`);
        };
        xhr.onerror = () => done(null, "Upload failed: network error");
        // A confirmation, not a fault: aborting is what the user just asked for.
        xhr.onabort = () => done("Upload aborted", null);
        xhr.send(isRemote ? null : picked);
    };

    const setConnected = async (on: boolean): Promise<void> => {
        if (mountPending) return;
        setMountPending(true);
        const result = await kvmdPost(session, `/api/msd/set_connected?connected=${on ? 1 : 0}`);
        // Present tense: a 200 is kvmd taking the request; the msd event says what happened.
        session.notices.notify(
            result.ok
                ? { text: on ? "Mounting on the target\u2026" : "Unmounting\u2026" }
                : { text: failureLine(on ? "mount" : "unmount", result), error: true },
        );
        setMountPending(false);
    };

    const removeImage = async (): Promise<void> => {
        if (!drive.image) return;
        const name = drive.image.name;
        const ok = await confirm.ask({
            title: `Delete \u201c${name}\u201d?`,
            body: "It is removed from the PiKVM. This cannot be undone.",
            confirm: "Delete image",
            danger: true,
        });
        if (!ok) return;
        const result = await kvmdPost(session, `/api/msd/remove?image=${encodeURIComponent(name)}`);
        session.notices.notify(
            result.ok ? { text: "Image deleted" } : { text: failureLine("delete the image", result), error: true },
        );
    };

    const resetDrive = async (): Promise<void> => {
        const ok = await confirm.ask({
            title: "Reset the mass storage drive?",
            body: "Anything mounted is unmounted.",
            confirm: "Reset drive",
            danger: true,
        });
        if (!ok) return;
        const result = await kvmdPost(session, "/api/msd/reset");
        session.notices.notify(
            result.ok ? { text: "Drive reset" } : { text: failureLine("reset the drive", result), error: true },
        );
    };

    const canUpload = controls.settable && (file !== null || url.trim() !== "");

    return (
        <>
            <DialogShell
                title="Mass storage"
                onClose={onClose}
                testId="msd-dialog"
                initialFocus="[data-done]"
                startActions={
                    controls.present ? (
                        <Btn disabled={!controls.canReset} onClick={() => void resetDrive()}>
                            Reset drive
                        </Btn>
                    ) : null
                }
                actions={
                    <Btn variant="primary" data-done="" onClick={onClose}>
                        Done
                    </Btn>
                }
            >
                <Note live>{msdSummary(msd)}</Note>
                {controls.present ? (
                    <>
                        <div className="dlg-row stack">
                            <label className="dlg-label" htmlFor="msd-image">
                                Image
                            </label>
                            <select
                                id="msd-image"
                                className="dlg-select dlg-grow"
                                value={drive.image?.inStorage ? drive.image.name : ""}
                                disabled={!controls.settable}
                                onChange={(e) => void setDriveParam(session, "image", e.target.value)}
                            >
                                <option value="">{images.length > 0 ? "\u2014 select an image \u2014" : "no images uploaded"}</option>
                                {images.map((image) => (
                                    <option key={image.name} value={image.name}>
                                        {image.name} ({humanBytes(image.size)})
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="dlg-row wrap">
                            <label className="dlg-label" htmlFor="msd-mode">
                                Mode
                            </label>
                            <select
                                id="msd-mode"
                                className="dlg-select"
                                value={drive.cdrom ? "1" : "0"}
                                disabled={!controls.settable}
                                onChange={(e) => void setDriveParam(session, "cdrom", e.target.value === "1" ? 1 : 0)}
                            >
                                <option value="1">CD/DVD</option>
                                <option value="0">Flash drive</option>
                            </select>
                            <label className="dlg-check">
                                <input
                                    type="checkbox"
                                    checked={drive.rw}
                                    disabled={!controls.writableApplies}
                                    onChange={(e) => void setDriveParam(session, "rw", e.target.checked ? 1 : 0)}
                                />
                                Writable
                            </label>
                        </div>
                        <div className="dlg-inline-actions" style={{ flexWrap: "wrap" }}>
                            {drive.connected ? (
                                <Btn
                                    disabled={!controls.canDisconnect}
                                    aria-disabled={mountPending}
                                    onClick={() => void setConnected(false)}
                                >
                                    Unmount
                                </Btn>
                            ) : (
                                <Btn
                                    disabled={!controls.canConnect}
                                    aria-disabled={mountPending}
                                    onClick={() => void setConnected(true)}
                                >
                                    Mount on the target
                                </Btn>
                            )}
                            <Btn disabled={!controls.canRemove} onClick={() => void removeImage()}>
                                Delete image
                            </Btn>
                        </div>

                        <Rule />

                        <div className="dlg-row stack">
                            <label className="dlg-label" htmlFor="msd-file">
                                Upload
                            </label>
                            <input
                                ref={fileInput}
                                id="msd-file"
                                type="file"
                                className="dlg-file"
                                accept=".iso,.img,.bin,application/octet-stream"
                                disabled={!controls.settable}
                                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                            />
                        </div>
                        <div className="dlg-row stack">
                            <label className="dlg-label" htmlFor="msd-url">
                                or image URL
                            </label>
                            <input
                                id="msd-url"
                                type="text"
                                className="dlg-text dlg-grow"
                                placeholder={"https://\u2026/image.iso"}
                                spellCheck={false}
                                autoCapitalize="off"
                                autoCorrect="off"
                                disabled={!controls.settable}
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                            />
                        </div>
                        {progress ? (
                            <div className="dlg-row" data-testid="msd-progress">
                                <progress
                                    className="dlg-grow"
                                    max={100}
                                    aria-label="Upload progress"
                                    aria-describedby="msd-progress-value"
                                    {...(progress.pct !== null ? { value: progress.pct } : {})}
                                />
                                <span className="dlg-hint" id="msd-progress-value">
                                    {progress.label}
                                </span>
                            </div>
                        ) : null}
                        <div className="dlg-row">
                            {upload ? (
                                <Btn onClick={() => upload.xhr.abort()}>Abort</Btn>
                            ) : (
                                <Btn disabled={!canUpload} onClick={startUpload}>
                                    Start upload
                                </Btn>
                            )}
                            <span className="dlg-hint">{free === null ? "" : `${humanBytes(free)} free`}</span>
                        </div>
                    </>
                ) : null}
            </DialogShell>
            {confirm.element}
        </>
    );
}
