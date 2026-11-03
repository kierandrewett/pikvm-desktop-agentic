/**
 * Mass storage as the dialog reads it: a sentence for the top, the image list, the free space,
 * a transfer the Pi is running, and which controls may act right now. kvmd rejects a change the
 * drive cannot make, so the controls that would make one are disabled rather than left to fail.
 */

import type { MsdState } from "@pikvm/kvm-engine";
import { asNumber, asRecord, asString, humanBytes } from "./guards";

export interface MsdImage {
    readonly name: string;
    readonly size: number;
}

export interface MsdDrive {
    /** The selected image, if any. */
    readonly image: { readonly name: string; readonly size: number | null; readonly inStorage: boolean; readonly removable: boolean } | null;
    readonly cdrom: boolean;
    readonly rw: boolean;
    readonly connected: boolean;
}

export function msdDrive(msd: MsdState | null): MsdDrive {
    const drive = asRecord(msd?.drive);
    const image = drive?.["image"];
    // kvmd sends an object; a bare name is tolerated (the fake sends one) so the dialog still works.
    const record = asRecord(image);
    const name = record ? asString(record["name"]) : asString(image);
    return {
        image: name
            ? {
                  name,
                  size: record ? asNumber(record["size"]) : null,
                  inStorage: record ? record["in_storage"] !== false : true,
                  removable: record ? record["removable"] !== false : true,
              }
            : null,
        cdrom: drive?.["cdrom"] !== false,
        rw: !!drive?.["rw"],
        connected: !!drive?.["connected"],
    };
}

/** Newest first, so the image just uploaded is the one at the top of the list. */
export function msdImages(msd: MsdState | null): MsdImage[] {
    const images = asRecord(msd?.storage.images);
    if (!images) return [];
    return Object.keys(images)
        .map((name) => {
            const entry = asRecord(images[name]);
            return { name, size: asNumber(entry?.["size"]) ?? 0, modified: asNumber(entry?.["mod_ts"]) ?? 0 };
        })
        .sort((a, b) => b.modified - a.modified)
        .map(({ name, size }) => ({ name, size }));
}

/** Free bytes on the default storage part, or null. */
export function msdFree(msd: MsdState | null): number | null {
    const parts = asRecord(msd?.storage.parts);
    if (!parts) return null;
    const names = Object.keys(parts);
    const first = names[0];
    if (first === undefined) return null;
    return asNumber(asRecord(parts[""] !== undefined ? parts[""] : parts[first])?.["free"]);
}

export interface MsdTransfer {
    readonly name: string;
    readonly written: number;
    readonly size: number;
}

/** A transfer the Pi is running. Anything without two usable numbers is null (an unmeasured bar). */
export function msdTransfer(msd: MsdState | null): MsdTransfer | null {
    const storage = msd?.storage;
    const t = asRecord(storage?.downloading) ?? asRecord(storage?.uploading);
    if (!t) return null;
    const written = asNumber(t["written"]) ?? asNumber(t["current"]);
    const size = asNumber(t["size"]) ?? asNumber(t["total"]);
    if (written === null || size === null || size <= 0) return null;
    return { name: asString(t["name"]) ?? "", written, size };
}

/** Not knowing yet and knowing there is none are different answers. */
export function msdSummary(msd: MsdState | null): string {
    if (!msd) return "Checking the drive";
    if (!msd.enabled) return "This PiKVM has no mass storage.";
    if (!msd.online) return "The drive is offline.";
    const d = msdDrive(msd);
    let what: string;
    if (d.connected) {
        what =
            `Mounted on the target: ${d.image?.name ?? "(no image)"} as ${d.cdrom ? "a CD/DVD" : "a flash drive"}` +
            `${d.rw ? ", writable" : ", read-only"}.`;
    } else if (d.image) {
        const size = humanBytes(d.image.size);
        what = `Ready to mount ${d.image.name}${size ? ` (${size})` : ""}.`;
    } else {
        what = "No image selected.";
    }
    return msd.busy ? `${what} The drive is busy, so nothing can be changed just now.` : what;
}

export interface MsdControls {
    /** The drive exists at all (shows the form rather than the sentence alone). */
    readonly present: boolean;
    /** Image, mode, writable, upload may be changed. */
    readonly settable: boolean;
    readonly canConnect: boolean;
    readonly canDisconnect: boolean;
    readonly canRemove: boolean;
    readonly canReset: boolean;
    readonly writableApplies: boolean;
}

export function msdControls(msd: MsdState | null, uploading: boolean): MsdControls {
    const present = !!msd?.enabled;
    const online = present && !!msd?.online;
    const busy = !!msd?.busy;
    const d = msdDrive(msd);
    const settable = online && !d.connected && !busy && !uploading;
    return {
        present,
        settable,
        // Mounting the PREVIOUS image in the middle of writing a new one is a change kvmd will not make.
        canConnect: online && !!d.image && !d.connected && !busy && !uploading,
        canDisconnect: online && d.connected && !busy,
        canRemove: settable && !!d.image?.removable,
        canReset: online && !busy && !uploading,
        // A CD/DVD is read-only by definition.
        writableApplies: settable && !d.cdrom,
    };
}
