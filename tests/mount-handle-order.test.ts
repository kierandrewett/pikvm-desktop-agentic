import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const js = readFileSync(resolve(process.cwd(), "src/views/console.js"), "utf8");

/**
 * The console mounts its dialog buttons from shared components and keeps the
 * returned handle in a `var`, then repaints through it. That only works while
 * the DECLARATION runs before the assignment.
 *
 * `var` hoists the name but not the initialiser, so a `var handle = null;`
 * sitting further down the file executes when control reaches it — after the
 * wiring that already filled it in. It sets the handle back to null, every
 * later repaint sees null and returns, and the buttons freeze at whatever
 * state they happened to mount with. Nothing throws. The mass storage dialog
 * shipped like that: Reset drive was permanently disabled and Mount/Unmount
 * never tracked the drive.
 *
 * Checked statically rather than through the DOM because the failure is the
 * ORDER of two lines, and a runtime test would need the real load sequence to
 * reproduce it at all.
 */
test("a mount handle is never re-initialised after it has been assigned", () => {
    const declaration = /^[ \t]*var[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*null[ \t]*;/gm;
    const offenders: string[] = [];

    for (const match of js.matchAll(declaration)) {
        const name = match[1];
        const declaredAt = match.index ?? 0;
        // An assignment to the same name that is not itself a declaration.
        const assignment = new RegExp(`(?<!var[ \\t]+)\\b${name}[ \\t]*=[ \\t]*mount(DialogActions|RowButtons)\\(`, "g");
        for (const use of js.matchAll(assignment)) {
            if ((use.index ?? 0) < declaredAt) offenders.push(name);
        }
    }

    assert.deepEqual(
        offenders,
        [],
        `mounted before declared, so the declaration wipes the handle: ${offenders.join(", ")}`,
    );
});

/** The five mass storage body buttons are drawn by the shared library, not by
 *  hand-written markup poked at from paintMsd. */
test("the mass storage dialog draws its body buttons from state", () => {
    const html = readFileSync(resolve(process.cwd(), "src/views/console.html"), "utf8");
    for (const id of ["msd-connect", "msd-disconnect", "msd-remove", "msd-upload", "msd-abort", "log-refresh"]) {
        assert.doesNotMatch(html, new RegExp(`<button[^>]*id="${id}"`), `${id} is still hand-written markup`);
    }
    assert.match(js, /msdDriveActions = mountDialogActions\("msd-drive-actions"/);
    assert.match(js, /msdUploadActions = mountDialogActions\("msd-upload-actions"/);
    assert.match(js, /mountDialogActions\("log-refresh-host"/);
});

/**
 * The console and the shared component library both define a colour palette.
 * The library's token block is emitted UNLAYERED, so it outranks console.css's
 * :root on document order — which once left the theme toggle resolving light
 * and dark to identical values, with the whole window stuck light.
 *
 * The library keys its palette off a `dark` class, so applying the theme has to
 * set that class, and color-scheme has to out-specify the library's :root.
 */
test("the theme is applied in the form the shared library reads", () => {
    const css = readFileSync(resolve(process.cwd(), "src/views/console.css"), "utf8");
    assert.match(js, /classList\.toggle\("dark", t === "dark"\)/);
    assert.match(css, /html\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark/);
    assert.match(css, /html\[data-theme="light"\]\s*\{\s*color-scheme:\s*light/);
});

/**
 * A frame that mounts after the theme was applied has missed the broadcast, so
 * both of ours ask for it on mount. The desktop block answers that — but the
 * whole block is skipped in a browser, and the browser is exactly where the
 * terminal panel is used. The reply has to exist outside it too.
 */
test("a frame asking for the theme is answered on every platform", () => {
    const desktopBlockAt = js.indexOf("(function desktopConsole() {");
    assert.ok(desktopBlockAt > 0, "desktop block not found");

    // Both handlers compare rather than construct: `d.type === "subscribe"` in
    // the desktop block, `d.type !== "subscribe"` as an early return in the
    // common one. Match the comparison, not a literal property.
    const replies = [...js.matchAll(/d\.type [!=]== "subscribe"/g)].map((m) => m.index ?? 0);
    assert.ok(replies.length >= 1, "nothing answers a subscribe");
    assert.ok(
        replies.some((at) => at < desktopBlockAt),
        "the only subscribe handler is inside the desktop-only block, so web and mobile never get an answer",
    );
});
