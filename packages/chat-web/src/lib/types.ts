import type { ConversationSummary, OutputItem } from "@pikvm/chat-protocol";

export interface User {
    id: string;
    email: string;
    name: string;
    image: string | null;
    role: "admin" | "user";
    banned: boolean;
}

export interface Bootstrap {
    instanceName: string;
    signup: "open" | "closed";
    needsSetup: boolean;
    auth: {
        emailPassword: boolean;
        minPasswordLength: number;
        passkey: boolean;
        twoFactor: boolean;
        social: string[];
        oidc: { id: string; label: string }[];
    };
    user: User | null;
}

export interface SettingView {
    key: string;
    description: string;
    merge: "override" | "record";
    value: unknown;
    source: "user" | "global" | "default";
    userValue?: unknown;
    globalValue?: unknown;
    owners?: Record<string, "global" | "user">;
    shadowed?: string[];
    managedByFile: boolean;
    writable: boolean;
}

export type { ConversationSummary, OutputItem };
