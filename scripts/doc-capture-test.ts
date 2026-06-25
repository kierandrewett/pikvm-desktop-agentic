// Smoke test for the document-capture wrapper (src/doc-capture.ts). Pure logic +
// the orchestrator driven with a fake process runner and fake fs — no Python, no Pi.
//   esbuild scripts/doc-capture-test.ts --bundle --platform=node --format=cjs \
//     --outfile=dist/doc-capture-test.cjs && node dist/doc-capture-test.cjs

import { buildCaptureArgs, runDocCapture, type DocCaptureConfig, type DocCaptureRunDeps } from "../src/doc-capture";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
    if (cond) console.log(`  ok   ${name}`);
    else {
        failed++;
        console.log(`  FAIL ${name}`, extra ?? "");
    }
}

const base: DocCaptureConfig = { python: "python3", script: "/app/doc-capture/capture.py", host: "pikvm", scheme: "https", user: "admin", password: "pw", outDir: "/out/cap-1" };

console.log("doc-capture smoke test");

// buildCaptureArgs ---------------------------------------------------------
{
    const a = buildCaptureArgs(base);
    check("args: script first", a[0] === "/app/doc-capture/capture.py");
    check("args: scan + no-confirm + keep-intermediates", a.includes("--mode") && a.includes("scan") && a.includes("--no-confirm") && a.includes("--keep-intermediates"));
    check("args: host + out", a.includes("--host") && a.includes("pikvm") && a.includes("--out") && a.includes("/out/cap-1"));
    check("args: https → no --http, --pdf on", !a.includes("--http") && a.includes("--pdf"));
    check("args: creds passed", a.includes("--user") && a.includes("admin") && a.includes("--password") && a.includes("pw"));
    const h = buildCaptureArgs({ ...base, scheme: "http", pdf: false, mode: "paged" });
    check("args: http → --http; pdf:false → --no-pdf; mode paged", h.includes("--http") && h.includes("--no-pdf") && h.includes("paged") && !h.includes("--pdf"));
}

// Fake deps builder --------------------------------------------------------
function fakeDeps(over: Partial<DocCaptureRunDeps> & { proc?: { code?: number | null; timedOut?: boolean; tail?: string }; files?: string[]; transcript?: string | null } = {}): { deps: DocCaptureRunDeps; events: string[] } {
    const events: string[] = [];
    const deps: DocCaptureRunDeps = {
        runProcess: async (_cmd, _args, opts) => {
            events.push("run");
            opts.onLine?.("  [001] +375px");
            return { code: over.proc?.code ?? 0, timedOut: over.proc?.timedOut ?? false, tail: over.proc?.tail ?? "" };
        },
        readFile: async () => (over.transcript !== undefined ? over.transcript : "--- page 1 ---\nHello doc\n"),
        listFiles: async () => over.files ?? ["page_001.png", "page_002.png", "Classification OFFICIAL.pdf", "all.txt"],
        join: (...p) => p.join("/"),
        pauseInput: () => events.push("pause"),
        resumeInput: () => events.push("resume"),
        onProgress: (l) => events.push("progress:" + l.trim()),
        ...over,
    };
    return { deps, events };
}

async function main(): Promise<void> {
    // Missing creds → clean error, never spawns.
    {
        const { deps, events } = fakeDeps();
        const res = await runDocCapture({ ...base, user: undefined, password: undefined }, deps);
        check("no creds → ok:false with a credentials error", !res.ok && /credential/i.test(res.error ?? ""), res);
        check("no creds → did not run the process", !events.includes("run"));
    }

    // Happy path → transcript + pdf (not page_NNN.pdf) + page count; pause/resume bracket the run.
    {
        const { deps, events } = fakeDeps();
        const res = await runDocCapture(base, deps);
        check("happy: ok + transcript", res.ok && (res.transcript ?? "").includes("Hello doc"), res);
        check("happy: pdfPath is the title pdf", res.pdfPath === "/out/cap-1/Classification OFFICIAL.pdf", res.pdfPath);
        check("happy: pageCount from page PNGs", res.pageCount === 2, res.pageCount);
        check("happy: paused before + resumed after the run", events.indexOf("pause") < events.indexOf("run") && events.indexOf("run") < events.indexOf("resume"), events);
        check("happy: progress streamed", events.some((e) => e.startsWith("progress:")));
    }

    // pdf picker must skip per-page page_NNN.pdf intermediates.
    {
        const { deps } = fakeDeps({ files: ["page_001.png", "page_001.pdf", "Doc Title.pdf", "all.txt"] });
        const res = await runDocCapture(base, deps);
        check("pdf: skips page_NNN.pdf, picks the final title pdf", res.pdfPath === "/out/cap-1/Doc Title.pdf", res.pdfPath);
    }

    // Timeout + non-zero exit → ok:false, resume still runs.
    {
        const { deps, events } = fakeDeps({ proc: { timedOut: true, code: null } });
        const res = await runDocCapture(base, deps);
        check("timeout → ok:false 'timed out'", !res.ok && /timed out/i.test(res.error ?? ""), res);
        check("timeout → still resumed input", events.includes("resume"));
    }
    {
        const { deps } = fakeDeps({ proc: { code: 4, tail: "pypdf not installed" } });
        const res = await runDocCapture(base, deps);
        check("exit 4 → ok:false with the code + tail hint", !res.ok && res.error!.includes("4") && res.error!.includes("pypdf"), res);
    }

    // No transcript file (e.g. --no-pdf path failed OCR) → still ok, pageCount from PNGs.
    {
        const { deps } = fakeDeps({ transcript: null, files: ["page_001.png"] });
        const res = await runDocCapture(base, deps);
        check("no all.txt → ok, no transcript, pageCount from PNGs", res.ok && res.transcript === undefined && res.pageCount === 1, res);
    }

    if (failed) {
        console.error(`\n${failed} check(s) FAILED`);
        process.exit(1);
    }
    console.log("\nall checks passed");
}

void main();
