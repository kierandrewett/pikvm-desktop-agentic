/**
 * Fork, rewind and message versions (docs/spec/thread-branching.md): REST contracts shared by the server and the
 * web app. An edit is not here: it is a `response.create` with `metadata.edit_of` (responses.ts).
 *
 * Both act on the conversation's session tree. A cut point is named by a history item id (the ids
 * `GET /api/conversations/:id/items` returns):
 * - a user message: the cut is just before it, and its text comes back as `draft` for the composer
 * - any other item: the cut is the end of that item's turn (everything up to the next user message)
 */
import type { ConversationSummary } from "./responses.ts";

/** `POST /api/conversations/:id/fork`. Without `itemId` the whole chat is forked. */
export interface ForkRequest {
    itemId?: string;
}

export interface ForkResponse {
    /** The new chat. Its `forkedFrom` names the source. */
    conversation: ConversationSummary;
    /** Text of the user message the fork was cut before, for the new chat's composer. */
    draft?: string;
}

/** `POST /api/conversations/:id/rewind`: discard everything after the cut. The old branch is kept. */
export interface RewindRequest {
    itemId: string;
}

export interface RewindResponse {
    conversation: ConversationSummary;
    /** The active branch now ends here (a marker entry). Undo must name it. */
    leaf: string;
    /** Where the active branch ended before the rewind. Undo returns to it. */
    previousLeaf: string;
    /** Text of the user message the rewind was cut before. */
    draft?: string;
}

/**
 * `POST /api/conversations/:id/rewind/undo`: return to `previousLeaf`. Refused (409) when the active
 * branch no longer ends at `leaf`, for example because a message was sent after the rewind.
 */
export interface RewindUndoRequest {
    leaf: string;
    previousLeaf: string;
}

export interface RewindUndoResponse {
    conversation: ConversationSummary;
    leaf: string;
}

/**
 * `POST /api/conversations/:id/versions`: make version `itemId` of a user message active (an id from that
 * message's `versions.ids`). The next turn's context follows it. Refused (409) while a response runs.
 */
export interface VersionSwitchRequest {
    itemId: string;
}

export interface VersionSwitchResponse {
    conversation: ConversationSummary;
    /** The active branch now ends here. */
    leaf: string;
}
