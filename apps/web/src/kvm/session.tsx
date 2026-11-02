/**
 * One KVM session per app: the kvmd link and everything that has to outlive any one screen
 * (the key queue and its held modifiers, the typing gate, the paste and macro runners).
 *
 * It lives outside React on purpose. A key queue torn down by a re-render, or a second link
 * opened by a remount, is how keys end up stuck on the target; components only ever read it
 * through the hooks here and never own it.
 */

import {
    bindLinkLifecycle,
    browserSocket,
    createFetchHttp,
    createKeyboard,
    createMacroRunner,
    createPaster,
    createStore,
    createTargetLink,
    createTypingGate,
    eventSocketUrl,
    systemClock,
    type Clock,
    type HttpPort,
    type Keyboard,
    type LinkTiming,
    type MacroRunner,
    type Paster,
    type SocketFactory,
    type Store,
    type TargetLink,
    type TargetState,
    type TypingGate,
} from "@pikvm/kvm-engine";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { createDialogCenter, type DialogCenter } from "./dialog-seam";
import { createNoticeCenter, type NoticeCenter } from "./notices";

export interface KvmSessionOptions {
    readonly clock?: Clock;
    readonly socket?: SocketFactory;
    readonly http?: HttpPort;
    readonly url?: string | (() => string);
    readonly timing?: Partial<LinkTiming>;
    /** Tests drive the lifecycle themselves; the page's own events are bound otherwise. */
    readonly bindLifecycle?: boolean;
}

export interface KvmSession {
    readonly clock: Clock;
    readonly http: HttpPort;
    readonly link: TargetLink;
    readonly keyboard: Keyboard;
    readonly gate: TypingGate;
    readonly paster: Paster;
    readonly macros: MacroRunner;
    readonly notices: NoticeCenter;
    readonly dialogs: DialogCenter;
    /** The keymap text is typed with (paste and text macros); null = whatever the Pi defaults to. */
    readonly keymap: Store<string | null>;
    /** Connect and keep connected. Idempotent. */
    start(): void;
    stop(): Promise<void>;
}

export function createKvmSession(options: KvmSessionOptions = {}): KvmSession {
    const clock = options.clock ?? systemClock;
    const http = options.http ?? createFetchHttp();
    const link = createTargetLink({
        url: options.url ?? (() => eventSocketUrl()),
        socket: options.socket ?? browserSocket,
        http,
        clock,
        ...(options.timing ? { timing: options.timing } : {}),
    });
    const keyboard = createKeyboard({ clock, target: link });
    const gate = createTypingGate();
    const notices = createNoticeCenter(clock);
    const dialogs = createDialogCenter();
    const keymap = createStore<string | null>(null);
    const paster = createPaster({ http, gate, keymap: () => keymap.getState(), notify: notices.notify });
    const macros = createMacroRunner({
        clock,
        keys: keyboard,
        isInputOpen: () => link.isOpen(),
        http,
        gate,
        keymap: () => keymap.getState(),
        notify: notices.notify,
    });

    let unbind: (() => void) | null = null;
    let started = false;

    return {
        clock,
        http,
        link,
        keyboard,
        gate,
        paster,
        macros,
        notices,
        dialogs,
        keymap,
        start() {
            if (started) return;
            started = true;
            link.start();
            // Back from the background after more than a few seconds, or the network returning:
            // the socket that still reads open usually is not.
            if (options.bindLifecycle !== false) unbind = bindLinkLifecycle(link, clock);
        },
        async stop() {
            started = false;
            unbind?.();
            unbind = null;
            keyboard.releaseAll();
            await link.stop();
        },
    };
}

let shared: KvmSession | null = null;

/** The app's one session, made on first use. */
export function sharedKvmSession(): KvmSession {
    shared ??= createKvmSession();
    return shared;
}

const SessionContext = createContext<KvmSession | null>(null);

export function KvmSessionProvider({ session, children }: { session?: KvmSession; children: ReactNode }) {
    return <SessionContext.Provider value={session ?? sharedKvmSession()}>{children}</SessionContext.Provider>;
}

export function useKvmSession(): KvmSession {
    const session = useContext(SessionContext);
    if (!session) throw new Error("useKvmSession needs a KvmSessionProvider");
    return session;
}

/** The whole link and device state. Prefer `useTarget(select)` where only a part is read. */
export function useTarget<T>(select: (state: TargetState) => T): T {
    const { link } = useKvmSession();
    return useSyncExternalStore(
        link.store.subscribe,
        () => select(link.store.getState()),
        () => select(link.store.getState()),
    );
}
