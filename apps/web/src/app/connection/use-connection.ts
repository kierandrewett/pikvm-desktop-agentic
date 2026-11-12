/** Starts the app's connection monitor and gives it what the page already knows: the target link and the chat socket. */

import { chatSocket } from "@pikvm/chat-web";
import { toast } from "@pikvm/chat-web/settings";
import { useEffect, useSyncExternalStore } from "react";
import type { KvmSession } from "../../kvm/session";
import { recoveredText } from "./format";
import type { ConnectionSnapshot } from "./machine";
import { appMonitor } from "./monitor";

const TOAST_ID = "connection-back";
const TOAST_MS = 4500;

/** Runs while the shell is mounted. One monitor for the whole app, whatever tab is in front. */
export function useConnectionMonitor(session: KvmSession): void {
    useEffect(() => {
        const monitor = appMonitor();
        const { machine } = monitor;
        const stop = monitor.start();

        // The engine's target link: the one socket to the host that the host keeps open to the PiKVM.
        const pushLink = (): void => machine.setLink(session.link.store.getState().link);
        pushLink();
        const offLink = session.link.store.subscribe(pushLink);

        // The event socket is not in the browser's connection queue, so a quick answer on it shows the host alive when a probe is starved.
        const offLiveness = monitor.setLiveness({ ping: (timeoutMs) => session.link.ping(timeoutMs) });

        // The chat socket opens only when chat is used; the machine ignores it until it has been open once.
        machine.setChat(chatSocket.status);
        const offChat = chatSocket.onStatus((status) => machine.setChat(status));

        // The KVM toast shows on the KVM tab and the chat toast on Chat and Settings. The chat has its own toast for its own
        // socket, so that one is not told twice.
        const offRecovered = monitor.onRecovered((outage) => {
            if (outage.cause === "chat") return;
            const text = recoveredText(outage.cause, outage.endedAt - outage.startedAt);
            session.notices.notify({ text });
            // A toast waits in the chat's store until its pane is shown: do not let it outlive its moment.
            toast.success(text, { id: TOAST_ID });
            setTimeout(() => toast.dismiss(TOAST_ID), TOAST_MS);
        });

        return () => {
            offRecovered();
            offLiveness();
            offChat();
            offLink();
            machine.setLink(null);
            machine.setChat(null);
            stop();
        };
    }, [session]);
}

const subscribe = (listener: () => void): (() => void) => appMonitor().machine.subscribe(listener);
const getSnapshot = (): ConnectionSnapshot => appMonitor().machine.getSnapshot();

/** What the banner and the list of drops show. */
export function useConnectionSnapshot(): ConnectionSnapshot {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
