// Smoke test for the screen-settle gate (src/ambient/fingerprint.ts). Pure logic:
// the K-consecutive-stable debounce + timeout, with an injected clock/sleep and a
// scripted fingerprint sequence. No timers, no Electron, no Pi.
//   esbuild scripts/settle-test.ts --bundle --platform=node --format=cjs \
//     --outfile=dist/settle-test.cjs && node dist/settle-test.cjs

import { awaitSettled, fpDiff } from "../src/ambient/fingerprint";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
    if (cond) console.log(`  ok   ${name}`);
    else {
        failed++;
        console.log(`  FAIL ${name}`, extra ?? "");
    }
}

// Two visibly-different 16-px fingerprints; diff(A,A)=0 (<settle), diff(A,B) large.
const A = new Uint8Array(16).fill(0);
const B = new Uint8Array(16).fill(255);

/** A fake clock + sleep that advances deterministically (no real timers). */
function fakeTime() {
    let t = 0;
    return { now: () => t, sleep: (ms: number) => ((t += ms), Promise.resolve()) };
}
/** Drive awaitSettled over a scripted sequence of frames (one per poll). */
function run(seq: (Uint8Array | null)[], opts: { k?: number; timeoutMs?: number } = {}) {
    const ft = fakeTime();
    let i = 0;
    const capture = () => Promise.resolve(i < seq.length ? seq[i++]! : seq[seq.length - 1] ?? null);
    return awaitSettled(capture, { pollMs: 100, k: opts.k ?? 2, timeoutMs: opts.timeoutMs ?? 1000, now: ft.now, sleep: ft.sleep });
}

async function main(): Promise<void> {
    console.log("settle smoke test");

    check("fpDiff: identical → 0", fpDiff(A, A) === 0);
    check("fpDiff: opposite → 1", fpDiff(A, B) === 1);

    // Two consecutive stable frames after motion ⇒ ready.
    {
        const r = await run([A, B, B, B]); // prev=A; B(move), B(stable1), B(stable2) → ready
        check("settle: ready after K=2 consecutive stable", r.ready && !r.stillAnimating, r);
    }
    // A SINGLE stable frame is not enough — the debounce must require K in a row.
    {
        // prev=A; B(move,reset), B(stable1), A(move,reset), B(stable1), B(stable2)→ready
        const r = await run([A, B, B, A, B, B]);
        check("settle: a lone stable frame does not declare ready early", r.ready, r);
        check("settle: waited past the first stable frame", r.waitedMs >= 300, r);
    }
    // A perpetually-animating screen times out as stillAnimating (never hangs).
    {
        const flip: Uint8Array[] = [];
        for (let i = 0; i < 50; i++) flip.push(i % 2 ? B : A);
        const r = await run(flip, { timeoutMs: 500 });
        check("settle: animating screen → stillAnimating at timeout", !r.ready && r.stillAnimating, r);
    }
    // No fingerprint source ⇒ ready immediately (graceful degrade).
    {
        const r = await awaitSettled(() => Promise.resolve(null));
        check("settle: no fingerprint source → ready immediately", r.ready && r.waitedMs === 0, r);
    }

    if (failed) {
        console.error(`\n${failed} check(s) FAILED`);
        process.exit(1);
    }
    console.log("\nall checks passed");
}

void main();
