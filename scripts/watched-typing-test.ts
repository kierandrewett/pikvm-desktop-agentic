// Smoke test for watched typing (src/agent/watched-typing.ts). Pure logic, no
// Electron — exercises field auto-locate, mismatch classification, chunking, and
// the orchestrator's happy / no-focus / layout-correction paths with fake deps.
//   esbuild scripts/watched-typing-test.ts --bundle --platform=node --format=cjs \
//     --outfile=dist/watched-typing-test.cjs && node dist/watched-typing-test.cjs

import {
    chunkText,
    classifyMismatch,
    computeVerdict,
    isExactText,
    locateChangedBBox,
    runWatchedTyping,
    visibleTypingRegionIssue,
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

// 1b. visible typing target preflight --------------------------------------
{
    check("visible target: missing region is rejected", !!visibleTypingRegionIssue(undefined, dims));
    check("visible target: on-screen field accepted", visibleTypingRegionIssue({ x: 10, y: 10, width: 220, height: 32 }, dims) === null);
    check("visible target: off-screen field rejected", !!visibleTypingRegionIssue({ x: 5000, y: 10, width: 220, height: 32 }, dims));
    check("visible target: mostly clipped field rejected", !!visibleTypingRegionIssue({ x: -200, y: 10, width: 220, height: 32 }, dims));
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
    check("classify: visible prefix only → null", classifyMismatch("Confirm server scope with Jason", "Confirm server scope") === null);
}

// 2b. classifyMismatch in PRECISE mode (commands/code/paths) ----------------
// The reported bug: a US/UK layout slip corrupts symbols in a shell command, but the
// lenient confusable+Levenshtein path absorbed it and reported "verified correctly".
// In precise mode symbols/case are load-bearing and must surface as a real mismatch.
{
    // Reproduced false-passes (these returned null in the lenient path):
    check("precise: $1 vs $l (digit/letter) → NOT null", classifyMismatch("echo $1 > out", "echo $l > out", { precise: true }) !== null);
    check("precise: pipe vanished (| → l) → NOT null", classifyMismatch("cat f.txt | wc -l", "cat f.txt l wc -l", { precise: true }) !== null);
    // Letters/digits identical, only symbols differ ⇒ the US/UK layout signature.
    check('precise: layout slip (" → @) → layout', classifyMismatch('echo "hi"', "echo @hi@", { precise: true }) === "layout");
    check("precise: layout slip (| → ~) → layout", classifyMismatch("ls | sort", "ls ~ sort", { precise: true }) === "layout");
    // A clean precise read must NOT be flagged (no false correction of correct commands).
    check("precise: exact command → null", classifyMismatch("rm ~/tmp/x", "rm ~/tmp/x", { precise: true }) === null);
    check("precise: contains (prompt echoes more) → null", classifyMismatch("git status", "$ git status", { precise: true }) === null);
}

// 2c. computeVerdict — a symbol/case slip in a command is NEVER "match" -------
{
    check("verdict: exact (non-precise) → match", computeVerdict("hello world", "hello world") === "match");
    check("verdict: precise exact → match", computeVerdict("git pull", "git pull", { precise: true }) === "match");
    // The exact reported command shape: " → @ and | → ~, letters lowercased by OCR.
    const cmd = `find . -name 'README*' | sort && echo "=== ROOT ==="`;
    const readBack = `find . -name 'readme*' ~ sort && echo @=== root ===@`;
    check("verdict: reported command slip → mismatch (NOT match)", computeVerdict(cmd, readBack, { precise: true }) === "mismatch");
    check("verdict: $1 vs $l precise → mismatch", computeVerdict("echo $1 > out", "echo $l > out", { precise: true }) === "mismatch");
}

// 2e. Terminal/field read-back artefacts must NOT cause a false "doesn't match" -------
// The crop catches the shell prompt, quote-glyph variants, or a results dropdown — none
// of which are typing errors. (Reported: "$" prompt read as typed text; Quick Open list.)
{
    // Leading shell prompt the crop caught is stripped before comparing.
    check("prompt: '$ git status' read-back → match", computeVerdict("git status", "$ git status", { precise: true }) === "match");
    check("prompt: classify '$ '-prefixed → no correction", classifyMismatch("git status", "$ git status", { precise: true }) === null);
    check("prompt: user@host MINGW prompt stripped", computeVerdict("ls -la", "drewettk@HOST MINGW64 ~/p$ ls -la", { precise: true }) === "match");
    // Image 5: single→double quote OCR variance under a '$ ' prompt is not a mismatch.
    const cmd5i = "find . -maxdepth 3 -iname '*.md' -not -path '*/.terraform/*' | sort";
    const cmd5r = `$ find . -maxdepth 3 -iname "*.md" -not -path "*/.terraform/*" | sort`;
    check("quotes: '*.md' read as \"*.md\" under a prompt → match", computeVerdict(cmd5i, cmd5r, { precise: true }) === "match");
    check("quotes: classify → no correction", classifyMismatch(cmd5i, cmd5r, { precise: true }) === null);
    // Image 6: a truncated read-back under a prompt is a clean prefix → unverified, not mismatch.
    const cmd6i = "clear; wc -l image-build/oel9-cis/README.md; sed -n '1,45p' image-build/oel9-cis/README.md";
    const cmd6r = "$ clear; wc -l image-build/oel9-cis/README.md; sed -n '1,45p' image-build";
    check("prefix: truncated terminal read-back → unverified (not mismatch)", computeVerdict(cmd6i, cmd6r, { precise: true }) === "unverified");
    check("prefix: classify truncated → no correction", classifyMismatch(cmd6i, cmd6r, { precise: true }) === null);
    // Image 8: the crop read the Quick Open RESULTS list, not the typed path → unverified.
    const qoi = "oel9-cis/README.md";
    const qor = "® README.md image-build\\oel9-cis\\runner RS NE a";
    check("results: Quick Open list read instead of the field → unverified (not mismatch)", computeVerdict(qoi, qor, { precise: true }) === "unverified");
    check("results: classify wrong-region read → no destructive correction", classifyMismatch(qoi, qor, { precise: true }) === null);
    // A real layout slip UNDER a prompt is STILL caught (don't over-soften).
    check("layout still caught through a prompt: 'ls | sort' read '$ ls ~ sort'", classifyMismatch("ls | sort", "$ ls ~ sort", { precise: true }) === "layout");
}

// 2d. isExactText — commands/paths/URLs precise; ordinary prose lenient -------
{
    check("exact: shell pipe", isExactText("cat f.txt | wc -l"));
    check("exact: redirect + var", isExactText("echo $HOME > out.txt"));
    check("exact: command head", isExactText("git switch main"));
    check("exact: absolute path", isExactText("open /etc/hosts"));
    check("exact: url", isExactText("https://example.com/x"));
    check("lenient: plain prose", !isExactText("please reply to the team by friday"));
    check("lenient: email address in prose", !isExactText("email me at jane@domain.com about it"));
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
function makeFake(
    opts: {
        focus?: boolean;
        corrupt?: (s: string, layout: "us" | "uk") => string;
        localGlitch?: string;
        readBack?: (rendered: string) => string;
        /** Wire the server-side print fast path (printText/wait/capsLockOn). */
        fastPrint?: boolean;
        /** Report the target's Caps Lock as on (forces the humanized fallback). */
        capsOn?: boolean;
    } = {},
) {
    const focus = opts.focus ?? true;
    let field = "";
    let caret = 0;
    let layout: "us" | "uk" = "us";
    let backspaces = 0;
    let deletes = 0;
    let prints = 0;
    let chunks = 0;
    let selectAllUsed = false;
    const events: TypingEvent[] = [];
    const render = (s: string) => (opts.corrupt ? opts.corrupt(s, layout) : s);
    const read = () => {
        const rendered = render(field);
        return opts.readBack ? opts.readBack(rendered) : rendered;
    };
    const deps: WatchedTypingDeps = {
        async typeChunk(t) {
            chunks++;
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
            return opts.localGlitch !== undefined ? opts.localGlitch : read();
        },
        async opticalReadStrong() {
            return read();
        },
        getLayout: () => layout,
        setLayout: (l) => {
            layout = l;
        },
        remember: () => {},
        emit: (ev) => events.push(ev),
        getDimensions: () => dims,
    };
    if (opts.fastPrint) {
        deps.printText = async (t) => {
            prints++;
            field = field.slice(0, caret) + t + field.slice(caret);
            caret += t.length;
        };
        deps.wait = async () => {};
        deps.capsLockOn = () => opts.capsOn ?? false;
    }
    return {
        deps,
        events,
        get prints() {
            return prints;
        },
        get chunks() {
            return chunks;
        },
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
        check("run: no-focus tells agent not to retry blind", res.summary.includes("do not call type_text again yet"), res.summary);
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

    // Command layout slip (precise inferred from the shell shape): a pipe renders as '~'
    // on US until we flip to UK. This is the reported bug — it must self-correct, not be
    // absorbed as OCR noise and reported "verified".
    {
        const fake = makeFake({
            corrupt: (s, layout) => (layout === "us" ? s.replace(/\|/g, "~") : s),
        });
        const res = await runWatchedTyping("grep foo | sort", { verifyRegion: { x: 100, y: 100, width: 300, height: 40 } }, fake.deps);
        check("run: command pipe slip self-corrected (precise)", res.corrected === true, res);
        check("run: command layout flipped to uk", fake.layout === "uk");
        check("run: command field correct after fix", fake.field === "grep foo | sort", fake.field);
        check("run: command verdict not a false match-without-fix", res.verdict === "match" && res.corrected === true, res);
    }

    // Hybrid safety net: a local-OCR glitch must NOT trigger a destructive retype —
    // the strong (vision) confirm reads the field correctly, so no correction happens.
    {
        const fake = makeFake({ localGlitch: "qz garbled noise" });
        const res = await runWatchedTyping("the actual correct text", { verifyRegion: { x: 100, y: 100, width: 300, height: 40 } }, fake.deps);
        check("run: local glitch confirmed clean → no false correction", res.corrected === false, res);
        check("run: severe glitch → no false mismatch (unverified, not corrected)", res.verdict !== "mismatch", res);
    }

    // Real GUI fields can scroll or crop, so OCR may only see the first words even
    // though the full text landed. That must not be treated as "typing failed".
    {
        const text = "Confirm server scope with Jason";
        const visiblePrefix = "Confirm server scope";
        const fake = makeFake({ readBack: (rendered) => rendered.slice(0, visiblePrefix.length) });
        const res = await runWatchedTyping(text, { verifyRegion: { x: 100, y: 100, width: 300, height: 40 } }, fake.deps);
        check("run: prefix-only read-back is unverified, not mismatch", res.verdict === "unverified", res);
        check("run: prefix-only read-back still typed the full text", fake.field === text, fake.field);
        check("run: prefix-only read-back does not trigger correction", res.corrected === false, res);
    }

    // ---- FAST PRINT PATH (long prose → server-side print + single verify) ----
    const region = { x: 100, y: 100, width: 600, height: 200 };
    const longProse = "these are the iam changes we need from the llds, lots of detail to type out here";

    // Long plain prose takes the fast print path (one print, no per-char chunking).
    {
        const fake = makeFake({ fastPrint: true });
        const res = await runWatchedTyping(longProse, { verifyRegion: region }, fake.deps);
        check("fast: long prose verdict match", res.verdict === "match", res);
        check("fast: used printText, not the humanized chunker", fake.prints === 1 && fake.chunks === 0, { prints: fake.prints, chunks: fake.chunks });
        check("fast: field has the full text", fake.field === longProse, fake.field);
        check("fast: summary says fast", res.summary.toLowerCase().includes("fast"), res.summary);
    }

    // A long EXACT command (isExactText) must NOT take the fast path — humanized + self-correct.
    {
        const fake = makeFake({ fastPrint: true });
        await runWatchedTyping("git commit -m 'rework the whole config and redeploy it all now please'", { verifyRegion: region }, fake.deps);
        check("fast: exact command stays humanized (no print)", fake.prints === 0 && fake.chunks > 0, { prints: fake.prints, chunks: fake.chunks });
    }

    // Caps Lock ON → can't compensate server-side → humanized fallback (which inverts Shift).
    {
        const fake = makeFake({ fastPrint: true, capsOn: true });
        await runWatchedTyping(longProse, { verifyRegion: region }, fake.deps);
        check("fast: caps-lock on falls back to humanized typing", fake.prints === 0 && fake.chunks > 0, { prints: fake.prints, chunks: fake.chunks });
    }

    // Fast path, not focused → reports no-focus (doesn't blindly reprint).
    {
        const fake = makeFake({ fastPrint: true, focus: false });
        const res = await runWatchedTyping(longProse, { verifyRegion: region }, fake.deps);
        check("fast: no-focus → mismatch + not-focused message", res.verdict === "mismatch" && res.summary.includes("isn't focused"), res);
    }

    // Fast path: a local-OCR glitch is confirmed-clean by the strong read → no reprint.
    {
        const fake = makeFake({ fastPrint: true, localGlitch: "qz garbled noise" });
        const res = await runWatchedTyping(longProse, { verifyRegion: region }, fake.deps);
        check("fast: local glitch confirmed clean → no reprint", fake.prints === 1 && res.corrected === false, { prints: fake.prints, res });
    }

    // Fast path: a confident, persistent mismatch → clear + reprint exactly once.
    {
        const fake = makeFake({ fastPrint: true, corrupt: (s) => s.split(" ").reverse().join(" ") });
        const res = await runWatchedTyping(longProse, { verifyRegion: region }, fake.deps);
        check("fast: confirmed mismatch reprints once", fake.prints === 2 && res.corrected === true, { prints: fake.prints, res });
        check("fast: reprint cleared with Delete, never Ctrl+A", fake.deletes > 0 && fake.selectAllUsed === false);
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
