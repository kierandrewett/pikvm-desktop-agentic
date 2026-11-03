import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { nodeSocket } from "./node-socket";

const servers: WebSocketServer[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
});

async function serve() {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    servers.push(server);
    await new Promise<void>((done) => server.once("listening", done));
    const headers: Record<string, string | string[] | undefined>[] = [];
    server.on("connection", (_ws, req) => headers.push(req.headers));
    return { server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`, headers };
}

/** Handlers that record what the link would be told. */
function recorder() {
    const events: string[] = [];
    const done = Promise.withResolvers<void>();
    return {
        events,
        closed: done.promise,
        handlers: {
            open: () => void events.push("open"),
            message: (data: string) => void events.push(`message:${data}`),
            close: () => {
                events.push("close");
                done.resolve();
            },
            error: () => void events.push("error"),
        },
    };
}

describe("nodeSocket", () => {
    it("connects with the headers it is given, and passes text frames both ways", async () => {
        const { server, url, headers } = await serve();
        server.on("connection", (ws) => {
            ws.on("message", (data) => ws.send(`echo ${data.toString()}`));
            ws.send(JSON.stringify({ event_type: "hid" }));
        });
        const r = recorder();
        const socket = nodeSocket({ headers: () => ({ "X-KVMD-User": "operator", "X-KVMD-Passwd": "pw" }) })(url, r.handlers);
        await new Promise<void>((done) => {
            const check = setInterval(() => {
                if (r.events.includes('message:{"event_type":"hid"}')) {
                    clearInterval(check);
                    done();
                }
            }, 5);
        });
        expect(socket.isOpen()).toBe(true);
        socket.send("hello");
        await new Promise<void>((done) => {
            const check = setInterval(() => {
                if (r.events.includes("message:echo hello")) {
                    clearInterval(check);
                    done();
                }
            }, 5);
        });
        expect(headers[0]?.["x-kvmd-user"]).toBe("operator");
        expect(headers[0]?.["x-kvmd-passwd"]).toBe("pw");
        socket.close();
        await r.closed;
        expect(socket.isOpen()).toBe(false);
        expect(r.events[0]).toBe("open");
    });

    it("reads the headers anew for each connection, so a rotated credential is used on the retry", async () => {
        const { url, headers } = await serve();
        let user = "first";
        const factory = nodeSocket({ headers: () => ({ "X-KVMD-User": user }) });
        for (const name of ["first", "second"]) {
            user = name;
            const r = recorder();
            const socket = factory(url, r.handlers);
            await new Promise<void>((done) => {
                const check = setInterval(() => {
                    if (r.events.includes("open")) {
                        clearInterval(check);
                        done();
                    }
                }, 5);
            });
            socket.close();
            await r.closed;
        }
        expect(headers.map((h) => h["x-kvmd-user"])).toEqual(["first", "second"]);
    });

    it("a refused connection is an error and then a close, never a throw", async () => {
        const r = recorder();
        const socket = nodeSocket({ headers: () => ({}) })("ws://127.0.0.1:1/api/ws", r.handlers);
        await r.closed;
        expect(r.events).toContain("error");
        expect(r.events.at(-1)).toBe("close");
        expect(socket.isOpen()).toBe(false);
    });
});
