/**
 * Where the chat server is. The host sets this once, before the pane renders (ChatScope does, from its props).
 * `apiBase` is the REST root with no trailing slash; `wsUrl` is the Responses-style socket, absolute or a path.
 */
export interface ChatEndpoints {
    apiBase: string;
    wsUrl: string;
}

let endpoints: ChatEndpoints = { apiBase: "/app/chat/api", wsUrl: "/app/chat/ws" };

export function configureChat(next: ChatEndpoints): void {
    endpoints = { apiBase: next.apiBase.replace(/\/+$/, ""), wsUrl: next.wsUrl };
}

export const apiBase = (): string => endpoints.apiBase;

/** The socket URL as a ws(s) address on this origin when `wsUrl` is a path. */
export function socketUrl(): string {
    const { wsUrl } = endpoints;
    if (/^wss?:\/\//.test(wsUrl)) return wsUrl;
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${wsUrl}`;
}

/** A REST URL on the chat server, for code that cannot go through `api` (downloads, image sources, beacons). */
export const apiUrl = (path: string): string => `${endpoints.apiBase}${path}`;

/** A URL the server wrote for its own API (`/api/...`) mapped onto where this host mounts that API. */
export const serverUrl = (url: string): string => (url.startsWith("/api/") ? apiUrl(url.slice(4)) : url);
