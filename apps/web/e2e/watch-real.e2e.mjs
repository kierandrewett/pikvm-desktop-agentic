// One real smoke of the screen watch: the real image model and the real Jev, on the fake kvmd's frames. The web host is the real
// one; only the PiKVM (tools/fake-kvmd) and the push service (tools/fake-push) are fakes. The OpenRouter key is read from the
// environment (GNOBLIN_OPENROUTER_API_KEY; load it with `set -a; . ~/.env; set +a`) and goes into Settings, Providers the way a
// person's would; it is never printed.
//
//   node apps/web/e2e/watch-real.e2e.mjs
//
// Records the model ids, Jev's answers (the probabilities), each check's cost as OpenRouter reported it, and what was pushed, in
// the "real model" section of docs/e2e/<date>-screen-watch.md. Costs well under a cent.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drawFrames, sleep, startWatchStack, until } from "./watch-stack.mjs";

const key = process.env.GNOBLIN_OPENROUTER_API_KEY;
if (!key) {
    console.error("GNOBLIN_OPENROUTER_API_KEY is not set (set -a; . ~/.env; set +a)");
    process.exit(2);
}
const RULE = "tell me when the install finishes or an error shows";
const today = new Date().toISOString().slice(0, 10);
const frames = await drawFrames();
const stack = await startWatchStack({
    openrouter: "real",
    ports: { web: 18291, kvmd: 14711, push: 14721 },
    env: { PIKVM_WATCH_MIN_GAP_SEC: "5", PIKVM_WATCH_SETTLE_MS: "3000", PIKVM_WATCH_DAILY_CAP: "20" },
});

const rows = [];
let failed = false;
try {
    await stack.setProvider(key, "https://openrouter.ai/api/v1");
    const device = await stack.pushSubscribe();
    const sub = await fetch(`${stack.web}/app/api/v1/watch/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-host": "kvm.example.org", "x-forwarded-proto": "https" },
        body: JSON.stringify({ subscription: { endpoint: device.endpoint, keys: device.keys } }),
    });
    if (!sub.ok) throw new Error(`subscribing the fake device: ${sub.status}`);

    await stack.show(frames.installing);
    const on = await stack.patchWatch({ enabled: true, rule: RULE });
    const view = await on.json();
    if (!on.ok) throw new Error(`switching on: ${on.status} ${JSON.stringify(view)}`);
    const snapshots = await stack.snapshots();
    await until(async () => (await stack.snapshots()) >= snapshots + 3, "three looks at the starting screen", 20000);

    const steps = [
        { name: "install fails: a dialog opens over the terminal", frame: frames.failed, expect: "yes" },
        { name: "the dialog changes to 'Installation complete'", frame: frames.done, expect: "yes" },
        { name: "the terminal is back at 68%, nothing to report", frame: frames.installing, expect: "no" },
    ];
    for (const [i, step] of steps.entries()) {
        await stack.show(step.frame);
        await until(async () => (await stack.checks()).length >= i + 1, `check ${i + 1} is logged`, 120000, 1000);
        await sleep(1000);
        const line = (await stack.checks()).sort((a, b) => a.t - b.t)[i];
        const pushes = (await stack.pushReceived()).length;
        const pass = line.outcome !== "error" && line.noul !== undefined && (step.expect === "yes" ? line.noul >= 0.85 : line.noul <= 0.15);
        if (!pass) failed = true;
        rows.push({ ...step, line, pushes, pass });
        console.log(`${pass ? "PASS" : "FAIL"} ${step.name}: noul=${line.noul} outcome=${line.outcome} cost=$${line.costUsd} pushes=${pushes}`);
    }
    const pushed = await stack.pushReceived();
    const all = await stack.checks();
    const total = all.reduce((sum, line) => sum + (line.costUsd ?? 0), 0);

    const view2 = await stack.watch();
    const md = [
        "<!-- real:start -->",
        "## Real smoke: the real image model and the real Jev",
        "",
        `Script: \`apps/web/e2e/watch-real.e2e.mjs\`. The host is the real web host; the PiKVM is \`tools/fake-kvmd\` serving two frames drawn with sharp (a terminal installing a package, and the same with a dialog over it), the key is the one in \`~/.env\` (\`GNOBLIN_OPENROUTER_API_KEY\`), stored through Settings, Providers. Image model: **${rows[0].line.model}** (the default; \`${view2.defaultVisionModel}\`). Decision model: **typesafe/jev-1.14** at \`https://openrouter.ai/api/alpha/decisions\`. Rule: "${RULE}". Pace: look every 2 s, settle 3 s, one check per 5 s.`,
        "",
        "| Step | Expected | Jev's probability (noul) | Outcome | Cost (OpenRouter) | Asked |",
        "| --- | --- | --- | --- | --- | --- |",
        ...rows.map((r) => `| ${r.name} | ${r.expect} (>= 0.85 / <= 0.15) | ${r.line.noul} | ${r.line.outcome}${r.line.reason ? ` (${r.line.reason})` : ""} | $${r.line.costUsd ?? "n/a"} | ${r.line.asked} |`),
        "",
        `Total reported by OpenRouter for ${all.length} checks: **$${total.toFixed(6)}**. Pushes the fake device decrypted: ${pushed.length}.`,
        "",
        "What the models said, check by check:",
        "",
        ...rows.flatMap((r, i) => [
            `${i + 1}. **${r.name}**`,
            `   - previous: ${r.line.previous}`,
            `   - current: ${r.line.description}`,
            `   - diff score ${(r.line.score * 100).toFixed(1)}% of cells; Jev ${r.line.noul}; ${r.line.outcome}`,
        ]),
        "",
        "The notifications' bodies, as the fake device decrypted them:",
        "",
        ...pushed.map((p) => `- \`${JSON.stringify(p.payload)}\``),
        "",
        `${rows.filter((r) => r.pass).length} of ${rows.length} steps as expected.`,
        "<!-- real:end -->",
    ].join("\n");

    const file = join("docs/e2e", `${today}-screen-watch.md`);
    mkdirSync("docs/e2e", { recursive: true });
    const existing = existsSync(file) ? readFileSync(file, "utf8") : `# E2E run: the screen watch (${today})\n\n`;
    const next = /<!-- real:start -->[\s\S]*<!-- real:end -->/.test(existing) ? existing.replace(/<!-- real:start -->[\s\S]*<!-- real:end -->/, () => md) : `${existing.trimEnd()}\n\n${md}\n`;
    writeFileSync(file, next);
} catch (error) {
    console.error(`FAIL ${error.message}`);
    failed = true;
} finally {
    await stack.stop();
}
process.exit(failed ? 1 : 0);
