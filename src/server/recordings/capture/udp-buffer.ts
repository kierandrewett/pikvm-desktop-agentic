import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

/**
 * A larger UDP receive buffer for werift's media sockets.
 *
 * The PiKVM answers a picture-loss request with a keyframe of 250 to 350 KB, sent as one burst of about 300 packets. Node's default
 * SO_RCVBUF (net.core.rmem_default, 208 KB, and the kernel charges each packet its whole skb, so far fewer packets fit) overflows, and
 * the keyframe arrives with 130 to 270 packets missing; retransmission does not repair it. A 1 MiB or larger buffer lost nothing in
 * the spike. werift offers no option for it, so this wraps `dgram.createSocket` once, for the whole process, to add `recvBufferSize`.
 * werift reads `createSocket` off the module object at each call (`(0, dgram_1.createSocket)(...)`), so the wrapper reaches sockets
 * created after it whenever it is installed. node_modules is not touched.
 *
 * The kernel caps the request at net.core.rmem_max and reports twice what it granted; `grantedReceiveBufferBytes()` says what the
 * newest socket really got so the caller can warn when it is too small.
 */

const DEFAULT_BYTES = 4 * 1024 * 1024;
/** Below this the IDR burst of a 1080p60 stream is not safe (the spike's lossless setting was 1 MiB). */
export const MIN_SAFE_RECEIVE_BUFFER_BYTES = 1024 * 1024;

type CreateSocket = typeof dgram.createSocket;

let wanted = 0;
let granted: number | null = null;
let original: CreateSocket | null = null;

/** Installs the wrapper (once) and sets the size every socket created from now on asks for. Returns the size asked. */
export function installUdpReceiveBuffer(bytes: number = DEFAULT_BYTES): number {
    wanted = Math.max(0, Math.floor(bytes));
    if (original) return wanted;
    original = dgram.createSocket;
    const base = original;
    const wrapped = function (this: unknown, ...args: unknown[]): dgram.Socket {
        const first = args[0];
        const options: dgram.SocketOptions = typeof first === "string" ? { type: first as dgram.SocketType } : { ...(first as dgram.SocketOptions) };
        if (wanted > 0 && options.recvBufferSize === undefined) options.recvBufferSize = wanted;
        args[0] = options;
        const socket = (base as (...a: unknown[]) => dgram.Socket).apply(dgram, args);
        socket.once("listening", () => {
            try {
                granted = socket.getRecvBufferSize();
            } catch {
                // A socket closed before it listened has no size to report.
            }
        });
        return socket;
    } as CreateSocket;
    dgram.createSocket = wrapped;
    syncBuiltinESMExports();
    return wanted;
}

/** What the most recently bound socket was actually given (Linux reports twice the request), or null before any bound. */
export function grantedReceiveBufferBytes(): number | null {
    return granted;
}

/** Stops adding the option to new sockets. The wrapper itself stays installed: removing it could un-wrap someone else's. */
export function disableUdpReceiveBuffer(): void {
    wanted = 0;
}
