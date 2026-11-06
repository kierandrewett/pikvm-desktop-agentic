import { rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { paths } from "../paths.ts";
import { logo } from "../models/catalog.ts";
import { decisionModels } from "../models/decisions.ts";
import {
    catalogueIndex,
    CatalogueConflict,
    CatalogueMissing,
    cataloguePage,
    listModels,
    setRuntimeListener,
} from "../models/service.ts";
import { onSettingsChange } from "../settings/store.ts";
import { requireUser, type Env } from "./context.ts";
import { broadcast, broadcastEach } from "./hub.ts";

// A background refresh changed someone's models or commands: tell their open tabs to refetch.
setRuntimeListener((userId) => broadcast(userId, { type: "chat.models.updated" }));

// Settings that change the catalogue: provider entries (models, enablement, credentials, switched-off models), the
// default model and features. A global key reaches every open tab; a per-user key reaches that person's tabs only. A
// tab that is offline misses the event and finds the change in the revision of the catalogue index on its next load.
const CATALOGUE_KEYS: ReadonlySet<string> = new Set(["agent.providers", "agent.defaultModel", "models.features"]);
onSettingsChange((key) => {
    const [head, id, ...rest] = key.split(".");
    if (head === "users" && id) {
        if (CATALOGUE_KEYS.has(rest.join("."))) broadcast(id, { type: "chat.models.updated" });
    } else if (CATALOGUE_KEYS.has(key)) broadcastEach({ type: "chat.models.updated" });
});

const CatalogueQuery = z.discriminatedUnion("view", [
    z.object({ view: z.literal("index") }),
    z.object({
        view: z.literal("page"),
        revision: z.string().min(1).max(100),
        part: z.string().regex(/^\d{1,6}$/),
    }),
]);

export const modelsRoutes = new Hono<Env>()
    .get("/models", async (c) => {
        const user = requireUser(c);
        // `?view=index|page` serves the unified catalogue (chat models) in pages of one
        // snapshot. Without a view the answer is the chat-only list that settings screens still read.
        if (c.req.query("view") === undefined) return c.json(await listModels(user.id));
        const q = CatalogueQuery.safeParse(c.req.query());
        if (!q.success) throw new HTTPException(400, { message: "Invalid catalogue request" });
        if (q.data.view === "index") return c.json(await catalogueIndex(user.id));
        try {
            return c.json(await cataloguePage(user.id, q.data.revision, Number(q.data.part)));
        } catch (err) {
            if (err instanceof CatalogueConflict) throw new HTTPException(409, { message: err.message });
            if (err instanceof CatalogueMissing) throw new HTTPException(404, { message: err.message });
            throw err;
        }
    })
    .get("/models/decisions", async (c) => c.json(await decisionModels(requireUser(c).id)))
    // Forget everything the agent remembered for this user: the memory store in their own home. Safe while the agent runs; a new chat starts empty.
    .delete("/memory", (c) => {
        const user = requireUser(c);
        rmSync(join(paths.user(user.id).ompAgentDir, "memories"), { recursive: true, force: true });
        return c.json({ ok: true });
    })
    .get("/models/logos/:file", async (c) => {
        requireUser(c);
        const key = c.req.param("file").replace(/\.svg$/, "");
        const svg = await logo(key);
        if (!svg) throw new HTTPException(404, { message: "No logo" });
        return c.body(svg, 200, {
            "content-type": "image/svg+xml",
            "cache-control": "public, max-age=86400",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        });
    });
