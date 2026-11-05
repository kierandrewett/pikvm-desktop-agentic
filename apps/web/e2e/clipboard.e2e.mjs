// Copy and paste on the KVM screen, in real Chrome against a real web host in front of tools/fake-kvmd.
//
//   node apps/web/e2e/clipboard.e2e.mjs [--out docs/e2e]
//
// Two things are shown, each by what the fake kvmd RECEIVED:
//
//  1. Ctrl+C and Ctrl+V on the screen are the TARGET's: they reach it as keys, whatever is on this machine's
//     clipboard, and the browser's own paste never types this machine's clipboard into the page's hidden field.
//  2. This machine's clipboard reaches the target only through "Type text on the target", and a clipboard of
//     really odd text (curly quotes, CRLF, zero-width marks, emoji, a broken surrogate, tabs, a large mixed pile)
//     is typed as what a keyboard can type.
//
// How to bring the two servers up and set PUPPETEER_CORE / CHROME: docs/e2e/README.md.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { WEB, FAKE, Report, describe, fakeReset, launch, recorder, sleep } from "./harness.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e";
const report = new Report("Copy and paste");
const profile = "desktop";

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function check(name, fn) {
    try {
        const [pass, observed] = await fn();
        report.add(profile, name, observed, pass);
    } catch (error) {
        report.add(profile, name, `threw: ${error.message}`, false);
    }
}

async function live(page, timeout = 15000) {
    await page.waitForFunction(
        () => {
            const s = document.querySelector(".kvm-status")?.textContent ?? "";
            return s === "Live" || (document.querySelector(".kvm-dot")?.getAttribute("aria-label") ?? "") === "Live";
        },
        { timeout },
    );
}

const browser = await launch();
const context = browser.defaultBrowserContext();
await context.overridePermissions(WEB, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
await fakeReset();
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => {
    if (!/janus\/ws/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
await page.setViewport({ width: 1400, height: 900 });
await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
await live(page);
await page.bringToFront();

const rec = recorder();
const setClipboard = (text) => page.evaluate((t) => navigator.clipboard.writeText(t), text);
const readClipboard = () => page.evaluate(() => navigator.clipboard.readText());
const fieldValue = () => page.$eval(".kvm-kbd", (el) => el.value);

// A click on the picture focuses the hidden field the keyboard types into.
const box = await page.$eval('[data-testid="kvm-pane"]', (el) => {
    const r = el.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
});
await page.mouse.click(box.cx, box.cy);
await sleep(300);

const LOCAL = "THIS MACHINES CLIPBOARD";

// A key press from CDP does not run the browser's editing commands (paste, copy) unless the event says which command it
// stands for, as a real keyboard's press does. So each chord is sent with its command, and the page's own handling is what
// decides whether the command runs.
const cdp = await page.createCDPSession();
const CTRL = 2;
const SHIFT = 8;
async function key(type, code, keyName, vk, modifiers, commands) {
    await cdp.send("Input.dispatchKeyEvent", {
        type,
        code,
        key: keyName,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        modifiers,
        ...(commands ? { commands } : {}),
    });
}
async function chord(modifier, code, keyName, vk, commands) {
    const [modCode, modKey, modVk, bit] = modifier === "ctrl" ? ["ControlLeft", "Control", 17, CTRL] : ["ShiftLeft", "Shift", 16, SHIFT];
    await key("rawKeyDown", modCode, modKey, modVk, bit);
    await key("rawKeyDown", code, keyName, vk, bit, commands);
    await key("keyUp", code, keyName, vk, bit);
    await key("keyUp", modCode, modKey, modVk, 0);
}
const refocus = async () => {
    await page.mouse.click(box.cx, box.cy);
    await sleep(200);
};

await check("the hidden field has the keyboard after a click on the picture", async () => {
    const focused = await page.evaluate(() => document.activeElement?.classList.contains("kvm-kbd") === true);
    return [focused, `active element is the hidden field: ${focused}`];
});

await check("control: the same Ctrl+V with the paste command DOES paste this machine's clipboard into an ordinary text box", async () => {
    await setClipboard(LOCAL);
    await page.evaluate(() => {
        const probe = document.createElement("input");
        probe.id = "probe";
        probe.style.cssText = "position:fixed;left:0;top:0;width:300px;z-index:99999";
        document.body.appendChild(probe);
        probe.focus();
    });
    await chord("ctrl", "KeyV", "v", 86, ["paste"]);
    await sleep(300);
    const value = await page.$eval("#probe", (el) => el.value);
    await page.evaluate(() => document.getElementById("probe")?.remove());
    await refocus();
    return [value === LOCAL, `an ordinary input now holds ${JSON.stringify(value)}; so a paste that does not reach the page's field was stopped by the page`];
});

await check("Ctrl+V reaches the target as keys, with the paste command attached; nothing is typed from this machine's clipboard and the hidden field gains nothing", async () => {
    await setClipboard(LOCAL);
    const before = await fieldValue();
    await rec.mark();
    await chord("ctrl", "KeyV", "v", 86, ["paste"]);
    const { events, prints } = await rec.events(1200);
    const lines = describe(events);
    const after = await fieldValue();
    const pass =
        lines.includes("key ControlLeft down") && lines.includes("key KeyV down") && lines.includes("key KeyV up") && lines.includes("key ControlLeft up") && prints.length === 0 && after === before && !after.includes("CLIPBOARD");
    return [pass, `${lines.join(", ")}; typed on the target: ${prints.length} requests; hidden field ${before.length} characters before, ${after.length} after`];
});

await check("Ctrl+C reaches the target as keys, with the copy command attached, and this machine's clipboard is not replaced", async () => {
    await setClipboard(LOCAL);
    await rec.mark();
    await chord("ctrl", "KeyC", "c", 67, ["copy"]);
    const { events, prints } = await rec.events(1200);
    const lines = describe(events);
    const clip = await readClipboard();
    const pass = lines.includes("key ControlLeft down") && lines.includes("key KeyC down") && lines.includes("key KeyC up") && prints.length === 0 && clip === LOCAL;
    return [pass, `${lines.join(", ")}; this machine's clipboard still ${JSON.stringify(clip)}`];
});

await check("a paste that comes by another road (Shift+Insert with the paste command, as a menu would) types nothing", async () => {
    await setClipboard(LOCAL);
    const before = await fieldValue();
    await rec.mark();
    await chord("shift", "Insert", "Insert", 45, ["paste"]);
    const { prints } = await rec.events(1200);
    const after = await fieldValue();
    return [prints.length === 0 && after === before, `typed ${prints.length}; hidden field ${before.length} characters before, ${after.length} after`];
});

// ---- Type text on the target, with a clipboard that is anything -------------------------------------------------------------

async function openTypeText() {
    await page.click('[aria-label="More"]');
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Type text on the target"), { timeout: 5000 });
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Type text on the target")?.click());
    await page.waitForSelector('textarea[aria-label="Text to type on the target"]', { timeout: 5000 });
}

/** Opens the dialog (which prefills from this machine's clipboard), reads what it says, and types. */
async function typeFromClipboard(text) {
    await setClipboard(text);
    await rec.mark();
    await openTypeText();
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Text to type on the target"]')?.value ?? "") !== "", { timeout: 5000 });
    const note = await page.evaluate(() => document.querySelector('[data-testid="paste-dropped"]')?.textContent ?? "");
    const adjusted = await page.evaluate(() => document.querySelector('[data-testid="paste-adjusted"]')?.textContent ?? "");
    const count = await page.evaluate(() => document.querySelector('[data-testid="paste-count"]')?.textContent ?? "");
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Type on target")?.click());
    const { prints } = await rec.events(1800);
    // The dialog closes when kvmd has answered.
    await page.waitForFunction(() => !document.querySelector('[data-testid="paste-dialog"]'), { timeout: 5000 }).catch(() => undefined);
    return { prints, note, adjusted, count };
}

const ODD = "\u201cHi\u201d \u2014 it\u2019s\u2026\r\n\u{1f600}\u200bend";
await check("a clipboard of curly quotes, an em dash, an ellipsis, CRLF, an emoji and a zero-width mark types the plain text, and the dialog says what was adjusted and what was left out", async () => {
    const { prints, note, adjusted, count } = await typeFromClipboard(ODD);
    const expected = "\"Hi\" - it's...\nend";
    const pass = prints.length === 1 && prints[0].text === expected && /1 character/.test(note) && /^5 characters .*plain equivalents/.test(adjusted);
    return [pass, `typed ${JSON.stringify(prints[0]?.text)}; dialog: ${JSON.stringify(adjusted)} ${JSON.stringify(note)}, ${JSON.stringify(count)}`];
});

await check("plain text, tabs and a trailing newline are typed exactly", async () => {
    const plain = "echo 'a b' && ls -la\n\tindented line\n";
    const { prints } = await typeFromClipboard(plain);
    return [prints.length === 1 && prints[0].text === plain, `typed ${JSON.stringify(prints[0]?.text)}`];
});

await check("a broken surrogate, a byte order mark, a NUL, an escape and an arrow are gone; the words stay", async () => {
    const { prints } = await typeFromClipboard("\ufeffstart \ud800 mid\u0000dle\u001b \u2192 end");
    return [prints.length === 1 && prints[0].text === "start  middle  end", `typed ${JSON.stringify(prints[0]?.text)}`];
});

await check("a large pile of mixed rubbish types only what a keyboard can: no CR, no zero-width or format characters, no emoji, and the words are all there", async () => {
    const parts = ["word", "\u201cquoted\u201d", "caf\u00e9", "\u00a0", "\u200b", "\u{1f680}", "\r\n", "\u2013", "\ufb01le", "\uff21\uff22", "tab\there", "\u0007"];
    let pile = "";
    for (let i = 0; i < 400; i++) pile += `${parts[i % parts.length]}${i % 3 === 0 ? " " : ""}`;
    const { prints } = await typeFromClipboard(pile);
    const typed = prints[0]?.text ?? "";
    const forbidden = /[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u00a0\u201c\u201d\u2013\ufb01\uff21]|[\ud800-\udfff]/;
    const words = (typed.match(/word/g) ?? []).length;
    return [prints.length === 1 && typed.length > 1000 && !forbidden.test(typed) && words === Math.ceil(400 / parts.length), `${typed.length} characters typed in one request; "word" appears ${words} times; forbidden character present: ${forbidden.test(typed)}`];
});

await check("a clipboard that is only emoji sends nothing, and the dialog says why", async () => {
    await setClipboard("\u{1f600}\u{1f680}\u{1f525}");
    await rec.mark();
    await openTypeText();
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Text to type on the target"]')?.value ?? "") !== "", { timeout: 5000 });
    const disabled = await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Type on target")?.disabled === true);
    const nothing = await page.evaluate(() => document.querySelector('[data-testid="paste-nothing"]')?.textContent ?? "");
    const { prints } = await rec.events(500);
    await page.keyboard.press("Escape");
    return [disabled && prints.length === 0 && /Nothing in this text can be typed/.test(nothing), `button disabled ${disabled}; typed ${prints.length}; dialog says ${JSON.stringify(nothing)}`];
});

await check("no page errors", async () => [logs.filter((l) => l.startsWith("pageerror") || l.startsWith("error")).length === 0, logs.join(" | ") || "clean"]);

const chromeVersion = await browser.version();
await browser.close();

const puppeteerCore = (process.env.PUPPETEER_CORE ?? `${process.env.HOME}/dev/sidekick/node_modules/`).replace(/\/$/, "");
const puppeteerVersion = JSON.parse(readFileSync(`${puppeteerCore}/puppeteer-core/package.json`, "utf8")).version;
let commit = "unknown";
let dirty = "";
try {
    commit = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { encoding: "utf8" }).trim();
    const changed = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
    dirty = changed === "" ? "" : " plus uncommitted changes to the tracked files";
} catch {
    // not a git checkout: the report says so
}

const today = new Date().toISOString().slice(0, 10);
const md = [
    `# E2E run: copy and paste on the KVM screen (${today})`,
    "",
    `Host under test: \`node dist/web-server.js\` (${WEB}) in front of \`tools/fake-kvmd\` (${FAKE}), in headless Chrome through puppeteer-core (key presses are real CDP key events, so Chrome's own paste handling runs). Script: \`apps/web/e2e/clipboard.e2e.mjs\`; how to run it: \`docs/e2e/README.md\`.`,
    "",
    "Ctrl+C and Ctrl+V on the screen are the target's: they arrive as keys and this machine's clipboard is never typed. This machine's clipboard reaches the target only through \"Type text on the target\", which types what a keyboard can.",
    "",
    "| Case | Observed | Result |",
    "| --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.name} | ${r.observed.replace(/\|/g, "\\|")} | ${r.pass ? "pass" : "FAIL"} |`),
    "",
    `${report.rows.length - report.failed.length} of ${report.rows.length} passed.`,
    "",
    "## How this run was made",
    "",
    "```sh",
    `PUPPETEER_CORE=${process.env.PUPPETEER_CORE ?? "(default)"} CHROME=${process.env.CHROME ?? "(default)"} KVM_WEB=${WEB} KVM_FAKE=${FAKE} \\`,
    `    node apps/web/e2e/clipboard.e2e.mjs ${args.join(" ")}`.trimEnd(),
    "```",
    "",
    `- Repository commit: \`${commit}\`${dirty} (the host was built from this tree with \`yarn workspace @pikvm/web build && yarn build\`).`,
    `- Browser: ${chromeVersion}, headless, through puppeteer-core ${puppeteerVersion}; Node ${process.version} on ${process.platform} ${process.arch}.`,
    "- The web host ran with its own empty data directory and home, with `OMP_BIN` pointing at nothing, so no chat agent or user configuration was reachable; the fake kvmd was started fresh and reset at the start of the run.",
    "- Chrome's paste and copy commands were attached to the key events (see the control case), because a bare CDP key press does not run them.",
    "",
];
writeFileSync(`${outDir}/${today}-clipboard.md`, md.join("\n"));
process.exit(report.failed.length ? 1 : 0);
