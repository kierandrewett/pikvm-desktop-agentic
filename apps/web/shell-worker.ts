import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Gives the service worker (public/sw.js) the two things it cannot learn at run time: which build it belongs to and
 * which files that build is made of. The build's own output is the list, so it cannot drift from the build by hand.
 *
 * The source worker carries one line, `const SHELL = { build: "dev", files: [] }; // @shell`, which this replaces in
 * dist/sw.js with the real build id and file list. Because the id is inside the worker, every deploy changes sw.js
 * byte for byte and the browser installs the new worker beside the old one (see public/sw.js).
 */

/** The marker line in public/sw.js. */
const SHELL_LINE = /^const SHELL = .*; \/\/ @shell$/m;

/** Files that are not part of the shell: the worker itself, the build id (the host's word on what is deployed, never cached) and maps. */
const NEVER = (file: string): boolean => file === "sw.js" || file === "version.json" || file.endsWith(".map");

/** Packages that only render something nicer: code highlighting and maths. A chunk made of nothing else is fetched when it is first used. */
const OPTIONAL_PACKAGE = /\/node_modules\/(?:@shikijs\/|shiki\/|katex\/)/;
const OPTIONAL_FONT = /^assets\/KaTeX_/;
/** The first of several formats the stylesheet names; every browser that runs the worker reads woff2. */
const SPARE_FONT = /\.(?:woff|ttf)$/;

export interface BundleFile {
    readonly fileName: string;
    readonly type: "chunk" | "asset";
    readonly imports?: readonly string[];
    readonly moduleIds?: readonly string[];
}

/** The files the worker keeps for a build, as paths relative to the output directory, in a stable order. */
export function shellFiles(bundle: readonly BundleFile[], publicFiles: readonly string[]): string[] {
    const optional = new Set<string>();
    for (const file of bundle) {
        if (NEVER(file.fileName)) continue;
        if (file.type === "asset" && (OPTIONAL_FONT.test(file.fileName) || SPARE_FONT.test(file.fileName))) optional.add(file.fileName);
        if (file.type === "chunk" && file.moduleIds?.length && file.moduleIds.every((id) => id.includes("/node_modules/")) && file.moduleIds.some((id) => OPTIONAL_PACKAGE.test(id))) {
            optional.add(file.fileName);
        }
    }
    // A chunk that something in the shell loads statically comes with it, whatever it is made of.
    for (let changed = true; changed; ) {
        changed = false;
        for (const file of bundle) {
            if (optional.has(file.fileName) || NEVER(file.fileName)) continue;
            for (const dep of file.imports ?? []) {
                if (optional.delete(dep)) changed = true;
            }
        }
    }
    const files = new Set<string>();
    for (const file of bundle) if (!NEVER(file.fileName) && !optional.has(file.fileName)) files.add(file.fileName);
    for (const file of publicFiles) if (!NEVER(file)) files.add(file);
    return [...files].sort();
}

function listFiles(dir: string, from = dir): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? listFiles(path, from) : [relative(from, path).split("\\").join("/")];
    });
}

export function shellWorkerPlugin(options: { buildId: string }): Plugin {
    let base = "/app/";
    let root = process.cwd();
    let publicDir = "";
    let files: string[] = [];
    return {
        name: "pikvm:shell-worker",
        configResolved(config) {
            base = config.base;
            root = config.root;
            publicDir = config.publicDir;
        },
        generateBundle: {
            order: "post",
            handler(_options, bundle) {
                const output: BundleFile[] = Object.values(bundle).map((file) => ({
                    fileName: file.fileName,
                    type: file.type,
                    ...(file.type === "chunk" ? { imports: file.imports, moduleIds: file.moduleIds } : {}),
                }));
                if (!output.some((file) => file.fileName === "index.html")) throw new Error("shell-worker: the build has no index.html");
                files = shellFiles(output, publicDir ? listFiles(publicDir) : []);
            },
        },
        writeBundle: {
            order: "post",
            handler(outputOptions) {
                const target = resolve(root, outputOptions.dir ?? "dist", "sw.js");
                const source = readFileSync(target, "utf8");
                if ((source.match(new RegExp(SHELL_LINE, "gm")) ?? []).length !== 1) throw new Error("shell-worker: public/sw.js needs exactly one `const SHELL = ...; // @shell` line");
                // index.html is the shell's page: it is asked for as the app's own address.
                const urls = files.map((file) => (file === "index.html" ? base : `${base}${file}`));
                const shell = JSON.stringify({ build: options.buildId, files: urls });
                writeFileSync(target, source.replace(SHELL_LINE, () => `const SHELL = ${shell}; // @shell`));
            },
        },
    };
}
