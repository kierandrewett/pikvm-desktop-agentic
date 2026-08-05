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

/**
 * prefers-reduced-motion is about things that TRAVEL, not about colour.
 *
 * The console already quieted its spinner, dialog rise and menu, but the three
 * largest movements in the window were missed: the split animating its height,
 * the conversation panel sliding in, and the toasts sliding as they appear.
 * All three are live on the web and mobile path, where the desktop layout's
 * own `transition: none` does not apply.
 */
test("reduced motion stops the things that travel", () => {
    const css = readFileSync(resolve(process.cwd(), "src/views/console.css"), "utf8");
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{/g)].map((m) => {
        let depth = 1;
        let i = m.index! + m[0].length;
        while (depth > 0 && i < css.length) {
            if (css[i] === "{") depth++;
            else if (css[i] === "}") depth--;
            i++;
        }
        return css.slice(m.index! + m[0].length, i);
    });
    const all = blocks.join("\n");

    for (const sel of [".app", ".chat", ".toast", ".res-toast"]) {
        assert.ok(
            new RegExp(`(^|[,\\s])\\${sel}(\\.[\\w-]+)?\\s*[,{]`, "m").test(all),
            `${sel} moves but nothing quiets it under reduced motion`,
        );
    }
    // The toasts keep a crossfade rather than losing their feedback entirely,
    // and lose the offset with it so they cannot jump the distance they slid.
    assert.match(all, /transform:\s*translate\(-50%,\s*0\)/);
    assert.match(all, /transition:\s*opacity/);
});

/**
 * The legacy native UI (PIKVM_NATIVE_UI=1) had an "Agent sidebar" button left
 * over from before the agent moved out of the app. src/sidebar was deleted,
 * agent.svg with it, but the button, its icon reference and the whole
 * sidebar:toggle path survived — so pressing it grew the window, shrank the
 * KVM view by the same amount and left an empty band with nothing in it.
 *
 * The second half matters more than the first: ui.html reads every control it
 * touches out of the DOM once and uses them inside onState, which fires on
 * every window-state update. A getElementById that returns null there throws
 * and takes the rest of the handler with it — the fit, maximise and minimise
 * buttons stop updating too.
 */
test("the legacy titlebar has no controls it cannot resolve", () => {
    const html = readFileSync(resolve(process.cwd(), "src/views/ui.html"), "utf8");
    const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");

    const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
    const script = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));
    for (const m of script.matchAll(/getElementById\("([\w-]+)"\)/g)) {
        assert.ok(ids.has(m[1]), `ui.html reads #${m[1]} but no element has that id`);
    }

    // The dead path is gone rather than merely hidden.
    assert.doesNotMatch(html, /sidebar:toggle/);
    assert.doesNotMatch(html, /agent\.svg/);
    assert.doesNotMatch(main, /ipcMain\.on\("sidebar:toggle"/);
    // sidebarWidth stays: it is the detached conversation window's width now.
    assert.match(main, /width: Math\.max\(760, sidebarWidth\)/);
});
