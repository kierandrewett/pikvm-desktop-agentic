// Smoke test for the per-turn model router (src/agent/model-router.ts). Pure
// logic, no Electron — exercises the routing decision across reasoning turns,
// routine tool-call turns, errors, and the unknown/safe-default case.
//   esbuild scripts/model-router-test.ts --bundle --platform=node --format=cjs \
//     --outfile=dist/model-router-test.cjs --alias:electron=./scripts/electron-stub.cjs \
//     && node dist/model-router-test.cjs

import { decideModelTier, DEFAULT_ROUTER_THRESHOLDS, type TurnSummary } from "../src/agent/model-router";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
    if (cond) {
        console.log(`  ok   ${name}`);
    } else {
        failed++;
        console.log(`  FAIL ${name}`, extra ?? "");
    }
}

/** Build a TurnSummary, defaulting to a routine tool-call turn. */
function turn(over: Partial<TurnSummary> = {}): TurnSummary {
    return { isStart: false, hadError: false, assistantTextLength: 0, hadThinking: false, toolCallCount: 1, ...over };
}

// 1. Reasoning turns → big model -----------------------------------------
{
    check("substantial reasoning text → reasoning", decideModelTier(turn({ assistantTextLength: 400 })) === "reasoning");
    check("explicit thinking → reasoning", decideModelTier(turn({ hadThinking: true })) === "reasoning");
    // Even mid-plan: if the model thought out loud this turn, escalate next turn.
    check("thinking + a tool call → reasoning", decideModelTier(turn({ hadThinking: true, toolCallCount: 1 })) === "reasoning");
}

// 2. Routine tool-call turns → fast model --------------------------------
{
    check("plain tool call, no prose → fast", decideModelTier(turn({ toolCallCount: 1 })) === "fast");
    check("short narration + tool call → fast", decideModelTier(turn({ assistantTextLength: 20, toolCallCount: 2 })) === "fast");
    // Text just under the threshold is still "driving", not reasoning.
    check(
        "text just under threshold + tool call → fast",
        decideModelTier(turn({ assistantTextLength: DEFAULT_ROUTER_THRESHOLDS.reasoningTextChars - 1, toolCallCount: 1 })) === "fast",
    );
}

// 3. Errors → big model (recovery wants the cleverer model) ---------------
{
    check("error on a tool-call turn → reasoning", decideModelTier(turn({ hadError: true, toolCallCount: 1 })) === "reasoning");
    check("error with no tools → reasoning", decideModelTier(turn({ hadError: true, toolCallCount: 0 })) === "reasoning");
}

// 4. Unknown / start → safe default (big) --------------------------------
{
    check("start of run → reasoning (safe default)", decideModelTier(turn({ isStart: true })) === "reasoning");
    // Ambiguous: no tools, no real text — don't silently downgrade.
    check("no tools + no text → reasoning (safe default)", decideModelTier(turn({ toolCallCount: 0, assistantTextLength: 0 })) === "reasoning");
}

// 5. Threshold boundary --------------------------------------------------
{
    check(
        "text exactly at threshold → reasoning",
        decideModelTier(turn({ assistantTextLength: DEFAULT_ROUTER_THRESHOLDS.reasoningTextChars, toolCallCount: 1 })) === "reasoning",
    );
}

function main(): void {
    console.log("model-router smoke test");
    if (failed) {
        console.error(`\n${failed} check(s) FAILED`);
        process.exit(1);
    }
    console.log("\nall checks passed");
}

main();
