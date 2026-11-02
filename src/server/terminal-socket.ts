/**
 * The shared terminal WebSocket (`/app/terminal`): every device subscribes to
 * and drives the same server-hosted sessions.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { ClientMsg, TerminalSessions } from "../terminal-server";

export function createTerminalSocket(sessions: TerminalSessions | undefined) {
    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (ws) => {
        // The headless host has no terminal: close at once rather than hold a
        // socket that would never say anything.
        if (!sessions) return ws.close();
        sessions.ensurePrimary();
        const send = (msg: unknown) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
        };
        const unsub = sessions.subscribe(send);
        ws.on("message", (raw) => {
            let msg: ClientMsg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }
            sessions.handle(msg, send);
        });
        ws.on("close", unsub);
        ws.on("error", unsub);
    });

    return {
        upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
            wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
        },
        close(): void {
            wss.close();
        },
    };
}
