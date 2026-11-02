/**
 * The engine's only way to make an HTTP call to kvmd.
 *
 * Injected so the pure cores (macro runner, paste, mouse-output switch) never import fetch and
 * tests can answer with any status or failure. A response with a 4xx or 5xx status RESOLVES
 * (it is data: the macro runner distinguishes 413 from 500); only a network failure rejects.
 */
export interface HttpRequest {
    readonly method: "POST";
    /** Root-relative, e.g. `/api/hid/print?limit=0`. The adapter decides the origin. */
    readonly path: string;
    readonly body?: string;
    readonly contentType?: string;
}

export interface HttpResponse {
    readonly ok: boolean;
    readonly status: number;
}

export interface HttpPort {
    request(req: HttpRequest): Promise<HttpResponse>;
}
