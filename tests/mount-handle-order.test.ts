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

/**
 * Every getElementById in the console has to resolve to something.
 *
 * Moving the dialog actions onto the shared component library swapped their
 * `id` for `data-tb`, and three lookups were left behind pointing at ids that
 * no longer exist. They do not throw — getElementById returns null and the
 * guarded code simply stops happening — so the loss is invisible.
 *
 * One of them mattered: the health dialog focused its Done button on open, and
 * with that lookup dead the focus fell through to the first focusable in the
 * dialog, which on a V4 is the USB power breaker. Pressing Enter to dismiss a
 * dialog is muscle memory, and that is not the control it should land on.
 */
test("no console lookup points at an element that cannot exist", () => {
    const html = readFileSync(resolve(process.cwd(), "src/views/console.html"), "utf8");
    const inMarkup = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
    // Elements this file builds get their id assigned at runtime, whole or by prefix.
    const assigned = new Set([...js.matchAll(/\.id\s*=\s*"([\w-]+)"/g)].map((m) => m[1]));
    const prefixes = [...js.matchAll(/\.id\s*=\s*"([\w-]+)"\s*\+/g)].map((m) => m[1]);

    const unresolvable = [...new Set([...js.matchAll(/getElementById\("([\w-]+)"\)/g)].map((m) => m[1]))]
        .filter((k) => !inMarkup.has(k) && !assigned.has(k) && !prefixes.some((p) => k.startsWith(p)));

    assert.deepEqual(unresolvable, [], `these lookups can never resolve: ${unresolvable.join(", ")}`);

    /* The same trap through querySelectorAll. [data-add-step] survived the move
     * of the macro editor's step actions onto the shared library, matching
     * nothing and quietly duplicating addStep() where it could have drifted. */
    const attrSelectors = [...js.matchAll(/querySelectorAll?\(\s*"\[([\w-]+)\]"\s*\)/g)].map((m) => m[1]);
    const attrUnresolvable = [...new Set(attrSelectors)].filter(
        (a) => !html.includes(`${a}=`) && !js.includes(`setAttribute("${a}"`) && !js.includes(`"${a}",`),
    );
    assert.deepEqual(
        attrUnresolvable,
        [],
        `nothing ever carries these attributes: ${attrUnresolvable.join(", ")}`,
    );
});

test("the health dialog opens focused on Done, not on a power switch", () => {
    // Looked up across all three ways a dialog control can be drawn, because the
    // id form stopped resolving the moment the actions moved to the library.
    assert.match(js, /var close = dialogControl\("health-close"\);/);
    assert.match(js, /document\.querySelector\('\[data-tb="' \+ key \+ '"\]'\)/);
    assert.match(js, /document\.querySelector\('\[data-fk="' \+ key \+ '"\]'\)/);
});

/**
 * The resolution toast carries a 🔊 / 🎙 badge, and audioOn defaults to true
 * and deliberately SURVIVES a WebRTC drop so a re-watch does not wipe the
 * user's choice. Read straight, that meant the badge claimed audio on an MJPEG
 * stream — which has none — and on a Pi with no Janus at all, on every toast it
 * ever showed.
 *
 * The console already draws this line for the toggles themselves, so the badge
 * has to draw it too.
 */
test("the resolution toast only claims audio when a WebRTC session carries it", () => {
    const summary = js.slice(js.indexOf("function avSummary()"));
    // Comments in here NAME the flags while explaining them, so strip them
    // before asking which the code reaches first.
    const body = summary.slice(0, summary.indexOf("\n    }")).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(body, /if \(!webrtcActive\) return "";/);
    // The guard has to come before the flags are read, or it is decoration.
    assert.ok(
        body.indexOf("webrtcActive") < body.indexOf("audioOn"),
        "avSummary reads audioOn before checking that WebRTC is live",
    );
});

/**
 * The three guards that decide when this window may write to somebody's server.
 *
 * Verified behaviourally against a live MJPEG stream, with the console's
 * websocket terminating at a test harness rather than a PiKVM: a click on the
 * screen sends mouse_move + two mouse_button with no dialog open and sends
 * NOTHING with one open; a pointer move sends mouse_move while focused and
 * nothing while the window is in the background; and a held ControlLeft is
 * followed by ControlLeft:false the moment the window backgrounds, so
 * alt-tabbing cannot leave a modifier stuck down on the target.
 *
 * None of that can run in this suite, which is node-only. What it can do is
 * refuse to let the guards be deleted — which is the realistic regression, and
 * a silent one, because dropping a guard makes the console send MORE, not
 * fewer, events.
 */
test("input is refused while a modal owns the keyboard", () => {
    // Every entry point into the KVM input path checks it, not just the first.
    const guards = [...js.matchAll(/if \(modalOpen\(\)\) return;/g)];
    assert.ok(guards.length >= 4, `only ${guards.length} modalOpen guards on the input path`);
});

test("a background window neither moves the pointer nor holds a modifier down", () => {
    assert.match(js, /if \(window\.desktopConsole && !windowFocused\) return;/);
    // Releasing on blur is what stops alt-tab leaving Ctrl down on the target.
    const focusFn = js.slice(js.indexOf("function applyWinFocus(focused)"));
    const body = focusFn.slice(0, focusFn.indexOf("\n        }"));
    assert.match(body, /if \(!focused\) \{[\s\S]*releaseClickMods\(\);[\s\S]*releaseAllMods\(\);/);
});

/**
 * Hiding the target preview stops the keyboard too.
 *
 * The desktop keydown handler already refuses to forward when the window is in
 * the background or a modal is up — both of which mean the user is not looking
 * at the target. A collapsed preview is the same thing and was the one case
 * missing, and it left the two halves of the input path disagreeing: with the
 * screen at zero width no pointer event can reach it, so the mouse was already
 * off while the keyboard carried on.
 *
 * Verified in the natural flow — click the picture to take the keyboard, so
 * focus is on BODY and this handler is the live path — with the console's
 * websocket terminating at a test harness: keys forward with the preview
 * shown, stop when it is collapsed, and forwarded before this guard existed.
 */
test("a hidden target preview stops the keyboard reaching the target", () => {
    // Several keydown listeners exist; anchor on the desktop one's own comment.
    const at = js.indexOf("// Desktop keyboard: forward PHYSICAL keystrokes straight to the KVM.");
    assert.ok(at > 0, "desktop keydown handler not found");
    const body = js.slice(at, js.indexOf("\n        });", at));
    assert.match(body, /if \(!panelShown\(\)\) \{[\s\S]*?releaseAllMods\(\);[\s\S]*?return;/);
    // Alongside the two it already had, not instead of them.
    assert.match(body, /if \(!windowFocused\) return;/);
    assert.match(body, /if \(modalOpen\(\)\) \{/);
});

/**
 * The web/mobile overflow menu has to fit the screen it opens on.
 *
 * placeMenu clamps where the menu STARTS so it cannot open off-screen, but
 * nothing stopped it being taller than the viewport. At thirteen items it is
 * 490px and a phone in landscape has about 390px of height, so the clamp
 * pinned it to its 8px margin and the last three items — Reset among them —
 * sat below the fold with overflow:visible and no way to reach them.
 *
 * Measured at 844x390, 740x360, 667x375 and 430x480: every one cut off the
 * same 108px. With a cap the menu now ends inside the viewport, and the last
 * item comes into view either by scrolling or by tabbing to it.
 */
test("the overflow menu can never be taller than the screen", () => {
    const css = readFileSync(resolve(process.cwd(), "src/views/console.css"), "utf8");
    const at = css.indexOf(".more-menu {");
    const rule = css.slice(at, css.indexOf("}", at));
    assert.match(rule, /max-height:\s*calc\(100dvh - 16px\)/);
    // vh first, dvh second: dvh has to win where it is supported, and on a
    // phone vh is the tallest chrome state rather than the current one.
    assert.ok(
        rule.indexOf("100vh") < rule.indexOf("100dvh"),
        "the dvh max-height must come after the vh fallback to override it",
    );
    assert.match(rule, /overflow-y:\s*auto/);
});

/**
 * A macro's steps have to happen one after another.
 *
 * sendChord is fire-and-forget: it queues, and drainKeys plays the chord out
 * over several timeouts, so it returns long before the keys have been sent.
 * runMacro advanced on setTimeout(next, 0), which started the NEXT step while
 * the modifiers were still held down on the target.
 *
 * Measured against a test harness recording both HID paths, with a macro of
 * "Ctrl+Alt+Delete, then type hi":
 *   before  ControlLeft:true AltLeft:true print:hi Delete:true Delete:false ...
 *   after   ControlLeft:true AltLeft:true Delete:true Delete:false AltLeft:false
 *           ControlLeft:false print:hi
 * The text used to be typed inside the chord, so the target received
 * Ctrl+Alt+h and Ctrl+Alt+i instead of "hi".
 */
test("a macro's chord step finishes before the next step starts", () => {
    const fn = js.slice(js.indexOf("function runMacro(macro)"));
    const body = fn.slice(0, fn.indexOf("\n    }"));
    // Comments here NAME the old call while explaining it, so strip them before
    // asserting it is gone — otherwise the assertion reads the prose.
    const chord = body
        .slice(body.indexOf('if (step.type === "chord")'))
        .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(chord, /afterKeys\(next\)/);
    assert.doesNotMatch(chord, /setTimeout\(next, 0\)/);

    // afterKeys is only honest if something actually fires the waiters.
    const drain = js.slice(js.indexOf("function drainKeys()"));
    assert.match(drain.slice(0, drain.indexOf("var op =")), /keyDrained\.splice\(0, keyDrained\.length\)/);

    // The other two step types already waited for themselves; they still must.
    assert.match(body, /\.then\(next\);/);
    assert.match(body, /setTimeout\(next, step\.ms\);/);
});
