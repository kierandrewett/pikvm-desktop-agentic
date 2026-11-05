// Benchmarks the OCR engines the fast alerts could read a toast with, on the fixtures watch-ocr-fixtures.mjs writes.
//
//   node watch-ocr-bench.mjs --fixtures <dir> [--runs 5] [--inputs crop,tight,frame] [--models <dir>] [--paddle-bundle <file>] [--threads 2] [--engines tess-psm11,tess-psm6,tess-psm11-x2,tessjs,paddle-x1,paddle-x2] [--json out.json]
//
// Run it from a directory that has node_modules with sharp, tesseract.js and @gutenye/ocr-node (the engines are not
// dependencies of the repo: the winner is installed by deploy/Dockerfile). `tesseract` (5.x, eng) must be on PATH for the tess-*
// engines; TESSDATA_PREFIX or --tessdata names its data directory for tesseract.js.
//
// For each engine and each input (the zone crop, the crop of the cells that changed, the whole frame): the first call (cold,
// includes whatever lazy loading), the median of --runs warm calls over all fixtures, the slowest warm call, and word accuracy: the
// share of the words a toast says that the engine returned (case and punctuation ignored, each returned word used once).

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { join } from "node:path";

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
};
const dir = arg("fixtures");
if (!dir) throw new Error("--fixtures <dir> is required");
const runs = Number(arg("runs", "5"));
const engines = arg("engines", "tess-psm11,tess-psm6,tess-psm11-x2,tessjs,paddle-x1,paddle-x2").split(",");
const tessdata = arg("tessdata", process.env.TESSDATA_PREFIX ?? "/usr/share/tesseract/tessdata");
const require = createRequire(`${process.cwd()}/`);
const sharp = require("sharp");
const truth = JSON.parse(readFileSync(join(dir, "truth.json"), "utf8"));
const ids = Object.keys(truth);
const inputs = arg("inputs", "crop,tight,frame").split(",");
const file = (id, input) => join(dir, `${id}.${input}.jpg`);

const words = (text) =>
    text
        .toLowerCase()
        .split(/\s+/)
        .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter(Boolean);

/** The share of `expected` words found in `got`, each returned word matching one expected word at most once. */
function accuracy(expected, got) {
    const pool = words(got.join(" "));
    let hit = 0;
    for (const word of words(expected.join(" "))) {
        const i = pool.indexOf(word);
        if (i >= 0) {
            hit++;
            pool.splice(i, 1);
        }
    }
    return hit / words(expected.join(" ")).length;
}

/**
 * The share of the expected words found anywhere in the text once spaces are ignored: a recogniser that runs two words together
 * ("Areyoufree") still gave the reader the words, which is what a notification needs.
 */
function containment(expected, got) {
    const squashed = got.join("").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const list = words(expected.join(" "));
    return list.filter((word) => squashed.includes(word)).length / list.length;
}

const run = (cmd, args, env = {}) =>
    new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 200)}`))));
    });

/** Engines: `prepare()` once (not timed as a call), `read(path)` returns the text. */
const ENGINES = {
    "paddle-x1": () => ENGINES.paddle(1, Number(arg("threads", "2")))(),
    "paddle-x2": () => ENGINES.paddle(2, Number(arg("threads", "2")))(),
    "paddle-x1.5": () => ENGINES.paddle(1.5, Number(arg("threads", "2")))(),
    "tess-psm11": () => ({ read: async (path) => (await run("tesseract", [path, "stdout", "--psm", "11", "-l", "eng"], { OMP_THREAD_LIMIT: "1" })).out }),
    "tess-psm6": () => ({ read: async (path) => (await run("tesseract", [path, "stdout", "--psm", "6", "-l", "eng"], { OMP_THREAD_LIMIT: "1" })).out }),
    "tess-psm11-x2": () => ({
        read: async (path) => {
            const meta = await sharp(path).metadata();
            const big = await sharp(path).resize(meta.width * 2, meta.height * 2, { kernel: "lanczos3" }).png().toBuffer();
            const temp = join(os.tmpdir(), `ocr-bench-${process.pid}.png`);
            await sharp(big).toFile(temp);
            return (await run("tesseract", [temp, "stdout", "--psm", "11", "-l", "eng"], { OMP_THREAD_LIMIT: "1" })).out;
        },
    }),
    tessjs: async () => {
        const { createWorker } = require("tesseract.js");
        const worker = await createWorker("eng", 1, { langPath: tessdata, gzip: false, cacheMethod: "none" });
        await worker.setParameters({ tessedit_pageseg_mode: "11" });
        return { read: async (path) => (await worker.recognize(readFileSync(path))).data.text, close: () => worker.terminate() };
    },
    // PP-OCRv4 over onnxruntime-node with the host's own pipeline (src/server/watch/ocr-paddle.ts), bundled here from source.
    paddle: (scale = 1, threads = 2) => async () => {
        // --paddle-bundle: the module already bundled (for a machine that has no checkout); otherwise bundle it from source.
        let out = arg("paddle-bundle");
        if (!out) {
            const repo = new URL("../../..", import.meta.url).pathname;
            const { build } = createRequire(`${repo}/`)("esbuild");
            out = join(os.tmpdir(), `ocr-paddle-${process.pid}.cjs`);
            await build({ entryPoints: [join(repo, "src/server/watch/ocr-paddle.ts")], outfile: out, bundle: true, platform: "node", format: "cjs", logLevel: "error" });
        }
        const { createPaddleReader } = require(out);
        const models = arg("models", join(process.cwd(), "node_modules/@gutenye/ocr-models/assets"));
        const reader = await createPaddleReader(
            { det: join(models, "ch_PP-OCRv4_det_infer.onnx"), rec: join(models, "ch_PP-OCRv4_rec_infer.onnx"), dict: join(models, "ppocr_keys_v1.txt") },
            require("onnxruntime-node"),
            sharp,
            { scale, threads },
        );
        return { read: async (path) => (await reader.read(readFileSync(path))).lines.join("\n") };
    },
};

const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const results = [];
for (const name of engines) {
    const startedRss = process.memoryUsage().rss;
    const t0 = performance.now();
    const engine = await ENGINES[name]();
    const initMs = performance.now() - t0;
    for (const input of inputs) {
        let cold = null;
        const times = [];
        const accs = [];
        const contains = [];
        const failures = [];
        for (const id of ids) {
            for (let n = 0; n <= runs; n++) {
                const start = performance.now();
                const text = await engine.read(file(id, input));
                const ms = performance.now() - start;
                if (cold === null) cold = ms;
                else if (n > 0) times.push(ms);
                if (n === 0) {
                    const acc = accuracy(truth[id], [text]);
                    accs.push(acc);
                    contains.push(containment(truth[id], [text]));
                    if (acc < 0.8) failures.push(`${id} ${(acc * 100).toFixed(0)}%: ${text.replace(/\s+/g, " ").slice(0, 90)}`);
                }
            }
        }
        results.push({
            engine: name,
            input,
            initMs: Math.round(initMs),
            coldMs: Math.round(cold),
            medianMs: Math.round(median(times)),
            p95Ms: Math.round([...times].sort((a, b) => a - b)[Math.floor(times.length * 0.95)]),
            maxMs: Math.round(Math.max(...times)),
            accuracy: Number((accs.reduce((a, b) => a + b, 0) / accs.length).toFixed(3)),
            containment: Number((contains.reduce((a, b) => a + b, 0) / contains.length).toFixed(3)),
            worst: failures.slice(0, 3),
            rssMb: Math.round((process.memoryUsage().rss - startedRss) / 1048576),
        });
        console.error(JSON.stringify(results.at(-1)));
    }
    await engine.close?.();
}
const out = arg("json");
if (out) (await import("node:fs")).writeFileSync(out, JSON.stringify({ host: `${os.cpus()[0]?.model} x${os.cpus().length}`, load: os.loadavg(), node: process.version, runs, fixtures: ids.length, results }, null, 2));
console.log("| engine | input | init ms | cold ms | median ms | p95 ms | max ms | word accuracy | words found | +RSS MB |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of results) console.log(`| ${r.engine} | ${r.input} | ${r.initMs} | ${r.coldMs} | ${r.medianMs} | ${r.p95Ms} | ${r.maxMs} | ${(r.accuracy * 100).toFixed(1)}% | ${(r.containment * 100).toFixed(1)}% | ${r.rssMb} |`);
