// Signing a desktop app in to a server with the browser, in real Chrome against a real web host.
//
//   node apps/web/e2e/device-sign-in.e2e.mjs [--out docs/e2e]
//
// The desktop side is the real src/server/sync module (bundled with esbuild): its loopback listener, its PKCE and its
// store. The host is the real dist/web-server.js with PIKVM_ACCESS_TOKEN set. Chrome plays the person: signs in with the
// access token on the host's own page, reads the consent page and presses Allow. Then what the host did is checked
// over HTTP. Bring-up and variables: docs/e2e/README.md. Also needs TOKEN (the host's PIKVM_ACCESS_TOKEN).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { WEB, Report, launch, sleep } from "./harness.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e";
const TOKEN = process.env.TOKEN ?? "e2e-access-token";
const report = new Report("Signing a desktop app in with the browser");
const profile = "desktop";
const check = (name, pass, observed) => report.add(profile, name, observed, pass);

const work = mkdtempSync(`${tmpdir()}/device-sign-in-`);
const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");
buildSync({
    entryPoints: ["src/server/sync/index.ts"],
    outfile: `${work}/sync.mjs`,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "error",
});
const { createServerSync } = await import(pathToFileURL(`${work}/sync.mjs`).href);

const dataDir = `${work}/desktop`;
execFileSync("mkdir", ["-p", dataDir]);
const sync = createServerSync({ dir: dataDir, live: { track: () => undefined, closeAll: () => undefined } });

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 800 });
const shot = (name) => page.screenshot({ path: `${outDir}/device-sign-in/${name}.png` });
execFileSync("mkdir", ["-p", `${outDir}/device-sign-in`]);

try {
    const begun = await sync.editor.signIn({ origin: `${WEB}/` });
    check("the app answers an address on the server to open in the browser", begun.url.startsWith(`${WEB}/app/auth/device`), begun.url.split("?")[0]);

    await page.goto(begun.url, { waitUntil: "load" });
    const asksForSignIn = (await page.$('input[name="token"]')) !== null;
    check("a browser with no session is first sent to the host's own sign-in", asksForSignIn, page.url().split("?")[0]);
    await page.type('input[name="token"]', TOKEN);
    await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.keyboard.press("Enter")]);

    const heading = await page.$eval("h1", (el) => el.textContent).catch(() => "");
    await shot("consent");
    check("after signing in it shows the consent page", heading === "Allow this app to use this server?", heading);

    await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click('button[value="allow"]')]);
    const done = await page.evaluate(() => document.body.innerText);
    await shot("done");
    check("Allow sends the browser back to the app, which says it is signed in", /Signed in/.test(done), done.trim().slice(0, 80));

    let status = sync.editor.signInStatus(begun.id);
    for (let i = 0; i < 50 && status.state === "waiting"; i++) {
        await sleep(100);
        status = sync.editor.signInStatus(begun.id);
    }
    check("the app has the server saved", status.state === "done" && status.entry?.origin === WEB, JSON.stringify(status));

    const tokens = JSON.parse(readFileSync(`${dataDir}/server-tokens.json`, "utf8"));
    const saved = Object.values(tokens)[0];
    const bearer = typeof saved === "string" ? saved : saved?.token;
    check("the saved credential is a device token, not the access token", /^pkd_[0-9a-f]{12}_/.test(bearer ?? "") && bearer !== TOKEN, (bearer ?? "").slice(0, 8));

    const ok = await fetch(`${WEB}/app/api/v1/state`, { headers: { authorization: `Bearer ${bearer}` } });
    check("the device token opens the app API", ok.status === 200, `HTTP ${ok.status}`);
    check("and it never sets a cookie", ok.headers.get("set-cookie") === null, String(ok.headers.get("set-cookie")));
    const asCookie = await fetch(`${WEB}/app/api/v1/state`, { headers: { cookie: `__pikvm_session=${bearer}` } });
    check("a device token is not accepted as a cookie", asCookie.status === 401 || asCookie.status === 302, `HTTP ${asCookie.status}`);
    const lists = await fetch(`${WEB}/app/api/v1/devices`, { headers: { authorization: `Bearer ${bearer}` } });
    check("a device cannot list the other devices", lists.status === 401 || lists.status === 403, `HTTP ${lists.status}`);

    const replay = await fetch(`${WEB}/app/auth/device/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "x", verifier: "y" }) });
    check("a made-up code gets nothing", replay.status >= 400, `HTTP ${replay.status}`);

    await page.goto(`${WEB}/app/settings/account`, { waitUntil: "load" });
    await page.waitForFunction(() => /Signed-in desktop apps/.test(document.body.innerText), { timeout: 10000 });
    await shot("account");
    check("Settings > Account lists the signed-in app", true, (await page.evaluate(() => document.body.innerText)).includes("PiKVM Desktop") ? "named" : "listed");

    await page.evaluate(() => {
        [...document.querySelectorAll("button")].find((b) => b.textContent === "Revoke")?.click();
    });
    await page.waitForFunction(() => !/Signed-in desktop apps/.test(document.body.innerText), { timeout: 10000 });
    const after = await fetch(`${WEB}/app/api/v1/state`, { headers: { authorization: `Bearer ${bearer}` } });
    check("Revoke takes the list entry away and the token stops working", after.status === 401, `HTTP ${after.status}`);
} catch (error) {
    check("the run finished", false, `threw: ${error.stack ?? error.message}`);
} finally {
    await browser.close();
}

const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
const today = new Date().toISOString().slice(0, 10);
const md = [
    "# Signing a desktop app in with the browser (end to end)",
    "",
    `Result: ${report.rows.length - report.failed.length} of ${report.rows.length} checks passed.`,
    "",
    "| Check | Result | Observed |",
    "| --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.name} | ${r.pass ? "pass" : "FAIL"} | ${String(r.observed).replace(/\|/g, "/").replace(/\n/g, " ")} |`),
    "",
    "## How this run was made",
    "",
    "```sh",
    `TOKEN=<access token> KVM_WEB=${WEB} PUPPETEER_CORE=${process.env.PUPPETEER_CORE ?? "(default)"} CHROME=${process.env.CHROME ?? "(default)"} \\`,
    "    node apps/web/e2e/device-sign-in.e2e.mjs",
    "```",
    "",
    `- Repository commit: \`${commit}\` (host built with \`yarn workspace @pikvm/web build && yarn build\`).`,
    `- Node ${process.version}. The desktop side is the real \`src/server/sync\` module bundled with esbuild; the host is \`dist/web-server.js\` with \`PIKVM_ACCESS_TOKEN\` set and a scratch data directory.`,
    "- Not covered: the Electron window, a real identity provider, a phone.",
    "",
];
writeFileSync(`${outDir}/${today}-device-sign-in.md`, md.join("\n"));
process.exit(report.failed.length ? 1 : 0);
