/**
 * Generate @pikvm/icons from @phosphor-icons/core.
 *
 * Run: yarn workspace @pikvm/icons build (Node, --experimental-transform-types)
 *
 * Writes:
 * - src/generated/<Name>.ts  one module per icon, with regular, fill and bold path data
 * - src/index.ts             re-exports, with the same names as @phosphor-icons/react (Name, NameIcon, aliases)
 * - preview.html             source next to rounded output for regular and fill, with artefact flags
 *
 * Output is deterministic: icons are sorted by name and numbers are rounded to 1/100 unit.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { icons } from "@phosphor-icons/core";
import { checkElement } from "./check.ts";
import { CUSTOM_ICONS, CUSTOM_VARIANTS, type CustomIcon } from "./custom/index.ts";
import { OVERRIDES } from "./overrides.ts";
import { DEFAULT_OPTIONS, type SmoothOptions, type SmoothStats, smoothElement } from "./smooth.ts";
import { parsePath, serialisePath, shapeToPath } from "./svg-path.ts";

const WEIGHTS = ["regular", "fill", "bold"] as const;
type Weight = (typeof WEIGHTS)[number];
const PREVIEW_WEIGHTS: readonly Weight[] = ["regular", "fill"];

/** Icons that the preview shows first. The set named in the brief plus the ones apps/web uses today. */
const FOCUS = [
    "SidebarSimple",
    "House",
    "Folder",
    "FolderOpen",
    "FolderSimple",
    "FolderPlus",
    "ChatCircle",
    "ChatCompose",
    "NotePencil",
    "PencilSimple",
    "Gear",
    "MagnifyingGlass",
    "PushPin",
    "PushPinSlash",
    "Star",
    "Archive",
    "Trash",
    "Copy",
    "Check",
    "X",
    "ArrowUp",
    "Stop",
    "Microphone",
    "Paperclip",
    "Image",
    "File",
    "FileText",
    "FileLock",
    "Code",
    "Terminal",
    "Globe",
    "Lightning",
    "Brain",
    "Sparkle",
    "User",
    "UserCircle",
    "SignOut",
    "Lock",
    "LockSimple",
    "Key",
    "ShieldCheck",
    "CaretDown",
    "CaretRight",
    "CaretLeft",
    "DotsThree",
    "List",
    "Plus",
    "Minus",
    "Square",
    "SquaresFour",
    "At",
    "Command",
    "Plugs",
    "Hand",
    "WarningCircle",
    "CircleNotch",
    "CircleHalf",
    "Monitor",
    "Moon",
    "Sun",
    "UploadSimple",
    "ArrowUDownLeft",
    "FolderMinus",
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The package's exports map hides package.json, so walk up from the resolved entry to find its root. */
function packageRoot(entry: string): string {
    let dir = dirname(entry);
    while (!existsSync(join(dir, "package.json"))) {
        const parent = dirname(dir);
        if (parent === dir) throw new Error(`[icons] no package.json above ${entry}`);
        dir = parent;
    }
    return dir;
}

const coreDir = packageRoot(createRequire(import.meta.url).resolve("@phosphor-icons/core"));
const assetsDir = join(coreDir, "assets");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output")) {
    throw new Error("[icons] usage: node --experimental-transform-types scripts/build.ts [--output <new-directory>]");
}
const outputRoot = args[1] ? resolve(args[1]) : root;
if (args[1] && existsSync(outputRoot)) throw new Error("[icons] --output requires a new directory");
const outputs = new Map<string, string>();
const coreVersion = (JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8")) as { version: string }).version;

const SHAPES = /<(path|rect|circle|ellipse|line|polyline|polygon)\b([^>]*?)\/?>/g;
const ATTRS = /([\w:-]+)="([^"]*)"/g;

/** Path data of each filled element in one asset file. */
function readElements(file: string): string[] {
    const svg = readFileSync(file, "utf8");
    const out: string[] = [];
    for (const [, tag = "", attrText = ""] of svg.matchAll(SHAPES)) {
        const attrs: Record<string, string> = {};
        for (const [, k = "", v = ""] of attrText.matchAll(ATTRS)) attrs[k] = v;
        if (attrs.fill === "none" || attrs.opacity !== undefined) continue;
        const d = tag === "path" ? attrs.d : shapeToPath(tag, attrs);
        if (d) out.push(d);
    }
    if (out.length === 0) throw new Error(`[icons] no drawable elements in ${file}`);
    return out;
}

function assetPath(name: string, weight: Weight): string {
    return join(assetsDir, weight, weight === "regular" ? `${name}.svg` : `${name}-${weight}.svg`);
}

interface WeightResult {
    source: string[];
    rounded: string[];
    flags: string[];
}

const totals: SmoothStats = { reversed: 0, rounded: 0, joins: 0, clamped: 0, nextToCurves: 0 };
let bytesSource = 0;
let bytesRounded = 0;

function processWeight(
    name: string,
    weight: Weight,
    source = readElements(assetPath(name, weight)),
    trackTotals = true,
): WeightResult {
    const override = OVERRIDES[`${name}:${weight}`] ?? OVERRIDES[name];
    if (trackTotals) bytesSource += source.reduce((a, d) => a + d.length, 0);
    if (override === "source") {
        if (trackTotals) bytesRounded += source.reduce((a, d) => a + d.length, 0);
        return { source, rounded: source, flags: ["override:source"] };
    }
    const opts: SmoothOptions = { ...DEFAULT_OPTIONS, ...override };
    const flags: string[] = override ? ["override"] : [];
    const rounded = source.map((d, i) => {
        const parsed = parsePath(d);
        const { subpaths, stats } = smoothElement(parsed, opts);
        if (trackTotals) for (const k of Object.keys(totals) as (keyof SmoothStats)[]) totals[k] += stats[k];
        if (stats.reversed > 0)
            flags.push(source.length > 1 ? `${i}/reversed:${stats.reversed}` : `reversed:${stats.reversed}`);
        const out = serialisePath(subpaths);
        // Check what ships: the serialised, rounded output, parsed again.
        for (const f of checkElement(parsed, parsePath(out)).flags) flags.push(source.length > 1 ? `${i}/${f}` : f);
        return out;
    });
    if (trackTotals) bytesRounded += rounded.reduce((a, d) => a + d.length, 0);
    return { source, rounded, flags };
}

const HEADER = `// Generated by packages/icons/scripts/build.ts from @phosphor-icons/core ${coreVersion} (MIT). Do not edit.`;

function iconModule(pascal: string, results: Record<Weight, WeightResult>, custom = false): string {
    // Same shape Prettier gives, so the repo formatter leaves generated files alone.
    const weights = WEIGHTS.flatMap((w) => {
        const items = results[w].rounded.map((d) => JSON.stringify(d));
        const inline = `    ${w}: [${items.join(", ")}],`;
        if (inline.length <= 120) return [inline];
        return [`    ${w}: [`, ...items.map((d) => `        ${d},`), "    ],"];
    });
    return [
        custom ? "// Generated by packages/icons/scripts/build.ts from a custom drawing. Do not edit." : HEADER,
        `import { createIcon } from "../icon";`,
        "",
        `export const ${pascal} = /* @__PURE__ */ createIcon(${JSON.stringify(pascal)}, {`,
        ...weights,
        "});",
        "",
    ].join("\n");
}

interface PreviewIcon {
    n: string;
    f: string[];
    w: Record<string, [string[], string[]]>;
}

const sorted = [...icons].sort((a, b) => (a.pascal_name < b.pascal_name ? -1 : a.pascal_name > b.pascal_name ? 1 : 0));
const primaryNames = new Set<string>(sorted.map((i) => i.pascal_name));
const exportLines: string[] = [];
const preview: PreviewIcon[] = [];
const flagged: string[] = [];

const exportNames = new Set<string>();
for (const icon of sorted) {
    exportNames.add(icon.pascal_name);
    exportNames.add(`${icon.pascal_name}Icon`);
    const alias = (icon as { alias?: { pascal_name: string } }).alias?.pascal_name;
    if (alias && !primaryNames.has(alias)) {
        exportNames.add(alias);
        exportNames.add(`${alias}Icon`);
    }
}
for (const icon of CUSTOM_ICONS) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(icon.name)) throw new Error(`[icons] invalid custom name: ${icon.name}`);
    for (const name of [icon.name, `${icon.name}Icon`]) {
        if (exportNames.has(name)) throw new Error(`[icons] duplicate export: ${name}`);
        exportNames.add(name);
    }
}

for (const icon of sorted) {
    const pascal = icon.pascal_name;
    const results = Object.fromEntries(WEIGHTS.map((w) => [w, processWeight(icon.name, w)])) as Record<
        Weight,
        WeightResult
    >;
    outputs.set(`src/generated/${pascal}.ts`, iconModule(pascal, results));

    const names = [pascal, `${pascal}Icon`];
    const alias = (icon as { alias?: { pascal_name: string } }).alias?.pascal_name;
    if (alias && !primaryNames.has(alias)) names.push(alias, `${alias}Icon`);
    const specifiers = names.map((n) => (n === pascal ? n : `${pascal} as ${n}`));
    const from = `from "./generated/${pascal}";`;
    const oneLine = `export { ${specifiers.join(", ")} } ${from}`;
    exportLines.push(
        oneLine.length <= 120 ? oneLine : ["export {", ...specifiers.map((x) => `    ${x},`), `} ${from}`].join("\n"),
    );

    const flags = WEIGHTS.flatMap((w) => results[w].flags.map((f) => `${w}:${f}`));
    if (flags.some((f) => !f.includes("override"))) flagged.push(`${pascal} ${flags.join(" ")}`);
    preview.push({
        n: pascal,
        f: flags,
        w: Object.fromEntries(PREVIEW_WEIGHTS.map((w) => [w, [results[w].source, results[w].rounded]])),
    });
}

function customResults(icon: CustomIcon, trackTotals = true): Record<Weight, WeightResult> {
    const key = icon.name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    return Object.fromEntries(
        WEIGHTS.map((weight) => [weight, processWeight(key, weight, [...icon.paths[weight]], trackTotals)]),
    ) as Record<Weight, WeightResult>;
}

for (const icon of [...CUSTOM_ICONS].sort((a, b) => a.name.localeCompare(b.name))) {
    const results = customResults(icon);
    outputs.set(`src/generated/${icon.name}.ts`, iconModule(icon.name, results, true));
    exportLines.push(`export { ${icon.name}, ${icon.name} as ${icon.name}Icon } from "./generated/${icon.name}";`);
    const flags = WEIGHTS.flatMap((weight) => results[weight].flags.map((flag) => `${weight}:${flag}`));
    if (flags.some((flag) => !flag.includes("override"))) flagged.push(`${icon.name} ${flags.join(" ")}`);
    preview.push({
        n: icon.name,
        f: flags,
        w: Object.fromEntries(
            PREVIEW_WEIGHTS.map((weight) => [weight, [results[weight].source, results[weight].rounded]]),
        ),
    });
    for (const variant of CUSTOM_VARIANTS[icon.name] ?? []) {
        const variantResults = customResults(variant, false);
        preview.push({
            n: `${icon.name}: ${variant.name}`,
            f: WEIGHTS.flatMap((weight) => variantResults[weight].flags.map((flag) => `${weight}:${flag}`)),
            w: Object.fromEntries(
                PREVIEW_WEIGHTS.map((weight) => [
                    weight,
                    [variantResults[weight].source, variantResults[weight].rounded],
                ]),
            ),
        });
    }
}

outputs.set(
    "src/index.ts",
    [
        HEADER,
        `export { createIcon, IconContext } from "./icon";`,
        `export type { Icon, IconPaths, IconProps, IconWeight } from "./icon";`,
        "",
        ...exportLines,
        "",
    ].join("\n"),
);

const opts = DEFAULT_OPTIONS;
const params = {
    delta: opts.delta,
    junctionDelta: opts.junctionDelta,
    smoothing: opts.smoothing,
    clamp: opts.clamp,
    minTurnDeg: Math.round((opts.minTurn * 180) / Math.PI),
    maxTurnDeg: Math.round((opts.maxTurn * 180) / Math.PI),
    maxFilletTangent: opts.maxFilletTangent,
    microRun: opts.microRun,
    curveHandle: opts.curveHandle,
    acuteTangent: opts.acuteTangent,
};
const summary = {
    icons: sorted.length + CUSTOM_ICONS.length,
    core: coreVersion,
    ...totals,
    flagged: flagged.length,
    sizeChange: `${((bytesRounded / bytesSource - 1) * 100).toFixed(1)}%`,
};
const template = readFileSync(join(root, "scripts", "preview.template.html"), "utf8");
const data = JSON.stringify({ params, summary, focus: FOCUS, icons: preview }).replace(/</g, "\\u003c");
const DATA_MARKER = /\/\*__DATA__\*\/\s*null/;
if (!DATA_MARKER.test(template)) throw new Error("[icons] preview.template.html has no /*__DATA__*/ null marker");
outputs.set(
    "preview.html",
    template.replace(DATA_MARKER, () => data),
);
if (flagged.length > 0) {
    throw new Error(`[icons] geometry checks failed; output unchanged:\n${flagged.join("\n")}`);
}

// Complete all files before touching live output. Rename modules first and the export index last.
mkdirSync(dirname(outputRoot), { recursive: true });
const stage = mkdtempSync(join(dirname(outputRoot), ".pikvm-icons-stage-"));
try {
    for (const [path, content] of outputs) {
        const target = join(stage, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
    }
    for (const path of outputs.keys()) {
        const target = join(outputRoot, path);
        mkdirSync(dirname(target), { recursive: true });
        if (existsSync(target) && readFileSync(target, "utf8") === outputs.get(path)) continue;
        renameSync(join(stage, path), target);
    }
} finally {
    rmSync(stage, { recursive: true, force: true });
}

console.log(`[icons] ${sorted.length} Phosphor icons and ${CUSTOM_ICONS.length} custom icons (core ${coreVersion})`);
console.log(`[icons] params ${JSON.stringify(params)}`);
console.log(
    `[icons] corners rounded ${totals.rounded}, joins kept ${totals.joins}, clamped ${totals.clamped}, reversed ${totals.reversed}`,
);
console.log(`[icons] path data ${bytesSource} -> ${bytesRounded} bytes (${summary.sizeChange})`);
console.log(`[icons] flagged ${flagged.length}`);
for (const line of flagged) console.log(`[icons]   ${line}`);
