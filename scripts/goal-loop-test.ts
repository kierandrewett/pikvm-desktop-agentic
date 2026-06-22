// Validate the DECISION logic at the heart of the self-verifying goal loop:
// the pure goalLoopStep() function (achieved → stop, not-achieved → iterate,
// cap reached → stop), the blind-verdict parser (defaults to NOT achieved on
// doubt), and the /pursue argument parser. Pure functions only — no model, no
// KVM — so the loop is correct-by-construction and can never spin forever.
//
// Run:
//   esbuild scripts/goal-loop-test.ts --bundle --platform=node --format=cjs \
//     --outfile=dist/goal-loop-test.cjs --alias:electron=./scripts/electron-stub.cjs \
//     --log-level=error && node dist/goal-loop-test.cjs
import { goalLoopStep, parseVerdict, DEFAULT_GOAL_LOOP_CAP, type GoalVerdict } from "../src/agent/runner";
import { parsePursueArg } from "../src/commands";

let failures = 0;
function check(name: string, cond: boolean): void {
    console.log(`${cond ? "PASS" : "FAIL"} — ${name}`);
    if (!cond) failures++;
}

/* 1. achieved → stop (done), regardless of how many iterations remain. */
{
    const v: GoalVerdict = { achieved: true, reason: "The file is open showing the text." };
    const d = goalLoopStep(v, 1, 6);
    check("achieved on iteration 1 → done", d.kind === "done");
    const dLate = goalLoopStep(v, 5, 6);
    check("achieved on iteration 5 → done", dLate.kind === "done");
}

/* 2. not-achieved below the cap → iterate, feeding the gap back. */
{
    const v: GoalVerdict = { achieved: false, reason: "Editor empty.", whatsMissing: "type the three bullet points" };
    const d = goalLoopStep(v, 2, 6);
    check("not achieved, under cap → continue", d.kind === "continue");
    check("continue carries whatsMissing as feedback", d.kind === "continue" && d.feedback === "type the three bullet points");
}

/* 2b. not-achieved with no whatsMissing → falls back to the reason. */
{
    const v: GoalVerdict = { achieved: false, reason: "Nothing visible yet." };
    const d = goalLoopStep(v, 1, 6);
    check("continue falls back to reason when no whatsMissing", d.kind === "continue" && d.feedback === "Nothing visible yet.");
}

/* 3. cap reached → stop (never infinite). */
{
    const v: GoalVerdict = { achieved: false, reason: "Still not done.", whatsMissing: "more work" };
    const atCap = goalLoopStep(v, 6, 6);
    check("not achieved, iteration === cap → capped (stop)", atCap.kind === "capped");
    const overCap = goalLoopStep(v, 7, 6);
    check("not achieved, iteration > cap → capped (stop)", overCap.kind === "capped");
    // cap of 1: a single failed iteration already stops.
    check("cap of 1, not achieved → capped after one try", goalLoopStep(v, 1, 1).kind === "capped");
}

/* 4. The blind verdict parser is conservative — doubt is NOT a pass. */
{
    check("default cap is sensible (>=1)", DEFAULT_GOAL_LOOP_CAP >= 1);
    check(
        "parses a clean achieved verdict",
        parseVerdict('{"achieved":true,"reason":"visible"}').achieved === true,
    );
    const notDone = parseVerdict('{"achieved":false,"reason":"empty","whatsMissing":"open the file"}');
    check("parses a not-achieved verdict with gap", notDone.achieved === false && notDone.whatsMissing === "open the file");
    check("non-JSON reply → NOT achieved", parseVerdict("looks good to me!").achieved === false);
    check("empty reply → NOT achieved", parseVerdict("").achieved === false);
    check("achieved omitted → NOT achieved", parseVerdict('{"reason":"maybe"}').achieved === false);
    check("achieved as a string 'true' → NOT achieved (strict)", parseVerdict('{"achieved":"true"}').achieved === false);
    // JSON embedded in prose is still extracted.
    check(
        "extracts JSON embedded in prose",
        parseVerdict('Here is my verdict: {"achieved":true,"reason":"done"} ok').achieved === true,
    );
}

/* 5. /pursue argument parsing: optional leading cap, else whole string is the goal. */
{
    check("/pursue with cap", (() => { const r = parsePursueArg("3 open notepad"); return r.cap === 3 && r.goal === "open notepad"; })());
    check("/pursue without cap", (() => { const r = parsePursueArg("open notepad and type hi"); return r.cap === undefined && r.goal === "open notepad and type hi"; })());
    check("/pursue trims whitespace", parsePursueArg("   tidy the desktop   ").goal === "tidy the desktop");
}

/* 6. An end-to-end DECISION trace: simulate a loop using only the pure step. */
{
    const cap = 3;
    const verdicts: GoalVerdict[] = [
        { achieved: false, reason: "empty", whatsMissing: "step A" },
        { achieved: false, reason: "partial", whatsMissing: "step B" },
        { achieved: true, reason: "complete" },
    ];
    let stoppedAt = -1;
    let reason = "";
    for (let i = 1; i <= cap; i++) {
        const d = goalLoopStep(verdicts[i - 1]!, i, cap);
        if (d.kind === "done") { stoppedAt = i; reason = "done"; break; }
        if (d.kind === "capped") { stoppedAt = i; reason = "capped"; break; }
    }
    check("traced loop stops on the achieved iteration (3)", stoppedAt === 3 && reason === "done");
}

/* 7. A loop that never achieves stops exactly at the cap. */
{
    const cap = 4;
    const never: GoalVerdict = { achieved: false, reason: "no", whatsMissing: "x" };
    let stoppedAt = -1;
    for (let i = 1; i <= 100; i++) {
        const d = goalLoopStep(never, i, cap);
        if (d.kind !== "continue") { stoppedAt = i; break; }
    }
    check("never-achieved loop stops exactly at the cap (4)", stoppedAt === cap);
}

console.log(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
