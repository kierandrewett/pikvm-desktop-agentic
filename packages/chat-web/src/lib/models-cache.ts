/**
 * Model catalogue loader. The server splits `GET /api/models` into a small index and pages of one snapshot
 * (`?view=index`, `?view=page&revision=&part=`). This module fetches the pages in parallel, checks them and returns
 * one complete catalogue for the `keys.models` query. That query is already persisted on the device by
 * query-persist.ts (IndexedDB, current owner only), so a reload paints from the device and then asks the index
 * whether the saved revision is still current. Same revision: zero page requests.
 *
 * Failure handling: a load that fails ends in one toast with a Retry action. TanStack Query keeps the data it had,
 * so a failed refresh never discards a usable catalogue. Account changes and cancelled requests end in a
 * CancelledError and never toast, write data or call back into the next account.
 */
import type { ModelInfo, ModelsResponse } from "@pikvm/chat-protocol";
import { CancelledError } from "@tanstack/react-query";
import { toast } from "../components/ui/toast";
import { translate } from "../l10n/runtime";
import { api, ApiError } from "./api";
import { describeError } from "./errors";
import { captureSessionEpoch, isSessionEpochCurrent, keys, queryClient } from "./queries";
import { registerSessionReset } from "./session-reset";
import type { Bootstrap } from "./types";

/** Parallel page requests. */
export const PAGE_CONCURRENCY = 4;
const PAGE_RETRIES = 1;
const LOAD_RESTARTS = 1;
const TOAST_ID = "models-load-failed";

/** What a model can do for the server. Absent on entries from the chat-only list: those can chat. */
export interface ModelExecution {
    chat: boolean;
    decisions: "chat" | "systemone" | null;
}

export interface CatalogueModel extends ModelInfo {
    execution?: ModelExecution;
}

/** The data of the `keys.models` query. `ownerId` and `revision` are absent on data from the chat-only list. */
export interface Catalogue extends ModelsResponse {
    models: CatalogueModel[];
    ownerId?: string;
    revision?: string;
}

interface CatalogueIndex {
    ownerId: string;
    revision: string;
    pageSize: number;
    parts: number;
    total: number;
    defaultModel: string | null;
    errors: ModelsResponse["errors"];
}

interface CataloguePage {
    ownerId: string;
    revision: string;
    part: number;
    models: CatalogueModel[];
}

class RevisionChanged extends Error {}

const currentOwner = () => queryClient.getQueryData<Bootstrap>(keys.bootstrap)?.user?.id ?? null;
const cancelled = () => new CancelledError({ silent: true });

/** Models that can start a chat. Entries without metadata come from the chat-only list. */
export const chatModelsOf = (models: readonly CatalogueModel[]): CatalogueModel[] =>
    models.filter((m) => m.execution?.chat !== false);

/** Models that can answer a Decision: native ones and chat models whose API the server supports. */
export const decisionModelsOf = (models: readonly CatalogueModel[]): CatalogueModel[] =>
    models.filter((m) => (m.execution ? m.execution.decisions !== null : true));

/** The chat-only view of a catalogue, with the same fields as the old response. */
export function chatView(data: Catalogue): ModelsResponse {
    const models = chatModelsOf(data.models);
    const defaultModel = data.defaultModel && models.some((m) => m.id === data.defaultModel) ? data.defaultModel : null;
    return { models, defaultModel: defaultModel ?? models[0]?.id ?? null, errors: data.errors };
}

interface Attempt {
    owner: string;
    epoch: number;
    signal: AbortSignal;
}

/** Throws when the account, the session or the request changed since the attempt began. */
function assertCurrent(a: Attempt): void {
    if (a.signal.aborted || !isSessionEpochCurrent(a.epoch) || currentOwner() !== a.owner) throw cancelled();
}

async function pageWithRetry(a: Attempt, revision: string, part: number): Promise<CataloguePage> {
    for (let tries = 0; ; tries++) {
        try {
            const page = await api.get<CataloguePage>(
                `/models?view=page&revision=${encodeURIComponent(revision)}&part=${part}`,
                a.signal,
            );
            assertCurrent(a);
            if (page.ownerId !== a.owner) throw cancelled();
            if (page.revision !== revision || page.part !== part || !Array.isArray(page.models))
                throw new Error("The model list answered with the wrong page");
            return page;
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) throw new RevisionChanged();
            if (a.signal.aborted || err instanceof CancelledError) throw err;
            // 4xx other than a conflict will not improve; a network or server fault gets another try.
            const permanent = err instanceof ApiError && err.status >= 400 && err.status < 500;
            if (permanent || tries >= PAGE_RETRIES) throw err;
        }
    }
}

/** Fetch every page with at most PAGE_CONCURRENCY in flight. One failure aborts the siblings. */
async function fetchPages(a: Attempt, index: CatalogueIndex): Promise<CatalogueModel[]> {
    const own = new AbortController();
    const inner: Attempt = { ...a, signal: AbortSignal.any([a.signal, own.signal]) };
    const pages: CataloguePage[] = new Array(index.parts);
    let next = 0;
    const worker = async () => {
        while (next < index.parts) {
            const part = next++;
            pages[part] = await pageWithRetry(inner, index.revision, part);
        }
    };
    try {
        await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, index.parts) }, worker));
    } catch (err) {
        own.abort();
        // A sibling aborted by the first failure reports a cancel; the first failure is the one that matters.
        throw err;
    }
    const models = pages.flatMap((p) => p.models);
    const ids = new Set(models.map((m) => m.id));
    if (models.length !== index.total) throw new Error("The model list is incomplete");
    if (ids.size !== models.length) throw new Error("The model list has duplicate entries");
    return models;
}

async function attemptLoad(a: Attempt, previous: Catalogue | undefined): Promise<Catalogue> {
    const index = await api.get<CatalogueIndex>("/models?view=index", a.signal);
    assertCurrent(a);
    if (index.ownerId !== a.owner) throw cancelled();
    if (previous?.ownerId === a.owner && previous.revision === index.revision) {
        return { ...previous, defaultModel: index.defaultModel, errors: index.errors };
    }
    const models = await fetchPages(a, index);
    // The catalogue may have changed while the pages loaded: the assembled list must match the current index.
    const again = await api.get<CatalogueIndex>("/models?view=index", a.signal);
    assertCurrent(a);
    if (again.revision !== index.revision) throw new RevisionChanged();
    return {
        models,
        defaultModel: index.defaultModel,
        errors: index.errors,
        ownerId: index.ownerId,
        revision: index.revision,
    };
}

/** Load the whole catalogue, starting from what the query holds. Never returns a partial list. */
export async function loadCatalogue(signal: AbortSignal): Promise<Catalogue> {
    const owner = currentOwner();
    if (!owner) throw cancelled();
    const a: Attempt = { owner, epoch: captureSessionEpoch(), signal };
    const held = queryClient.getQueryData<Catalogue>(keys.models);
    const previous = held?.ownerId === owner ? held : undefined;
    for (let restarts = 0; ; restarts++) {
        try {
            return await attemptLoad(a, previous);
        } catch (err) {
            if (err instanceof RevisionChanged && restarts < LOAD_RESTARTS) continue;
            if (err instanceof RevisionChanged) throw new Error("The model list kept changing while it loaded");
            throw err;
        }
    }
}

// Failure feedback: one toast per failed load, with Retry. A repeated automatic failure with the same cause does
// not toast again; a human Retry reports its own result.
let lastFailure: string | undefined;
let manualRetry = false;

function retry(epoch: number, owner: string): void {
    // The toast belongs to one account. A stale Retry does nothing.
    if (!isSessionEpochCurrent(epoch) || currentOwner() !== owner) {
        toast.dismiss(TOAST_ID);
        return;
    }
    manualRetry = true;
    void queryClient.refetchQueries({ queryKey: keys.models, type: "all" }).catch(() => undefined);
}

function reportFailure(err: unknown, a: Attempt): void {
    const description = describeError(err).message;
    const signature = `${a.owner}\n${description}`;
    const explicit = manualRetry;
    manualRetry = false;
    if (!explicit && signature === lastFailure) return;
    lastFailure = signature;
    toast.error(translate("models-load-failed"), {
        id: TOAST_ID,
        description,
        action: { label: translate("state-retry"), onClick: () => retry(a.epoch, a.owner) },
    });
}

/** The `queryFn` of the shared models query. Loads, reports a real failure once, and keeps quiet when cancelled. */
export async function fetchCatalogue({ signal }: { signal: AbortSignal }): Promise<Catalogue> {
    const owner = currentOwner();
    const epoch = captureSessionEpoch();
    try {
        const data = await loadCatalogue(signal);
        if (lastFailure !== undefined) toast.dismiss(TOAST_ID);
        lastFailure = undefined;
        manualRetry = false;
        return data;
    } catch (err) {
        const stale =
            !owner ||
            signal.aborted ||
            err instanceof CancelledError ||
            !isSessionEpochCurrent(epoch) ||
            currentOwner() !== owner;
        if (stale) throw err instanceof CancelledError ? err : cancelled();
        reportFailure(err, { owner, epoch, signal });
        throw err;
    }
}

registerSessionReset("models-cache", () => {
    lastFailure = undefined;
    manualRetry = false;
    toast.dismiss(TOAST_ID);
});
