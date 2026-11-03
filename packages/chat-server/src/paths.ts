/**
 * The single source of truth for every path under the chat data directory (`<data>/chat`). Nothing else
 * in the server joins data paths by hand.
 *
 * One server runs per process, so the paths are a live binding: `configurePaths` replaces them once, at start
 * (and tests replace them per file).
 */
import { join, resolve } from "node:path";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Reject ids that could escape their directory. Ids come from the database, but defend anyway. */
function id(value: string, what: string): string {
    if (!SAFE_ID.test(value)) throw new Error(`[paths] unsafe ${what}: ${value}`);
    return value;
}

/** The only user. Kept as an id so every query that names a user stays as it is in ~/dev/chat. */
export const OPERATOR_ID = "operator";

function build(root: string) {
    return {
        /** `<data>/chat`. */
        dataDir: root,
        db: join(root, "chat.db"),
        secretKey: join(root, "secret.key"),
        /** The agent surface as a unix socket, when the host listens on one. */
        agentSocket: join(root, "run", "agent.sock"),
        runDir: join(root, "run"),
        cacheDir: join(root, "cache"),
        modelsDevCache: join(root, "cache", "models.dev.json"),
        logosDir: join(root, "cache", "logos"),
        usersDir: join(root, "users"),
        user(userId: string) {
            const base = join(root, "users", id(userId, "user id"));
            return {
                root: base,
                /** The agent's HOME. Holds the runtime's .omp dir, whose files are all generated. */
                home: join(base, "home"),
                ompAgentDir: join(base, "home", ".omp", "agent"),
                ompModels: join(base, "home", ".omp", "agent", "models.yml"),
                ompMcp: join(base, "home", ".omp", "agent", "mcp.json"),
                ompConfig: join(base, "home", ".omp", "agent", "config.yml"),
                /** Last model and command listing from the runtime, served while a fresh one is fetched. */
                runtimeInfo: join(base, "cache", "runtime-info.json"),
                workspace: join(base, "workspace"),
                /** A conversation's working directory. Empty in the computer profile. */
                chatWorkspace: (conversationId: string) =>
                    join(base, "workspace", "chats", id(conversationId, "conversation id")),
                uploads: join(base, "uploads"),
                upload: (uploadId: string) => join(base, "uploads", id(uploadId, "upload id")),
                /** Holds the agent session JSONL files. */
                conversations: join(base, "conversations"),
                conversation: (conversationId: string) =>
                    join(base, "conversations", id(conversationId, "conversation id")),
            };
        },
    };
}

export type Paths = ReturnType<typeof build>;

export let paths: Paths = build(resolve(process.env.CHAT_DATA_DIR ?? "./.data/chat"));

/** Point every path at `<dataDir>/chat`. Call before the database opens. */
export function configurePaths(dataDir: string): Paths {
    paths = build(join(resolve(dataDir), "chat"));
    return paths;
}
