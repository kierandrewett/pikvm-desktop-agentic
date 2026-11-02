/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** Where the existing console is served until the KVM screen is ported (phase 4). */
    readonly VITE_LEGACY_CONSOLE_PATH?: string;
    /** Where the existing agent workspace is served until chat is ported (phase 3). */
    readonly VITE_WORKSPACE_PATH?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
