// Smoke test for watched typing (src/agent/watched-typing.ts). Pure logic, no
// Electron — exercises field auto-locate, mismatch classification, chunking, and
// the orchestrator's happy / no-focus / layout-correction paths with fake deps.
//   esbuild scripts/watched-typing-test.ts --bundle --platform=node --format=cjs \
//     --outfile=dist/watched-typing-test.cjs && node dist/watched-typing-test.cjs

import {
    chunkText,
    classifyMismatch,
    locateChangedBBox,
    runWatchedTyping,
    type GridSnapshot,
    type TypingEvent,
    type WatchedTypingDeps,
} from "../src/agent/watched-typing";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
    if (cond) {
        console.log(`  ok   ${name}`);
    } else {
        failed++;
        console.log(`  FAIL ${name}`, extra ?? "");
    }
}

const COLS = 96;
const ROWS = 54;
function blankGrid(v = 30): GridSnapshot {
    return { cols: COLS, rows: ROWS, cells: new Uint8Array(COLS * ROWS).fill(v) };
}
/** Paint a bright run of cells (simulating a typed line) into a grid copy. */
function withRun(base: GridSnapshot, r: number, c0: number, c1: number, v = 220): GridSnapshot {
    const cells = Uint8Array.from(base.cells);
    for (let c = c0; c <= c1; c++) cells[r * COLS + c] = v;
    return { cols: COLS, rows: ROWS, cells };
}

const dims = { width: 1920, height: 1080 };

// 1. locateChangedBBox -----------------------------------------------------
{
    const before = blankGrid();
    const after = withRun(before, 20, 10, 25); // a horizontal run = typed text
    const box = locateChangedBBox(before, after, dims);
    check("locate: finds a text run", !!box);
    if (box) {
        check("locate: box is wide-and-short (a field row)", box.width > box.height, box);
        check("locate: x maps into frame space", box.x > 0 && box.x < dims.width, box);
    }
    check("locate: no change → null (not focused)", locateChangedBBox(before, blankGrid(), dims) === null);
    // A single isolated changed cell is noise, not typing.
    const noisy = Uint8Array.from(before.cells);
    noisy[5 * COLS + 5] = 240;
    check("locate: single isolated cell → null", locateChangedBBox(before, { cols: COLS, rows: ROWS, cells: noisy }, dims) === null);
    // A full repaint (whole screen) is an app switch, not a field.
    const repaint = blankGrid(200);
    check("locate: full repaint → null", locateChangedBBox(before, repaint, dims) === null);
}

// 2. classifyMismatch ------------------------------------------------------
{
    check("classify: exact match → null", classifyMismatch("hello world", "hello world") === null);
    check("classify: case/space tolerant → null", classifyMismatch("Hello  World", "hello world") === null);
    check("classify: contains (prefilled) → null", classifyMismatch("hello", "say hello") === null);
    check("classify: fuzzy OCR noise → null", classifyMismatch("important note", "lmportant note") === null);
    // Letters/digits identical, symbols wrong = the layout signature.
    check('classify: layout slip (@ vs ")', classifyMismatch('user@host', 'user"host') === "layout");
    check("classify: layout slip (# vs ~)", classifyMismatch("a#b", "a~b") === "layout");
    check("classify: garbage (unrelated read) → NO correction", classifyMismatch("hello", "zzzz qqqq") === null);
    // OCR-confusable glyphs (l/1, O/0, S/5…) must NOT look like a typo — the very bug
    // where correct `oel9-linux-build` read back as `oe19-…` and got destructively cleared.
    check("classify: l↔1 confusable → null", classifyMismatch("feature/oel9-linux-build", "feature/oe19-linux-build") === null);
    check("classify: O↔0 + S↔5 confusable → null", classifyMismatch("S3-Bucket-Oslo", "53-Bucket-0slo") === null);
    check("classify: confusable inside a longer command → null", classifyMismatch("git switch feature/oel9", "git switch feature/oe19") === null);
}

// 3. chunkText -------------------------------------------------------------
{
    check("chunk: short text = one chunk", chunkText("hi there").length === 1);
    const long = "the quick brown fox jumps over the lazy dog repeatedly today";
    const cs = chunkText(long);
    check("chunk: long text splits", cs.length > 1);
    check("chunk: chunks rejoin to the original", cs.join("") === long, cs);
    const url = "supercalifragilisticexpialidocioussupercalifragilistic";
    check("chunk: a giant word still rejoins", chunkText(url).join("") === url);
}

// 4. Orchestrator with fake deps ------------------------------------------
/** A fake "screen": typing appends to a buffer; an optional transform corrupts it
 *  (e.g. a layout slip) until the layout is toggled. captureGrid reports a run when
 *  the buffer is non-empty so auto-locate + focus detection work. */
function makeFake(opts: { focus?: boolean; corrupt?: (s: string, layout: "us" | "uk") => string; localGlitch?: string } = {}) {
    const focus = opts.focus ?? true;
    let field = "";
    let caret = 0;
    let layout: "us" | "uk" = "us";
    let backspaces = 0;
    let deletes = 0;
    let selectAllUsed = false;
    const events: TypingEvent[] = [];
    const render = (s: string) => (opts.corrupt ? opts.corrupt(s, layout) : s);
    const deps: WatchedTypingDeps = {
        async typeChunk(t) {
            field = field.slice(0, caret) + t + field.slice(caret); // insert at the caret
            caret += t.length;
        },
        async pressKey(c) {
            if (c === "Enter" || c === "NumpadEnter") throw new Error("Enter leaked!");
            if (c === "Home") caret = 0;
            else if (c === "End") caret = field.length;
            else if (c === "Backspace") {
                if (caret > 0) {
                    field = field.slice(0, caret - 1) + field.slice(caret);
                    caret--;
                }
                backspaces++;
            } else if (c === "Delete") {
                if (caret < field.length) field = field.slice(0, caret) + field.slice(caret + 1); // forward delete; no-op past end
                deletes++;
            }
        },
        async hotkey(cs) {
            if (cs.includes("Enter")) throw new Error("Enter leaked!");
            if (cs.includes("ControlLeft") && cs.includes("KeyA")) selectAllUsed = true; // the terminal-corrupting bug
        },
        async captureGrid() {
            const base = blankGrid();
            if (!focus || !field) return base; // not focused → nothing changes
            return withRun(base, 20, 10, Math.min(80, 10 + field.length));
        },
        async cropField() {
            return { data: "x", mimeType: "image/jpeg" };
        },
        // Local OCR (fast path): may glitch. Strong read (vision): always accurate.
        async opticalRead() {
            return opts.localGlitch !== undefined ? opts.localGlitch : render(field);
        },
        async opticalReadStrong() {
            return render(field);
        },
        getLayout: () => layout,
        setLayout: (l) => {
            layout = l;
        },
        remember: () => {},
        emit: (ev) => events.push(ev),
        getDimensions: () => dims,
    };
    return {
        deps,
        events,
        get field() {
            return field;
        },
        get layout() {
            return layout;
        },
        get backspaces() {
            return backspaces;
        },
        get deletes() {
            return deletes;
        },
        get selectAllUsed() {
            return selectAllUsed;
        },
    };
}

async function orchestrator(): Promise<void> {
    // Happy path: text lands, verified clean.
    {
        const fake = makeFake();
        const res = await runWatchedTyping("hello there friend", { verifyRegion: { x: 100, y: 100, width: 300, height: 40 } }, fake.deps);
        check("run: happy path verdict match", res.verdict === "match", res);
        check("run: happy path not corrected", res.corrected === false);
        check("run: emits a done event", fake.events.some((e) => e.phase === "done"));
    }

    // No-focus: nothing changes on screen → fail fast, stop early.
    {
        const fake = makeFake({ focus: false });
        const res = await runWatchedTyping("password attempt here", {}, fake.deps);
        check("run: no-focus → mismatch", res.verdict === "mismatch", res);
        check("run: no-focus emits correcting/no-focus", fake.events.some((e) => e.phase === "correcting" && (e as any).reason === "no-focus"));
    }

    // Layout slip: '@' renders as '"' on US until we flip to UK; should self-correct.
    {
        const fake = makeFake({
            corrupt: (s, layout) => (layout === "us" ? s.replace(/@/g, '"') : s),
        });
        const res = await runWatchedTyping("email@domain.com about it", { verifyRegion: { x: 100, y: 100, width: 300, height: 40 } }, fake.deps);
        check("run: layout slip self-corrected", res.corrected === true, res);
        check("run: layout flipped to uk", fake.layout === "uk");
        check("run: field ends correct after fix", fake.field === "email@domain.com about it", fake.field);
        check("run: emits correcting/layout", fake.events.some((e) => e.phase === "correcting" && (e as any).reason === "layout"));
        check("run: correction cleared with Home+Delete, never Ctrl+A (terminal-safe)", fake.deletes > 0 && fake.selectAllUsed === false);
    }

    // Hybrid safety net: a local-OCR glitch must NOT trigger a destructive retype —
    // the strong (vision) confirm reads the field correctly, so no correction happens.
    {
        const fake = makeFake({ localGlitch: "qz garbled noise" });
        const res = await runWatchedTyping("the actual correct text", { verifyRegion: { x: 100, y: 100, width: 300, height: 40 } }, fake.deps);
        check("run: local glitch confirmed clean → no false correction", res.corrected === false, res);
        check("run: severe glitch → no false mismatch (unverified, not corrected)", res.verdict !== "mismatch", res);
    }
}

async function main(): Promise<void> {
    console.log("watched-typing smoke test");
    await orchestrator();
    if (failed) {
        console.error(`\n${failed} check(s) FAILED`);
        process.exit(1);
    }
    console.log("\nall checks passed");
}

void main();
