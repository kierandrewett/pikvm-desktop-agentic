/**
 * Undo: one way back for a change, offered in a toast.
 *
 *   offerUndo({ message, undo, failure, ... })
 *       The change is already saved. Undo sends the reverse change (which must restore the exact previous state).
 *   deferCommit({ message, hide, restore, commit, commitOnUnload, failure, ... })
 *       The change (a delete) waits. The item is hidden at once, Undo puts it back and nothing is sent; when the
 *       toast goes any other way (it times out, is dismissed or is pushed out) the real change is sent.
 *   undoLatest()
 *       What Mod+Z runs: the newest open offer. Returns false when there is none.
 *
 * Every offer follows the same rules:
 * - One toast. Pass `toastId` to put Undo on a toast the action already shows instead of adding a second one.
 * - Once only. The first Undo (button or Mod+Z) wins; a second press does nothing.
 * - One account. An offer belongs to the session epoch captured when the action started (`epoch`, from
 *   captureSessionEpoch in lib/queries.ts). A sign-out or account switch closes every offer without running it,
 *   and a waiting delete is dropped, so the item stays on the server. Undo never reaches another account.
 * - No overwriting. `changed()` returns a reason when the item changed since the action (in another tab, or by a
 *   socket event). Undo then says so and changes nothing.
 * - Calm failure. A failed undo or commit puts the cache back and shows one error toast.
 * - Page unload. A waiting delete is sent with `commitOnUnload` (a keepalive request) when the page goes; if that
 *   request fails, the item is still there after the reload, which is the safe way to fail.
 *
 * Mod+Z (Ctrl+Z, or Cmd+Z on a Mac) runs undoLatest only when focus is not in an editable field and no dialog or
 * menu is open, so text undo in fields (including the composer's own Mod+Z) keeps working.
 */
import { translate } from "../../l10n/runtime";
import { api, ApiError } from "../../lib/api";
import { apiUrl } from "../../lib/config";
import { isMac } from "../../lib/media";
import { captureSessionEpoch, isSessionEpochCurrent, queryClient } from "../../lib/queries";
import { registerSessionReset } from "../../lib/session-reset";
import { errorDescription, toast } from "./toast";

interface UndoCommon {
    /** Toast text, for example "Chat archived". */
    message: string;
    /** Second line, usually the item's name. */
    description?: string;
    /** Put Undo on this existing toast instead of a new one. */
    toastId?: string;
    /** Session epoch captured before the action's first await. Defaults to the current one. */
    epoch?: number;
    /** Error toast title when the undo (offerUndo) or the delayed change (deferCommit) fails. */
    failure: string;
    /** Toast duration in milliseconds; the toast default otherwise. */
    duration?: number;
}

export interface UndoOffer extends UndoCommon {
    /**
     * Send the reverse change and update the cache. Reject on failure, after putting the cache back.
     * `alive()` is false once the account has changed: check it after each await before touching the cache.
     */
    undo: (alive: () => boolean) => Promise<unknown>;
    /** A reason when the item changed since the action, so undoing would overwrite a newer change. */
    changed?: () => string | false | undefined;
}

export interface DeferredChange extends UndoCommon {
    /**
     * Hide the item in the cache. Runs at once and again after every cache update while the change waits, so a
     * refetch or socket event cannot bring it back. It must change nothing when the item is already hidden.
     */
    hide: () => void;
    /** Show the item again, after Undo or a failed commit. */
    restore: () => void;
    /** Send the real change. Runs at most once. */
    commit: () => Promise<unknown>;
    /** Send the real change while the page unloads (fetch with keepalive). Runs instead of commit. */
    commitOnUnload?: () => void;
}

interface Entry {
    toastId: string;
    epoch: number;
    open: boolean;
    /** Undo. */
    run: () => void;
    /** Session ended: close without running anything. */
    drop: () => void;
    /** Page unload while a deferred change waits. */
    unload?: () => void;
    /** Send a waiting deferred change now and resolve when it settles. */
    flush?: () => Promise<void>;
}

/** Longest wait for waiting deletes at sign-out. */
const FLUSH_MS = 3000;
const SHORTCUT = isMac ? "Meta+Z" : "Control+Z";
/** Open offers, oldest first. */
const entries: Entry[] = [];
let seq = 0;

function close(entry: Entry): void {
    entry.open = false;
    const i = entries.indexOf(entry);
    if (i >= 0) entries.splice(i, 1);
}

function showToast(o: UndoCommon, entry: Entry, onClose: (reason: string) => void): void {
    entries.push(entry);
    toast.info(o.message, {
        id: entry.toastId,
        description: o.description,
        duration: o.duration,
        action: { label: translate("ui-undo"), onClick: entry.run, shortcut: SHORTCUT },
        onClose,
    });
}

function failed(o: UndoCommon, entry: Entry, error: unknown): void {
    if (!isSessionEpochCurrent(entry.epoch)) return;
    toast.error(o.failure, { id: `${entry.toastId}-failed`, description: errorDescription(error) });
}

export function offerUndo(o: UndoOffer): void {
    const epoch = o.epoch ?? captureSessionEpoch();
    if (!isSessionEpochCurrent(epoch)) return;
    const alive = () => isSessionEpochCurrent(epoch);
    const entry: Entry = {
        toastId: o.toastId ?? `undo-${++seq}`,
        epoch,
        open: true,
        run: () => {
            if (!entry.open) return;
            close(entry);
            toast.dismiss(entry.toastId);
            if (!alive()) return;
            const reason = o.changed?.();
            if (reason) {
                toast.info(translate("ui-undo-nothing"), { id: `${entry.toastId}-changed`, description: reason });
                return;
            }
            o.undo(alive).catch((error: unknown) => failed(o, entry, error));
        },
        drop: () => close(entry),
    };
    showToast(o, entry, () => close(entry));
}

/** Re-run `hide` after every cache update until released. Re-entrant updates from `hide` itself are ignored. */
function holdHidden(hide: () => void): () => void {
    let busy = false;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (busy || (event.type !== "updated" && event.type !== "added")) return;
        busy = true;
        try {
            hide();
        } finally {
            busy = false;
        }
    });
    return unsubscribe;
}

export function deferCommit(o: DeferredChange): void {
    const epoch = o.epoch ?? captureSessionEpoch();
    if (!isSessionEpochCurrent(epoch)) return;
    o.hide();
    const release = holdHidden(o.hide);
    const entry: Entry = {
        toastId: o.toastId ?? `undo-${++seq}`,
        epoch,
        open: true,
        run: () => {
            if (!entry.open) return;
            close(entry);
            release();
            toast.dismiss(entry.toastId);
            if (isSessionEpochCurrent(epoch)) o.restore();
        },
        drop: () => {
            close(entry);
            release();
        },
        unload: () => {
            if (!entry.open) return;
            close(entry);
            if (isSessionEpochCurrent(epoch)) o.commitOnUnload?.();
        },
    };
    const commit = (): Promise<void> => {
        if (!entry.open) return Promise.resolve();
        close(entry);
        if (!isSessionEpochCurrent(epoch)) return Promise.resolve(release());
        return o.commit().then(release, (error: unknown) => {
            release();
            if (!isSessionEpochCurrent(epoch)) return;
            o.restore();
            failed(o, entry, error);
        });
    };
    entry.flush = async () => {
        if (!entry.open) return;
        // Start the commit first: it closes the entry, so the toast's own close below sends nothing twice.
        const sent = commit();
        toast.dismiss(entry.toastId);
        await sent;
    };
    // Undo closes the entry before the toast reports "action", so any close that reaches here means: send it.
    showToast(o, entry, () => void commit());
}

/** Run the newest open offer of the current account. */
export function undoLatest(): boolean {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (entry.open && isSessionEpochCurrent(entry.epoch)) {
            entry.run();
            return true;
        }
    }
    return false;
}

/**
 * Send every waiting delete of the current account now, and wait for the requests. Sign-out runs this before it
 * ends the session, so a delete the person already confirmed is not lost with the toast. Undo offers that are
 * already saved (offerUndo) are not touched. The toast is dismissed first, so its close does not send it twice.
 */
export async function commitPendingDeletes(): Promise<void> {
    const waiting = entries.filter((e) => e.open && e.flush && isSessionEpochCurrent(e.epoch));
    // Bounded, so a slow server cannot hold sign-out. A delete that does not finish stays on the server.
    const bound = new Promise<void>((resolve) => setTimeout(resolve, FLUSH_MS));
    await Promise.race([Promise.allSettled(waiting.map((e) => e.flush!())), bound]);
}

/** DELETE for a commit or an undo. A 404 means it is already gone, which is what was asked for. */
export async function deleteGone(path: string): Promise<void> {
    try {
        await api.del(path);
    } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
}

/** Same-origin request that outlives the page (no body, so it fits the keepalive budget). */
export function sendOnUnload(method: "DELETE" | "PATCH" | "POST", path: string): void {
    void fetch(apiUrl(path), {
        method,
        keepalive: true,
        credentials: "same-origin",
        headers: { "x-chat-request": "1" },
    }).catch(() => undefined);
}

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "radio", "submit", "reset", "range", "color", "file", "image"]);

function editable(el: Element | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
    if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
    return !!el.closest('[role="textbox"], [role="combobox"]');
}

function onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.repeat || e.altKey || e.shiftKey || e.key.toLowerCase() !== "z") return;
    if (!(isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return;
    if (editable(document.activeElement)) return;
    if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"], [role="menu"]')) return;
    if (undoLatest()) e.preventDefault();
}

function onPageHide(): void {
    for (const entry of [...entries]) entry.unload?.();
}

function resetUndo(): void {
    for (const entry of [...entries]) {
        entry.drop();
        toast.dismiss(entry.toastId);
    }
}

if (typeof window !== "undefined") addEventListener("pagehide", onPageHide);
const unregisterSessionReset = registerSessionReset("undo-offers", resetUndo);
import.meta.hot?.dispose(() => {
    unregisterSessionReset();
    removeEventListener("pagehide", onPageHide);
});

/** Bind Ctrl/Cmd+Z to the latest Undo offer. The pane binds it while it is in front and unbinds it when hidden. */
export function bindUndoShortcut(): () => void {
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
}
