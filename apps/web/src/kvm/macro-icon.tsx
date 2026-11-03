/**
 * A macro's icon: the stored name drawn as its Phosphor glyph, or, when the name did not
 * resolve, the glyph (a literal one or two characters written before the picker existed) or
 * the label's initials. Stored names never change; only what draws them does.
 */

import { macroGlyph } from "@pikvm/kvm-engine";
import {
    ArrowsClockwise,
    ArrowsOut,
    Bell,
    Camera,
    ClipboardText,
    Command,
    Copy,
    DownloadSimple,
    FloppyDisk,
    FolderSimple,
    Gear,
    type Icon,
    Keyboard,
    Lightning,
    Lock,
    MagnifyingGlass,
    Monitor,
    Play,
    Power,
    Star,
    Terminal,
    Trash,
    UploadSimple,
} from "@pikvm/icons";

const MACRO_ICONS: Readonly<Record<string, Icon>> = {
    camera: Camera,
    monitor: Monitor,
    terminal: Terminal,
    power: Power,
    lock: Lock,
    refresh: ArrowsClockwise,
    folder: FolderSimple,
    search: MagnifyingGlass,
    clipboard: ClipboardText,
    play: Play,
    save: FloppyDisk,
    keyboard: Keyboard,
    download: DownloadSimple,
    upload: UploadSimple,
    star: Star,
    bell: Bell,
    copy: Copy,
    zap: Lightning,
    maximize: ArrowsOut,
    command: Command,
    trash: Trash,
    settings: Gear,
};

/** The names the macro editor offers, in order. */
export const MACRO_ICON_NAMES: readonly string[] = Object.keys(MACRO_ICONS);

export function MacroIcon({ macro }: { macro: { readonly icon?: string; readonly label: string } }) {
    const Glyph = macro.icon ? MACRO_ICONS[macro.icon] : undefined;
    if (!Glyph) return <span aria-hidden="true">{macroGlyph(macro)}</span>;
    return <Glyph aria-hidden="true" />;
}
