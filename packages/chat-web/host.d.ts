/**
 * What the host app sees of this package. The app's TypeScript settings are stricter than the lifted code was
 * written for (`exactOptionalPropertyTypes`), so the app resolves `@pikvm/chat-web` to this file for type-checking
 * and never checks the pane's internals. `src/test/host-types.ts` checks, under this package's settings, that
 * `src/index.ts` satisfies it.
 */
import type { ReactElement, ReactNode } from "react";

export interface ChatScopeProps {
    /** REST root and socket URL of the chat server; default to the host's `/app/chat/*` routes. */
    apiBase?: string | undefined;
    wsUrl?: string | undefined;
    /** False while the pane is hidden behind another tab. */
    active?: boolean | undefined;
    /** Where the pane starts; a settings deep link or a conversation. */
    initialPath?: string | undefined;
    children: ReactNode;
}

export function ChatScope(props: ChatScopeProps): ReactElement;
export function ChatPane(): ReactElement;
export function ProvidersPage(): ReactElement;
export function ModelsPage(): ReactElement;
export function AgentPage(): ReactElement;

export interface RunFinished {
    readonly conversationId: string;
    /** How the response ended; `cancelled` is the person stopping it themselves. */
    readonly status: "completed" | "failed" | "incomplete" | "cancelled";
}
/** Hear every response this page watches end, from now on. Returns what stops listening. */
export function onRunFinished(listener: (event: RunFinished) => void): () => void;
