import { rmSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_SEARCH_QUERY_CHARS, type TranscriptSegment } from "@pikvm/contracts/recordings";

/**
 * The full-text index over transcripts and titles: `<dataDir>/recordings/index.db`, SQLite through `node:sqlite` with FTS5.
 *
 * It is only a copy. The transcripts (`transcript.json`) and the titles (`meta.json`) are the truth; the service
 * (service.ts) fills this from them when a transcript finishes or a title changes, takes rows out when a recording is deleted
 * or swept, and brings it level with the recordings at every start (`reconcile`), so a missing, older or damaged file costs a
 * rebuild and never a search that lies. A host whose SQLite has no FTS5 (or cannot open the file at all) runs with
 * `available: false` and a reason: search answers 503 and nothing else is affected.
 *
 * Tables: `docs` (one row per indexed recording: when it started, and the `sig` of the transcript it was built from),
 * `seg` (one row per transcript segment), `title` (one row per titled recording), and an external-content FTS5 table over each
 * of `seg.text` and `title.text`, kept level by triggers. The tokenizer is `porter unicode61 remove_diacritics 2`: words
 * match their other forms and ignore accents and case.
 */

/** Bump when the tables change: an index made by another version is dropped and rebuilt. */
export const INDEX_VERSION = 1;

/** A snippet is cut to about this many characters around the first match. */
const SNIPPET_CHARS = 220;
/** More terms than this in one query are ignored: nobody typed them, and each is a join in the index. */
const MAX_TERMS = 12;
/** The hit markers: control characters that cannot be in indexed text (they are replaced when it goes in). */
const OPEN = "\u0001";
const CLOSE = "\u0002";

export interface IndexedSegment {
    start: number;
    end: number;
    speaker: string;
    text: string;
}

export interface SearchParams {
    /** The FTS5 expression made by `buildMatch`. */
    match: string;
    limit: number;
    offset: number;
    speaker: string | null;
    /** Milliseconds since the epoch: keep recordings that started at or after / before these. */
    fromMs: number | null;
    toMs: number | null;
}

export interface IndexHit {
    id: string;
    kind: "title" | "transcript";
    startMs: number | null;
    endMs: number | null;
    speaker: string | null;
    text: string;
    ranges: Array<[number, number]>;
    rank: number;
}

export interface IndexPage {
    hits: IndexHit[];
    total: number;
    recordings: number;
}

/**
 * What a person typed as an FTS5 expression, or null when there is nothing to search for. Words are quoted, so no operator or
 * column filter or punctuation of theirs reaches FTS5; words must all match; `"in quotes"` is a phrase; the last word, when the
 * text does not end in a space or a quote, also matches by prefix.
 */
export function buildMatch(input: string): string | null {
    const text = input.slice(0, MAX_SEARCH_QUERY_CHARS);
    const terms: Array<{ phrase: string; quoted: boolean }> = [];
    const chunk = /"([^"]*)"?|([^\s"]+)/gu;
    for (let found = chunk.exec(text); found !== null; found = chunk.exec(text)) {
        const quoted = found[1] !== undefined;
        const words = (found[1] ?? found[2] ?? "").match(/[\p{L}\p{N}\p{M}]+/gu);
        if (words) terms.push({ phrase: words.join(" "), quoted });
    }
    if (terms.length === 0) return null;
    const last = terms.length > MAX_TERMS ? MAX_TERMS - 1 : terms.length - 1;
    const open = !/[\s"]$/u.test(text);
    return terms
        .slice(0, MAX_TERMS)
        .map((term, i) => `"${term.phrase}"${i === last && open && !term.quoted ? "*" : ""}`)
        .join(" ");
}

/** Indexed text may not carry the hit markers. */
const clean = (text: string): string => text.replace(/[\u0001\u0002]/g, " ");

/**
 * `marked` is text with OPEN and CLOSE around each matched word (SQLite's highlight()). Out come the plain text cut to a window
 * around the first match, and the matches in it. Matches separated only by white space (the words of a phrase) are one range.
 */
export function snippetOf(marked: string): { text: string; ranges: Array<[number, number]> } {
    let plain = "";
    const found: Array<[number, number]> = [];
    let from = -1;
    for (const ch of marked) {
        if (ch === OPEN) from = plain.length;
        else if (ch === CLOSE) {
            if (from >= 0 && plain.length > from) found.push([from, plain.length]);
            from = -1;
        } else plain += ch;
    }
    const ranges: Array<[number, number]> = [];
    for (const range of found) {
        const before = ranges[ranges.length - 1];
        if (before && /^\s*$/u.test(plain.slice(before[1], range[0]))) before[1] = range[1];
        else ranges.push([range[0], range[1]]);
    }
    if (plain.length <= SNIPPET_CHARS) return { text: plain, ranges };

    const anchor = ranges[0]?.[0] ?? 0;
    let start = Math.max(0, anchor - Math.round(SNIPPET_CHARS / 4));
    if (start > 0) {
        // Start at a word: move on to the next space, if one is near.
        const space = plain.indexOf(" ", start);
        if (space >= 0 && space < anchor) start = space + 1;
    }
    let end = Math.min(plain.length, start + SNIPPET_CHARS);
    if (end < plain.length) {
        const space = plain.lastIndexOf(" ", end);
        if (space > Math.max(start, (ranges[0]?.[1] ?? 0) - 1)) end = space;
    }
    const lead = start > 0 ? "\u2026" : "";
    const tail = end < plain.length ? "\u2026" : "";
    const cut: Array<[number, number]> = [];
    for (const [a, b] of ranges) {
        const s = Math.max(a, start);
        const e = Math.min(b, end);
        if (e > s) cut.push([s - start + lead.length, e - start + lead.length]);
    }
    return { text: lead + plain.slice(start, end) + tail, ranges: cut };
}

const SCHEMA = `
CREATE TABLE docs (rec TEXT PRIMARY KEY, started_ms INTEGER NOT NULL, sig TEXT NOT NULL);
CREATE TABLE seg (id INTEGER PRIMARY KEY, rec TEXT NOT NULL, seq INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX seg_rec ON seg(rec);
CREATE INDEX seg_speaker ON seg(speaker);
CREATE VIRTUAL TABLE seg_fts USING fts5(text, content='seg', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER seg_ai AFTER INSERT ON seg BEGIN INSERT INTO seg_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER seg_ad AFTER DELETE ON seg BEGIN INSERT INTO seg_fts(seg_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
CREATE TABLE title (rec TEXT PRIMARY KEY, text TEXT NOT NULL);
CREATE VIRTUAL TABLE title_fts USING fts5(text, content='title', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER title_ai AFTER INSERT ON title BEGIN INSERT INTO title_fts(rowid, text) VALUES (new.rowid, new.text); END;
CREATE TRIGGER title_ad AFTER DELETE ON title BEGIN INSERT INTO title_fts(title_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
`;

type Row = Record<string, unknown>;

export class RecordingIndex {
    private constructor(
        private readonly db: DatabaseSync | null,
        readonly reason: string | null,
    ) {}

    get available(): boolean {
        return this.db !== null;
    }

    /** Opens (making it if need be) `<dir>/index.db`. Never throws: a host that cannot is `available: false` with a reason. */
    static open(dir: string, log: (line: string) => void): RecordingIndex {
        const file = join(dir, "index.db");
        const attempt = (): RecordingIndex => {
            const db = new DatabaseSync(file);
            try {
                db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
                const version = Number((db.prepare("PRAGMA user_version").get() as Row | undefined)?.["user_version"] ?? 0);
                if (version !== INDEX_VERSION) {
                    if (version !== 0) log(`[recordings] the search index is version ${version}, this host's is ${INDEX_VERSION}: rebuilding it`);
                    for (const row of db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view')").all() as Row[]) {
                        // Virtual tables go first with their shadow tables; a plain DROP of each name in turn is enough.
                        if (/_(?:data|idx|content|docsize|config)$/.test(String(row["name"]))) continue;
                        db.exec(`DROP TABLE IF EXISTS "${String(row["name"])}"`);
                    }
                    db.exec(SCHEMA);
                    db.exec(`PRAGMA user_version = ${INDEX_VERSION}`);
                }
                // The tables must really work: this is where a SQLite without FTS5 is found, and a damaged file.
                db.prepare("SELECT count(*) AS n FROM seg_fts WHERE seg_fts MATCH ?").get('"probe"');
                db.prepare("SELECT count(*) AS n FROM title_fts WHERE title_fts MATCH ?").get('"probe"');
                return new RecordingIndex(db, null);
            } catch (error) {
                db.close();
                throw error;
            }
        };
        try {
            return attempt();
        } catch (first) {
            // A file that is not a usable index is only a cache that was lost: start again from nothing.
            log(`[recordings] the search index could not be used (${message(first)}); making a new one`);
            for (const suffix of ["", "-wal", "-shm"]) {
                try {
                    rmSync(file + suffix, { force: true });
                } catch {
                    // Not removable (it is a directory, or the disk is read-only): the second attempt says why it cannot be opened.
                }
            }
            try {
                return attempt();
            } catch (second) {
                log(`[recordings] search is unavailable: ${message(second)}`);
                return new RecordingIndex(null, `The search index could not be opened (${message(second)}).`);
            }
        }
    }

    /** The index file is private, like the recordings it was made from. */
    async restrict(dir: string): Promise<void> {
        for (const suffix of ["", "-wal", "-shm"]) await chmod(join(dir, `index.db${suffix}`), 0o600).catch(() => undefined);
    }

    close(): void {
        this.db?.close();
    }

    // ── writing ──────────────────────────────────────────────────────────────────────────────────────────────────
    private transaction(run: (db: DatabaseSync) => void): void {
        const db = this.db;
        if (!db) return;
        db.exec("BEGIN IMMEDIATE");
        try {
            run(db);
            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    }

    /** The transcript signature a recording was indexed with: "" when it has none; null when it is not indexed at all. */
    signatureOf(id: string): string | null {
        const row = this.db?.prepare("SELECT sig FROM docs WHERE rec = ?").get(id) as Row | undefined;
        return row ? String(row["sig"]) : null;
    }

    titleOf(id: string): string | null {
        const row = this.db?.prepare("SELECT text FROM title WHERE rec = ?").get(id) as Row | undefined;
        return row ? String(row["text"]) : null;
    }

    ids(): string[] {
        return ((this.db?.prepare("SELECT rec FROM docs").all() as Row[] | undefined) ?? []).map((row) => String(row["rec"]));
    }

    /** Makes the recording's rows, from this transcript (or none), under `sig`. The title is left as it is. */
    putTranscript(id: string, startedMs: number, sig: string, segments: readonly IndexedSegment[]): void {
        this.transaction((db) => {
            db.prepare("DELETE FROM seg WHERE rec = ?").run(id);
            db.prepare("INSERT INTO docs (rec, started_ms, sig) VALUES (?, ?, ?) ON CONFLICT(rec) DO UPDATE SET started_ms = excluded.started_ms, sig = excluded.sig").run(id, startedMs, sig);
            const insert = db.prepare("INSERT INTO seg (rec, seq, start_ms, end_ms, speaker, text) VALUES (?, ?, ?, ?, ?, ?)");
            segments.forEach((segment, seq) => {
                const text = clean(segment.text).trim();
                if (text === "") return;
                insert.run(id, seq, Math.round(segment.start * 1000), Math.round(segment.end * 1000), clean(segment.speaker), text);
            });
        });
    }

    /** The transcript is gone (a new one is being made): its segments leave, the title stays. */
    clearTranscript(id: string): void {
        this.transaction((db) => {
            db.prepare("DELETE FROM seg WHERE rec = ?").run(id);
            db.prepare("UPDATE docs SET sig = '' WHERE rec = ?").run(id);
        });
    }

    /** Sets or clears the title of a recording. */
    putTitle(id: string, startedMs: number, title: string | null): void {
        this.transaction((db) => {
            db.prepare("INSERT INTO docs (rec, started_ms, sig) VALUES (?, ?, '') ON CONFLICT(rec) DO UPDATE SET started_ms = excluded.started_ms").run(id, startedMs);
            db.prepare("DELETE FROM title WHERE rec = ?").run(id);
            const text = title === null ? "" : clean(title).trim();
            if (text !== "") db.prepare("INSERT INTO title (rec, text) VALUES (?, ?)").run(id, text);
        });
    }

    /** Everything of one recording. */
    remove(id: string): void {
        this.transaction((db) => {
            db.prepare("DELETE FROM seg WHERE rec = ?").run(id);
            db.prepare("DELETE FROM title WHERE rec = ?").run(id);
            db.prepare("DELETE FROM docs WHERE rec = ?").run(id);
        });
    }

    // ── reading ──────────────────────────────────────────────────────────────────────────────────────────────────
    /** Counts, for the log and the checks: how many recordings, segments and titles are indexed. */
    stats(): { recordings: number; segments: number; titles: number } {
        const one = (sql: string): number => Number((this.db?.prepare(sql).get() as Row | undefined)?.["n"] ?? 0);
        return { recordings: one("SELECT count(*) AS n FROM docs"), segments: one("SELECT count(*) AS n FROM seg"), titles: one("SELECT count(*) AS n FROM title") };
    }

    search(params: SearchParams): IndexPage {
        const db = this.db;
        if (!db) return { hits: [], total: 0, recordings: 0 };
        const where: string[] = [];
        const args: Array<string | number> = [];
        if (params.fromMs !== null) {
            where.push("docs.started_ms >= ?");
            args.push(params.fromMs);
        }
        if (params.toMs !== null) {
            where.push("docs.started_ms < ?");
            args.push(params.toMs);
        }
        const range = where.length > 0 ? ` AND ${where.join(" AND ")}` : "";

        const titleRows =
            params.speaker !== null
                ? []
                : (db
                      .prepare(
                          `SELECT title.rec AS rec, bm25(title_fts) AS rank, highlight(title_fts, 0, char(1), char(2)) AS marked
                           FROM title_fts JOIN title ON title.rowid = title_fts.rowid JOIN docs ON docs.rec = title.rec
                           WHERE title_fts MATCH ?${range} ORDER BY rank, docs.started_ms DESC`,
                      )
                      .all(params.match, ...args) as Row[]);

        const speaker = params.speaker === null ? "" : " AND seg.speaker = ?";
        const segArgs = params.speaker === null ? args : [...args, params.speaker];
        const from = `FROM seg_fts JOIN seg ON seg.id = seg_fts.rowid JOIN docs ON docs.rec = seg.rec WHERE seg_fts MATCH ?${range}${speaker}`;
        const counts = db.prepare(`SELECT count(*) AS n, count(DISTINCT seg.rec) AS r ${from}`).get(params.match, ...segArgs) as Row;
        const segmentTotal = Number(counts["n"]);
        const titleOnly = new Set(titleRows.map((row) => String(row["rec"])));
        const segmentRecs = db.prepare(`SELECT DISTINCT seg.rec AS rec ${from}`).all(params.match, ...segArgs) as Row[];
        for (const row of segmentRecs) titleOnly.add(String(row["rec"]));

        const hits: IndexHit[] = [];
        for (const row of titleRows.slice(params.offset, params.offset + params.limit)) {
            const { text, ranges } = snippetOf(String(row["marked"]));
            hits.push({ id: String(row["rec"]), kind: "title", startMs: null, endMs: null, speaker: null, text, ranges, rank: Number(row["rank"]) });
        }
        const segmentOffset = Math.max(0, params.offset - titleRows.length);
        const room = params.limit - hits.length;
        if (room > 0) {
            const rows = db
                .prepare(
                    `SELECT seg.rec AS rec, seg.start_ms AS start_ms, seg.end_ms AS end_ms, seg.speaker AS speaker, bm25(seg_fts) AS rank,
                            highlight(seg_fts, 0, char(1), char(2)) AS marked
                     ${from} ORDER BY rank, docs.started_ms DESC, seg.start_ms LIMIT ? OFFSET ?`,
                )
                .all(params.match, ...segArgs, room, segmentOffset) as Row[];
            for (const row of rows) {
                const { text, ranges } = snippetOf(String(row["marked"]));
                hits.push({
                    id: String(row["rec"]),
                    kind: "transcript",
                    startMs: Number(row["start_ms"]),
                    endMs: Number(row["end_ms"]),
                    speaker: String(row["speaker"]),
                    text,
                    ranges,
                    rank: Number(row["rank"]),
                });
            }
        }
        return { hits, total: titleRows.length + segmentTotal, recordings: titleOnly.size };
    }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A transcript's segments as the index takes them; anything that is not a segment is left out. */
export function indexedSegments(segments: readonly TranscriptSegment[]): IndexedSegment[] {
    return segments
        .filter((s) => typeof s.text === "string" && typeof s.speaker === "string" && Number.isFinite(s.start) && Number.isFinite(s.end))
        .map((s) => ({ start: s.start, end: s.end, speaker: s.speaker, text: s.text }));
}
