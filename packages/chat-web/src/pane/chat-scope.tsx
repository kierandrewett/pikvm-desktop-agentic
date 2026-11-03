/**
 * ChatScope: everything the conversation pane needs around it, in one provider: the scope element with the pane's
 * tokens and portal layer (KitScope) and the chat server's data layer (ChatServices).
 */
import type { ReactNode } from "react";
import { ChatServices } from "./chat-services";
import { KitScope } from "./kit-scope";

export interface ChatScopeProps {
    /** REST root and socket URL of the chat server; defaults to the host's `/app/chat/*` routes. */
    apiBase?: string;
    wsUrl?: string;
    /** False while the pane is hidden behind another tab. */
    active?: boolean;
    /** Where the pane starts; a settings deep link or a conversation. */
    initialPath?: string;
    children: ReactNode;
}

export function ChatScope({ apiBase, wsUrl, active = true, initialPath = "/", children }: ChatScopeProps) {
    return (
        <KitScope active={active} initialPath={initialPath}>
            <ChatServices {...(apiBase !== undefined ? { apiBase } : {})} {...(wsUrl !== undefined ? { wsUrl } : {})}>
                {children}
            </ChatServices>
        </KitScope>
    );
}
