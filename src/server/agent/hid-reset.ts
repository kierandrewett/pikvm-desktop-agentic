import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { PiKvmControl } from "../../pikvm-control";

/**
 * Lets go of every key and button the target thinks is held (kvmd's `POST /api/hid/reset`).
 *
 * Called when the agent takes the keyboard and mouse: a person's key-up that arrives after that is refused at the
 * proxy, so a key they were holding would otherwise stay down on the target for as long as the agent works.
 * Best effort: a Pi that does not answer is not worth stopping the agent for.
 */
export async function resetHid(control: Pick<PiKvmControl, "proxyTarget">): Promise<void> {
    try {
        const { origin, headers, rejectUnauthorized } = await control.proxyTarget();
        const https = origin.protocol === "https:";
        await new Promise<void>((resolve) => {
            const req = (https ? httpsRequest : httpRequest)(
                {
                    protocol: origin.protocol,
                    hostname: origin.hostname,
                    port: origin.port || (https ? 443 : 80),
                    method: "POST",
                    path: "/api/hid/reset",
                    headers: { ...headers, host: origin.host, "content-length": "0" },
                    rejectUnauthorized,
                    timeout: 3000,
                },
                (res) => {
                    res.resume();
                    res.on("end", resolve);
                    res.on("error", () => resolve());
                },
            );
            req.on("error", () => resolve());
            req.on("timeout", () => {
                req.destroy();
                resolve();
            });
            req.end();
        });
    } catch {
        /* nothing to reset */
    }
}
