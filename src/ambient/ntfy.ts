/**
 * ntfy push client. Mirrors the user's `ntfy` Claude skill: POST to
 * ntfy.drewett.dev/<topic> with a bearer token, gated by the
 * is-kieran.drewett.dev "active" check so we only buzz them when they're around.
 * The token is read on demand from the secrets vault (never stored in plaintext
 * settings).
 */

export type NtfyPriority = "min" | "low" | "default" | "high" | "urgent";

export interface NtfyConfig {
    baseUrl: string;
    topic: string;
    activeCheckUrl?: string;
}

export interface NtfyDeps {
    config: () => NtfyConfig;
    /** Bearer token (from the secrets vault), or undefined for an open topic. */
    getToken: () => string | undefined | Promise<string | undefined>;
}

export class NtfyClient {
    constructor(private readonly deps: NtfyDeps) {}

    /** Whether the user is currently active (so a push is worth sending). */
    async isUserActive(): Promise<boolean> {
        const url = this.deps.config().activeCheckUrl;
        if (!url) return true;
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 5000);
            const r = await fetch(url, { signal: ctrl.signal });
            clearTimeout(t);
            const text = (await r.text()).trim();
            return text === "yes";
        } catch {
            // If the check is unreachable, don't block the notification.
            return true;
        }
    }

    async notify(
        message: string,
        opts: { title?: string; priority?: NtfyPriority; tags?: string; respectActive?: boolean; click?: string } = {},
    ): Promise<{ sent: boolean; reason?: string }> {
        const { baseUrl, topic } = this.deps.config();
        if (!baseUrl || !topic) return { sent: false, reason: "ntfy not configured" };
        if (opts.respectActive !== false && !(await this.isUserActive())) {
            return { sent: false, reason: "user inactive" };
        }
        const token = await this.deps.getToken();
        const headers: Record<string, string> = { Title: opts.title ?? "PiKVM Agent" };
        if (opts.priority) headers.Priority = opts.priority;
        if (opts.tags) headers.Tags = opts.tags;
        if (opts.click) headers.Click = opts.click;
        if (token) headers.Authorization = `Bearer ${token}`;
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 8000);
            const r = await fetch(`${baseUrl.replace(/\/$/, "")}/${topic}`, {
                method: "POST",
                headers,
                body: message,
                signal: ctrl.signal,
            });
            clearTimeout(t);
            return r.ok ? { sent: true } : { sent: false, reason: `ntfy ${r.status}` };
        } catch (e) {
            return { sent: false, reason: String((e as Error)?.message ?? e) };
        }
    }
}
