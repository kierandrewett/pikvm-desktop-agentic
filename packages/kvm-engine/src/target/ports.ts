/**
 * The socket seam. The link never constructs a WebSocket itself: it asks a factory for one and
 * hands it the handlers to call, so a test's fake can fire opens, closes and frames in any
 * order, including the late close of an abandoned socket the stale guard exists for.
 */

export interface SocketHandlers {
    open(): void;
    message(data: string): void;
    close(): void;
    error(): void;
}

export interface KvmSocket {
    /** True while the socket can carry a frame (readyState OPEN). */
    isOpen(): boolean;
    send(data: string): void;
    close(): void;
}

/** May throw (an invalid URL, a blocked scheme); the link treats that as a failed attempt. */
export type SocketFactory = (url: string, handlers: SocketHandlers) => KvmSocket;
