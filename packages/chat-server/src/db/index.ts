/**
 * Database handle. SQLite through `node:sqlite` with Drizzle ORM.
 *
 * Drizzle has no node:sqlite driver, and its `sqlite-proxy` driver is asynchronous, which would put an `await` on
 * every query in code that was written against a synchronous driver. Its better-sqlite3 session only needs a client
 * with `prepare`, `transaction` and `raw`, so `NodeSqliteClient` gives it exactly that over `DatabaseSync`, and the
 * query code stays as it is upstream. We build the database object ourselves because the better-sqlite3 entry
 * point imports the native addon, which Electron would need rebuilt.
 */
import { createTableRelationsHelpers, extractTablesRelationalConfig } from "drizzle-orm";
import { BetterSQLiteSession } from "drizzle-orm/better-sqlite3/session";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { BaseSQLiteDatabase, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { uuidv7 } from "../ids.ts";
import { paths } from "../paths.ts";
import * as schema from "./schema.ts";

export { schema };

type Params = SQLInputValue[];

/** The slice of the better-sqlite3 statement API that Drizzle's session calls. */
class NodeSqliteStatement {
    private rawMode = false;
    constructor(private readonly stmt: StatementSync) {}

    raw(): this {
        this.rawMode = true;
        this.stmt.setReturnArrays(true);
        return this;
    }
    run(...params: Params) {
        return this.stmt.run(...params);
    }
    all(...params: Params) {
        return this.stmt.all(...params);
    }
    get(...params: Params) {
        return this.stmt.get(...params);
    }
    get isRaw(): boolean {
        return this.rawMode;
    }
}

type TransactionBehaviour = "deferred" | "immediate" | "exclusive";

/** `client.transaction(fn)` returns a function per behaviour, as better-sqlite3 does. */
function transactionRunner(sqlite: DatabaseSync) {
    return <A extends unknown[], R>(fn: (...args: A) => R) => {
        const run = (behaviour: TransactionBehaviour) =>
            (...args: A): R => {
                // A transaction opened inside a transaction would fail on BEGIN; Drizzle nests with savepoints instead.
                sqlite.exec(`BEGIN ${behaviour.toUpperCase()}`);
                try {
                    const result = fn(...args);
                    sqlite.exec("COMMIT");
                    return result;
                } catch (err) {
                    if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
                    throw err;
                }
            };
        return Object.assign(run("deferred"), {
            deferred: run("deferred"),
            immediate: run("immediate"),
            exclusive: run("exclusive"),
        });
    };
}

class NodeSqliteClient {
    readonly transaction: ReturnType<typeof transactionRunner>;
    constructor(readonly sqlite: DatabaseSync) {
        this.transaction = transactionRunner(sqlite);
    }
    prepare(sql: string): NodeSqliteStatement {
        return new NodeSqliteStatement(this.sqlite.prepare(sql));
    }
}

function construct(client: NodeSqliteClient) {
    const dialect = new SQLiteSyncDialect();
    const tables = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
    const config = { fullSchema: schema, schema: tables.tables, tableNamesMap: tables.tableNamesMap };
    const session = new BetterSQLiteSession(client as never, dialect, config, {});
    return new BaseSQLiteDatabase("sync", dialect, session, config) as BaseSQLiteDatabase<"sync", unknown, typeof schema>;
}

export type Db = ReturnType<typeof construct>;

let sqliteHandle: DatabaseSync | undefined;

/** The migrations the build copies beside the bundle, or the package's own folder in development. */
let migrationsDir: string | undefined;

/** Where a bundled host keeps the migrations it copied beside itself. */
export function setMigrationsDir(dir: string | undefined): void {
    migrationsDir = dir;
}

export function migrationsFolder(): string {
    return migrationsDir ?? process.env.CHAT_MIGRATIONS_DIR ?? new URL("../../migrations", import.meta.url).pathname;
}

/** Open `chat.db` under the current data directory, run the migrations and seed the operator row. */
export function openDb(): Db {
    closeDb();
    mkdirSync(dirname(paths.db), { recursive: true });
    const sqlite = new DatabaseSync(paths.db);
    sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const orm = construct(new NodeSqliteClient(sqlite));
    const migrations = readMigrationFiles({ migrationsFolder: migrationsFolder() });
    (orm as unknown as { dialect: SQLiteSyncDialect; session: BetterSQLiteSession<never, never> }).dialect.migrate(
        migrations,
        (orm as unknown as { session: never }).session,
        { migrationsFolder: migrationsFolder() },
    );
    sqliteHandle = sqlite;
    db = orm;
    return orm;
}

export function closeDb(): void {
    sqliteHandle?.close();
    sqliteHandle = undefined;
}

/** The open database. A live binding: `openDb` replaces it, so import it, never copy it at module load. */
export let db: Db = undefined as unknown as Db;

export const now = () => Date.now();
export const newId = () => uuidv7();
