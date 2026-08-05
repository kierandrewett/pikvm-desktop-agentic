import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/* Resolved against the working directory, not __dirname: the runner bundles
   each test into a temporary directory, so __dirname is not the repo. */

/**
 * The Settings window's PiKVM URL field hides the inline password until the
 * field is focused.
 *
 * Two things can go wrong here, and neither one announces itself.
 *
 * The first is masking too much. The pattern has to tell a password apart from
 * a port, and `https://pikvm:8443/` looks a lot like `https://user:pass@host/`
 * up to the colon. Masking a port would show the user a URL they never typed.
 *
 * The second is worse: the input's value is the MASKED text while the field is
 * unfocused, so saving `urlEl.value` writes the dots into the config as the
 * password. The app then relaunches and cannot connect, and the real password
 * is gone. `realUrl` is the source of truth precisely to prevent that.
 *
 * Compared as source text because the page is a plain browser script.
 */

const html = () =>
    readFileSync(resolve(process.cwd(), "src/views/settings-console.html"), "utf-8");

/** Rebuild the page's masking function from its own source. */
function maskFromSource(): (value: string) => string {
    const source = html();
    const pattern = source.match(/var PASSWORD_IN_URL = (\/.*\/i);/)?.[1];
    assert.ok(pattern, "PASSWORD_IN_URL not found in settings-console.html");
    const mask = source.match(/var MASK = ("(?:\\u2022)+");/)?.[1];
    assert.ok(mask, "MASK not found in settings-console.html");
    const body = source.match(/function maskPassword\(value\) \{([\s\S]*?)\n {12}\}/)?.[1];
    assert.ok(body, "maskPassword not found in settings-console.html");
    // Build-time evaluation of checked-in literals, not runtime input.
    return eval(`(function () {
        var PASSWORD_IN_URL = ${pattern};
        var MASK = ${mask};
        return function (value) {${body}};
    })()`) as (value: string) => string;
}

test("the password is masked, and nothing else is", () => {
    const mask = maskFromSource();
    const dots = "•".repeat(8);

    assert.equal(mask("https://admin:secret@pikvm/"), `https://admin:${dots}@pikvm/`);
    assert.equal(mask("http://u:p@host:8443/path"), `http://u:${dots}@host:8443/path`);

    // A port is not a password.
    assert.equal(mask("https://pikvm:8443/"), "https://pikvm:8443/");
    // Nothing to hide.
    assert.equal(mask("https://pikvm/"), "https://pikvm/");
    assert.equal(mask("https://admin@pikvm/"), "https://admin@pikvm/");
    assert.equal(mask("https://admin:@pikvm/"), "https://admin:@pikvm/");
    assert.equal(mask(""), "");
    assert.equal(mask("not a url"), "not a url");

    // A fixed run of dots, so the masked form does not leak the real length.
    assert.equal(mask("https://a:x@h/"), mask("https://a:averylongpassword@h/"));
});

test("saving reads the real URL, never the field's displayed value", () => {
    const source = html();

    // The field shows dots while unfocused; saving what it displays would write
    // them into the config as the password.
    assert.doesNotMatch(
        source,
        /urlEl\.value\.trim\(\)/,
        "save must read realUrl, not the (possibly masked) input value",
    );
    assert.match(source, /var value = realUrl\.trim\(\);/, "save should read realUrl");
    // Typing has to keep the source of truth up to date, or edits are lost.
    assert.match(source, /realUrl = urlEl\.value;/, "the input handler should update realUrl");
});

test("the field cannot be edited while it is still showing dots", () => {
    const source = html();

    /* Chromium sets activeElement WITHOUT firing focus when the window itself is
       unfocused (observed in the running app via CDP). Revealing on focus alone
       therefore leaves a window where the field is editable but masked, and the
       first keystroke would store the mask as the password. */
    for (const event of ["focus", "pointerdown", "keydown"]) {
        assert.match(
            source,
            new RegExp(`urlEl\\.addEventListener\\("${event}", reveal\\)`),
            `reveal should be bound to ${event}, so it runs before any edit lands`,
        );
    }

    // And a backstop in case an edit still arrives masked.
    assert.match(
        source,
        /if \(urlEl\.value\.indexOf\(MASK\) !== -1\) \{/,
        "the input handler should refuse to store the mask as the password",
    );
});

test("the password is re-hidden when the window goes to the background", () => {
    // The field can still hold focus while the window is behind something else,
    // which is precisely when a revealed password should not be on screen.
    assert.match(
        html(),
        /window\.addEventListener\("blur", hide\)/,
        "leaving the window should re-mask the password",
    );
});

test("the field is not focused on open, because focus reveals the password", () => {
    // Focusing the field on a validation failure is right, and is the ONLY
    // focus() the page should carry. A second one is the autofocus coming back.
    const source = html();
    const focuses = source.match(/urlEl\.focus\(\)/g) ?? [];
    assert.equal(focuses.length, 1, "the URL field should only be focused when validation fails");
});

test("the settings window can measure the height it actually needs", () => {
    /* Main sizes this window once after load by reading
     * documentElement.scrollHeight. Pinned to height:100% the body cannot grow
     * past the viewport, so content needing more overflows THROUGH the bottom
     * padding and the measurement comes back exactly one padding short — the
     * window opened with Save and Cancel flush against its bottom edge.
     * Measured before and after: 371px tall with 0px below the buttons, then
     * 389px with the declared 18px. */
    const html = readFileSync(resolve(process.cwd(), "src/views/settings-console.html"), "utf8");
    assert.match(html, /body \{ margin: 0; min-height: 100%; \}/);
    assert.doesNotMatch(html, /html, body \{ margin: 0; height: 100%; \}/);
    // The padding that has to survive the measurement.
    assert.match(html, /padding: 18px 20px;/);

    // And main still measures rather than guessing a fixed height.
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    assert.match(main, /executeJavaScript\("document\.documentElement\.scrollHeight"\)/);
    assert.match(main, /if \(wanted > height\) settingsWin\.setContentSize\(width, wanted\);/);
});

/**
 * Settings is a separate BrowserWindow, so it cannot read the console's theme
 * choice out of localStorage. Main remembers what the console last reported and
 * hands it over synchronously, or Settings opens black over a light console —
 * the one part of the app that ignored the setting.
 */
test("the settings window follows the console's theme", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const preload = readFileSync(resolve(process.cwd(), "src/preload-settings.ts"), "utf8");

    // Remembered on report, and used when the window is built.
    assert.match(main, /consoleTheme = theme;/);
    assert.match(main, /darkTheme: consoleTheme === "dark"/);
    assert.match(main, /backgroundColor: THEME_BG\[consoleTheme\]/);
    // Pushed to an already-open Settings rather than only applied at open.
    assert.match(main, /settingsWin\.webContents\.send\("settings:theme", theme\)/);
    // Synchronous, so the first frame is already the right theme.
    assert.match(preload, /theme: \(\) => ipcRenderer\.sendSync\("settings:theme"\)/);

    const html = readFileSync(resolve(process.cwd(), "src/views/settings-console.html"), "utf8");
    assert.match(html, /:root\[data-theme="light"\]/);
    // No colour left hardcoded in a rule: every one comes from a token.
    const rules = html.slice(html.indexOf("</style>") - 4000, html.indexOf("</style>"));
    assert.doesNotMatch(rules, /background:\s*#0a0a0c/);
    assert.doesNotMatch(rules, /color:\s*#e6e6ea/);
});
