import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import webpush from "web-push";

/**
 * Web Push to the installed app: the server's VAPID key pair, each user's subscriptions, and the send.
 *
 * - The VAPID key pair is made once, into `<data>/push-vapid.json` (mode 0600), and never again: a new pair would
 *   orphan every subscription already made. A file that cannot be read stops push with a message instead of being replaced.
 * - Subscriptions live per user, in `users/<id>/watch/push-subscriptions.json` (0600). The browser hands over an endpoint on
 *   its vendor's push service; this server will POST to it, so only the push services browsers actually use are accepted
 *   (an authenticated person must not be able to point the server at an address inside its network).
 * - A push service that answers 404 or 410 says the subscription is gone: it is removed.
 */

export interface PushSubscriptionJson {
    endpoint: string;
    keys: { p256dh: string; auth: string };
}

export interface StoredSubscription extends PushSubscriptionJson {
    addedAt: string;
    userAgent?: string;
    /** The origin the app was opened at when it subscribed; it names the sender (the VAPID `sub`) to the push service. */
    origin?: string;
}

export interface PushPayload {
    title: string;
    body: string;
    tag: string;
    /** Where a tap goes, within the app. */
    url: string;
}

export interface SendResult {
    sent: number;
    removed: number;
    failed: { host: string; status: number | null; message: string }[];
}

export interface VapidKeys {
    publicKey: string;
    privateKey: string;
}

export interface PushSendOptions {
    vapid: VapidKeys & { subject: string };
    ttlSeconds: number;
}

/** What actually talks to a push service. Resolves the push service's status; rejects with `{ statusCode }` on a refusal. */
export type PushSender = (
    subscription: PushSubscriptionJson,
    body: string,
    options: PushSendOptions,
) => Promise<{ statusCode: number }>;

export interface PushOptions {
    /** The data volume's root; the key pair is `<dataDir>/push-vapid.json`. */
    dataDir: string;
    /** Where a user's subscriptions are kept. */
    subscriptionsFile(userId: string): string;
    /** The VAPID subject when a subscription carries no origin. `PIKVM_PUSH_SUBJECT`. */
    subject?: string | undefined;
    /** Accept any endpoint URL, loopback and plain http included. For tests and local runs only (`PIKVM_PUSH_ALLOW_LOCAL=1`). */
    allowLocalEndpoints?: boolean;
    sender?: PushSender;
    now?: () => Date;
}

export class PushError extends Error {
    constructor(
        message: string,
        readonly code: "unavailable" | "invalid" | "none",
    ) {
        super(message);
        this.name = "PushError";
    }
}

export interface Push {
    /** The application server key the browser subscribes with. Throws `PushError` when the key file cannot be used. */
    publicKey(): string;
    subscribe(userId: string, subscription: unknown, meta?: { userAgent?: string | undefined; origin?: string | undefined }): StoredSubscription;
    unsubscribe(userId: string, endpoint: string): boolean;
    list(userId: string): StoredSubscription[];
    /** Send to every subscription of the user. Throws `PushError("none")` when there are none. */
    send(userId: string, payload: PushPayload): Promise<SendResult>;
}

/** The push services the browsers use: Chrome and Edge (FCM), Safari and iOS (Apple), Firefox, Windows. */
const PUSH_HOSTS: readonly RegExp[] = [
    /^fcm\.googleapis\.com$/,
    /^(?:[a-z0-9-]+\.)*push\.apple\.com$/,
    /^(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
    /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/,
];

export function endpointAllowed(endpoint: string, allowLocal: boolean): boolean {
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        return false;
    }
    if (allowLocal) return url.protocol === "https:" || url.protocol === "http:";
    return url.protocol === "https:" && url.port === "" && PUSH_HOSTS.some((host) => host.test(url.hostname));
}

function prop(value: unknown, key: string): unknown {
    return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

function b64urlLength(value: string): number {
    return /^[A-Za-z0-9_-]+$/.test(value) ? Buffer.from(value, "base64url").length : -1;
}

function parseSubscription(input: unknown, allowLocal: boolean): PushSubscriptionJson {
    const endpoint = prop(input, "endpoint");
    const p256dh = prop(prop(input, "keys"), "p256dh");
    const auth = prop(prop(input, "keys"), "auth");
    if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
        throw new PushError("That is not a push subscription (it needs an endpoint and keys).", "invalid");
    }
    if (!endpointAllowed(endpoint, allowLocal)) {
        throw new PushError("That push endpoint is not one of the push services this server will send to.", "invalid");
    }
    if (b64urlLength(p256dh) !== 65 || b64urlLength(auth) !== 16) {
        throw new PushError("The subscription's keys are not the right size.", "invalid");
    }
    return { endpoint, keys: { p256dh, auth } };
}

function writePrivate(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
}

/**
 * web-push builds the request (VAPID header, aes128gcm body); this sends it with fetch. The library's own sender only speaks
 * https, and a test or a local run points the subscription at a plain-http fake.
 */
const defaultSender: PushSender = async (subscription, body, options) => {
    const request = webpush.generateRequestDetails(subscription, body, {
        vapidDetails: options.vapid,
        TTL: options.ttlSeconds,
        urgency: "high",
    });
    const { "Content-Length": _length, ...headers } = request.headers;
    const res = await fetch(request.endpoint, {
        method: "POST",
        headers,
        body: new Uint8Array(request.body),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
    });
    if (res.status < 200 || res.status >= 300) {
        throw Object.assign(new Error(`The push service answered ${res.status}.`), { statusCode: res.status });
    }
    return { statusCode: res.status };
};

export function createPush(options: PushOptions): Push {
    const vapidPath = join(options.dataDir, "push-vapid.json");
    const now = options.now ?? (() => new Date());
    const sender = options.sender ?? defaultSender;
    const allowLocal = options.allowLocalEndpoints === true;
    let keys: VapidKeys | undefined;

    function vapid(): VapidKeys {
        if (keys) return keys;
        if (!existsSync(vapidPath)) {
            const made = webpush.generateVAPIDKeys();
            mkdirSync(dirname(vapidPath), { recursive: true });
            try {
                // `wx`: a second process that raced us leaves the first one's pair alone.
                writeFileSync(vapidPath, JSON.stringify({ ...made, createdAt: now().toISOString() }, null, 2) + "\n", {
                    mode: 0o600,
                    flag: "wx",
                });
            } catch (error) {
                if (prop(error, "code") !== "EEXIST") throw error;
            }
        }
        try {
            const parsed: unknown = JSON.parse(readFileSync(vapidPath, "utf8"));
            const publicKey = prop(parsed, "publicKey");
            const privateKey = prop(parsed, "privateKey");
            if (typeof publicKey !== "string" || typeof privateKey !== "string" || b64urlLength(publicKey) !== 65) {
                throw new Error("it does not hold a key pair");
            }
            chmodSync(vapidPath, 0o600);
            keys = { publicKey, privateKey };
            return keys;
        } catch (error) {
            throw new PushError(
                `The push key file ${vapidPath} cannot be used (${error instanceof Error ? error.message : String(error)}). ` +
                    "Notifications are off until it is fixed; delete it only if you accept that every device must subscribe again.",
                "unavailable",
            );
        }
    }

    function read(userId: string): StoredSubscription[] {
        const file = options.subscriptionsFile(userId);
        if (!existsSync(file)) return [];
        try {
            const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
            return Array.isArray(parsed) ? parsed.filter((entry): entry is StoredSubscription => {
                try {
                    parseSubscription(entry, allowLocal);
                    return true;
                } catch {
                    return false;
                }
            }) : [];
        } catch {
            return [];
        }
    }

    function write(userId: string, list: StoredSubscription[]): void {
        writePrivate(options.subscriptionsFile(userId), JSON.stringify(list, null, 2) + "\n");
    }

    return {
        publicKey: () => vapid().publicKey,

        subscribe(userId, input, meta = {}) {
            const parsed = parseSubscription(input, allowLocal);
            const stored: StoredSubscription = {
                ...parsed,
                addedAt: now().toISOString(),
                ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 200) } : {}),
                ...(meta.origin ? { origin: meta.origin } : {}),
            };
            // One entry per endpoint: subscribing again from the same device replaces its keys.
            write(userId, [...read(userId).filter((entry) => entry.endpoint !== parsed.endpoint), stored]);
            return stored;
        },

        unsubscribe(userId, endpoint) {
            const before = read(userId);
            const after = before.filter((entry) => entry.endpoint !== endpoint);
            if (after.length === before.length) return false;
            write(userId, after);
            return true;
        },

        list: read,

        async send(userId, payload) {
            const subscriptions = read(userId);
            if (subscriptions.length === 0) throw new PushError("No device has subscribed to notifications yet.", "none");
            const { publicKey, privateKey } = vapid();
            const body = JSON.stringify(payload);
            const result: SendResult = { sent: 0, removed: 0, failed: [] };
            const gone: string[] = [];
            await Promise.all(
                subscriptions.map(async (subscription) => {
                    const subject = subscription.origin ?? options.subject ?? "https://localhost";
                    const host = new URL(subscription.endpoint).hostname;
                    try {
                        await sender(subscription, body, { vapid: { publicKey, privateKey, subject }, ttlSeconds: 3600 });
                        result.sent++;
                    } catch (error) {
                        const status = prop(error, "statusCode");
                        const code = typeof status === "number" ? status : null;
                        if (code === 404 || code === 410) {
                            gone.push(subscription.endpoint);
                            result.removed++;
                        } else {
                            result.failed.push({
                                host,
                                status: code,
                                message: error instanceof Error ? error.message.slice(0, 200) : "send failed",
                            });
                        }
                    }
                }),
            );
            if (gone.length > 0) write(userId, read(userId).filter((entry) => !gone.includes(entry.endpoint)));
            return result;
        },
    };
}
