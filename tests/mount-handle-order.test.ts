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

/**
 * An armed sticky modifier has to apply to the mouse buttons too.
 *
 * sendCode wraps a KEY in armedList() and clears it afterwards. The drawer's
 * click and scroll buttons did neither, so Ctrl+click — how you multi-select
 * almost anywhere — sent a bare click and left the Ctrl armed for whatever came
 * next. On a touch device that drawer is the only way to click at all, so there
 * was no other route to the gesture.
 *
 * Measured against a harness recording the HID socket:
 *   before  mouse_button mouse_button                      (Ctrl still armed)
 *   after   ControlLeft:true mouse_button mouse_button ControlLeft:false
 * and unchanged for keys, plus Ctrl+scroll now wraps the wheel and a
 * double-tap-locked modifier survives click after click.
 */
test("an armed modifier wraps the drawer's clicks and scrolls", () => {
    const clicks = js.slice(js.indexOf('document.querySelectorAll("[data-click]")'));
    assert.match(clicks.slice(0, clicks.indexOf("});")), /withArmedMods\(/);
    const scrolls = js.slice(js.indexOf('document.querySelectorAll("[data-scroll]")'));
    assert.match(scrolls.slice(0, scrolls.indexOf("});")), /withArmedMods\(/);

    const helper = js.slice(js.indexOf("function withArmedMods(act)"));
    const body = helper.slice(0, helper.indexOf("\n    }")).replace(/\/\*[\s\S]*?\*\//g, "");
    // Pressed before the action, cleared like a key, released after it.
    assert.match(body, /modMirror\.owned\(armedList\(\)\)/);
    assert.match(body, /clearArmed\(\)/);
    assert.ok(body.indexOf("clearArmed()") < body.indexOf("act("), "armed must be cleared before the action runs");
});

/**
 * The SCREEN's two click paths have to honour an armed modifier too.
 *
 * A commit earlier taught the drawer's own buttons this; the picture itself
 * still did not. pressClickMods built its list from the pointer event, so it
 * saw physical modifiers and never the armed ones, and the touch path went
 * through tapClick which had no modifier handling at all.
 *
 * Touch is the case that matters: on a phone there IS no physical Ctrl, so
 * arming it and tapping the picture was the only route to Ctrl+click, and it
 * sent a bare click.
 *
 * Recorded against a harness watching the HID socket:
 *   mouse, armed   before  mouse_move mouse_button mouse_button
 *                  after   mouse_move ControlLeft:true mouse_button
 *                          mouse_button ControlLeft:false
 *   touch, armed   after   ControlLeft:true mouse_button mouse_button
 *                          ControlLeft:false
 * Unchanged: a plain click sends no modifiers, a physical ctrl+click still
 * works, physical AND armed presses ControlLeft once rather than twice, and a
 * ctrl+drag holds it across every move until pointerup.
 */
test("a click on the picture honours an armed modifier, by mouse and by touch", () => {
    const press = js.slice(js.indexOf("function pressClickMods(e)"));
    const body = press.slice(0, press.indexOf("\n    }")).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(body, /armedList\(\)\.forEach/);
    assert.match(body, /clearArmed\(\);/);
    // Deduped: a modifier held physically AND armed must be pressed once.
    assert.match(body, /if \(m\.indexOf\(a\) < 0\) m\.push\(a\);/);

    const tap = js.slice(js.indexOf("function tapClick(button)"));
    assert.match(tap.slice(0, tap.indexOf("\n    }")), /withArmedMods\(/);
});

/**
 * Pinned macros have to be runnable where there is no titlebar.
 *
 * The titlebar carries them on the desktop and does not exist on web or
 * mobile, but the editor is reachable everywhere — so on a phone a macro could
 * be created, named, given an icon and ticked "Show in the titlebar", and then
 * never fired. Nothing outside that titlebar could run one: the only other
 * caller of runMacro is the desktop menu's macro: dispatch.
 *
 * Verified on the web surface with the titlebar display:none and tb-macros
 * empty: the overflow menu now lists the pinned macros after the editor entry,
 * clicking one sends its steps, and the menu closes behind it.
 */
test("the web overflow menu can run a pinned macro, not only edit them", () => {
    const html = readFileSync(resolve(process.cwd(), "src/views/console.html"), "utf8");
    assert.match(html, /id="macro-run-list"/);
    assert.match(html, /id="macro-run-sep"/);

    const fn = js.slice(js.indexOf("function paintMacroMenu()"));
    const body = fn.slice(0, fn.indexOf("\n    }")).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(body, /m\.pinned !== false/);
    assert.match(body, /runMacro\(m\)/);
    // The separator goes with them, so an empty list leaves no stray rule.
    assert.match(body, /sep\.hidden = !pinned\.length/);

    // And it repaints with the titlebar rather than needing its own trigger.
    const paint = js.slice(js.indexOf("function paintMacroButtons()"));
    assert.match(paint.slice(0, paint.indexOf("\n    }")), /paintMacroMenu\(\)/);
});

/**
 * Losing the window mid-drag has to release what is held, on every platform.
 *
 * These listeners sat inside the desktopConsole block, which returns early at
 * `if (!dc) return;` — so on web and mobile they were never registered. Tab or
 * app away mid-drag and the left button and any click modifiers stayed down on
 * the target, with no pointerup ever coming to clear them.
 *
 * Measured on the web path: mouse_button down and ControlLeft down while held,
 * then NOTHING on blur. Now the button and the modifier both come back up, and
 * the desktop — which also drives this from the main process's window focus —
 * still releases exactly once, since both helpers check what is actually held
 * before sending.
 */
test("a blur releases held input outside the desktop-only block", () => {
    const desktopBlockAt = js.indexOf("(function desktopConsole() {");
    assert.ok(desktopBlockAt > 0, "desktop block not found");
    for (const fn of ["releaseAllMods", "releaseHeldMouseButtons", "releaseClickMods"]) {
        const at = js.indexOf(`window.addEventListener("blur", ${fn});`);
        assert.ok(at > 0, `nothing releases ${fn} on blur`);
        assert.ok(
            at < desktopBlockAt,
            `${fn} is only released inside the desktop-only block, so web and mobile never get it`,
        );
    }
});

/**
 * "input offline" has to be visible, not only in a tooltip.
 *
 * The connection chip put the note in the title attribute alone, so a console
 * whose HID socket had dropped read a plain "Live" and looked healthy while
 * every keystroke and click went nowhere. A tooltip is the wrong home for it:
 * there is no hover on a phone at all, and on the desktop it means resting on
 * an 8px dot to find out why nothing works.
 *
 * hid.setStatus existed and nothing subscribed to it, so the socket coming or
 * going changed nothing on screen until some unrelated stream transition
 * happened to repaint.
 *
 * Verified against a harness that drops the socket server-side and refuses the
 * reconnect: with input measurably not arriving, the chip reads
 * "Live · input offline" and returns to "Live" on recovery, fitting the bar at
 * 390 and 320px wide with no clipping.
 */
test("the connection chip shows input being offline, not just its tooltip", () => {
    const fn = js.slice(js.indexOf("function paintConnStatus()"));
    const body = fn.slice(0, fn.indexOf("\n    }")).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(body, /connText\.textContent = d\.label \+ inputNote/);
    assert.match(body, /conn\.title = d\.label \+ inputNote/);
    // Repainted when the socket changes, not only when the stream state does.
    assert.match(js, /hid\.setStatus\(paintConnStatus\);/);
    // The overlay pill stays about the PICTURE: no input state on it.
    const setState = js.slice(js.indexOf("function setState(s) {"));
    const sbody = setState.slice(0, setState.indexOf("\n    }"));
    assert.match(sbody, /overlayLabel\.textContent = d\.label;/);
});

/**
 * A rejected stream change has to put its control back.
 *
 * sendStreamParam toasted the failure and left the slider sitting at the value
 * that had just been refused: ask for 60% quality, get a 409, and the dialog
 * went on reading 60% while the Pi stayed at 80. Nothing corrected it later —
 * kvmd only emits a streamer event when something really changes, so a
 * rejected change produces no update at all.
 *
 * Measured against a harness answering 409: before, slider 60 / readout "60%"
 * beside a toast saying it failed; after, slider 80 / readout "80%" with the
 * same toast. The accepted path is unchanged — the value stays where the user
 * put it and still stands once the Pi confirms it.
 */
test("a refused stream setting snaps back to what the Pi has", () => {
    const fn = js.slice(js.indexOf("function sendStreamParam(name, value)"));
    const body = fn.slice(0, fn.indexOf("\n    }")).replace(/\/\*[\s\S]*?\*\//g, "");
    // Both answers: a non-ok status and a thrown request.
    assert.equal((body.match(/revertStreamControls\(\);/g) || []).length, 2);
    assert.match(body, /if \(r\.ok\) return;/);

    // And it reverts by repainting from the Pi's applied state, not by guessing.
    const revert = js.slice(js.indexOf("function revertStreamControls()"));
    assert.match(revert.slice(0, revert.indexOf("\n    }")), /paintStreamDialog\(\);/);
});

/**
 * A network error on a drive setting has to say so, and put the control back.
 *
 * msd.setParam had no .catch, where its neighbour setConnected does. An HTTP
 * error toasted and RESOLVED, so the caller's .then(paintMsd) still ran and the
 * control snapped back to the drive's real setting. A network error did
 * neither: the promise rejected, nothing was said at all, and the select kept
 * showing the value that never arrived.
 *
 * Measured with the request blocked at the network layer: before, the mode read
 * CD/DVD with no toast while the drive was still a flash drive; after, it reads
 * flash drive with "Mass storage: Failed to fetch". Which of the two it is
 * decides what the target boots.
 */
test("a drive setting that never reached the Pi says so and snaps back", () => {
    const fn = js.slice(js.indexOf("setParam: function (name, value)"));
    const body = fn.slice(0, fn.indexOf("\n            },")).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(body, /\.catch\(function \(e\) \{/);
    // Resolving rather than rethrowing is what lets the caller's repaint run.
    assert.match(body, /return false;/);
    assert.doesNotMatch(body, /throw /);
    // Both callers still repaint from the drive's state rather than the click.
    assert.match(js, /msd\.setParam\("cdrom", mode\.value === "1" \? 1 : 0\)\.then\(paintMsd\)/);
    assert.match(js, /msd\.setParam\("rw", rw\.checked \? 1 : 0\)\.then\(paintMsd\)/);
});

/**
 * A toast may not claim an outcome the Pi has not confirmed.
 *
 * setConnected said "Mounted on the target" the moment its request returned
 * 200. That is kvmd ACCEPTING the request, not the drive being connected —
 * the msd event confirms that separately. So a success toast sat on screen
 * beside a dialog still reading "Ready to mount", with the Mount button still
 * offered: two things contradicting each other at once, and the toast was the
 * one that could turn out wrong.
 *
 * This file already words its other in-flight actions honestly — "the Pi is
 * downloading it…", "Reading the screen…", and ATX saying "sent" rather than
 * claiming the machine powered off.
 *
 * Measured: the toast now reads "Mounting on the target…" while the dialog
 * still says "Ready to mount", and the dialog alone reports the outcome once
 * kvmd confirms. Failures are unchanged and still say what went wrong.
 */
test("mounting reports what was asked for, not an outcome it cannot know", () => {
    const fn = js.slice(js.indexOf("setConnected: function (on)"));
    const body = fn.slice(0, fn.indexOf("\n            },")).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(body, /"Mounting on the target…"/);
    assert.match(body, /"Unmounting…"/);
    // The outcome claim is gone.
    assert.doesNotMatch(body, /"Mounted on the target"/);
    // The failure still names what failed and its status.
    assert.match(body, /"Could not " \+ \(on \? "mount" : "unmount"\) \+ " \(" \+ r\.status/);
});

/**
 * Attaching and detaching reports what was asked for, like mounting does.
 *
 * setHidConnected said "Keyboard and mouse detached" on its 200, which is kvmd
 * taking the request — the hid event reports what actually happened. So the
 * toast sat beside a row still reading "attached" and a button still offering
 * to Detach, in the same dialog.
 *
 * Measured: after clicking Detach the toast reads "Detaching the keyboard and
 * mouse…" while the row still says attached, and the row alone flips once the
 * Pi confirms.
 *
 * Left alone deliberately: "Image deleted" stays an outcome claim. A file
 * unlink is synchronous where a USB gadget connect is not, so a 200 there
 * plausibly does mean deleted, and the image list lagging is event latency
 * rather than the dialog contradicting itself.
 */
test("attach and detach report the request, not a state the Pi has not sent", () => {
    const fn = js.slice(js.indexOf("function setHidConnected(on)"));
    const body = fn.slice(0, fn.indexOf("\n    }")).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(body, /"Attaching the keyboard and mouse…"/);
    assert.match(body, /"Detaching the keyboard and mouse…"/);
    assert.doesNotMatch(body, /"Keyboard and mouse (attached|detached)"/);
    // The failure still names the action and its status.
    assert.match(body, /"Could not " \+ \(on \? "attach" : "detach"\)/);
});

/**
 * The console's own controls have to keep their own keystrokes.
 *
 * The desktop keydown forwarder exempted INPUT, TEXTAREA and SELECT and
 * nothing else, so a focused BUTTON was captured and forwarded like any other
 * key — and handleKeydown calls preventDefault, which stops the browser doing
 * what it would have done. Measured on the desktop path with the socket
 * terminating at a test harness:
 *
 *   Enter on the titlebar's panel toggle  did not toggle it, and sent
 *                                         Enter:true/false to the target
 *   Tab from any console button           did not move focus, and sent Tab
 *
 * So a control could be focused and then neither activated nor left — the
 * titlebar, the macros and the window controls were unreachable by keyboard,
 * and every attempt typed into the remote machine instead.
 *
 * After: Enter toggles the panel and sends nothing, Tab walks the titlebar and
 * sends nothing, and the two things that must not change still hold — clicking
 * the picture blurs to BODY and typing goes to the target, while a dialog's
 * text field keeps its own keys.
 */
test("a focused console control keeps its keystrokes instead of forwarding them", () => {
    const at = js.indexOf("// Desktop keyboard: forward PHYSICAL keystrokes straight to the KVM.");
    assert.ok(at > 0, "desktop keydown handler not found");
    const body = js.slice(at, js.indexOf("\n        });", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    // Anything that can hold focus is a control whose keys are its own.
    assert.match(body, /t\.closest\(FOCUSABLE\)/);
    // The old list named three tags and missed every button.
    assert.doesNotMatch(body, /t\.tagName === "INPUT"/);
    // FOCUSABLE is the set the dialog focus traps already use.
    assert.match(js, /var FOCUSABLE = 'button:not\(\[disabled\]\), \[href\]/);
});

/**
 * A control the user has not touched is not "busy".
 *
 * controlBusy exists for a real reason: a native <select> shuts its dropdown
 * the moment anything rewrites it, and kvmd pushes MSD and streamer state
 * continuously, so a dialog that repainted on every event closed its own list
 * under the pointer. But it treated plain FOCUS as the signal, and a dialog
 * hands its first control focus as it opens — so the MSD image picker was
 * frozen from the moment the dialog appeared, before the user had touched
 * anything. Open Mass storage against empty storage, then finish an upload:
 *
 *     dialog open, storage empty : focus=msd-image, "no images uploaded"
 *     two images arrive          : focus=msd-image, "no images uploaded"
 *     2.5s later                 : focus=msd-image, "no images uploaded"
 *     after focus moves off      : 3 options, "— select an image —"
 *
 * The images were there and the picker said there were none, with nothing on
 * screen to say the way out was to click elsewhere. The stream dialog's
 * resolution select and its sliders go through the same helper.
 *
 * A press is what opens a dropdown or starts a drag, so that is the signal
 * now. Re-measured: the picker fills the instant the images arrive while it
 * still holds focus, and pressing it still defers — pushed a second image
 * while engaged and the option list stayed put, then caught up to three on
 * blur. So the original protection survives.
 */
test("controlBusy defers for a control being worked, not one merely focused", () => {
    const at = js.indexOf("function controlBusy(el, repaint) {");
    assert.ok(at > 0, "controlBusy not found");
    const body = js.slice(at, js.indexOf("\n    function paintMsd()", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    // Focus on its own no longer makes a control busy.
    assert.doesNotMatch(body, /if \(!el \|\| document\.activeElement !== el\) return false;/);
    assert.match(body, /document\.activeElement !== el \|\| el\.getAttribute\("data-engaged"\) !== "1"/);
    // A press or a key is what marks it engaged; both open a list or move a slider.
    assert.match(body, /addEventListener\("pointerdown", engage\)/);
    assert.match(body, /addEventListener\("keydown", engage\)/);
    // And letting go clears it, alongside the catch-up repaint that already ran on blur.
    assert.match(body, /removeAttribute\("data-engaged"\)/);
    assert.match(body, /el\.removeAttribute\("data-catchup"\);\s*\n\s*repaint\(\);/);
});

/**
 * A macro's icon can be taken off again.
 *
 * The grid was the twenty-two named icons and nothing else, and the click
 * handler assigns macro.icon unconditionally, so choosing one was a one-way
 * door. A macro made, seen in the titlebar as its initials, then given the
 * power icon, could never go back to the initials — and "no icon" is not an
 * invalid state, it is the state every new macro starts in and the one
 * macroGlyph is written to render.
 *
 * It was odd as a radiogroup too: the grid carries role="radiogroup", opened
 * with nothing checked on a new macro, and had no choice that could return it
 * there. Measured on a macro seeded with an icon name that is not in the grid:
 *
 *     on open              : 23 choices, checked []
 *     after choosing power : checked ["power"],   titlebar draws the svg
 *     after choosing none  : checked ["No icon"], titlebar draws "SH" again
 *
 * The choice previews its own effect — macroGlyph with no icon is what the
 * titlebar would draw, the macro's first two letters — rather than showing an
 * abstract "off" mark that says nothing about the result.
 */
test("the macro icon grid can return a macro to no icon", () => {
    const at = js.indexOf('var icons = document.getElementById("macro-icons");');
    assert.ok(at > 0, "macro icon grid not found");
    const body = js.slice(at, js.indexOf('var steps = document.getElementById("macro-steps");', at))
        .replace(/\/\*[\s\S]*?\*\//g, "");
    // Checked only when there is genuinely no icon — an unrecognised one is neither.
    assert.match(body, /var iconSet = typeof macro\.icon === "string" && macro\.icon\.trim\(\) !== "";/);
    assert.match(body, /noIcon\.setAttribute\("aria-checked", String\(!iconSet\)\)/);
    // Same role as its twenty-two siblings, so the group has a reachable "none".
    assert.match(body, /noIcon\.setAttribute\("role", "radio"\)/);
    // Previews the fallback the titlebar uses rather than an abstract off mark.
    assert.match(body, /noIcon\.textContent = macroGlyph\(\{ icon: "", label: macro\.label \}\)/);
    assert.match(body, /macro\.icon = "";/);
    // And it is actually in the grid, ahead of the named icons.
    assert.match(body, /icons\.appendChild\(noIcon\);\s*\n\s*MACRO_ICON_NAMES\.forEach/);
});

/**
 * An empty problem list is not a clean bill of health.
 *
 * The all-clear line showed whenever nothing was wrong, and nothing is
 * "wrong" before the Pi has said a word — so the dialog opened claiming
 * "Everything looks fine." directly above a row reading "state unknown", and
 * went on claiming it through an outage with the socket dead:
 *
 *     connected, nothing reported : claimsFine=true, problems=[]
 *     socket killed               : claimsFine=true, problems=[]
 *     8s after the outage         : claimsFine=true, problems=[]
 *
 * Two different states — nothing wrong, and nothing known — were both being
 * reported as the good one. All three of the health module's inputs start
 * null and only an event fills them, so which it is IS knowable.
 *
 * Re-measured across the three states: socket down and nothing heard reads
 * "Nothing reported from the PiKVM yet."; events flowing with no problems
 * reads "Everything looks fine."; and an undervoltage flag hides the line and
 * lists "The Pi is undervolted — check the power supply and cable".
 */
test("the health dialog does not claim all-clear before the Pi has reported", () => {
    const at = js.indexOf('var ok = document.getElementById("health-ok");');
    assert.ok(at > 0, "health-ok is not painted");
    const body = js.slice(at, at + 1400).replace(/\/\*[\s\S]*?\*\//g, "");
    // Still hidden by a real problem, as before.
    assert.match(body, /ok\.hidden = problems\.length > 0;/);
    // But the wording now says which of the two empty states this is.
    assert.match(body, /ok\.textContent = health\.reported\(\)\s*\?\s*"Everything looks fine\."\s*:\s*"Nothing reported from the PiKVM yet\.";/);
    // reported() is the "have we heard anything at all" signal, not a problem count.
    const mod = js.slice(js.indexOf("reported: function () {"));
    assert.match(mod.slice(0, 120), /return !!\(info \|\| source \|\| hidState\);/);
});

/**
 * The paste keymap picker offered one keymap however many the Pi had.
 *
 * kvmd's hid_keymaps carries `available` as a MAP of name -> details. This
 * read it as an array, so `.length` was undefined, the guard fell through to
 * the default-only branch every time, and `avail.length < 2` then disabled the
 * control. Pushed an event carrying four keymaps:
 *
 *     available {en-us, en-gb, de, fr} -> options ["en-us"], disabled
 *
 * So typing into a target with a different layout was impossible, and it did
 * not fail loudly — it looked like a Pi with nothing to offer.
 *
 * Both shapes are accepted rather than trading one assumption for the other,
 * since a list of names is the other reasonable thing to send and this could
 * not be put against a real Pi. Measured across four states:
 *
 *     kvmd's map shape : ["de","en-gb","en-us","fr"] enabled, value en-gb
 *     a list of names  : ["de","en-us","fr"]         enabled, value de
 *     only a default   : ["en-us"]                   disabled, still shown
 *     nothing at all   : select and label hidden
 *
 * And the choice reaches the wire: picking a non-default keymap and pasting
 * sent /api/hid/print?limit=0&keymap=de&delay=0.02 with the text as the body.
 */
test("the paste keymap picker lists every keymap the Pi reports", () => {
    const at = js.indexOf("function fillKeymaps() {");
    assert.ok(at > 0, "fillKeymaps not found");
    const body = js.slice(at, js.indexOf("\n    function closePaste()", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    // A map's keys are names; an array already is names. Neither is assumed.
    assert.match(body, /Array\.isArray\(supplied\)/);
    assert.match(body, /Object\.keys\(supplied\)/);
    // Deterministic order, not whatever order the keys serialised in.
    assert.match(body, /avail\.sort\(\);/);
    // The default is what the Pi types with, so it is always in the list.
    assert.match(body, /if \(km\["default"\] && avail\.indexOf\(km\["default"\]\) < 0\) avail\.unshift\(km\["default"\]\);/);
    // Unchanged: one keymap is still worth showing, none still hides the control.
    assert.match(body, /pasteKeymap\.disabled = avail\.length < 2;/);
    assert.match(body, /pasteKeymap\.hidden = !avail\.length;/);
});

/**
 * A GPIO channel that is offline says so, instead of just going grey.
 *
 * Both `busy` and `!online` disable a row's controls, and with nothing on
 * screen but a greyed switch the two were indistinguishable — one is a fault
 * that stays, the other clears on its own. For a channel wired to a PDU or a
 * relay, "the button does not work and I cannot tell why" is the whole
 * problem. Pushed a five-channel scheme:
 *
 *     USB power to the target  note=""         ["On"]
 *     atx power                note=""         ["Pulse"]
 *     rack pdu 1               note=""         ["Pulse","On"]
 *     lab relay                note="busy"     ["Off" disabled]
 *     offline thing            note="offline"  ["Off" disabled]
 *
 * The note uses .dlg-hint, which is the same shape the keyboard/mouse row in
 * this dialog already uses for "state unknown", so it reads as one pattern
 * rather than a second invention.
 *
 * It is written in the LIVE pass, not when the rows are built: paintGpio only
 * rebuilds when the channel set changes, so a note set at build time would
 * have frozen at whatever the state was when the channel first appeared.
 */
test("a GPIO row distinguishes offline from busy", () => {
    const at = js.indexOf("function paintGpio() {");
    assert.ok(at > 0, "paintGpio not found");
    const body = js.slice(at, js.indexOf("function gpioSpecsFor(", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    // Built with the row, cleared with the row.
    assert.match(body, /note\.className = "dlg-hint";/);
    assert.match(body, /gpioNotes\[o\.name\] = note;/);
    assert.match(body, /gpioRows = \{\};\s*\n\s*gpioNotes = \{\};/);
    // And written on every repaint, beside the mounted.update() that repaints
    // the controls — the two states have different words.
    assert.match(body, /note\.textContent = !o\.online \? "offline" : o\.busy \? "busy" : "";/);
    assert.match(body, /note\.hidden = !note\.textContent;/);
});
