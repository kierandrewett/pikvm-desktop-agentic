/**
 * Connection toasts: when the live connection to the server drops for more than 2s after it was up, a toast says
 * the app is reconnecting (it stays until the connection is back), then turns into a short "Connected again".
 * Short blips (server restart, network hiccup) under 2s show nothing. Renders nothing itself.
 */
import { useEffect } from "react";
import { socket } from "../../lib/socket";
import { toast } from "./toast";

const ID = "connection";
const GRACE_MS = 2000;

export function ConnectionStatus() {
    useEffect(() => {
        let wasOpen = socket.status === "open";
        let shown = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const off = socket.onStatus((s) => {
            if (s === "open") {
                clearTimeout(timer);
                timer = undefined;
                if (shown) toast.success("Connected again", { id: ID });
                shown = false;
                wasOpen = true;
                return;
            }
            if (!wasOpen || timer || shown) return;
            timer = setTimeout(() => {
                timer = undefined;
                if (socket.status === "open") return;
                shown = true;
                toast.info("Reconnecting to the server", {
                    id: ID,
                    description: "Messages you send now go out when the connection is back.",
                    duration: Infinity,
                });
            }, GRACE_MS);
        });
        return () => {
            off();
            clearTimeout(timer);
        };
    }, []);
    return null;
}
