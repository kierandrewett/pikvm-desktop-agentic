/**
 * The connections this process serves itself: local WebSockets (the PiKVM's sockets, chat) and local server-sent event
 * streams. A change of the server in use ends them, so the page reconnects and the new route decides where it goes.
 */

/** What a socket or a response has in common here. */
export interface LiveConnection {
    destroy(): void;
    once(event: "close", listener: () => void): unknown;
}

export interface LiveConnections {
    track(connection: LiveConnection): void;
    /** Destroys every tracked connection that is still open. */
    closeAll(): void;
}

export function createLiveConnections(): LiveConnections {
    const open = new Set<LiveConnection>();
    return {
        track(connection) {
            open.add(connection);
            connection.once("close", () => open.delete(connection));
        },
        closeAll() {
            for (const connection of [...open]) {
                open.delete(connection);
                connection.destroy();
            }
        },
    };
}
