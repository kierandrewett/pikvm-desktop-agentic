import type { ChatServer } from "@pikvm/chat-server";
import type { ImageOps } from "../../src/image-ops";

/** Tests that are not about chat start the control server with this instead of a real chat server. */
export function stubChat(over: Partial<ChatServer> = {}): () => Promise<ChatServer> {
    return async () => ({
        handleRest: async () => new Response("chat"),
        handleNode: async (_req, res) => void res.writeHead(200).end("chat"),
        handleUpgrade: (_req, socket) => void socket.end(),
        askApproval: async () => "unavailable",
        stopResponses: () => 0,
        smallText: async () => undefined,
        hasSmallModel: () => false,
        decide: async () => undefined,
        hasDecisionModel: () => false,
        userDir: (userId) => `/stub/chat/users/${userId}`,
        setting: ((key: string) => (key === "agent.pikvm.maxEdge" ? 1280 : key === "agent.pikvm.approval" ? "risky" : false)) as ChatServer["setting"],
        status: () => ({ ready: true, runtime: { found: true, binary: "/stub/omp" }, profile: "computer", agentSurface: "http://127.0.0.1:0" }),
        stop: async () => undefined,
        ...over,
    });
}

export const noImages: ImageOps = { resize: async () => null, crop: async () => null };
