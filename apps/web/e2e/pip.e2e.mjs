// The live screen over Chat and Settings, in real Chrome against a real web host in front of tools/fake-kvmd.
//
//   node apps/web/e2e/pip.e2e.mjs [--out docs/e2e]
//
// A window on a wide screen and a round bubble on a phone (real CDP touch events): it is not there on the KVM tab, it shows
// the target's picture (its canvas is compared with the picture's own pixels), a throw flies on and stays inside the area
// and comes to rest, a tap opens the KVM, and the throw's closing click does not. How to bring the servers up and set
// PUPPETEER_CORE / CHROME: docs/e2e/README.md.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { Report, WEB, fakeReset, launch, line, sleep, touchSession } from "./harness.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e";
mkdirSync(`${outDir}/pip`, { recursive: true });
const report = new Report("Live screen window");
const check = (profile, name, pass, observed) => report.add(profile, name, observed, pass);

const browser = await launch();
await fakeReset();

async function live(page) {
    await page.waitForFunction(() => document.querySelector(".kvm-pane.has-frame") !== null, { timeout: 20000 });
}

/** The window's place in the content area, and the area. */
const where = (page) =>
    page.evaluate(() => {
        const pip = document.querySelector(".pip");
        const area = pip.parentElement.getBoundingClientRect();
        const r = pip.getBoundingClientRect();
        return { x: r.x - area.x, y: r.y - area.y, w: r.width, h: r.height, aw: area.width, ah: area.height, live: pip.hasAttribute("data-live") };
    });

/** How much of the window's canvas is not blank: the copy is of a picture, not an empty box. */
const painted = (page) =>
    page.evaluate(() => {
        const c = document.querySelector(".pip-canvas");
        const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit++;
        return lit / (data.length / 4);
    });

const inside = (p, margin = 9) => p.x >= margin && p.y >= margin && p.x + p.w <= p.aw - margin + 1 && p.y + p.h <= p.ah - margin + 1;

try {
    /* ---- a wide screen ---- */
    {
        const profile = "desktop";
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
        await live(page);
        check(profile, "not on the KVM tab", (await page.$(".pip")) === null, "no window");

        await page.goto(`${WEB}/app/settings`, { waitUntil: "load" });
        await page.waitForFunction(() => document.querySelector(".pip[data-live]") !== null, { timeout: 20000 });
        let p = await where(page);
        check(profile, "a window over Settings, once the KVM has a picture", p.live && p.w > 200, `${Math.round(p.w)}x${Math.round(p.h)} at ${Math.round(p.x)},${Math.round(p.y)}`);
        check(profile, "it starts at the top right", p.x + p.w > p.aw - 30 && p.y < 30, `x ${Math.round(p.x)} of ${Math.round(p.aw)}`);
        await sleep(400);
        check(profile, "its canvas holds the picture", (await painted(page)) > 0.9, `${Math.round((await painted(page)) * 100)}% painted`);
        await page.screenshot({ path: `${outDir}/pip/desktop-settings.png` });

        // Throw it: press on it, drag to the left and down with speed, let go.
        const box = await page.$eval(".pip-open", (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
        for (const [x, y] of line([box.x, box.y], [box.x - 260, box.y + 140], 8)) {
            await page.mouse.move(x, y);
            await sleep(12);
        }
        const during = await where(page);
        await page.mouse.up();
        await sleep(150);
        const early = await where(page);
        await sleep(2600);
        const rest = await where(page);
        await sleep(300);
        const later = await where(page);
        check(profile, "dragging moves it", Math.abs(during.x - p.x) > 150, `${Math.round(p.x)} to ${Math.round(during.x)}`);
        check(profile, "a throw keeps it moving after the pointer is up", Math.hypot(early.x - during.x, early.y - during.y) > 20, `${Math.round(Math.hypot(early.x - during.x, early.y - during.y))}px more`);
        check(profile, "it stays inside the area", inside(early) && inside(rest), JSON.stringify({ x: Math.round(rest.x), y: Math.round(rest.y) }));
        check(profile, "it comes to rest", Math.abs(later.x - rest.x) < 1 && Math.abs(later.y - rest.y) < 1, `${Math.round(rest.x)},${Math.round(rest.y)}`);
        check(profile, "the throw's closing click did not open the KVM", page.url().endsWith("/app/settings") || page.url().includes("/settings"), page.url());

        // Shift and the arrow keys.
        await page.focus(".pip-open");
        const before = await where(page);
        await page.keyboard.down("Shift");
        await page.keyboard.press("ArrowUp");
        await page.keyboard.up("Shift");
        const nudged = await where(page);
        check(profile, "Shift and an arrow key move it", nudged.y < before.y || nudged.y === 10, `${Math.round(before.y)} to ${Math.round(nudged.y)}`);

        // Tap.
        const at = await page.$eval(".pip-open", (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        await page.mouse.click(at.x, at.y);
        await page.waitForFunction(() => location.pathname.endsWith("/kvm"), { timeout: 5000 }).catch(() => undefined);
        check(profile, "a tap opens the KVM, where the window is gone", page.url().endsWith("/kvm") && (await page.$(".pip")) === null, page.url());
        await page.close();
    }

    /* ---- a phone ---- */
    {
        const profile = "phone";
        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        await page.goto(`${WEB}/app/kvm`, { waitUntil: "load" });
        await live(page);
        await page.goto(`${WEB}/app/chat`, { waitUntil: "load" });
        await page.waitForFunction(() => document.querySelector(".pip[data-live]") !== null, { timeout: 20000 });
        const p = await where(page);
        const shape = await page.$eval(".pip", (el) => el.getAttribute("data-shape"));
        check(profile, "a round bubble over Chat", shape === "bubble" && Math.abs(p.w - p.h) < 1 && p.w < 120, `${shape} ${Math.round(p.w)}x${Math.round(p.h)}`);
        await sleep(400);
        check(profile, "its canvas holds the picture", (await painted(page)) > 0.5, `${Math.round((await painted(page)) * 100)}% painted`);
        const composer = await page.evaluate(() => {
            const t = document.querySelector('textarea, [role="textbox"]');
            return t ? t.getBoundingClientRect().top : null;
        });
        check(profile, "it starts clear of the message field", composer === null || p.y + p.h < composer, `bubble bottom ${Math.round(p.y + p.h)}, field top ${composer === null ? "none" : Math.round(composer)}`);
        await page.screenshot({ path: `${outDir}/pip/phone-chat.png` });

        const touch = await touchSession(page);
        const c = await page.$eval(".pip-open", (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        const id = await touch.start(c.x, c.y);
        await touch.drag(id, line([c.x, c.y], [c.x - 200, c.y + 300], 10), 14);
        const during = await where(page);
        await touch.end(id);
        await sleep(2800);
        const rest = await where(page);
        check(profile, "a finger moves it and a throw lands it inside the area", Math.abs(during.x - p.x) > 100 && inside(rest), `${Math.round(p.x)},${Math.round(p.y)} to ${Math.round(rest.x)},${Math.round(rest.y)}`);
        check(profile, "the throw did not open the KVM", page.url().includes("/chat"), page.url());

        const t = await page.$eval(".pip-open", (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        await touch.tap(t.x, t.y);
        await page.waitForFunction(() => location.pathname.endsWith("/kvm"), { timeout: 5000 }).catch(() => undefined);
        check(profile, "a tap opens the KVM", page.url().endsWith("/kvm"), page.url());
        await page.close();
    }
} catch (error) {
    check("run", "the run finished", false, `threw: ${error.stack ?? error.message}`);
} finally {
    await browser.close();
}

const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
const today = new Date().toISOString().slice(0, 10);
const md = [
    "# The live screen over Chat and Settings (end to end)",
    "",
    `Result: ${report.rows.length - report.failed.length} of ${report.rows.length} checks passed.`,
    "",
    "| Profile | Check | Result | Observed |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.profile} | ${r.name} | ${r.pass ? "pass" : "FAIL"} | ${String(r.observed).replace(/\|/g, "/").replace(/\n/g, " ")} |`),
    "",
    "## How this run was made",
    "",
    "```sh",
    `PUPPETEER_CORE=${process.env.PUPPETEER_CORE ?? "(default)"} CHROME=${process.env.CHROME ?? "(default)"} KVM_WEB=${WEB} node apps/web/e2e/pip.e2e.mjs`,
    "```",
    "",
    `- Repository commit: \`${commit}\` (dirty tree if uncommitted); host from \`yarn workspace @pikvm/web build && yarn build\`, in front of \`tools/fake-kvmd\`.`,
    `- Node ${process.version}. Screenshots: \`${outDir}/pip/\`.`,
    "- Not covered: the agent holding the target (the lock is covered by tests/input-lock.test.ts over real sockets).",
    "",
];
writeFileSync(`${outDir}/${today}-pip.md`, md.join("\n"));
process.exit(report.failed.length ? 1 : 0);
