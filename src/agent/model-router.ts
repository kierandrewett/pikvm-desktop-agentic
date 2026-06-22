/**
 * Dynamic per-turn model router.
 *
 * The agent loop drives a remote PC: most turns are cheap, mechanical
 * tool-calling (screenshot → click → type → screenshot again), but a few are
 * genuine reasoning — starting a task, recovering from an error, or working out
 * a plan. Paying for the big reasoning model on every routine click is wasteful
 * in both cost and latency, so we pick the model PER TURN: a capable model for
 * the thinking, a fast/cheap one for the mechanical driving.
 *
 * This module holds the DECISION only — a pure, side-effect-free function that
 * looks at a small summary of the turn that just finished and returns which
 * "tier" the NEXT turn should run on. The runner maps the tier to a concrete
 * model id (configurable in Settings) and feeds it to the loop via
 * `prepareNextTurn`. Keeping the decision pure makes it trivially unit-testable
 * (see `scripts/model-router-test.ts`).
 *
 * Heuristic, in priority order (transparent and easily tuned below):
 *   1. We don't know what the turn was (start of run, or no signal) → reasoning.
 *      Safe default: never silently downgrade a turn we can't classify.
 *   2. The previous turn errored (a tool failed, the model got stuck) → reasoning.
 *      Recovering from a problem is exactly when the cleverer model earns its keep.
 *   3. The model produced substantial free-form text / reasoning → reasoning.
 *      It's explaining, planning or problem-solving, not just driving.
 *   4. A straightforward continue-the-plan tool call with little/no prose
 *      (the click/type/screenshot loop) → fast.
 *
 * Because the underlying loop keeps using whichever model we last handed it, the
 * runner asks the router on EVERY turn and always passes a concrete tier back —
 * so a turn can escalate to reasoning and de-escalate to fast again freely.
 */

/** Which model tier the next turn should run on. */
export type ModelTier = "reasoning" | "fast";

/**
 * A compact, framework-agnostic summary of the turn that just completed. The
 * runner derives this from the agent transcript; the router never touches the
 * framework types, which keeps it pure and testable.
 */
export interface TurnSummary {
    /**
     * True at the very start of a run — there is no completed assistant turn to
     * classify yet. Also use this whenever the turn can't be summarised.
     */
    isStart: boolean;
    /** The just-finished turn ended in an error (a tool failed, or the model errored). */
    hadError: boolean;
    /**
     * Number of plain assistant text characters produced this turn (reasoning,
     * explanation, narration) — NOT counting tool-call arguments. A high count
     * signals the model was thinking out loud rather than just driving.
     */
    assistantTextLength: number;
    /** The model emitted explicit thinking/reasoning content this turn. */
    hadThinking: boolean;
    /** Number of tool calls the just-finished turn requested. */
    toolCallCount: number;
}

/**
 * Tunable thresholds for the heuristic. Exposed so they can be adjusted (or
 * overridden in tests) without touching the decision logic.
 */
export interface RouterThresholds {
    /**
     * Assistant free-text at or above this many characters counts as
     * "substantial reasoning", forcing the reasoning tier. Routine tool turns
     * usually emit little or no prose ("Clicking the menu.", or nothing at all),
     * so this is deliberately low-ish but above one-liners.
     */
    reasoningTextChars: number;
}

export const DEFAULT_ROUTER_THRESHOLDS: RouterThresholds = {
    reasoningTextChars: 160,
};

/**
 * Decide which model tier the NEXT turn should run on, given a summary of the
 * turn that just finished. Pure: same input → same output, no side effects.
 */
export function decideModelTier(
    summary: TurnSummary,
    thresholds: RouterThresholds = DEFAULT_ROUTER_THRESHOLDS,
): ModelTier {
    // 1. Unknown / start of run → safe default is the capable model.
    if (summary.isStart) return "reasoning";
    // 2. Recovering from an error wants the cleverer model.
    if (summary.hadError) return "reasoning";
    // 3. The model was thinking/explaining, not just driving.
    if (summary.hadThinking) return "reasoning";
    if (summary.assistantTextLength >= thresholds.reasoningTextChars) return "reasoning";
    // 4. A plain continue-the-plan tool call → fast/cheap path.
    if (summary.toolCallCount > 0) return "fast";
    // No tool calls and little text: ambiguous → stay on the safe (reasoning) tier.
    return "reasoning";
}
