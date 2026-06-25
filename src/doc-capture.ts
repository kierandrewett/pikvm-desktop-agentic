/**
 * High-quality document capture — wrapper around the vendored Python "scanner"
 * (`tools/doc-capture/capture.py`, copied to `dist/doc-capture/` by the build).
 *
 * The script scrolls a document open on the PiKVM target top-to-bottom over the
 * video stream, registers frames with sub-pixel phase correlation, stitches them
 * into one tall image, splits it into pages and OCRs each — far sharper text +
 * figures than a single screenshot. We run it with `--no-confirm` (the agent does
 * the Word prep) and `--keep-intermediates` (so `all.txt` + page PNGs survive the
 * PDF cleanup), passing the LIVE PiKVM host/credentials, and return the transcript
 * + artifact paths for ingestion (e.g. into Atlas).
 *
 * The core is dependency-injected (process spawn + fs are passed in) so it's unit
 * testable; `createCaptureDocument` wires the real node child_process/fs for
 * main.ts / server-main.ts.
 */

import { spawn } from "node:child_process";
import { readFile as fsReadFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface DocCaptureConfig {
    /** Python interpreter (e.g. "python3" or a venv path). */
    python: string;
    /** Absolute path to the vendored capture.py. */
    script: string;
    /** PiKVM host (no scheme), e.g. "pikvm" or "10.0.0.5:8443". */
    host: string;
    scheme: "http" | "https";
    /** Basic-auth credentials — required (the snapshot endpoint can't use our cookie here). */
    user?: string;
    password?: string;
    /** Output directory (created by the caller). */
    outDir: string;
    mode?: "scan" | "paged";
    /** Build a searchable PDF too (default true). */
    pdf?: boolean;
    timeoutMs?: number;
}

/** Build the capture.py argv. Always `--no-confirm` (agent did the prep) and
 *  `--keep-intermediates` (so all.txt + page images survive the PDF cleanup). */
export function buildCaptureArgs(cfg: DocCaptureConfig): string[] {
    const args = [cfg.script, "--mode", cfg.mode ?? "scan", "--no-confirm", "--keep-intermediates", "--host", cfg.host, "--out", cfg.outDir];
    if (cfg.scheme === "http") args.push("--http");
    args.push(cfg.pdf === false ? "--no-pdf" : "--pdf");
    if (cfg.user) args.push("--user", cfg.user);
    if (cfg.password) args.push("--password", cfg.password);
    return args;
}

export interface DocCaptureResult {
    ok: boolean;
    outDir: string;
    transcript?: string;
    pdfPath?: string;
    pageCount?: number;
    error?: string;
}

export interface DocCaptureRunDeps {
    /** Run the process to completion; line-buffer stdout/stderr to onLine; kill on timeout. */
    runProcess(
        command: string,
        args: string[],
        opts: { onLine?: (line: string) => void; timeoutMs?: number },
    ): Promise<{ code: number | null; timedOut: boolean; tail: string }>;
    readFile(path: string): Promise<string | null>;
    listFiles(dir: string): Promise<string[]>;
    join(...parts: string[]): string;
    pauseInput?(): void;
    resumeInput?(): void;
    onProgress?(line: string): void;
}

function tailHint(tail: string): string {
    const t = (tail || "")
        .trim()
        .split("\n")
        .slice(-3)
        .join(" ")
        .slice(0, 300);
    return t
        ? `Last output: ${t}`
        : "Check python3 + the deps in tools/doc-capture/requirements.txt and the tesseract binary are installed.";
}

/** Orchestrate one capture run. Pure of node APIs (all injected) so it can be tested. */
export async function runDocCapture(cfg: DocCaptureConfig, deps: DocCaptureRunDeps): Promise<DocCaptureResult> {
    if (!cfg.user || !cfg.password) {
        return {
            ok: false,
            outDir: cfg.outDir,
            error: "No PiKVM username/password available — document capture needs basic-auth credentials (the snapshot endpoint can't use a session cookie here). Set them in the PiKVM connection settings.",
        };
    }
    deps.pauseInput?.();
    try {
        const { code, timedOut, tail } = await deps.runProcess(cfg.python, buildCaptureArgs(cfg), {
            timeoutMs: cfg.timeoutMs ?? 15 * 60_000,
            ...(deps.onProgress ? { onLine: deps.onProgress } : {}),
        });
        if (timedOut) return { ok: false, outDir: cfg.outDir, error: `Capture timed out after ${Math.round((cfg.timeoutMs ?? 900_000) / 1000)}s.` };
        if (code !== 0) return { ok: false, outDir: cfg.outDir, error: `Capture tool exited with code ${code ?? "null"}. ${tailHint(tail)}` };

        const transcript = (await deps.readFile(deps.join(cfg.outDir, "all.txt"))) ?? undefined;
        const files = await deps.listFiles(cfg.outDir);
        // The final searchable PDF is the non-`page_NNN.pdf` one capture.py names from the title.
        const pdf = files.find((f) => f.toLowerCase().endsWith(".pdf") && !/^page_\d+\.pdf$/i.test(f));
        const pageCount =
            files.filter((f) => /^page_\d+\.png$/i.test(f)).length ||
            (transcript ? (transcript.match(/--- page \d+ ---/g) ?? []).length : 0);

        const res: DocCaptureResult = { ok: true, outDir: cfg.outDir };
        if (transcript) res.transcript = transcript;
        if (pdf) res.pdfPath = deps.join(cfg.outDir, pdf);
        if (pageCount) res.pageCount = pageCount;
        return res;
    } catch (e) {
        return { ok: false, outDir: cfg.outDir, error: e instanceof Error ? e.message : String(e) };
    } finally {
        deps.resumeInput?.();
    }
}

/** Real child_process runner: ignore stdin (so capture.py's auth-retry prompt EOFs
 *  rather than hangs), line-buffer stdout+stderr, SIGKILL on timeout. */
function realRunProcess(
    command: string,
    args: string[],
    opts: { onLine?: (line: string) => void; timeoutMs?: number },
): Promise<{ code: number | null; timedOut: boolean; tail: string }> {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) {
            resolve({ code: null, timedOut: false, tail: e instanceof Error ? e.message : String(e) });
            return;
        }
        let buf = "";
        let tail = "";
        let timedOut = false;
        const onData = (d: Buffer): void => {
            buf += d.toString();
            let i: number;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                tail = (tail + line + "\n").slice(-2000);
                opts.onLine?.(line);
            }
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        const timer = opts.timeoutMs
            ? setTimeout(() => {
                  timedOut = true;
                  try {
                      child.kill("SIGKILL");
                  } catch {
                      /* ignore */
                  }
              }, opts.timeoutMs)
            : undefined;
        child.on("error", (e) => {
            if (timer) clearTimeout(timer);
            resolve({ code: null, timedOut, tail: `${tail}${e.message}` });
        });
        child.on("close", (code) => {
            if (timer) clearTimeout(timer);
            if (buf) {
                tail = (tail + buf).slice(-2000);
                opts.onLine?.(buf);
            }
            resolve({ code, timedOut, tail });
        });
    });
}

export interface CaptureWiring {
    python: string;
    script: string;
    /** Live PiKVM connection details (from PiKvmControl.captureTarget()). */
    target: () => { host: string; scheme: "http" | "https"; user?: string; password?: string };
    /** Base dir under which a timestamped capture-<ts>/ folder is created per run. */
    outBase: string;
    pdf?: boolean;
    pauseInput?: () => void;
    resumeInput?: () => void;
    /** Injectable clock for tests (default Date.now). */
    now?: () => number;
}

/** Wire the real capture function (used by main.ts / server-main.ts as the
 *  `captureDocument` MCP dep). */
export function createCaptureDocument(wiring: CaptureWiring) {
    return async (opts: { mode?: "scan" | "paged"; onProgress?: (line: string) => void } = {}): Promise<DocCaptureResult> => {
        const t = wiring.target();
        const ts = new Date((wiring.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-");
        const outDir = join(wiring.outBase, `capture-${ts}`);
        await mkdir(outDir, { recursive: true }).catch(() => {});
        const cfg: DocCaptureConfig = {
            python: wiring.python,
            script: wiring.script,
            host: t.host,
            scheme: t.scheme,
            outDir,
            ...(t.user ? { user: t.user } : {}),
            ...(t.password ? { password: t.password } : {}),
            ...(opts.mode ? { mode: opts.mode } : {}),
            ...(wiring.pdf !== undefined ? { pdf: wiring.pdf } : {}),
        };
        const deps: DocCaptureRunDeps = {
            runProcess: realRunProcess,
            readFile: async (p) => {
                try {
                    return await fsReadFile(p, "utf8");
                } catch {
                    return null;
                }
            },
            listFiles: async (d) => {
                try {
                    return await readdir(d);
                } catch {
                    return [];
                }
            },
            join,
            ...(wiring.pauseInput ? { pauseInput: wiring.pauseInput } : {}),
            ...(wiring.resumeInput ? { resumeInput: wiring.resumeInput } : {}),
            ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        };
        return runDocCapture(cfg, deps);
    };
}
