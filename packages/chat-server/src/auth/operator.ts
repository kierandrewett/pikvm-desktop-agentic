/**
 * There is one user. The host decides who may reach the server (its own gate), so the chat server has no sign-in:
 * every request is the operator. The row exists so foreign keys hold.
 */
import { db, schema } from "../db/index.ts";
import { OPERATOR_ID } from "../paths.ts";

export interface User {
    id: string;
    email: string;
    name: string;
    image: string | null;
    role: "admin" | "user";
    banned: boolean;
}

export const OPERATOR: User = {
    id: OPERATOR_ID,
    email: "",
    name: "Operator",
    image: null,
    role: "admin",
    banned: false,
};

/** Insert the operator row when the database is new. */
export function seedOperator(): void {
    db.insert(schema.users).values({ id: OPERATOR.id, name: OPERATOR.name }).onConflictDoNothing().run();
}
