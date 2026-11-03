/**
 * Composer (docs/spec/web-and-claude-notes.md A.2-A.4 and A.8; ui-spec 3 for menus).
 *
 * One surface, one CSS grid, two layouts, so the textarea never re-mounts:
 * - single-line: a 52px pill, `[+] [editor] [effort, send]` in one 36px row. Under 640px the same layout is
 *   "stacked" as on the reference: editor row on top, controls below, radius 28px;
 * - multi-line: editor on its own row (padding 15/18/16), controls below, radius 28px. Used when the text has a
 *   newline, would not fit on one line at the single-line editor width, or when attachments are present.
 * Motion matches the reference as measured frame by frame (docs/spec/composer-expand.md): nothing animates. The
 * switch to multi-line lands in the same frame as the keystroke that overflows, later lines grow and shrink in
 * one frame, and the + and trailing controls jump to the bottom row without a transition. Once multi-line, the
 * composer stays multi-line until the text is empty, so deleting back to one short line does not jump back.
 * The editor scrolls past min(25dvh, 320px) with a 1rem fade mask, and an Expand button appears once it overflows.
 *
 * "/" at the start of a line lists commands, "@" after whitespace lists workspace files, and "+" opens the same
 * inline menu with attachment actions. Focus stays in the editor; it routes Up/Down/Enter/Tab/Escape to the menu.
 *
 * Under the pill a quiet tray holds the model picker and the permission pill.
 *
 * Phones (useIsMobile) get their own layout of the same grid, still without re-mounting the textarea:
 * `[+] [editor] [dictate, send]` in one 48px pill that grows upwards with the text (buttons stay at the bottom),
 * 40px controls with 48px hit areas, and a tray row of model, effort and permissions. "+" opens a sheet
 * (attach-sheet.tsx) instead of the inline menu, and "/" and "@" lists open as a sheet behind the composer
 * (InlineMenu `sheet`). The disclaimer is left out. The docks pad the safe-area inset; only the home variant pads
 * it here.
 *
 * Contract (kept from the stub):
 * - variant "home": centred on the new-chat screen; sending creates a conversation and navigates to it
 * - variant "thread": docked at the bottom of a conversation
 */
import {
    ArrowsOutSimple,
    Brain,
    Broom,
    FolderSimple,
    Hand,
    Lightbulb,
    NotePencil,
    Plus,
    WarningCircle,
    X,
} from "@pikvm/icons";
import {
    ComposerFeatures,
    type ComposerFeatureOptions,
    type InputFile,
    type InputImage,
    type ServerEvent,
    type ThinkingEffort,
    type ThinkingSelector,
} from "@pikvm/chat-protocol";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "../../nav";
import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ClipboardEvent,
    type FormEvent,
    type KeyboardEvent,
    type ReactNode,
    type SyntheticEvent,
} from "react";
import { useT } from "../../l10n/provider";
import { translate } from "../../l10n/runtime";
import { cn } from "../../lib/cn";
import {
    beaconServerDraft,
    draftKey as draftStorageKey,
    draftListKey,
    fetchServerDraft,
    isEmptyDraft,
    pushServerDraft,
    reconcile,
    sameDraft,
    serverScope,
    pruneMissing,
    readDraft,
    removeDraft,
    purgeDraft,
    subscribeDrafts,
    writeDraft,
    type Draft,
} from "../../lib/drafts";
import { clearLive, useLive } from "../../lib/live";
import { useCoarsePointer, useIsMobile } from "../../lib/media";
import { touchTarget } from "../../lib/touch";
import {
    captureSessionEpoch,
    conversationsQuery,
    isSessionEpochCurrent,
    conversationSummaryQuery,
    queryClient,
    useBootstrap,
    useSetting,
} from "../../lib/queries";
import { isSendError, sendMessage, stopResponse } from "../../lib/send";
import { chatParams } from "../../lib/chat-path";
import { socket } from "../../lib/socket";
import { registerSessionReset } from "../../lib/session-reset";
import { ModelPicker } from "../model-picker/model-picker";
import { identityOf } from "../model-picker/models";
import { ModelMark } from "../model-picker/provider-logo";
import { searchModels } from "../model-picker/search";
import { useQuestionReply } from "../thread/questions/store";
import { Tooltip } from "../ui/tooltip";
import { AttachSheet } from "./attach-sheet";
import {
    AttachmentRow,
    draftAttachments,
    DropOverlay,
    readImageUrl,
    useFileDrop,
    type Attachment,
} from "./attachments";
import {
    editTextarea,
    markerFor,
    markerLabel,
    motionOf,
    nextMarkerNumber,
    NO_MOTION,
    paintChips,
    rangeOf,
    removeChip,
    removeChipAt,
    replaceWithChip,
    scanChips,
    selOf,
    snapSelection,
    stepOverChip,
    withoutChips,
    type Motion,
    type Sel,
} from "./chips";
import { discardComposerUpload, uploadComposerFile, UploadError } from "./upload";
import { EFFORT_LABELS, rememberChoice, useComposerChoice, type Permission } from "./choice";
import { ComposerButton, PermissionMenu, SendButton } from "./controls";
import { McpServersMenu } from "./mcp-servers";
import { DictateButton, DictationControls, useDictation, useSpeechConfig, Waveform } from "./dictation";
import { toast } from "../ui/toast";
import "./variant-dev";
import "./composer.css";
import { arriveFrom, currentSlot, leaveRect, skipComposerMove } from "./move";
import { appendBlock, onComposerInsert } from "./insert";
import { Balloon, BalloonAnnouncer, findAnchor, type BalloonAnchor, type BalloonData } from "./balloon";
import { EffortControl } from "./effort";
/** The full-screen editor's tabs; the pane has no full-screen editor, but the draft format keeps the field. */
type EditorView = "write" | "preview";
import {
    ARG_COMMANDS,
    attachItem,
    commandItem,
    detectTrigger,
    filterCommands,
    InlineMenu,
    menuBack,
    menuKeyAction,
    resourceItem,
    resourceToken,
    serverItem,
    toolItem,
    useCommands,
    wholeServerItem,
    useMcp,
    useMcpResources,
    type CommandInfo,
    type CommandMatch,
    type McpServer,
    type McpTool,
    type SuggestItem,
} from "./suggest";

export interface ComposerProps {
    variant: "home" | "thread";
    conversationId?: string;
    /** Panel hosts already animate the composer with their own surface. */
    embedded?: boolean;
    /** UI and local actions exposed by this host. Omitted keys keep the complete interface. */
    features?: ComposerFeatureOptions;
    /** Called with the real conversation id after a new conversation is created. */
    onCreated?: (conversationId: string) => void;
}

/** Unsent text per conversation ("home" for the new-chat screen), kept for the life of the tab. */
/** Drafts of temporary chats: kept for the tab session only, never written to storage (lib/drafts.ts). */
const memoryDrafts = new Map<string, StoredDraft>();
type StoredDraft = Pick<Draft, "text" | "selection" | "multi" | "attachments" | "editor" | "serverAt" | "synced">;
/** The first composer mount after a page load may show "Draft restored". */
let pageLoadPending = true;
/** Drafts of conversations deleted elsewhere are dropped once per page load. */
let prunedThisLoad = false;
const unregisterComposer = registerSessionReset("composer-drafts", () => {
    memoryDrafts.clear();
    pageLoadPending = true;
    prunedThisLoad = false;
});
import.meta.hot?.dispose(unregisterComposer);

/** One toast id for the composer, so a new failure or hint replaces the last one. */
const COMPOSER_TOAST = "composer";
const MULTI_PAD_Y = 31; // 15px top + 16px bottom in multi-line
const PHONE_PAD_Y = 22; // 11px top and bottom: one line is a 48px pill
const LINE = 26;
/** "server/tool" for a mention. The tool `label` already has that form; `name` is the runtime's internal id. */
function toolPath(server: McpServer, tool: McpTool): string {
    return tool.label?.includes("/") ? tool.label : `${server.name}/${tool.name}`;
}

/** Commands that run in the client instead of being sent to the agent. */
const APP_COMMANDS = new Set(["new", "model", "effort", "clear", "permission"]);

const EFFORT_ALIASES: Record<string, ThinkingEffort> = {
    none: "off",
    min: "minimal",
    med: "medium",
    mid: "medium",
    hi: "high",
    lo: "low",
    xh: "xhigh",
    extra: "xhigh",
    extrahigh: "xhigh",
    maximum: "max",
};

/** "high", "med", "Extra high", "xhigh", "auto" -> a level the model accepts, or undefined. */
function parseEffort(arg: string, efforts: ThinkingEffort[]): ThinkingSelector | undefined {
    const a = arg.toLowerCase().replace(/[\s_-]+/g, "");
    // Auto is valid for any model with at least one level (ModelInfo.efforts never lists it).
    if (a === "auto" && efforts.length) return "auto";
    const want = EFFORT_ALIASES[a] ?? (a as ThinkingEffort);
    if (efforts.includes(want)) return want;
    const hits = efforts.filter(
        (e) => e.startsWith(a) || EFFORT_LABELS[e].toLowerCase().replace(/\s+/g, "").startsWith(a),
    );
    return hits.length === 1 ? hits[0] : undefined;
}

let measureCanvas: HTMLCanvasElement | undefined;
function textWidth(text: string, font: string): number {
    measureCanvas ??= document.createElement("canvas");
    const ctx = measureCanvas.getContext("2d");
    if (!ctx) return 0;
    ctx.font = font;
    return ctx.measureText(text).width;
}

export function Composer({
    variant,
    conversationId,
    onCreated,
    embedded = false,
    features: featureOptions,
}: ComposerProps) {
    const features = useMemo(() => ComposerFeatures.parse(featureOptions ?? {}), [featureOptions]);
    const navigate = useNavigate();
    const coarse = useCoarsePointer();
    const mobile = useIsMobile();
    const enterToSend = useSetting<boolean>("ui.composer.enterToSend", true);
    const t = useT();
    const pasteAsFileChars = useSetting<number>("ui.composer.pasteAsFileChars", 10_000);
    const choice = useComposerChoice(conversationId, features);
    const live = useLive(conversationId);
    const running = !!live && !live.done;
    const stopping = running && !!live.stopping;
    const side = variant === "home" && !mobile ? "bottom" : "top";
    const placement = side === "bottom" ? "below" : "above";
    const menuId = useId();

    // Drafts (lib/drafts.ts): one per conversation, and one for the new-chat screen, in localStorage.
    const { data: summary } = useQuery({
        ...conversationSummaryQuery(conversationId ?? ""),
        enabled: !!conversationId,
    });
    const { data: bootstrap } = useBootstrap();
    const userId = bootstrap?.user?.id;
    const context = conversationId ?? "home";
    const draftKey = `${userId ?? "signed-out"}:${conversationId && !summary ? "pending:" : ""}${context}`;
    const storeKey = !conversationId || summary ? draftStorageKey({ conversationId, userId }) : null;
    const scope = userId && (!conversationId || summary) ? serverScope({ conversationId }) : null;
    // Cross-device layer: what the server holds for this scope (as far as this tab knows), and whether the user
    // has typed since the draft was opened (then the server copy never replaces local text).
    const serverCopy = useRef<{ text: string; attachments: Draft["attachments"]; at?: number } | null>(null);
    const typedSinceLoad = useRef(false);
    const reconciledScope = useRef<string | null>(null);
    const loadDraft = (memKey: string, key: string | null): StoredDraft | null =>
        key ? readDraft(key) : (memoryDrafts.get(memKey) ?? null);
    const [initial] = useState(() => loadDraft(draftKey, storeKey));
    const [text, setText] = useState(() => initial?.text ?? "");
    const [attachments, setAttachments] = useState<Attachment[]>(() =>
        features.attachments ? (initial?.attachments ?? []) : [],
    );
    const [mentions, setMentions] = useState<string[]>([]);
    /** Argument hints of inserted command tokens, shown as ghost text while nothing follows the token. */
    const [commandHints, setCommandHints] = useState<Record<string, string>>({});
    // Failures (send, dictation, attachments, agent commands) show as one toast, updated in place; a new
    // attempt clears it.
    const reportError = useCallback((title: string, message?: string) => {
        toast.error(title, { id: COMPOSER_TOAST, description: message });
    }, []);
    const clearError = useCallback(() => toast.dismiss(COMPOSER_TOAST), []);
    /**
     * Output of a local-only agent command, or why a new chat or a command could not start (there is no turn to
     * show it in); stays until dismissed or replaced.
     */
    const [notice, setNotice] = useState<{ text: string; error?: string } | null>(null);
    /**
     * Confirmation of an app command, as a balloon on the control it changed. Falls back to the notice when that
     * control is not visible (for example on a narrow screen).
     */
    const [balloon, setBalloon] = useState<(BalloonData & { el: HTMLElement }) | null>(null);
    const [announce, setAnnounce] = useState("");
    const balloonId = useRef(0);
    const confirmChange = (anchor: BalloonAnchor, title: string, detail: string | undefined, icon: ReactNode) => {
        const text = detail ? `${title}. ${detail}` : title;
        setAnnounce(text);
        const el = findAnchor(root.current, anchor);
        if (!el) {
            setBalloon(null);
            toast.info(title, { id: COMPOSER_TOAST, description: detail });
            return;
        }
        setNotice(null);
        setBalloon({ id: ++balloonId.current, anchor, title, detail, icon, el });
    };
    const balloonDone = useCallback((id: number) => setBalloon((b) => (b?.id === id ? null : b)), []);
    const [pickerQuery, setPickerQuery] = useState("");
    const [creating, setCreating] = useState(false);
    /** Temporary id of the new chat being created, so Stop works before the server answers. */
    const pendingNewChat = useRef<string | undefined>(undefined);
    const [caret, setCaret] = useState(0);
    const [plusOpen, setPlusOpen] = useState(false);
    /** Phones: the "+" sheet (attach-sheet.tsx) in place of the inline "+" menu. */
    const [attachOpen, setAttachOpen] = useState(false);
    const [dismissed, setDismissed] = useState<number | null>(null);
    const [activeState, setActiveState] = useState({ key: "", index: 0 });
    const [pickerOpen, setPickerOpen] = useState(false);
    const [effortOpen, setEffortOpen] = useState(false);
    // Full-screen editor (fullscreen.tsx): open state and Write / Preview, kept in the draft.
    const [fullscreen, setFullscreen] = useState(() => features.fullscreen && !!initial?.editor?.open);
    const [editorView, setEditorView] = useState<EditorView>(() => initial?.editor?.view ?? "write");
    const [fsPickerOpen, setFsPickerOpen] = useState(false);
    const [fsEffortOpen, setFsEffortOpen] = useState(false);
    const [overflowing, setOverflowing] = useState(false);

    // Swap drafts when the conversation changes under a mounted composer. The outgoing draft is flushed by the
    // persistence effect's cleanup; the incoming one is read here, in render, so no frame shows the old text.
    const [shownKey, setShownKey] = useState(draftKey);
    const pendingSelection = useRef<readonly [number, number] | null>(initial?.selection ?? null);
    /** Selection in the full-screen editor, so the snapshot (and the collapse) keep it. */
    const fsSelection = useRef<[number, number] | null>(null);
    if (shownKey !== draftKey) {
        const next = loadDraft(draftKey, storeKey);
        // Metadata arrival must not replace text entered while that metadata was loading.
        const pendingSameContext = shownKey === `${userId ?? "signed-out"}:pending:${context}`;
        if (pendingSameContext && (text || attachments.length)) {
            const carried: StoredDraft = {
                text,
                attachments: draftAttachments(attachments),
                selection: [caret, caret],
                multi: text.includes("\n"),
                synced: false,
            };
            if (storeKey) writeDraft(storeKey, carried);
            else memoryDrafts.set(draftKey, carried);
        }
        const incoming =
            pendingSameContext && (text || attachments.length)
                ? storeKey
                    ? readDraft(storeKey)
                    : memoryDrafts.get(draftKey)
                : next;
        setShownKey(draftKey);
        setText(incoming?.text ?? "");
        setAttachments(features.attachments ? (incoming?.attachments ?? []) : []);
        setMentions([]);
        pendingSelection.current = incoming?.selection ?? null;
        setPlusOpen(false);
        setFullscreen(features.fullscreen && !!incoming?.editor?.open);
        setEditorView(incoming?.editor?.view ?? "write");
    }

    const toastDraftKey = useRef(draftKey);
    useEffect(() => {
        if (toastDraftKey.current === draftKey) return;
        toastDraftKey.current = draftKey;
        clearError();
    }, [draftKey, clearError]);

    const root = useRef<HTMLDivElement>(null);
    const surface = useRef<HTMLFormElement>(null);
    const editor = useRef<HTMLTextAreaElement>(null);
    const mirror = useRef<HTMLTextAreaElement>(null);
    const backdrop = useRef<HTMLDivElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const photoInput = useRef<HTMLInputElement>(null);
    const cameraInput = useRef<HTMLInputElement>(null);
    const pendingCaret = useRef<number | null>(null);

    // Layout measurement: the single-line editor column width, and the font used to measure text.
    const [singleWidth, setSingleWidth] = useState(0);
    const chrome = useRef(0);
    const font = useRef("");
    const overflowsLine = singleWidth > 0 && !!text && textWidth(text, font.current) > singleWidth - 2;
    const needsMulti = attachments.length > 0 || text.includes("\n") || overflowsLine;
    // Hysteresis as on the reference: multi-line sticks until the text is cleared (or the conversation changes).
    // Derived during render, so the first and last frames are already in the right layout.
    const [sticky, setSticky] = useState<{ on: boolean; key: string }>(() => ({ on: !!initial?.multi, key: draftKey }));
    if (sticky.key !== draftKey) setSticky({ on: needsMulti || !!loadDraft(draftKey, storeKey)?.multi, key: draftKey });
    else if (needsMulti && !sticky.on) setSticky({ on: true, key: draftKey });
    else if (!text && !attachments.length && sticky.on) setSticky({ on: false, key: draftKey });
    const multi = needsMulti || (sticky.on && sticky.key === draftKey && !!text);

    const measure = useCallback(() => {
        const s = surface.current;
        const ed = editor.current;
        if (!s || !ed) return;
        if (!font.current) font.current = getComputedStyle(ed).font;
        if (ed.dataset.layout === "single") {
            const cs = getComputedStyle(ed);
            const inner = ed.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
            chrome.current = s.clientWidth - inner;
            setSingleWidth(inner);
        } else if (chrome.current) {
            setSingleWidth(s.clientWidth - chrome.current);
        }
    }, []);

    useLayoutEffect(() => {
        const s = surface.current;
        if (!s) return;
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(s);
        return () => ro.disconnect();
    }, [measure]);

    // Fonts can load after the first measurement; re-read the font then.
    useEffect(() => {
        void document.fonts?.ready.then(() => {
            font.current = "";
            measure();
        });
    }, [measure]);

    const updateFade = useCallback(() => {
        const ed = editor.current;
        if (!ed) return;
        const max = ed.scrollHeight - ed.clientHeight;
        ed.style.setProperty("--fade-top", ed.scrollTop > 1 ? "1rem" : "0px");
        ed.style.setProperty("--fade-bottom", max > 1 && ed.scrollTop < max - 1 ? "1rem" : "0px");
        if (backdrop.current) {
            backdrop.current.scrollTop = ed.scrollTop;
            backdrop.current.scrollLeft = ed.scrollLeft;
        }
    }, []);

    // Multi-line height follows a hidden mirror. It is set in a layout effect, so it lands in the same frame as the
    // text change (no transition, as on the reference).
    useLayoutEffect(() => {
        const ed = editor.current;
        if (!ed) return;
        if (!multi) {
            ed.style.height = "";
            if (overflowing) setOverflowing(false);
            measure();
            return;
        }
        const vh = visualViewport?.height ?? innerHeight;
        const pad = mobile ? PHONE_PAD_Y : MULTI_PAD_Y;
        // The cap applies to the text area without its padding: measured on the reference, 12 pasted lines at a
        // 899px viewport give a 255.75px editor cell, which is 25dvh (224.75) + 31px padding.
        const max = Math.max(LINE * 3, Math.min(vh * 0.25, 320)) + pad;
        const content = mirror.current ? mirror.current.scrollHeight : LINE + pad;
        const target = Math.min(content, max);
        ed.style.height = `${Math.max(target, LINE + pad)}px`;
        const over = content > max;
        if (over !== overflowing) setOverflowing(over);
        updateFade();
    });

    // Shared-element move across layouts (move.ts): FLIP fallback when no view transition carries it.
    useLayoutEffect(() => {
        const el = root.current;
        if (!el || embedded) return;
        const slot = currentSlot();
        arriveFrom(el, slot);
        return () => leaveRect(el, slot);
    }, [embedded]);

    // Draft persistence. `snapshot` reads the live editor selection; writes are debounced (150ms) and flushed
    // synchronously on pagehide / hidden and when the key changes, so a closed tab keeps the last keystrokes.
    // While a send is in flight the stored draft is kept even though the field is empty, so a failed send can
    // never lose it; it is removed only when the send succeeds and the field is still empty.
    const sending = useRef<{ key: string | null; memKey: string } | null>(null);
    const snapshot = (): StoredDraft => {
        const ed = editor.current;
        const sel: [number, number] =
            fullscreen && fsSelection.current
                ? fsSelection.current
                : ed
                  ? [ed.selectionStart, ed.selectionEnd]
                  : [text.length, text.length];
        const images = draftAttachments(attachments);
        const server = serverCopy.current;
        const synced = server ? sameDraft(server, { text, attachments: images }) : !text && !images.length;
        return {
            text,
            selection: sel,
            multi,
            attachments: images,
            editor: { open: fullscreen, view: editorView },
            serverAt: server?.at,
            synced,
        };
    };
    const snapshotRef = useRef(snapshot);
    snapshotRef.current = snapshot;
    const textRef = useRef(text);
    textRef.current = text;
    const persist = useCallback((memKey: string, key: string | null, d: StoredDraft) => {
        const empty = isEmptyDraft(d);
        if (empty && sending.current && sending.current.memKey === memKey) return;
        if (!key) {
            if (empty) memoryDrafts.delete(memKey);
            else memoryDrafts.set(memKey, d);
            return;
        }
        writeDraft(key, d);
    }, []);
    // One pending write at a time. A pending write for another key (the conversation changed) is flushed before
    // the new one is queued, so switching never drops the last keystrokes of the outgoing draft.
    const pendingWrite = useRef<{ memKey: string; key: string | null; snap: StoredDraft } | null>(null);
    const writeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const flushPending = useCallback(() => {
        clearTimeout(writeTimer.current);
        const w = pendingWrite.current;
        pendingWrite.current = null;
        if (w) persist(w.memKey, w.key, w.snap);
    }, [persist]);
    useEffect(() => {
        if (pendingWrite.current && pendingWrite.current.memKey !== draftKey) flushPending();
        pendingWrite.current = { memKey: draftKey, key: storeKey, snap: snapshotRef.current() };
        clearTimeout(writeTimer.current);
        writeTimer.current = setTimeout(flushPending, 150);
    }, [text, attachments, multi, caret, fullscreen, editorView, draftKey, storeKey, flushPending]);
    useEffect(() => {
        // Leaving the page: write the live state now (it also catches a selection change with no pending write).
        const leave = () => {
            pendingWrite.current = {
                memKey: shownKeyRef.current,
                key: storeKeyRef.current,
                snap: snapshotRef.current(),
            };
            flushPending();
        };
        const onVisibility = () => document.visibilityState === "hidden" && leave();
        addEventListener("pagehide", leave);
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            removeEventListener("pagehide", leave);
            document.removeEventListener("visibilitychange", onVisibility);
            flushPending(); // unmount (route change)
        };
    }, [flushPending]);
    const shownKeyRef = useRef(draftKey);
    shownKeyRef.current = draftKey;
    const storeKeyRef = useRef(storeKey);
    storeKeyRef.current = storeKey;

    // Server copy (lib/drafts.ts): pushed about 800ms after the last change, with a keepalive request when the
    // page goes away, and reconciled once each time a draft is opened.
    const scopeRef = useRef(scope);
    scopeRef.current = scope;
    const userIdRef = useRef(userId);
    userIdRef.current = userId;
    const pushNow = useCallback(
        async (sc: string, snap: StoredDraft, account = userId) => {
            if (!account) return;
            if (isEmptyDraft(snap) && sending.current) return;
            const res = await pushServerDraft(sc, snap, account);
            if (res === undefined || scopeRef.current !== sc || userIdRef.current !== account) return;
            serverCopy.current = res ? { text: res.text, attachments: res.attachments, at: res.updatedAt } : null;
            void queryClient.invalidateQueries({ queryKey: draftListKey });
            // Mark the local copy as in sync, unless the user typed again meanwhile.
            const cur = snapshotRef.current();
            if (cur.synced && storeKeyRef.current) writeDraft(storeKeyRef.current, cur);
        },
        [userId],
    );
    useEffect(() => {
        if (!scope) return;
        const snap = snapshotRef.current();
        if (snap.synced || reconciledScope.current !== scope || (isEmptyDraft(snap) && sending.current)) return;
        const t = setTimeout(() => void pushNow(scope, snapshotRef.current()), 800);
        return () => clearTimeout(t);
    }, [text, attachments, scope, pushNow]);
    useEffect(() => {
        const leave = () => {
            const sc = scopeRef.current;
            const snap = snapshotRef.current();
            if (sc && reconciledScope.current === sc && !snap.synced && !(isEmptyDraft(snap) && sending.current))
                beaconServerDraft(sc, snap, userId!);
        };
        addEventListener("pagehide", leave);
        return () => {
            removeEventListener("pagehide", leave);
            const sc = scope;
            const local = storeKey ? readDraft(storeKey) : null;
            if (sc && reconciledScope.current === sc && userId && local && !local.synced)
                void pushServerDraft(sc, local, userId);
        };
    }, [scope, storeKey, userId]);
    // Seed what the server holds from the stored copy before any effect writes the draft again (layout
    // effects run first), so the first local write keeps `synced` and `serverAt`.
    const loaded = useRef<Draft | null>(null);
    useLayoutEffect(() => {
        typedSinceLoad.current = false;
        reconciledScope.current = null;
        const local = storeKey ? readDraft(storeKey) : null;
        loaded.current = local;
        serverCopy.current =
            local?.serverAt !== undefined && local.synced
                ? { text: local.text, attachments: local.attachments, at: local.serverAt }
                : null;
        // Once per opened draft.
    }, [scope]);
    useEffect(() => {
        if (!scope) return;
        const local = loaded.current;
        let live = true;
        void fetchServerDraft(scope, userId!).then((server) => {
            if (!live || scopeRef.current !== scope || server === undefined) return;
            reconciledScope.current = scope;
            const changed =
                typedSinceLoad.current || !sameDraft(snapshotRef.current(), local ?? { text: "", attachments: [] });
            const action = reconcile(local, server, changed);

            if (server)
                serverCopy.current = { text: server.text, attachments: server.attachments, at: server.updatedAt };
            else if (action !== "drop") serverCopy.current = null;
            if (action === "take" && server) {
                setText(server.text);
                setAttachments(features.attachments ? server.attachments : []);
                pendingSelection.current = [server.text.length, server.text.length];
            } else if (action === "drop") {
                serverCopy.current = null;
                setText("");
                setAttachments([]);
            } else if (action === "push") {
                void pushNow(scope, snapshotRef.current());
            }
        });
        return () => {
            live = false;
        };
        // Once per opened draft (scope); the stored copy is read inside.
    }, [scope, features.attachments]);

    // A temporary chat's draft never stays on disk (for example one typed before the chat was known to be
    // temporary).

    // Another tab edited the same draft: take it, unless this tab's editor is focused (never move a live caret).
    useEffect(
        () =>
            subscribeDrafts((key) => {
                if (key !== null && key !== storeKey) return;
                const typingHere =
                    document.activeElement === editor.current &&
                    document.hasFocus() &&
                    document.visibilityState === "visible";
                if (typingHere) return;
                const d = readDraft(storeKey);
                const cur = snapshotRef.current();
                if ((d?.text ?? "") === cur.text && (d?.attachments.length ?? 0) === cur.attachments.length) return;
                if (!d && sending.current) return;
                setText(d?.text ?? "");
                setAttachments(features.attachments ? (d?.attachments ?? []) : []);
            }),
        [storeKey, features.attachments],
    );

    // Text added from the thread (selection toolbar, insert.ts): appended as a new block, caret at the end, focused.
    useEffect(
        () =>
            onComposerInsert(conversationId, (block) => {
                const next = appendBlock(snapshotRef.current().text, block);
                pendingCaret.current = next.length;
                setText(next);
            }),
        [conversationId],
    );

    // After a reload, say that the draft came back (once per page load, only for a draft with content).
    useEffect(() => {
        if (!pageLoadPending) return;
        pageLoadPending = false;
        if (initial && !isEmptyDraft(initial) && performance.now() < 15_000)
            toast.info(translate("composer-draft-restored"), { id: COMPOSER_TOAST, duration: 2500 });
        // Mount only.
    }, []);

    // Drop drafts of conversations that no longer exist, once per page load when both lists are known.
    const { data: activeList } = useQuery(conversationsQuery(false));
    const { data: archivedList } = useQuery({ ...conversationsQuery(true), enabled: !prunedThisLoad });
    useEffect(() => {
        if (prunedThisLoad || !activeList || !archivedList) return;
        prunedThisLoad = true;
        if (userId) pruneMissing(new Set([...activeList, ...archivedList].map((c) => c.id)), userId);
    }, [activeList, archivedList]);

    // Mod+Z on an empty composer within 10s of sending puts the sent text back.
    const lastSent = useRef<{ text: string; at: number } | null>(null);

    // Restore the selection of a loaded draft (once per load), without stealing focus.
    useLayoutEffect(() => {
        const sel = pendingSelection.current;
        const ed = editor.current;
        if (!sel || !ed) return;
        pendingSelection.current = null;
        ed.setSelectionRange(sel[0], sel[1]);
        setCaret(sel[1]);
    }, [draftKey]);

    // Restore the caret after programmatic text changes (menu picks, commands).
    useLayoutEffect(() => {
        const p = pendingCaret.current;
        const ed = editor.current;
        if (p === null || !ed) return;
        pendingCaret.current = null;
        ed.focus({ preventScroll: true });
        ed.setSelectionRange(p, p);
        setCaret(p);
    }, [text]);

    // Dictation. Browser mode writes the live transcript between the text before and after the caret.
    const speech = useSpeechConfig(features.dictation);
    const dictationBase = useRef({ before: "", after: "" });
    const joinAt = (before: string, insert: string, after: string) => {
        const lead = before && !/\s$/.test(before) ? " " : "";
        const tail = after && !/^\s/.test(after) ? " " : "";
        return { value: before + lead + insert + tail + after, caret: (before + lead + insert).length };
    };
    const dictation = useDictation(speech.mode, speech.language, {
        onLive: (t) => {
            const { before, after } = dictationBase.current;
            const next = t ? joinAt(before, t, after) : { value: before + after, caret: before.length };
            setText(next.value);
            pendingCaret.current = next.caret;
        },
        onCancel: () => {
            const { before, after } = dictationBase.current;
            setText(before + after);
            pendingCaret.current = before.length;
        },
        onError: (m) => reportError(t("composer-dictation-stopped"), m),
    });
    const dictating = dictation.state !== "idle";
    const startDictation = () => {
        if (!features.dictation) return;
        const at = editor.current?.selectionStart ?? text.length;
        dictationBase.current = { before: text.slice(0, at), after: text.slice(at) };
        clearError();
        setPlusOpen(false);
        void dictation.start();
    };

    const focusEditor = useCallback(() => {
        if (!coarse) editor.current?.focus({ preventScroll: true });
    }, [coarse]);

    // Autofocus on desktop only (on touch it would raise the keyboard on every navigation).
    useEffect(() => {
        if (!matchMedia("(pointer: coarse)").matches) editor.current?.focus({ preventScroll: true });
    }, [draftKey]);

    // Attachments (attachments.tsx) and their chips (chips.tsx). `latest` lets the callbacks below read the current
    // text and attachments without being re-created on every keystroke.
    const latest = useRef({ text, attachments, fullscreen });
    latest.current = { text, attachments, fullscreen };
    /** Files kept for a retry, and ids removed while their upload was still running. */
    const sources = useRef(new Map<string, File>());
    const removed = useRef(new Set<string>());
    const [announcement, setAnnouncement] = useState("");
    const patchAttachment = useCallback(
        (id: string, patch: Partial<Attachment>) =>
            setAttachments((prev) => prev.map((a) => (a.id === id ? ({ ...a, ...patch } as Attachment) : a))),
        [],
    );

    const startAttachment = useCallback(
        (id: string) => {
            if (!features.attachments) return;
            const file = sources.current.get(id);
            if (!file) return;
            const epoch = captureSessionEpoch();
            const failed = (e: unknown) => {
                if (!isSessionEpochCurrent(epoch) || removed.current.has(id)) return;
                const retry = e instanceof UploadError ? e.retry : true;
                patchAttachment(id, {
                    status: "failed",
                    error: e instanceof Error ? e.message : t("composer-upload-failed"),
                    canRetry: retry,
                });
            };
            patchAttachment(id, { status: "uploading", error: undefined, canRetry: undefined });
            if (file.type.startsWith("image/")) {
                readImageUrl(file)
                    .then((url) => {
                        if (!isSessionEpochCurrent(epoch) || removed.current.has(id)) return;
                        sources.current.delete(id);
                        patchAttachment(id, { status: undefined, url } as Partial<Attachment>);
                    })
                    .catch((e: unknown) =>
                        failed(e instanceof Error ? new UploadError(e.message, "file_too_large", false) : e),
                    );
                return;
            }
            uploadComposerFile(file, conversationId)
                .then((up) => {
                    if (!isSessionEpochCurrent(epoch)) return;
                    if (removed.current.has(id)) return discardComposerUpload(up.id);
                    // A pasted file keeps its bytes, so Undo after deleting its chip can upload it again.
                    if (!latest.current.attachments.some((x) => x.id === id && x.marker)) sources.current.delete(id);
                    patchAttachment(id, { status: undefined, uploadId: up.id } as Partial<Attachment>);
                })
                .catch(failed);
        },
        [features.attachments, conversationId, patchAttachment],
    );

    /** Put `token` at the caret (or over the selection), with a space on each side where needed. */
    const insertAtCaret = useCallback((token: string) => {
        const cur = latest.current.text;
        const ed = editor.current;
        // The full-screen editor keeps its own selection (fsSelection); the textarea is hidden then.
        const fs = latest.current.fullscreen ? fsSelection.current : null;
        const from = Math.min(fs?.[0] ?? ed?.selectionStart ?? cur.length, cur.length);
        const to = Math.min(fs?.[1] ?? ed?.selectionEnd ?? cur.length, cur.length);
        const before = cur.slice(0, from);
        const after = cur.slice(to);
        const insert = `${before && !/\s$/.test(before) ? " " : ""}${token}${/^\s/.test(after) ? "" : " "}`;
        typedSinceLoad.current = true;
        setText(before + insert + after);
        if (fs) fsSelection.current = [before.length + insert.length, before.length + insert.length];
        else pendingCaret.current = before.length + insert.length;
    }, []);

    /** Add files. `chips` is true for a paste: each file also gets a marker in the text at the caret. */
    const addFiles = useCallback(
        (files: File[], opts: { chips?: boolean; kind?: "paste" } = {}) => {
            if (!features.attachments || !files.length) return;
            const { text: cur, attachments: have } = latest.current;
            let n = nextMarkerNumber(
                cur,
                have.flatMap((a) => (a.marker ? [a.marker] : [])),
            );
            const added: Attachment[] = [];
            for (const f of files) {
                const image = f.type.startsWith("image/");
                const ext = f.type.split("/")[1]?.replace(/[+;].*/, "") || "png";
                const name = f.name || (image ? `pasted-image.${ext}` : "pasted-file");
                const id = crypto.randomUUID();
                const marker = opts.chips ? markerFor(opts.kind ?? (image ? "image" : "file"), n++) : undefined;
                sources.current.set(id, f.name === name ? f : new File([f], name, { type: f.type }));
                added.push(
                    image
                        ? { id, kind: "image", name, url: "", status: "uploading", ...(marker ? { marker } : {}) }
                        : { id, kind: "file", name, size: f.size, status: "uploading", ...(marker ? { marker } : {}) },
                );
            }
            setAttachments((prev) => [...prev, ...added]);
            const markers = added.flatMap((a) => (a.marker ? [a.marker] : []));
            if (markers.length) {
                insertAtCaret(markers.join(" "));
                setAnnouncement(t("composer-chip-added", { labels: markers.map(markerLabel).join(", ") }));
            }
            for (const a of added) startAttachment(a.id);
        },
        [features.attachments, insertAtCaret, startAttachment, t],
    );
    const dragging = useFileDrop((files) => addFiles(files), features.attachments);

    /** Remove an attachment, its marker in the text and, when it was never sent, its upload. */
    const removeAttachment = useCallback(
        (id: string) => {
            const a = latest.current.attachments.find((x) => x.id === id);
            if (!a) return;
            removed.current.add(id);
            sources.current.delete(id);
            if (a.kind === "file" && a.uploadId) discardComposerUpload(a.uploadId);
            setAttachments((prev) => prev.filter((x) => x.id !== id));
            const marker = a.marker;
            if (!marker) return;
            setAnnouncement(t("composer-chip-removed", { label: markerLabel(marker) }));
            setText((t) => {
                const at = t.indexOf(marker);
                return at < 0 ? t : removeChip(t, { start: at, end: at + marker.length }).text;
            });
        },
        [t],
    );
    // A chip deleted from the text (Backspace, cut, an edit) takes its attachment with it. The attachment is kept
    // in `undone` by its marker, so Undo, which brings the marker's text back, brings the attachment back too.
    const undone = useRef(new Map<string, { attachment: Attachment; file?: File }>());
    useEffect(() => {
        for (const a of attachments) {
            if (!a.marker || text.includes(a.marker)) continue;
            undone.current.set(a.marker, { attachment: a, file: sources.current.get(a.id) });
            removeAttachment(a.id);
        }
    }, [text, attachments, removeAttachment]);
    useEffect(() => undone.current.clear(), [draftKey]);
    /** After Undo: the attachments whose marker is back in `value`. A file is uploaded again (its upload was removed). */
    const restoreUndone = (value: string) => {
        if (!features.attachments) return;
        for (const [marker, { attachment, file }] of undone.current) {
            if (!value.includes(marker) || latest.current.attachments.some((a) => a.marker === marker)) continue;
            undone.current.delete(marker);
            const id = crypto.randomUUID();
            if (attachment.kind === "image") {
                if (!attachment.url) continue;
                setAttachments((prev) => [...prev, { ...attachment, id, status: undefined }]);
            } else {
                if (!file) continue;
                sources.current.set(id, file);
                setAttachments((prev) => [...prev, { ...attachment, id, uploadId: undefined, status: "uploading" }]);
                startAttachment(id);
            }
            setAnnouncement(t("composer-chip-added", { labels: markerLabel(marker) }));
        }
    };
    const retryAttachment = useCallback((id: string) => startAttachment(id), [startAttachment]);
    /** Phone "+" sheet: an @mention of an MCP server at the caret, as picked from the "@" list. */
    const mentionAtCaret = (token: string) => {
        const at = editor.current?.selectionStart ?? text.length;
        const before = text.slice(0, at);
        const insert = `${before && !/\s$/.test(before) ? " " : ""}${token} `;
        setMentions((m) => [...m, token]);
        setText(before + insert + text.slice(at));
        pendingCaret.current = (before + insert).length;
    };
    const onPicked = (e: FormEvent<HTMLInputElement>) => {
        addFiles([...(e.currentTarget.files ?? [])]);
        e.currentTarget.value = "";
    };

    // Suggestion menu: "+" (explicit), "@" mentions or "/" commands (from the text before the caret).
    // Chips (chips.tsx): attachment markers, "@" mentions and "/" commands. Backspace or Delete next to one removes it
    // whole, and the caret never rests inside one.
    const chipTokens = useMemo(
        () => ({ mentions, markers: attachments.flatMap((a) => (a.marker ? [a.marker] : [])) }),
        [mentions, attachments],
    );
    const chips = useMemo(() => scanChips(text, chipTokens.mentions, chipTokens.markers), [text, chipTokens]);
    // A finished chip is not a query: the caret at the end of "@notes" must not open the menu again.
    const detected = useMemo(() => detectTrigger(text, caret), [text, caret]);
    function commandEnabled(name: string): boolean {
        return name === "model"
            ? features.modelPicker
            : name === "effort"
              ? features.effort
              : name === "permission"
                ? features.permissions
                : true;
    }
    const trigger =
        detected &&
        (detected.kind === "mention" ? features.mentions : features.commands) &&
        (detected.kind !== "argument" || commandEnabled(detected.command)) &&
        detected.start !== dismissed &&
        !chips.some((c) => c.start === detected.start)
            ? detected
            : null;
    const menu: "plus" | "mention" | "command" | "argument" | null = plusOpen ? "plus" : (trigger?.kind ?? null);
    const query = trigger?.query ?? "";
    // The "+" menu lists the servers too (the same list as "@" with nothing typed).
    const mcpQ = useMcp(features.mcp && (menu === "mention" || menu === "plus" || attachOpen));
    const commandsQ = useCommands(
        features.commands && (text.trimStart().startsWith("/") || menu === "command" || menu === "argument"),
        conversationId,
    );
    // "@server/..." searches that server's tools; any other "@text" searches files too.
    const slash = query.indexOf("/");
    const servers = features.mcp ? (mcpQ.data ?? []) : [];
    const scopedServer = slash > 0 ? servers.find((sv) => sv.name === query.slice(0, slash)) : undefined;
    const resourcesQ = useMcpResources(
        features.mcp && menu === "mention" && !!scopedServer?.connected,
        scopedServer?.name,
    );

    type Entry = { item: SuggestItem; run: (viaTab: boolean) => void };
    const entries = useMemo((): {
        sections: { label?: string; entries: Entry[] }[];
        footer?: string;
        status: string;
    } => {
        if (!menu) return { sections: [], status: "" };
        // Through the browser's editing commands where it can, so Undo takes a pick back to the typed query.
        // Without a typed trigger (the "+" menu) the text goes in at the caret.
        const replace = (insert: string) => {
            const ed = editor.current;
            const end = trigger ? caret : (ed?.selectionEnd ?? text.length);
            const start = trigger?.start ?? ed?.selectionStart ?? end;
            if (!trigger && !insert) return;
            const lead = !trigger && start > 0 && !/\s/.test(text[start - 1] ?? "") ? " " : "";
            if (ed && editTextarea(ed, start, end, lead + insert)) return;
            setText((t) => t.slice(0, start) + lead + insert + t.slice(end));
            pendingCaret.current = start + lead.length + insert.length;
        };
        const mention = (token: string) => {
            setMentions((m) => [...m, token]);
            replace(`${token} `);
        };
        const attach: Entry = {
            item: attachItem(),
            run: () => {
                if (trigger) replace("");
                setPlusOpen(false);
                fileInput.current?.click();
            },
        };
        const serverEntry = (sv: McpServer): Entry => ({
            item: serverItem(sv),
            run: (viaTab) => (viaTab && sv.tools.length ? replace(`@${sv.name}/`) : mention(`@${sv.name}`)),
        });
        const toolEntry = (sv: McpServer, t: McpTool): Entry => ({
            item: toolItem(sv.name, t),
            run: () => mention(`@${toolPath(sv, t)}`),
        });

        if (menu === "argument" && trigger?.kind === "argument") {
            const q = query.toLowerCase();
            const done = (...args: Parameters<typeof confirmChange>) => {
                setText("");
                pendingCaret.current = 0;
                confirmChange(...args);
            };
            if (trigger.command === "effort") {
                const model = choice.model;
                const efforts = model?.reasoning ? model.efforts : [];
                const options: ThinkingSelector[] = efforts.length ? ["auto", ...efforts] : [];
                const list = options
                    .filter((e) => !q || e.startsWith(q) || EFFORT_LABELS[e].toLowerCase().includes(q))
                    .map((e): Entry => ({
                        item: {
                            id: `effort:${e}`,
                            title: EFFORT_LABELS[e],
                            icon: <Brain className="size-5" />,
                            checked: e === choice.effort,
                        },
                        run: () => {
                            choice.setEffort(e);
                            done(
                                "effort",
                                t("composer-effort-changed"),
                                t("composer-applies-to-new", { name: EFFORT_LABELS[e] }),
                                <Lightbulb />,
                            );
                        },
                    }));
                return {
                    sections: [{ label: t("composer-effort-label"), entries: list }],
                    status: efforts.length ? t("composer-effort-no-match") : t("composer-effort-unsupported"),
                };
            }
            if (trigger.command === "model") {
                const list = searchModels(choice.models ?? [], query)
                    .slice(0, 50)
                    .map((m): Entry => ({
                        item: {
                            id: `model:${m.id}`,
                            title: m.name,
                            description: identityOf(m).byline,
                            icon: <ModelMark model={m} size={20} />,
                            checked: m.id === choice.modelId,
                        },
                        run: () => {
                            choice.setModel(m.id);
                            done(
                                "model",
                                t("composer-model-changed"),
                                t("composer-applies-to-new", { name: m.name }),
                                <ModelMark model={m} size={20} />,
                            );
                        },
                    }));
                return {
                    sections: [{ label: t("composer-models-section"), entries: list }],
                    status: choice.models ? t("composer-model-no-match") : t("composer-loading"),
                };
            }
            if (trigger.command === "permission") {
                const rows: [Permission, string][] = [
                    ["default", t("composer-permission-default")],
                    ["full", t("composer-permission-full")],
                ];
                const list = rows
                    .filter(([id, label]) => !q || id.startsWith(q) || label.toLowerCase().includes(q))
                    .map(([id, label]): Entry => ({
                        item: {
                            id: `perm:${id}`,
                            title: label,
                            icon: id === "full" ? <WarningCircle className="size-5" /> : <Hand className="size-5" />,
                            checked: id === choice.permission,
                        },
                        run: () => {
                            choice.setPermission(id);
                            done(
                                "permission",
                                t("composer-permission-changed"),
                                id === "full"
                                    ? t("composer-permission-full-effect")
                                    : t("composer-permission-default-effect"),
                                id === "full" ? <WarningCircle /> : <Hand />,
                            );
                        },
                    }));
                return {
                    sections: [{ label: t("composer-permission-section"), entries: list }],
                    status: t("composer-no-match"),
                };
            }
            const list: Entry[] = !q
                ? [
                      {
                          item: {
                              id: "new:none",
                              title: t("composer-new-chat"),
                              icon: <NotePencil className="size-5" />,
                          },
                          run: () => runAppCommand("new", ""),
                      },
                  ]
                : [];
            return {
                sections: [{ entries: list }],
                status: t("composer-no-match"),
            };
        }
        if (menu === "command") {
            const toEntry = (m: CommandMatch): Entry => {
                const c = m.command;
                const blocked = c.source === "agent" && !conversationId;
                const item = commandItem(m);
                return {
                    item: blocked ? { ...item, description: t("composer-start-chat-first"), disabled: true } : item,
                    run: () => {
                        if (blocked) return;
                        if (c.source === "app" && (ARG_COMMANDS as readonly string[]).includes(c.name)) {
                            // Commands with an argument list open it, so the argument can be filled in.
                            replace(`/${c.name} `);
                            return;
                        }
                        if (c.source === "app" && APP_COMMANDS.has(c.name)) {
                            replace("");
                            runAppCommand(c.name, "");
                            return;
                        }
                        // Agent commands, skills and MCP prompts become an inline token, like the reference's mentions.
                        const token = `/${c.name}`;
                        setMentions((ms) => [...ms, token]);
                        if (c.hint) setCommandHints((h) => ({ ...h, [token]: c.hint ?? "" }));
                        replace(`${token} `);
                    },
                };
            };
            const matched = filterCommands(
                (commandsQ.data ?? []).filter(
                    (c) => (c.source !== "app" || commandEnabled(c.name)) && (c.source !== "mcp" || features.mcp),
                ),
                query,
            );
            // MCP prompts are named `<server>:<prompt>`: one heading per server.
            const mcpPromptSections = (entries: Entry[]) => {
                const byServer = new Map<string, Entry[]>();
                for (const e of entries) {
                    const server = e.item.id.replace(/^cmd:mcp:/, "").split(":")[0] || "MCP";
                    byServer.set(server, [...(byServer.get(server) ?? []), e]);
                }
                return [...byServer].map(([server, list]) => ({
                    label: t("composer-mcp-prompts-section", { server }),
                    entries: list,
                }));
            };
            const group = (src: CommandInfo["source"]) => matched.filter((m) => m.command.source === src).map(toEntry);
            return {
                sections: [
                    { entries: group("app") },
                    { label: t("composer-section-agent"), entries: group("agent") },
                    { label: t("composer-section-skills"), entries: group("skill") },
                    ...mcpPromptSections(group("mcp")),
                ],
                status: commandsQ.isError
                    ? t("composer-commands-error")
                    : commandsQ.isLoading
                      ? t("composer-loading")
                      : t("composer-no-commands"),
            };
        }
        if (menu === "plus" || !query) {
            return {
                sections: [
                    { entries: features.attachments ? [attach] : [] },
                    { entries: servers.map(serverEntry) },
                ],
                footer: t("composer-search-footer"),
                status: "",
            };
        }
        if (scopedServer) {
            const q = query.slice(slash + 1).toLowerCase();
            const tools = scopedServer.tools.filter(
                (t) =>
                    !q ||
                    toolPath(scopedServer, t).toLowerCase().includes(q) ||
                    (t.description ?? "").toLowerCase().includes(q),
            );
            return {
                sections: [
                    {
                        label: scopedServer.name,
                        entries: [
                            ...(!q
                                ? [{ item: wholeServerItem(scopedServer), run: () => mention(`@${scopedServer.name}`) }]
                                : []),
                            ...tools.map((t) => toolEntry(scopedServer, t)),
                        ],
                    },
                    {
                        label: t("composer-resources"),
                        entries: (resourcesQ.data ?? [])
                            .filter((r) => !q || `${r.name} ${r.title ?? ""} ${r.uri}`.toLowerCase().includes(q))
                            .map((r): Entry => ({
                                item: resourceItem(r),
                                run: () => mention(resourceToken(scopedServer.name, r.uri)),
                            })),
                    },
                ],
                status: scopedServer.connected
                    ? t("composer-no-tools")
                    : (scopedServer.error ?? t("composer-server-not-connected")),
            };
        }
        const q = query.toLowerCase();
        const matchedServers = servers.filter((sv) => sv.name.toLowerCase().includes(q)).map(serverEntry);
        const matchedTools = servers
            .flatMap((sv) =>
                sv.tools
                    .filter((t) => t.name.toLowerCase().includes(q) || t.label.toLowerCase().includes(q))
                    .map((t) => toolEntry(sv, t)),
            )
            .slice(0, 20);
        const actions = features.attachments && "add photos & files".includes(q) ? [attach] : [];
        return {
            sections: [
                { label: t("composer-section-mcp"), entries: [...matchedServers, ...matchedTools] },
                { label: t("composer-section-actions"), entries: actions },
            ],
            status: mcpQ.isError
                ? t("composer-files-error")
                : mcpQ.isLoading
                  ? t("composer-loading")
                  : t("composer-no-files-or-tools"),
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        menu,
        query,
        features,
        trigger?.start,
        caret,
        servers,
        scopedServer,
        resourcesQ.data,
        t,
        commandsQ.data,
        commandsQ.isLoading,
        commandsQ.isError,
        mcpQ.isLoading,
        mcpQ.isError,
        conversationId,
        choice.models,
        choice.model,
        choice.modelId,
        choice.effort,
        choice.permission,
    ]);
    const flat = useMemo(() => entries.sections.flatMap((sec) => sec.entries), [entries]);
    const sections = useMemo(
        () => entries.sections.map((sec) => ({ label: sec.label, items: sec.entries.map((e) => e.item) })),
        [entries],
    );
    const menuKey = `${menu}:${trigger?.start ?? ""}:${query}`;
    const menuKeyRef = useRef(menuKey);
    menuKeyRef.current = menuKey;
    const active = activeState.key === menuKey ? Math.min(activeState.index, Math.max(0, flat.length - 1)) : 0;
    const setActive = useCallback((index: number) => setActiveState({ key: menuKeyRef.current, index }), []);

    // Close the "+" menu on an outside press.
    useEffect(() => {
        if (!plusOpen) return;
        const onDown = (e: PointerEvent) => {
            if (!root.current?.contains(e.target as Node)) setPlusOpen(false);
        };
        document.addEventListener("pointerdown", onDown);
        return () => document.removeEventListener("pointerdown", onDown);
    }, [plusOpen]);

    /**
     * Client-side commands. They never reach the server. With an argument they set the state directly and
     * confirm with a notice; without one they open the matching control.
     */

    function runAppCommand(name: string, arg: string): boolean {
        if (!commandEnabled(name)) return false;
        const a = arg.trim();
        const clearInput = () => {
            setText("");
            setMentions([]);
            pendingCaret.current = 0;
        };
        if (name === "clear") {
            clearInput();
            setAttachments([]);
            confirmChange("composer", t("composer-cleared"), t("composer-cleared-detail"), <Broom />);
            return true;
        }
        if (name === "new") {
            clearInput();
            void navigate({ to: "/", search: {} });
            return true;
        }
        if (name === "effort") {
            const model = choice.model;
            if (!model?.reasoning || !model.efforts.length) {
                clearInput();
                confirmChange(
                    "model",
                    t("composer-effort-none"),
                    model ? t("composer-effort-none-detail", { name: model.name }) : undefined,
                    <WarningCircle />,
                );
                return true;
            }
            const e = a ? parseEffort(a, model.efforts) : undefined;
            clearInput();
            if (e) {
                choice.setEffort(e);
                confirmChange(
                    "effort",
                    t("composer-effort-changed"),
                    t("composer-applies-to-new", { name: EFFORT_LABELS[e] }),
                    <Lightbulb />,
                );
            } else setEffortOpen(true);
            return true;
        }
        if (name === "model") {
            clearInput();
            const models = choice.models ?? [];
            const exact = models.find((m) =>
                [m.id, m.modelId, m.name].some((v) => v.toLowerCase() === a.toLowerCase()),
            );
            const hits = a ? searchModels(models, a) : [];
            const pickModel = exact ?? (hits.length === 1 ? hits[0] : undefined);
            if (pickModel) {
                choice.setModel(pickModel.id);
                confirmChange(
                    "model",
                    t("composer-model-changed"),
                    t("composer-applies-to-new", { name: pickModel.name }),
                    <ModelMark model={pickModel} size={20} />,
                );
            } else {
                setPickerQuery(a);
                setPickerOpen(true);
            }
            return true;
        }
        if (name === "permission") {
            clearInput();
            const v = a.toLowerCase();
            const p: Permission | undefined = v.startsWith("full")
                ? "full"
                : v.startsWith("def") || v.startsWith("ask")
                  ? "default"
                  : undefined;
            if (p) {
                choice.setPermission(p);
                confirmChange(
                    "permission",
                    t("composer-permission-changed"),
                    p === "full" ? t("composer-permission-full-effect") : t("composer-permission-default-effect"),
                    p === "full" ? <WarningCircle /> : <Hand />,
                );
            } else setText("/permission ");
            if (!p) pendingCaret.current = "/permission ".length;
            return true;
        }
        return false;
    }

    /**
     * Agent runtime commands (/compact, /context, ...) run inside an existing conversation without an optimistic
     * user bubble. A local-only result (`response.local`) shows as a notice above the composer instead of a chat
     * exchange, and its live state is dropped.
     */
    const runAgentCommand = (commandText: string) => {
        if (!conversationId) {
            toast.info(t("composer-start-chat-first"), {
                id: COMPOSER_TOAST,
                description: t("composer-commands-need-chat"),
            });
            return;
        }
        const cid = conversationId;
        socket.send({
            type: "response.create",
            conversation: cid,
            model: features.modelPicker ? choice.modelId : undefined,
            reasoning: features.effort && choice.effort ? { effort: choice.effort } : undefined,
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: commandText }] }],
            metadata: { permission: choice.permission },
        });
        const off = socket.on((e: ServerEvent) => {
            if (isSendError(e)) {
                off();
                setNotice({ error: t("composer-command-failed"), text: e.error.message });
                return;
            }
            if (!/^response\.(completed|failed|cancelled|incomplete)$/.test(e.type) || !("response" in e)) return;
            if (e.response.conversation.id !== cid) return;
            off();
            if (!e.response.local) return;
            const out = e.response.output
                .flatMap((it) => (it.type === "message" ? it.content.map((c) => ("text" in c ? c.text : "")) : []))
                .join("\n")
                .trim();
            setNotice({ text: out || "Done" });
            clearLive(cid);
        });
        setTimeout(off, 120_000);
    };

    const pick = (index: number, viaTab = false) => {
        const e = flat[index];
        if (!e) return;
        if (e.item.disabled) {
            toast.info(t("composer-start-chat-first"), {
                id: COMPOSER_TOAST,
                description: t("composer-commands-need-chat"),
            });
            return;
        }
        if (menu === "plus") setPlusOpen(false);
        // A row that opens a level (`more`) opens it, by Enter, Tab or a click.
        e.run(viaTab || !!e.item.more);
    };

    // Menu levels: "@server/" and "/command " are a level below the first. The listbox is named after its level and
    // the change is announced. `backTo` holds the ids of the row to highlight after going back one level.
    const level = useMemo((): { label: string } => {
        if (menu === "command") return { label: t("composer-commands") };
        if (menu === "argument" && trigger?.kind === "argument")
            return { label: t("composer-menu-arguments", { command: `/${trigger.command}` }) };
        if (menu === "mention" && scopedServer)
            return { label: t("composer-menu-server", { server: scopedServer.name }) };
        return { label: t("composer-add-more") };
    }, [menu, trigger, scopedServer, t]);
    // Opening the menu is announced through the highlighted row; going down or back a level is not, so say it.
    const announcedLevel = useRef("");
    useEffect(() => {
        const key = menu ? level.label : "";
        const was = announcedLevel.current;
        announcedLevel.current = key;
        if (key && was && key !== was)
            setAnnouncement(t("composer-menu-level-opened", { label: level.label, count: flat.length }));
        // Only a change of level is announced, not a change in the number of rows.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [menu, level.label, t]);
    const backTo = useRef<string[] | null>(null);
    useEffect(() => {
        const ids = backTo.current;
        if (!ids || !menu) return;
        const i = flat.findIndex((e) => ids.includes(e.item.id));
        if (i < 0) return;
        backTo.current = null;
        setActive(i);
    }, [flat, menu, setActive]);
    /** A menu key (suggest.tsx menuKeyAction). True when the menu took the key. */
    const onMenuKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
        const back = trigger && menu !== "plus" ? menuBack(trigger) : null;
        const list = document.getElementById(menuId);
        const row = list?.querySelector<HTMLElement>('[role="option"]');
        const action = menuKeyAction(
            e.key,
            { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey },
            {
                count: flat.length,
                active,
                page: list && row ? Math.max(1, Math.floor(list.clientHeight / row.offsetHeight) - 1) : 5,
                canDrill: !!flat[active]?.item.more && !flat[active]?.item.disabled,
                canGoBack: !!back,
                // A fully typed command name runs on Enter instead of being picked from the list.
                enterRuns: menu === "command" && (commandsQ.data ?? []).some((c) => c.name === query),
            },
        );
        if (!action) return false;
        e.preventDefault();
        if (action.type === "move") setActive(action.index);
        else if (action.type === "pick") pick(active, action.viaTab);
        else if (action.type === "drill") pick(active, true);
        else if (action.type === "back" && back) {
            backTo.current = back.highlight;
            const ed = e.currentTarget;
            if (!editTextarea(ed, back.from, caret, back.text)) {
                setText(text.slice(0, back.from) + back.text + text.slice(caret));
                pendingCaret.current = back.from + back.text.length;
            }
        } else if (action.type === "close") {
            e.stopPropagation();
            if (plusOpen) setPlusOpen(false);
            else if (trigger) setDismissed(trigger.start);
        }
        return true;
    };

    // Caret and chips (the caret model is in chips.tsx). `motion` is the key that last moved the caret and when,
    // `lastSel` the selection after the last change, and `verticalGoal` the place inside a chip that Up or Down
    // aimed at before the snap, so the next Up or Down keeps its column.
    const lastSel = useRef<Sel>({ anchor: 0, focus: 0 });
    const motion = useRef<{ m: Motion; at: number }>({ m: NO_MOTION, at: 0 });
    const verticalGoal = useRef<{ at: number; goal: number } | null>(null);
    const composingText = useRef(false);
    const select = (ed: HTMLTextAreaElement, sel: Sel) => {
        const [start, end, direction] = rangeOf(sel);
        ed.setSelectionRange(start, end, direction);
        lastSel.current = sel;
    };
    /** Backspace or Delete next to a chip removes all of it (Ctrl or Alt: also across the spaces before it). */
    const deleteChip = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
        const ed = e.currentTarget;
        if (ed.selectionStart !== ed.selectionEnd || !chips.length || e.metaKey) return false;
        const key = e.key === "Delete" ? "Delete" : "Backspace";
        const hit = removeChipAt(text, chips, ed.selectionStart, key, e.ctrlKey || e.altKey);
        if (!hit) return false;
        e.preventDefault();
        if (!editTextarea(ed, hit.start, hit.end, "")) {
            setText(text.slice(0, hit.start) + text.slice(hit.end));
            pendingCaret.current = hit.start;
        }
        if (hit.chip.kind === "paste" || hit.chip.kind === "image" || hit.chip.kind === "file")
            setAnnouncement(t("composer-chip-removed", { label: markerLabel(hit.chip.token) }));
        return true;
    };
    /** Arrow keys around chips: one press steps over a chip; Up and Down keep their column past one. */
    const chipCaretKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
        const ed = e.currentTarget;
        const m = motionOf(e.key, getComputedStyle(ed).direction === "rtl");
        motion.current = { m, at: performance.now() };
        const sel = selOf(ed.selectionStart, ed.selectionEnd, ed.selectionDirection);
        lastSel.current = sel;
        if (!chips.length || e.altKey || e.ctrlKey || e.metaKey) return false;
        if (m.kind === "vertical") {
            const goal = verticalGoal.current;
            verticalGoal.current = null;
            // Start the browser's own move from where it aimed last time, inside the chip, not from the snapped edge.
            if (goal && goal.at === sel.focus)
                select(ed, { anchor: e.shiftKey ? sel.anchor : goal.goal, focus: goal.goal });
            return false;
        }
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return false;
        const next = stepOverChip(chips, sel, m.dir > 0, e.shiftKey);
        if (!next) return false;
        e.preventDefault();
        verticalGoal.current = null;
        select(ed, next);
        setCaret(Math.min(next.anchor, next.focus));
        return true;
    };
    /**
     * Every selection change of the editor (keys, clicks, programmatic): keep it out of chips. A native
     * selectionchange listener, because React's onSelect also fires inside keydown (before the browser moves the
     * caret) and not at all for setSelectionRange.
     */
    const onSelectionChange = useRef(() => {});
    onSelectionChange.current = () => {
        const ed = editor.current;
        if (!ed || document.activeElement !== ed) return;
        let sel = selOf(ed.selectionStart, ed.selectionEnd, ed.selectionDirection);
        if (chips.length && !composingText.current) {
            const m = performance.now() - motion.current.at < 400 ? motion.current.m : NO_MOTION;
            // A key moves the caret once: a later change (a script, a late event) must not take its direction.
            motion.current = { m: NO_MOTION, at: 0 };
            const snapped = snapSelection(chips, sel, m);
            if (snapped.anchor !== sel.anchor || snapped.focus !== sel.focus) {
                verticalGoal.current = m.kind === "vertical" ? { at: snapped.focus, goal: sel.focus } : null;
                select(ed, snapped);
                sel = snapped;
            }
        }
        lastSel.current = sel;
        setCaret(Math.min(sel.anchor, sel.focus));
    };
    useEffect(() => {
        const on = () => onSelectionChange.current();
        document.addEventListener("selectionchange", on);
        return () => document.removeEventListener("selectionchange", on);
    }, []);

    const images = draftAttachments(attachments);
    const uploading = attachments.some((a) => a.status === "uploading");
    // An open agent question with free text: the composer answers it (thread/questions).
    const question = useQuestionReply(conversationId);
    // Bootstrap owns session confirmation. A stored model id alone does not make a new send ready.
    const sessionReady = !!userId;
    const sendReady = sessionReady && !!choice.model && !choice.modelsError;
    const noModels = !!choice.models && choice.models.length === 0;
    // A question uses its existing response context, not a refreshed model catalogue. Stop is independent.
    const canSend =
        sessionReady &&
        (question ? !!text.trim() : sendReady) &&
        (!running || !!question) &&
        !creating &&
        !dictating &&
        !uploading &&
        (text.trim().length > 0 || attachments.length > 0);

    const submit = () => {
        if (!sessionReady) return;
        // Answering an agent question counts as a send: the draft is cleared here and on the server.
        if (question && text.trim()) {
            question.reply(text);
            lastSent.current = { text, at: Date.now() };
            setText("");
            setFullscreen(false);
            if (storeKey) removeDraft(storeKey);
            else memoryDrafts.delete(draftKey);
            clearTimeout(writeTimer.current);
            pendingWrite.current = null;
            if (scope) void pushServerDraft(scope, { text: "", attachments: [] }, userId!);
            return;
        }
        // Slash commands: app commands run here; agent commands use their own route.
        const cmd = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
        if (features.commands && cmd?.[1] && !attachments.length) {
            const name = cmd[1];
            const known = (commandsQ.data ?? []).find((c) => c.name === name);
            if ((known?.source === "app" || (!known && APP_COMMANDS.has(name))) && runAppCommand(name, cmd[2] ?? ""))
                return;
            if (!conversationId && !commandsQ.data) {
                // Unknown until the command list loads: never start a conversation just to run a command.
                toast.info(t("composer-commands-loading"), {
                    id: COMPOSER_TOAST,
                    description: t("composer-try-again"),
                });
                return;
            }
            if (known?.source === "agent" && !running) {
                if (!sendReady || creating || dictating || uploading) return;
                setText("");
                setMentions([]);
                runAgentCommand(text.trim());
                return;
            }
        }
        // No model could answer: keep the draft, say why (the send button's tooltip says the same).
        if (noModels && (text.trim() || attachments.length)) {
            toast.info(t("composer-no-models"), {
                id: COMPOSER_TOAST,
                description: t("composer-no-models-hint"),
                action: {
                    label: t("composer-open-settings"),
                    onClick: () => void navigate({ to: "/settings/$section", params: { section: "providers" } }),
                },
            });
            return;
        }
        if (!canSend) return;
        if (attachments.some((a) => a.status === "failed")) {
            toast.info(t("composer-failed-toast-title"), {
                id: COMPOSER_TOAST,
                description: t("composer-failed-toast-body"),
            });
            return;
        }
        const draft = { text, attachments, mentions };
        const parts = (features.attachments ? attachments : []).flatMap((a): (InputImage | InputFile)[] => {
            const marker = a.marker ? { marker: a.marker } : {};
            if (a.kind === "image") return [{ type: "input_image", image_url: a.url, ...marker }];
            return a.uploadId ? [{ type: "input_file", upload_id: a.uploadId, filename: a.name, ...marker }] : [];
        });
        const picked = { model: choice.modelId, effort: choice.effort };
        const sentContext = draftKey;
        const sentUser = userId;
        const restore = () => {
            if (shownKeyRef.current !== sentContext || userIdRef.current !== sentUser) return;
            setText((t) => t || draft.text);
            setAttachments((a) => (a.length ? a : draft.attachments));
            setMentions((m) => (m.length ? m : draft.mentions));
        };
        clearError();
        if (notice?.error) setNotice(null);
        setText("");
        setAttachments([]);
        setMentions([]);
        setCommandHints({});
        setFullscreen(false);
        setPlusOpen(false);
        // Keep the stored draft until the server accepts the message (see `sending`).
        // Flush the sent content before the field is cleared, including the final keystroke.
        clearTimeout(writeTimer.current);
        pendingWrite.current = null;
        persist(draftKey, storeKey, snapshotRef.current());
        const flight = { key: storeKey, memKey: draftKey, scope, userId };
        sending.current = flight;
        const settle = (ok: boolean) => {
            if (sending.current !== flight || userIdRef.current !== flight.userId) return;
            sending.current = null;
            if (!ok) return;
            lastSent.current = { text: draft.text, at: Date.now() };
            // Only clear what is still the sent draft: text typed since then is a new draft.
            const stored = flight.key ? readDraft(flight.key) : (memoryDrafts.get(flight.memKey) ?? null);
            const current = shownKeyRef.current === flight.memKey ? snapshotRef.current() : stored;
            if (
                (!current || isEmptyDraft(current) || sameDraft(current, { text: draft.text, attachments: images })) &&
                (!stored || sameDraft(stored, { text: draft.text, attachments: images }) || isEmptyDraft(stored))
            ) {
                clearTimeout(writeTimer.current);
                pendingWrite.current = null;
                if (flight.key) removeDraft(flight.key);
                else memoryDrafts.delete(flight.memKey);
                if (flight.scope) {
                    serverCopy.current = null;
                    void pushServerDraft(flight.scope, { text: "", attachments: [] }, flight.userId!).then(
                        () => void queryClient.invalidateQueries({ queryKey: draftListKey }),
                    );
                }
            }
        };
        rememberChoice(conversationId, picked);
        // A new chat has no id until the server creates it; Stop uses this temporary one until then.
        const tempId = conversationId ? undefined : `tmp_${crypto.randomUUID()}`;
        pendingNewChat.current = tempId;
        const pending = sendMessage(
            {
                conversationId,
                text,
                attachments: parts,
                model: features.modelPicker || !conversationId ? choice.modelId : undefined,
                // Hidden effort controls must not overwrite the conversation's server-owned effort.
                effort: features.effort ? choice.effort : undefined,
                permission: choice.permission,
                tempId,
            },
            {
                onAccepted: () => settle(true),
                // A rejected message stays in the thread with the reason and "Try again" (lib/send.ts), so the
                // turn owns the text now: treat the draft as sent. A new chat rejected before it exists is
                // handled below instead.
                onRejected: () => {
                    if (conversationId) settle(true);
                },
            },
        );
        if (conversationId) return;
        setCreating(true);
        pending
            .then((id) => {
                settle(true);
                if (shownKeyRef.current !== sentContext || userIdRef.current !== sentUser) return;
                rememberChoice(id, picked);
                onCreated?.(id);
                skipComposerMove();
                void navigate({ to: "/c/$conversationId", params: chatParams(id) });
            })
            .catch((e: unknown) => {
                // No conversation, so no thread to show it in: the reason shows above the composer and the text
                // comes back.
                settle(false);
                restore();
                if (tempId) clearLive(tempId);
                if (shownKeyRef.current !== sentContext || userIdRef.current !== sentUser) return;
                setNotice({
                    error: t("composer-send-failed"),
                    text: e instanceof Error ? e.message : t("composer-try-again"),
                });
            })
            .finally(() => {
                if (pendingNewChat.current === tempId) pendingNewChat.current = undefined;
                setCreating(false);
            });
    };

    const onSubmit = (e: FormEvent) => {
        e.preventDefault();
        submit();
    };

    // Stop: the running response, or the new chat still being created (its temporary id until the server answers).
    const creatingLive = useLive(creating ? pendingNewChat.current : undefined);
    const stopShown = running || (creating && !conversationId);
    const stopPending = stopping || !!creatingLive?.stopping;
    const onStop = () => {
        const key = conversationId ?? pendingNewChat.current;
        if (key) stopResponse(key);
    };

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        const composing = e.nativeEvent.isComposing || e.keyCode === 229;
        const sent = lastSent.current;
        if (
            sent &&
            !text &&
            (e.metaKey || e.ctrlKey) &&
            !e.shiftKey &&
            e.key.toLowerCase() === "z" &&
            Date.now() - sent.at < 10_000
        ) {
            e.preventDefault();
            lastSent.current = null;
            pendingCaret.current = sent.text.length;
            setText(sent.text);
            return;
        }
        if (menu && !composing && onMenuKey(e)) return;
        if (!composing && chipCaretKey(e)) return;
        if ((e.key === "Backspace" || e.key === "Delete") && !composing && deleteChip(e)) return;
        if (e.key !== "Enter" || composing) return;
        const mod = e.ctrlKey || e.metaKey;
        // Touch keyboards insert a newline on Enter (as in the reference mobile apps); the send button sends.
        const sends = enterToSend && !coarse ? !e.shiftKey && !e.altKey : mod;
        if (!sends) return;
        e.preventDefault();
        submit();
    };

    // Paste: files and screenshots become attachments with a marker at the caret. Text longer than the
    // `ui.composer.pasteAsFileChars` setting becomes a text file the same way. Everything else pastes as text.
    // Spreadsheet and word processor copies carry an image of the cells next to the text: the text wins then.
    /** True when the paste was taken (files or long text); the caller then cancels the browser's own paste. */
    const handlePaste = (data: DataTransfer): boolean => {
        if (!features.attachments) return false;
        const plain = data.getData("text/plain");
        let pasted = [...data.files];
        if (!pasted.length)
            pasted = [...data.items].flatMap((i) =>
                i.kind === "file" ? [i.getAsFile()].filter((f) => f !== null) : [],
            );
        if (pasted.length && !(plain && pasted.every((f) => f.type.startsWith("image/")))) {
            addFiles(pasted, { chips: true });
            return true;
        }
        if (question || pasteAsFileChars <= 0 || plain.length <= pasteAsFileChars) return false;
        const n = nextMarkerNumber(
            text,
            attachments.flatMap((a) => (a.marker ? [a.marker] : [])),
        );
        addFiles([new File([plain], `pasted-text-${n}.txt`, { type: "text/plain" })], { chips: true, kind: "paste" });
        return true;
    };
    const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
        if (handlePaste(e.clipboardData)) e.preventDefault();
    };

    const marks = useMemo(() => paintChips(text, chips), [text, chips]);
    // Argument hint as ghost text while the input holds only a command token (reference placeholder treatment).
    const ghost = useMemo(() => {
        const m = /^(\/\S+) $/.exec(text);
        return m?.[1] ? commandHints[m[1]] : undefined;
    }, [text, commandHints]);
    const layout = multi ? "multi" : "single";
    const showExpand = features.fullscreen && multi && overflowing;
    const phone = mobile;
    const editorText = "text-md leading-[26px] font-[400]";
    const singlePad = phone
        ? "h-12 px-1.5 py-[11px]"
        : "h-[var(--composer-control-height)] px-0 py-[calc((var(--composer-control-height)-26px)/2)]";
    const multiPad = phone
        ? cn("px-1.5 py-[11px]", showExpand && "pe-10")
        : cn("px-2.5 pt-[15px] pb-4 [scrollbar-gutter:stable]", showExpand && "pe-10");
    const reasoning =
        features.effort && !!choice.model?.reasoning && !!choice.effort && choice.model.efforts.length > 0;
    const hasTray =
        features.modelPicker ||
        features.permissions ||
        (features.mcp && !!conversationId) ||
        (!phone && features.disclaimer) ||
        (phone && reasoning);
    const hasAdd = features.attachments || features.mcp || (phone && features.fullscreen);
    const suggestMenu = menu && (
        <InlineMenu
            id={menuId}
            label={level.label}
            sections={sections}
            active={active}
            placement={placement}
            status={entries.status}
            footer={entries.footer}
            onHover={setActive}
            onPick={pick}
            sheet={phone ? root : undefined}
        />
    );

    return (
        <div
            ref={root}
            data-composer
            className={cn(
                "relative flex w-full flex-col",
                phone ? "gap-1.5" : "gap-2",
                phone && menu && "z-20",
                // The thread and temporary docks pad the inset themselves; padding it here too doubled it.
                variant === "home" && "pb-safe",
                !embedded && "[view-transition-name:composer]",
            )}
        >
            {/* Phones: the "/" and "@" sheet sits behind the composer and its tray (both z-1 below). */}
            {phone && suggestMenu}
            <BalloonAnnouncer text={announce} />
            {balloon && <Balloon key={balloon.id} balloon={balloon} anchor={balloon.el} onDone={balloonDone} />}
            {notice && (
                // Output of a local-only agent command (for example /context), or why a new chat or command could
                // not start: content about this composer, not a passing status, so it stays here instead of a toast.
                <div
                    role={notice.error ? "alert" : "status"}
                    className="absolute inset-x-0 bottom-[calc(100%+8px)] z-40 flex max-h-[40dvh] items-start gap-2 overflow-y-auto rounded-2xl bg-menu px-3 py-2 text-base text-text shadow-dropdown"
                >
                    {notice.error && (
                        <WarningCircle aria-hidden weight="fill" className="mt-1 size-[18px] shrink-0 text-danger" />
                    )}
                    <span className="min-w-0 flex-1 py-0.5 break-words whitespace-pre-wrap">
                        {notice.error && <span className="block font-medium">{notice.error}</span>}
                        <span className={cn(notice.error && "text-secondary")}>{notice.text}</span>
                    </span>
                    <button
                        type="button"
                        aria-label={t("composer-dismiss")}
                        onClick={() => setNotice(null)}
                        className="relative -my-0.5 -me-1 flex size-6 shrink-0 items-center justify-center rounded-full text-tertiary hover-device:hover:bg-hover hover-device:hover:text-text after:absolute after:-inset-2 after:content-['']"
                    >
                        <X className="size-4" />
                    </button>
                </div>
            )}
            <div className={cn("relative", phone && "z-[1]")}>
                <form
                    ref={surface}
                    data-balloon-anchor="composer"
                    onSubmit={onSubmit}
                    data-layout={layout}
                    data-drag-active={dragging || undefined}
                    className={cn(
                        "relative z-10 bg-composer shadow-composer",
                        // Focus treatment per surface direction (tokens.css); the defaults keep the rest state.
                        "transition-[box-shadow,background-color,translate] duration-200 ease-[var(--ease-standard)]",
                        "focus-within:bg-[var(--composer-focus-bg,var(--composer))] focus-within:translate-y-[var(--composer-lift,0px)] focus-within:shadow-[var(--shadow-composer-focus,var(--shadow-composer))]",
                        "data-[drag-active]:bg-[color-mix(in_oklab,var(--menu)_50%,transparent)]",
                        // Phones: the same 24px radius at every height, so the pill does not change shape as it grows.
                        multi || phone ? "rounded-3xl" : "rounded-full",
                    )}
                >
                    <span role="status" aria-live="polite" className="sr-only">
                        {announcement}
                    </span>
                    {features.attachments && attachments.length > 0 && (
                        <AttachmentRow items={attachments} onRemove={removeAttachment} onRetry={retryAttachment} />
                    )}
                    <div
                        onClick={(e) => e.target === e.currentTarget && editor.current?.focus()}
                        className={cn(
                            "grid",
                            phone
                                ? "grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-x-0.5 px-1"
                                : multi
                                  ? "grid-cols-[minmax(0,auto)_auto_minmax(0,1fr)] grid-rows-[auto_var(--composer-control-height)] items-center gap-x-[5px] px-2 pb-[9px]"
                                  : "grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 p-2",
                        )}
                    >
                        {hasAdd && (
                            <div
                                className={cn(
                                    "col-start-1",
                                    phone ? "row-start-1 mb-1" : multi ? "row-start-2" : "row-start-1",
                                )}
                            >
                                <Tooltip label={t("composer-add-more")} side={side}>
                                    {phone ? (
                                        <ComposerButton
                                            aria-label={t("composer-add-more")}
                                            aria-haspopup="dialog"
                                            aria-expanded={attachOpen}
                                            data-state={attachOpen ? "open" : "closed"}
                                            onClick={() => setAttachOpen(true)}
                                            phone
                                            className="aspect-square px-0 text-text"
                                        >
                                            <Plus className="size-5" />
                                        </ComposerButton>
                                    ) : (
                                        <ComposerButton
                                            aria-label={t("composer-add-more")}
                                            aria-expanded={plusOpen}
                                            aria-controls={plusOpen ? menuId : undefined}
                                            data-state={plusOpen ? "open" : "closed"}
                                            onPointerDown={(e) => !coarse && e.preventDefault()}
                                            onClick={() => {
                                                setPlusOpen((o) => !o);
                                                focusEditor();
                                            }}
                                            className="aspect-square px-0 text-text"
                                        >
                                            <Plus className="size-5" />
                                        </ComposerButton>
                                    )}
                                </Tooltip>
                            </div>
                        )}
                        <div
                            className={cn(
                                "relative row-start-1",
                                phone
                                    ? hasAdd
                                        ? "col-start-2"
                                        : "col-span-2"
                                    : multi
                                      ? "col-span-3"
                                      : hasAdd
                                        ? "col-start-2"
                                        : "col-span-2",
                            )}
                        >
                            {marks && (
                                <div
                                    ref={backdrop}
                                    aria-hidden
                                    className={cn(
                                        editorText,
                                        "pointer-events-none absolute inset-0 overflow-hidden text-text",
                                        multi
                                            ? cn(multiPad, "break-words whitespace-pre-wrap")
                                            : cn(singlePad, "whitespace-pre"),
                                    )}
                                >
                                    {marks}
                                    {ghost && <span className="text-tertiary">{ghost}</span>}
                                    {"\n"}
                                </div>
                            )}
                            <textarea
                                ref={editor}
                                data-layout={layout}
                                aria-label={t("composer-message")}
                                aria-autocomplete={menu ? "list" : undefined}
                                aria-controls={menu ? menuId : undefined}
                                aria-activedescendant={menu && flat.length ? `${menuId}-${active}` : undefined}
                                placeholder={question?.placeholder ?? t("composer-placeholder")}
                                rows={1}
                                wrap={multi ? "soft" : "off"}
                                enterKeyHint={enterToSend && !coarse ? "send" : "enter"}
                                value={text}
                                onChange={(e) => {
                                    typedSinceLoad.current = true;
                                    setText(e.target.value);
                                    if ((e.nativeEvent as InputEvent).inputType === "historyUndo")
                                        restoreUndone(e.target.value);
                                    setCaret(e.target.selectionStart);
                                    if (dismissed !== null && !detectTrigger(e.target.value, e.target.selectionStart))
                                        setDismissed(null);
                                    if (plusOpen) setPlusOpen(false);
                                }}
                                onPointerDown={() => (motion.current = { m: NO_MOTION, at: 0 })}
                                onCompositionStart={() => (composingText.current = true)}
                                onCompositionEnd={() => (composingText.current = false)}
                                onKeyDown={onKeyDown}
                                onPaste={onPaste}
                                onScroll={updateFade}
                                onBlur={() => setDismissed(null)}
                                className={cn(
                                    editorText,
                                    "relative block w-full resize-none bg-transparent caret-[var(--text)] outline-none placeholder:text-tertiary placeholder:opacity-100 focus-visible:outline-none disabled:cursor-not-allowed",
                                    marks ? "text-transparent" : "text-text",
                                    multi
                                        ? cn(
                                              multiPad,
                                              "overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,var(--mask-solid)_var(--fade-top,0px),var(--mask-solid)_calc(100%-var(--fade-bottom,0px)),transparent)]",
                                          )
                                        : cn(singlePad, "overflow-hidden whitespace-pre"),
                                )}
                            />
                            {multi && (
                                <textarea
                                    ref={mirror}
                                    aria-hidden
                                    tabIndex={-1}
                                    readOnly
                                    rows={1}
                                    value={text}
                                    className={cn(
                                        editorText,
                                        multiPad,
                                        "pointer-events-none invisible absolute inset-x-0 top-0 h-0 resize-none overflow-hidden",
                                    )}
                                />
                            )}
                            {showExpand && (
                                <Tooltip label={t("composer-open-editor")} side="top">
                                    <button
                                        type="button"
                                        aria-label={t("composer-open-editor")}
                                        onClick={() => setFullscreen(true)}
                                        className={cn(
                                            "absolute top-2 z-[2] flex size-8 items-center justify-center rounded-full text-secondary outline-none hover-device:hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
                                            phone ? "right-0" : "right-2",
                                            touchTarget,
                                        )}
                                    >
                                        <ArrowsOutSimple className="size-5" />
                                    </button>
                                </Tooltip>
                            )}
                        </div>
                        <div
                            className={cn(
                                "col-start-3 flex items-center justify-self-end",
                                phone ? "row-start-1 mb-1 gap-2" : multi ? "row-start-2" : "row-start-1",
                            )}
                        >
                            {dictating ? (
                                <>
                                    <Waveform
                                        analyser={dictation.analyser}
                                        live={dictation.state === "recording"}
                                        className={phone ? "w-16" : "w-24"}
                                    />
                                    <span className="flex items-center gap-2">
                                        <DictationControls
                                            state={dictation.state}
                                            onCancel={dictation.cancel}
                                            onConfirm={dictation.confirm}
                                            phone={phone}
                                        />
                                    </span>
                                </>
                            ) : (
                                <>
                                    {/* Phones: effort moves to the tray row, next to the model it belongs to. */}
                                    {!phone && reasoning && choice.model && choice.effort && (
                                        <EffortControl
                                            value={choice.effort}
                                            efforts={choice.model.efforts}
                                            onChange={choice.setEffort}
                                            side={side}
                                            open={effortOpen}
                                            onOpenChange={setEffortOpen}
                                        />
                                    )}
                                    {features.dictation && speech.mode !== "off" && !running && (
                                        <DictateButton onClick={startDictation} busy={creating} phone={phone} />
                                    )}
                                    <span className={cn("flex", !phone && "ms-2")}>
                                        <SendButton
                                            running={stopShown}
                                            stopping={stopPending}
                                            disabled={!canSend}
                                            onStop={onStop}
                                            phone={phone}
                                            hint={noModels ? t("composer-no-models-hint") : undefined}
                                        />
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
                    <input ref={fileInput} type="file" multiple hidden onChange={onPicked} />
                    {phone && (
                        <>
                            <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={onPicked} />
                            <input
                                ref={cameraInput}
                                type="file"
                                accept="image/*"
                                capture="environment"
                                hidden
                                onChange={onPicked}
                            />
                        </>
                    )}
                </form>
                {!phone && suggestMenu}
            </div>
            {phone && hasAdd && (
                <AttachSheet
                    open={attachOpen}
                    onOpenChange={setAttachOpen}
                    servers={servers}
                    attachments={features.attachments}
                    fullscreen={features.fullscreen}
                    onPhotos={() => photoInput.current?.click()}
                    onCamera={() => cameraInput.current?.click()}
                    onFiles={() => fileInput.current?.click()}
                    onFullscreen={() => setFullscreen(true)}
                    onServer={(sv) => mentionAtCaret(`@${sv.name}`)}
                />
            )}
            {hasTray && (
                <div
                    className={cn(
                        "flex min-w-0 items-center",
                        // Desktop: equal outer columns, so the disclaimer centres on the composer, not between two
                        // controls of different widths. The outer columns never shrink below their control.
                        phone
                            ? "relative z-[1] gap-0.5 px-0.5"
                            : "grid grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(max-content,1fr)] gap-2 px-1.5 [&>*:first-child]:justify-self-start [&>*:last-child]:justify-self-end",
                    )}
                >
                    {features.modelPicker && (
                        <ModelPicker
                            models={choice.models}
                            value={choice.modelId}
                            onChange={choice.setModel}
                            onRestoreFocus={focusEditor}
                            open={pickerOpen}
                            onOpenChange={(o) => {
                                setPickerOpen(o);
                                if (!o) setPickerQuery("");
                            }}
                            initialQuery={pickerQuery}
                            avoidRef={root}
                        />
                    )}
                    {phone && reasoning && choice.model && choice.effort && (
                        <EffortControl
                            value={choice.effort}
                            efforts={choice.model.efforts}
                            onChange={choice.setEffort}
                            side={side}
                            open={effortOpen}
                            onOpenChange={setEffortOpen}
                            tray
                        />
                    )}
                    {features.disclaimer &&
                        (phone ? (
                            // Phones leave the disclaimer out: the row is for controls.
                            <span aria-hidden className="flex-1" />
                        ) : (
                            // The disclaimer sits between the two controls; it drops out where they need the room.
                            <p className="min-w-0 truncate text-center text-xs text-tertiary select-none max-sm:hidden">
                                Chat can make mistakes. Check important info.
                            </p>
                        ))}
                    <span className="flex min-w-0 items-center gap-0.5">
                        {features.mcp && conversationId && (
                            <McpServersMenu conversationId={conversationId} side={side} />
                        )}
                        {features.permissions && (
                            <PermissionMenu
                                value={choice.permission}
                                onChange={choice.setPermission}
                                side={side}
                                label={phone ? "short" : "full"}
                            />
                        )}
                    </span>
                </div>
            )}
            <DropOverlay active={dragging} />
        </div>
    );
}
