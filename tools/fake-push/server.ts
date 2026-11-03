// A Web Push service for tests: what a browser vendor's push service is to this server, and what the browser is to the
// notification. It hands out subscriptions (an endpoint on itself and a real P-256 key pair and auth secret), accepts the
// POSTs the server makes to them, checks the VAPID signature and decrypts the aes128gcm payload (RFC 8188, RFC 8291), and
// records what a device would have been shown. Nothing here talks to a real push service.
//
// Run:  node --experimental-strip-types --disable-warning=ExperimentalWarning tools/fake-push/server.ts --port 4520
//
// Control API (plain JSON):
//   POST /__fake/subscription            -> { id, endpoint, keys: { p256dh, auth } }, a new device
//   GET  /__fake/received[?id=]          -> every push accepted, with its decrypted payload and the VAPID facts
//   POST /__fake/status?id=&status=410   -> the next pushes to that device get this status (omit status to clear)
//   POST /__fake/reset                   -> forget subscriptions and records
//
// Only erasable TypeScript is used, so Node can strip the types without a build step.

import { createECDH, createHash, createDecipheriv, createPublicKey, createVerify, hkdfSync, randomBytes, type ECDH } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";

export interface FakePushSubscription {
    id: string;
    endpoint: string;
    keys: { p256dh: string; auth: string };
}

export interface Received {
    id: string;
    at: number;
    /** The decrypted body, parsed as JSON when it is. */
    payload: unknown;
    vapid: { publicKey: string; subject: string | null; audience: string | null; signatureValid: boolean; expiresInSeconds: number | null };
    ttl: number | null;
    urgency: string | null;
}

export interface FakePushService {
    port: number;
    url: string;
    received: Received[];
    subscribe(): FakePushSubscription;
    /** Answer pushes to this device with `status` until cleared with null. */
    setStatus(id: string, status: number | null): void;
    reset(): void;
    close(): Promise<void>;
}

interface Device {
    id: string;
    ecdh: ECDH;
    auth: Buffer;
}

const b64u = (data: Buffer): string => data.toString("base64url");

/** RFC 8291 section 3.4: the payload a push service delivers to the user agent, decrypted with the device's keys. */
export function decryptPush(body: Buffer, device: { ecdh: ECDH; auth: Buffer }): Buffer {
    const salt = body.subarray(0, 16);
    const recordSize = body.readUInt32BE(16);
    const keyIdLength = body[20]!;
    const serverPublic = body.subarray(21, 21 + keyIdLength);
    const ciphertext = body.subarray(21 + keyIdLength);
    if (ciphertext.length > recordSize) throw new Error("more than one record: not what this server sends");
    const userPublic = device.ecdh.getPublicKey();
    const secret = device.ecdh.computeSecret(serverPublic);
    const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), userPublic, serverPublic]);
    const ikm = Buffer.from(hkdfSync("sha256", secret, device.auth, keyInfo, 32));
    const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const decipher = createDecipheriv("aes-128-gcm", key, nonce);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
    let end = padded.length;
    while (end > 0 && padded[end - 1] === 0) end--;
    if (end === 0 || padded[end - 1] !== 2) throw new Error("the last record has no padding delimiter");
    return padded.subarray(0, end - 1);
}

/** The facts of an `Authorization: vapid t=<jwt>, k=<key>` header, with the signature checked against `k`. */
export function checkVapid(header: string | undefined): Received["vapid"] | null {
    const match = /^vapid\s+t=([^,\s]+),\s*k=(\S+)$/.exec(header ?? "");
    if (!match) return null;
    const [, jwt, key] = match as unknown as [string, string, string];
    const [head, claims, signature] = jwt.split(".");
    if (!head || !claims || !signature) return null;
    const raw = Buffer.from(key, "base64url");
    if (raw.length !== 65 || raw[0] !== 4) return null;
    const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: "jwk" });
    const verifier = createVerify("SHA256");
    verifier.update(`${head}.${claims}`);
    const signatureValid = verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
    const parsed: unknown = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
    const claim = (name: string): unknown => (parsed !== null && typeof parsed === "object" ? Reflect.get(parsed, name) : undefined);
    const exp = claim("exp");
    return {
        publicKey: key,
        subject: typeof claim("sub") === "string" ? (claim("sub") as string) : null,
        audience: typeof claim("aud") === "string" ? (claim("aud") as string) : null,
        signatureValid,
        expiresInSeconds: typeof exp === "number" ? exp - Math.floor(Date.now() / 1000) : null,
    };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
};

export async function startFakePush(options: { port?: number; host?: string } = {}): Promise<FakePushService> {
    const devices = new Map<string, Device>();
    const statuses = new Map<string, number>();
    let received: Received[] = [];
    let origin = "";

    const server: Server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://fake-push");
        try {
            const body = await readBody(req);
            if (url.pathname.startsWith("/push/") && req.method === "POST") {
                const id = url.pathname.slice("/push/".length);
                const device = devices.get(id);
                if (!device) return json(res, 404, { error: "unknown subscription" });
                const forced = statuses.get(id);
                if (forced) return json(res, forced, { error: `forced ${forced}` });
                const vapid = checkVapid(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined);
                if (!vapid || !vapid.signatureValid) return json(res, 403, { error: "bad VAPID" });
                if (req.headers["content-encoding"] !== "aes128gcm") return json(res, 400, { error: "expected aes128gcm" });
                if (body.length > 4096) return json(res, 413, { error: "too large" });
                let plain: Buffer;
                try {
                    plain = decryptPush(body, device);
                } catch (error) {
                    return json(res, 400, { error: `cannot decrypt: ${(error as Error).message}` });
                }
                let payload: unknown = plain.toString("utf8");
                try {
                    payload = JSON.parse(payload as string);
                } catch {
                    /* kept as text */
                }
                received.push({
                    id,
                    at: Date.now(),
                    payload,
                    vapid,
                    ttl: req.headers.ttl !== undefined ? Number(req.headers.ttl) : null,
                    urgency: typeof req.headers.urgency === "string" ? req.headers.urgency : null,
                });
                res.writeHead(201, { location: `${origin}/message/${createHash("sha1").update(body).digest("hex").slice(0, 8)}` });
                res.end();
                return;
            }
            if (url.pathname === "/__fake/subscription" && req.method === "POST") return json(res, 200, service.subscribe());
            if (url.pathname === "/__fake/received") {
                const id = url.searchParams.get("id");
                return json(res, 200, { received: id ? received.filter((entry) => entry.id === id) : received });
            }
            if (url.pathname === "/__fake/status" && req.method === "POST") {
                const status = url.searchParams.get("status");
                service.setStatus(url.searchParams.get("id") ?? "", status ? Number(status) : null);
                return json(res, 200, { ok: true });
            }
            if (url.pathname === "/__fake/reset" && req.method === "POST") {
                service.reset();
                return json(res, 200, { ok: true });
            }
            json(res, 404, { error: "not found" });
        } catch (error) {
            json(res, 500, { error: (error as Error).message });
        }
    });

    await new Promise<void>((done, fail) => {
        server.once("error", fail);
        server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => done());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake-push: no TCP address");
    origin = `http://${options.host ?? "127.0.0.1"}:${address.port}`;

    const service: FakePushService = {
        port: address.port,
        url: origin,
        get received() {
            return received;
        },
        subscribe() {
            const id = randomBytes(6).toString("hex");
            const ecdh = createECDH("prime256v1");
            ecdh.generateKeys();
            const auth = randomBytes(16);
            devices.set(id, { id, ecdh, auth });
            return { id, endpoint: `${origin}/push/${id}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
        },
        setStatus(id, status) {
            if (status === null) statuses.delete(id);
            else statuses.set(id, status);
        },
        reset() {
            devices.clear();
            statuses.clear();
            received = [];
        },
        close: () =>
            new Promise<void>((done) => {
                server.close(() => done());
                server.closeAllConnections();
            }),
    };
    return service;
}

function argValue(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
    const port = Number(argValue("port") ?? process.env.PORT ?? 4520);
    const host = argValue("host") ?? process.env.HOST ?? "127.0.0.1";
    void startFakePush({ port, host }).then((fake) => {
        console.log(`fake-push listening on ${fake.url}`);
        const stop = () => void fake.close().then(() => process.exit(0));
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
    });
}
