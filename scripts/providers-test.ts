// Smoke test for the pure multi-provider model-spec core (src/agent/providers.ts).
// No Electron, no pi-ai runtime — exercises `provider/model` parsing, the
// default fallbacks, the unknown-provider → safe-default path, and the
// text-only fast-tier vision guard.
//   esbuild scripts/providers-test.ts --bundle --platform=node --format=cjs \
//     --outfile=dist/providers-test.cjs --alias:electron=./scripts/electron-stub.cjs \
//     && node dist/providers-test.cjs

import {
    parseModelSpec,
    parseSpecOrDefault,
    formatSpec,
    guardFastTier,
    getProviderInfo,
    getProviderInfoByPi,
    DEFAULT_REASONING_SPEC,
    DEFAULT_FAST_SPEC,
} from "../src/agent/providers";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
    if (cond) {
        console.log(`  ok   ${name}`);
    } else {
        failed++;
        console.log(`  FAIL ${name}`, extra ?? "");
    }
}

// 1. Parsing valid specs --------------------------------------------------
{
    const codex = parseModelSpec("codex/gpt-5.5");
    check("codex/gpt-5.5 → provider codex", codex?.provider === "codex", codex);
    check("codex/gpt-5.5 → pi provider openai-codex", codex?.piProvider === "openai-codex", codex);
    check("codex/gpt-5.5 → model gpt-5.5", codex?.model === "gpt-5.5", codex);

    const kimi = parseModelSpec("moonshotai/kimi-k2.6");
    check("moonshotai/kimi-k2.6 parses", kimi?.provider === "moonshotai" && kimi?.model === "kimi-k2.6", kimi);

    // OpenRouter ids carry extra slashes — only the FIRST slash splits.
    const or = parseModelSpec("openrouter/moonshotai/kimi-k2.6");
    check("openrouter keeps nested slashes in model", or?.provider === "openrouter" && or?.model === "moonshotai/kimi-k2.6", or);

    check("opencode/kimi-k2.6 parses (brief example)", parseModelSpec("opencode/kimi-k2.6")?.model === "kimi-k2.6");
}

// 2. Malformed / unknown specs → undefined --------------------------------
{
    check("empty string → undefined", parseModelSpec("") === undefined);
    check("no slash → undefined", parseModelSpec("gpt-5.5") === undefined);
    check("leading slash → undefined", parseModelSpec("/gpt-5.5") === undefined);
    check("trailing slash → undefined", parseModelSpec("codex/") === undefined);
    check("unknown provider → undefined", parseModelSpec("nope/whatever") === undefined);
    check("null → undefined", parseModelSpec(null) === undefined);
    check("undefined → undefined", parseModelSpec(undefined) === undefined);
}

// 3. parseSpecOrDefault: always resolves to something valid ---------------
{
    check("valid spec passes through", formatSpec(parseSpecOrDefault("moonshotai/kimi-k2.6", DEFAULT_FAST_SPEC)) === "moonshotai/kimi-k2.6");
    check("unknown provider → default fallback", formatSpec(parseSpecOrDefault("ghost/x", DEFAULT_FAST_SPEC)) === DEFAULT_FAST_SPEC);
    check("missing value → default fallback", formatSpec(parseSpecOrDefault(undefined, DEFAULT_REASONING_SPEC)) === DEFAULT_REASONING_SPEC);
    // Even a broken fallback can't strand us — falls back to the built-in reasoning default.
    check("broken value AND broken fallback → built-in default", formatSpec(parseSpecOrDefault("x", "also-bad")) === DEFAULT_REASONING_SPEC);
}

// 4. formatSpec round-trips -----------------------------------------------
{
    const spec = parseModelSpec("openrouter/moonshotai/kimi-k2.6")!;
    check("formatSpec round-trips nested ids", formatSpec(spec) === "openrouter/moonshotai/kimi-k2.6");
}

// 5. Provider lookups -----------------------------------------------------
{
    check("getProviderInfo(codex) is oauth", getProviderInfo("codex")?.kind === "oauth");
    check("getProviderInfo(moonshotai) is apiKey", getProviderInfo("moonshotai")?.kind === "apiKey");
    check("moonshotai uses MOONSHOT_API_KEY", getProviderInfo("moonshotai")?.envVar === "MOONSHOT_API_KEY");
    check("opencode uses OPENCODE_API_KEY", getProviderInfo("opencode")?.envVar === "OPENCODE_API_KEY");
    check("reverse lookup openai-codex → codex", getProviderInfoByPi("openai-codex")?.id === "codex");
    check("unknown provider id → undefined", getProviderInfo("ghost") === undefined);
}

// 6. Fast-tier vision guard -----------------------------------------------
{
    const reasoning = parseModelSpec(DEFAULT_REASONING_SPEC)!;
    const kimi = parseModelSpec("moonshotai/kimi-k2.6")!;
    const textOnly = parseModelSpec("deepseek/deepseek-chat" as any) ?? kimi; // deepseek isn't registered here; fall back to a known spec for shape

    // Vision-capable fast model → accepted, no warning.
    {
        const r = guardFastTier(kimi, { vision: true }, reasoning, true);
        check("vision fast model accepted", formatSpec(r.spec) === "moonshotai/kimi-k2.6" && r.warning === null, r);
    }
    // Text-only fast model + vision needed → swapped for reasoning, warns.
    {
        const r = guardFastTier(kimi, { vision: false }, reasoning, true);
        check("text-only fast model rejected → reasoning", formatSpec(r.spec) === DEFAULT_REASONING_SPEC, r);
        check("text-only fast model warns", typeof r.warning === "string" && r.warning!.includes("text-only"), r);
    }
    // Unknown caps + vision needed → also falls back (don't risk images on text-only).
    {
        const r = guardFastTier(kimi, undefined, reasoning, true);
        check("unknown caps + vision needed → reasoning", formatSpec(r.spec) === DEFAULT_REASONING_SPEC && r.warning !== null, r);
    }
    // Vision NOT needed → keep whatever was requested, no warning.
    {
        const r = guardFastTier(kimi, { vision: false }, reasoning, false);
        check("vision not needed → keep requested", formatSpec(r.spec) === "moonshotai/kimi-k2.6" && r.warning === null, r);
    }
    void textOnly;
}

console.log(failed === 0 ? "\nproviders-test: PASS" : `\nproviders-test: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
