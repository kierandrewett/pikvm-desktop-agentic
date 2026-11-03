/**
 * `GET /api/bootstrap` and `GET /api/me`. There is no sign-in, so the answer is the same for every request: the
 * operator, with every sign-in method off. The web client reads this shape (apps/web `lib/auth`), so it stays.
 */
import { Hono } from "hono";
import { INSTANCE_NAME } from "../env.ts";
import { OPERATOR } from "../auth/operator.ts";
import type { Env } from "./context.ts";

export const bootstrapRoutes = new Hono<Env>()
    .get("/bootstrap", (c) =>
        c.json({ instanceName: INSTANCE_NAME, signup: false, needsSetup: false, auth: {}, user: OPERATOR }),
    )
    .get("/me", (c) => c.json({ user: OPERATOR }));
