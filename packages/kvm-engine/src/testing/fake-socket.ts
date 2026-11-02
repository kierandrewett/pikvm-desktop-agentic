import type { HttpPort, HttpRequest, HttpResponse } from "../http";
import type { KvmSocket, SocketFactory, SocketHandlers } from "../target/ports";

export interface SentCommand {
    readonly event_type: string;
    readonly event: Record<string, unknown>;
}

function parseSent(text: string): SentCommand {
    const parsed: SentCommand = JSON.parse(text);
    return parsed;
}

/**
 * Test doubles for the link's ports. A FakeSocket does nothing on its own: the test plays the
 * server, firing opens, frames and closes in whatever order the scenario needs, including a
 * close that arrives late from a socket the link already abandoned.
 */
export class FakeSocket implements KvmSocket {
    readonly sent: string[] = [];
    state: "connecting" | "open" | "closed" = "connecting";
    closeCalls = 0;

    constructor(
        readonly url: string,
        private readonly handlers: SocketHandlers,
    ) {}

    isOpen(): boolean {
        return this.state === "open";
    }

    send(data: string): void {
        if (this.state !== "open") throw new Error("socket is not open");
        this.sent.push(data);
    }

    close(): void {
        this.closeCalls++;
        this.state = "closed";
    }

    /** Server accepted the connection. */
    serverOpen(): void {
        this.state = "open";
        this.handlers.open();
    }

    serverMessage(frame: unknown): void {
        this.handlers.message(typeof frame === "string" ? frame : JSON.stringify(frame));
    }

    /** The connection ended (from either side). */
    serverClose(): void {
        this.state = "closed";
        this.handlers.close();
    }

    serverError(): void {
        this.handlers.error();
    }

    /** Everything the client sent, parsed, excluding pings unless asked. */
    commands(includePings = false): SentCommand[] {
        const all = this.sent.map(parseSent);
        return includePings ? all : all.filter((c) => c.event_type !== "ping");
    }

    pings(): number {
        return this.sent.map(parseSent).filter((c) => c.event_type === "ping").length;
    }
}

export class FakeSocketHub {
    readonly sockets: FakeSocket[] = [];
    /** When set, the next factory call throws (a refused constructor). */
    throwNext = false;

    readonly factory: SocketFactory = (url, handlers) => {
        if (this.throwNext) {
            this.throwNext = false;
            throw new Error("bad url");
        }
        const socket = new FakeSocket(url, handlers);
        this.sockets.push(socket);
        return socket;
    };

    get last(): FakeSocket {
        const s = this.sockets[this.sockets.length - 1];
        if (!s) throw new Error("no socket was created");
        return s;
    }
}

/** An HTTP port that records requests and answers from a script. */
export class FakeHttp implements HttpPort {
    readonly requests: HttpRequest[] = [];
    /** Called per request; return a status, or throw/reject for a network failure. */
    respond: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse = () => ({ ok: true, status: 200 });

    async request(req: HttpRequest): Promise<HttpResponse> {
        this.requests.push(req);
        return this.respond(req);
    }
}

export function status(code: number): HttpResponse {
    return { ok: code >= 200 && code < 300, status: code };
}
