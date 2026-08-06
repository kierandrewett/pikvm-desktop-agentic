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
    // The text step advances from inside the fetch's fulfilment handler rather
    // than a bare .then(next), because it now has to inspect r.ok as well — a
    // 4xx/5xx resolves, so the old lone .catch never saw one.
    const textStep = body
        .slice(body.indexOf('if (step.type === "text")'))
        .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(textStep, /\.then\(\s*function \(r\) \{[\s\S]*?next\(\);/);
    assert.doesNotMatch(textStep, /setTimeout\(next, 0\)/);
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
    assert.match(body, /setText\(connText, d\.label \+ inputNote\)/);
    assert.match(body, /conn\.title = d\.label \+ inputNote/);
    // Repainted when the socket changes, not only when the stream state does.
    assert.match(js, /hid\.setStatus\(paintConnStatus\);/);
    // The overlay pill stays about the PICTURE: no input state on it.
    const setState = js.slice(js.indexOf("function setState(s) {"));
    const sbody = setState.slice(0, setState.indexOf("\n    }"));
    assert.match(sbody, /setText\(overlayLabel, d\.label\);/);
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
    // Through setProp now, so an unchanged repaint does not rewrite the attribute.
    assert.match(body, /setProp\(ok, "hidden", problems\.length > 0\);/);
    // But the wording now says which of the two empty states this is.
    assert.match(body, /setText\(ok, health\.reported\(\)\s*\?\s*"Everything looks fine\."\s*:\s*"Nothing reported from the PiKVM yet\."\);/);
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
    assert.match(body, /setText\(note, !o\.online \? "offline" : o\.busy \? "busy" : ""\);/);
    assert.match(body, /setProp\(note, "hidden", !note\.textContent\);/);
});

/**
 * The desktop had no way of saying input was not reaching the Pi.
 *
 * paintConnStatus appends " · input offline" to the connection chip, and its
 * comment explains why that matters: a console whose HID socket has dropped
 * otherwise shows a plain "Live" and looks perfectly healthy while every
 * keystroke and click goes nowhere. But that chip is #conn/#conn-text inside
 * #bar-main — the web/mobile bar, which the desktop console does not paint.
 * Measured at 1200x760 with the socket killed: 45 painted text nodes, not one
 * mentioning it, and no visible title or aria-label carrying it either. The
 * fix had landed on the surface with a chip and not on the one without.
 *
 * It goes in paintHealth rather than health.problems(): that module reports
 * what the PI says, and a socket that is not up is a fact about this client.
 * First in the list, because it is the most actionable thing on it.
 *
 * The signal is "an attempt has RESOLVED and we are not open", not simply
 * "not open" — otherwise every cold start would show an error for as long as
 * the first connection took. Both resolved outcomes count: a socket that
 * worked and stopped, and one refused from the start because kvmd is down or
 * the credentials are wrong. Input is equally dead either way. Measured:
 *
 *     healthy          : no titlebar button, "Everything looks fine."
 *     socket dropped   : button, is-error, "Health: Keyboard and mouse input
 *                        is not reaching the PiKVM", all-clear line hidden
 *     refused from load: same, rather than staying silent
 *     socket back      : button gone, "Everything looks fine." again
 *
 * And no cold-start flash: watched the badge count every frame for 12s across
 * three healthy loads and it never left 0.
 */
test("the desktop says when input is not reaching the Pi", () => {
    const at = js.indexOf("function paintHealth() {");
    assert.ok(at > 0, "paintHealth not found");
    const body = js.slice(at, at + 1800).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(body, /if \(hid\.everSettled\(\) && !hid\.isOpen\(\)\) \{/);
    assert.match(body, /\{ level: "error", text: "Keyboard and mouse input is not reaching the PiKVM" \}\]\.concat\(problems\)/);
    /* Settled means an attempt resolved either way, so a refused socket counts.
     * Anchored on the two handlers rather than a byte offset into the module:
     * this asserted against its first 4000 characters and broke the day a
     * comment was added above them, which is a test failing for a reason that
     * has nothing to do with what it checks. */
    const onopen = js.slice(js.indexOf("ws.onopen = function () {"), js.indexOf("ws.onclose = function () {"));
    assert.match(onopen, /open = true;\s*\n\s*everSettled = true;/);
    const onclose = js.slice(js.indexOf("ws.onclose = function () {"), js.indexOf("ws.onerror = function () {"));
    assert.match(onclose, /open = false;[\s\S]*?everSettled = true;/);
    // And the socket changing has to repaint it, or it would only update when
    // some unrelated health event happened to arrive.
    assert.match(js, /setState\(streamState \|\| "connecting"\);\s*\n[^\n]*\n\s*paintHealth\(\);/);
});

/**
 * A remote image download shows how far it has got.
 *
 * startMsdUpload's own comment says that for a URL the Pi fetches itself,
 * "progress comes back on the msd event rather than from us" — and setState
 * has stored storage.downloading and storage.uploading since it was written
 * with nothing anywhere reading either. So the bar stayed indeterminate and
 * the line stayed "the Pi is downloading it…" for the whole transfer, which
 * for a multi-gigabyte ISO over a slow link is minutes of a dialog that
 * cannot say whether it is nearly done or barely started.
 *
 * The shapes are read defensively rather than pinned to one guess, the same
 * call as the paste keymap picker and for the same reason — this could not be
 * put against a real Pi. Anything without two usable numbers reads as no
 * measurement. Measured against a live upload:
 *
 *     just started, Pi silent : indeterminate, "the Pi is downloading it…"
 *     written/size            : 25%, "25%  ·  954 MB of 3.7 GB"
 *     further along           : 85%
 *     current/total shape     : 98%
 *     only a name, no numbers : back to indeterminate
 *
 * That last one matters and was wrong first time round: it left the bar
 * frozen at 98%, which keeps claiming a measurement we no longer have — the
 * same lie a determinate bar pinned at 0 tells, and the reason this one
 * starts indeterminate at all.
 *
 * Only OUR remote upload moves it. A local file measures itself from
 * xhr.upload.onprogress and would fight over the same bar, and a transfer
 * another client started is not this dialog's to report: with the dialog open
 * and nothing of ours running, a pushed download left the row hidden.
 */
test("a Pi-side image download reports its progress", () => {
    const at = js.indexOf("transfer: function () {");
    assert.ok(at > 0, "no transfer accessor on the msd module");
    const acc = js.slice(at, at + 700);
    // Either pair of names, and nothing without two usable numbers.
    assert.match(acc, /st\.downloading \|\| st\.uploading/);
    assert.match(acc, /typeof t\.written === "number" \? t\.written : typeof t\.current === "number"/);
    assert.match(acc, /typeof t\.size === "number" \? t\.size : typeof t\.total === "number"/);
    assert.match(acc, /if \(done === null \|\| typeof total !== "number" \|\| total <= 0\) return null;/);
    // Painted only for our own remote upload, and honest when the numbers stop.
    const paint = js.slice(js.indexOf("if (msdUpload && msdUploadRemote) {"), js.indexOf("if (msdUpload && msdUploadRemote) {") + 1200)
        .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(paint, /var tr = msd\.transfer\(\);/);
    assert.match(paint, /setMsdProgress\(pct, pct \+ "%  ·  " \+ humanBytes\(tr\.written\) \+ " of " \+ humanBytes\(tr\.size\)\);/);
    assert.match(paint, /\} else \{\s*\n\s*setMsdProgress\(undefined, "the Pi is downloading it…"\);/);
    // Set for a URL, cleared when the upload ends, so a later local one is unaffected.
    assert.match(js, /msdUploadRemote = !picked && !!remote;/);
    assert.match(js, /msdUpload = null;\s*\n\s*msdUploadRemote = false;/);
});

/**
 * A half-built step survives the save that happens while you build it.
 *
 * The server drops any step it cannot use — src/macros.ts cleanStep returns
 * null for a chord with no code, for empty text and for a zero delay, and
 * line 96 filters those out. saveMacros already knows this and holds back a
 * whole MACRO that would not persist, but it stopped there: for a macro the
 * server DOES store, it adopted the server's answer wholesale, and the
 * half-built step inside it was adopted away mid-edit.
 *
 * Every edit saves, so the natural way to build a chord — add the combo, pick
 * the modifiers, then pick the key — deleted itself on the first modifier
 * press:
 *
 *     add key combo : ["text x", "chord key=''"]
 *     press Ctrl    : ["text x"]
 *
 * The step vanished with nothing said, and the only order that worked was key
 * first, which nothing tells you. A new text step and a zero pause go the
 * same way.
 *
 * Re-measured with two drafts, one of them in the middle so the ordering is
 * actually exercised:
 *
 *     combo + new text : ["text(x)","chord(-)","text(-)"]
 *     Ctrl on the combo: ["text(x)","chord(-)","text(-)"]
 *     key picked       : ["text(x)","chord(KeyB)","text(-)"], chord rows = 1
 *
 * So the drafts hold their positions, and finishing one promotes it in place
 * rather than leaving a second copy behind.
 */
test("building a chord does not delete the step you are building", () => {
    const at = js.indexOf("var withDrafts = function (stored, local) {");
    assert.ok(at > 0, "draft steps are not preserved across a save");
    const body = js.slice(at, js.indexOf("var merged = [];", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    // The same rule the whole-macro draft check already mirrors from the server.
    assert.match(body, /if \(!stepWouldPersist\(st\)\) drafts\.push\(\{ at: i, step: st \}\);/);
    // Back where it was, not appended: a macro is a sequence.
    assert.match(body, /steps\.splice\(Math\.min\(d\.at, steps\.length\), 0, d\.step\)/);
    // Nothing to put back means the server's answer is taken unchanged.
    assert.match(body, /if \(!drafts\.length\) return stored;/);
    // And it is actually used by the merge.
    assert.match(js, /merged\.push\(withDrafts\(byId\[m\.id\], m\)\);/);
    // stepWouldPersist still mirrors cleanStep, or the above puts back the wrong things.
    const rule = js.slice(js.indexOf("function stepWouldPersist(step) {"), js.indexOf("function macroWouldPersist"));
    assert.match(rule, /if \(step\.type === "chord"\) return !!step\.code;/);
    assert.match(rule, /if \(step\.type === "delay"\) return Number\(step\.ms\) > 0;/);
});

/**
 * A macro cannot start on top of one that is still playing.
 *
 * runMacro builds a per-run chain with its own step index and nothing stopped
 * a second one starting over the first. The steps then group across runs
 * rather than interleaving cleanly. Fired three times 120ms apart, a macro of
 * "Ctrl+Alt+Delete, pause, type hello, Enter" sent:
 *
 *     CAD  CAD  CAD  hello Enter  hello Enter  hello Enter
 *
 * All three chords before any pause finished, then all three text steps. So
 * the pause — which exists precisely to let the target catch up before
 * anything is typed — was honoured for the first run and defeated for the
 * other two. On a log-in macro that is the password typed into whatever the
 * second and third Ctrl+Alt+Deletes left on screen.
 *
 * A macro is exactly where this happens: the click has no visible consequence
 * on THIS machine, and the toast only appears when the run FINISHES, so during
 * a long one there was nothing at all to say it had started.
 *
 * Measured after, with a 2.5s macro:
 *
 *     idle              : 0 of 20 macro buttons disabled
 *     mid-run           : 20 of 20 disabled
 *     blocked attempt   : still 20 disabled, toast "… is still running"
 *     after it finishes : 0 disabled, toast "… sent"
 *     runs again        : 9 events, same as one clean run
 *
 * and the three-rapid-fire case now produces 9 events rather than 27.
 *
 * The flag is cleared through one done() helper reached by both endings — the
 * chain running out of steps, and a step that failed stopping the run — which
 * is safe because every branch reaches one of them: a chord waits on afterKeys,
 * which drainKeys always fires from a timer whatever the socket is doing; the
 * text step settles its fetch both ways; a delay is a plain timeout. So it
 * cannot stall and leave every macro disabled for good.
 */
test("a second macro cannot start while one is still playing", () => {
    assert.match(js, /var macroRunning = null;/);
    const at = js.indexOf("function runMacro(macro) {");
    assert.ok(at > 0, "runMacro not found");
    const body = js.slice(at, js.indexOf("\n    function ", at + 10)).replace(/\/\*[\s\S]*?\*\//g, "");
    // Refuses, and says so — the send-keys menu has no disabled state to show.
    assert.match(body, /if \(macroRunning\) \{[\s\S]*?toast\(macroRunning\.label \+ " is still running", true\);[\s\S]*?return;/);
    // Claimed on the way in, released in the terminal branch, repainting both times.
    assert.match(body, /macroRunning = macro;\s*\n\s*paintMacroButtons\(\);/);
    assert.match(body, /macroRunning = null;\s*\n\s*paintMacroButtons\(\);/);
    // And the strip shows it, for any macro rather than just the running one.
    const spec = js.slice(js.indexOf("function pinnedMacroSpecs() {"), js.indexOf("function paintMacroButtons()"))
        .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(spec, /disabled: typingBusy\(\) \|\| macroBlocked\(m\),/);
});

/**
 * One click on a GPIO control sends one request.
 *
 * A row's controls are disabled by the Pi's own `busy`, and that does not
 * arrive until the Pi has answered — so between the click and that event every
 * further click went straight out. Three rapid clicks sent three requests:
 *
 *     gpio:pulse:channel=rack_pdu_1
 *     gpio:pulse:channel=rack_pdu_1
 *     gpio:pulse:channel=rack_pdu_1
 *
 * A pulse is a momentary contact closure, so on a relay wired to a power
 * button that is three presses of it. The switch happens to survive — all
 * three read the same stale `on` and asked for the same state — but the pulse
 * has no such luck, and a user channel carries no confirmation to slow the
 * second click down either.
 *
 * The lock is per channel, because two relays are independent and blocking one
 * because another is mid-request would be its own surprise. Measured with 900ms
 * of latency on the endpoint:
 *
 *     idle        : rack pdu 1 -> Pulse,Off        lab relay -> Pulse
 *     mid-request : rack pdu 1 -> Pulse[off],Off[off]   lab relay -> Pulse
 *     released    : rack pdu 1 -> Pulse,Off        lab relay -> Pulse
 *     after a 409 : released just the same
 *
 * Three clicks now send one request, and two deliberate clicks still send two.
 *
 * Releasing on a .then of the returned promise is safe because the module's
 * own .catch is last in its chain, so the promise always resolves — a relay
 * left permanently disabled would be worse than the bug.
 */
test("a GPIO control cannot fire twice before the Pi answers", () => {
    assert.match(js, /var gpioPending = \{\};/);
    const helper = js.slice(js.indexOf("function gpioBusy(name, busy) {"), js.indexOf("function paintGpio()"));
    assert.match(helper, /if \(busy\) gpioPending\[name\] = true;\s*\n\s*else delete gpioPending\[name\];/);
    assert.match(helper, /var mounted = gpioRows\[name\];\s*\n\s*if \(mounted\) mounted\.update\(\);/);
    const specs = js.slice(js.indexOf("function gpioSpecsFor(name, labelId) {"), js.indexOf("function mountRowButtons"))
        .replace(/\/\*[\s\S]*?\*\//g, "");
    // Both controls lock, alongside the Pi's own busy and offline.
    const locked = specs.match(/disabled: o\.busy \|\| !o\.online \|\| !!gpioPending\[name\],/g) ?? [];
    assert.equal(locked.length, 2, "both the pulse and the switch must take the lock");
    // Claimed before the request and released when it settles, either way.
    assert.match(specs, /gpioBusy\(name, true\);\s*\n\s*gpio\.pulse\(name\)\.then\(function \(\) \{\s*\n\s*gpioBusy\(name, false\);/);
    assert.match(specs, /gpioBusy\(name, true\);\s*\n\s*gpio\.switchTo\(name, !cur\.on\)\.then\(function \(\) \{\s*\n\s*gpioBusy\(name, false\);/);
    // The release depends on these always resolving: the .catch is last in both.
    const mod = js.slice(js.indexOf("var gpio = (function () {"), js.indexOf("HID recovery"));
    assert.match(mod, /pulse: function \(name\) \{[\s\S]*?\.catch\(function \(e\) \{[\s\S]*?\}\);\s*\n\s*\},/);
});

/**
 * Only one dialog is up at a time, because everything assumes it.
 *
 * openScrim is written as "THE dialog currently up" and returns the FIRST
 * non-hidden scrim in DOM order; the focus trap, Escape and modalOpen are all
 * built on that being the only one. Nothing enforced it, and the ⋯ menu opens
 * a dialog without closing what is already there.
 *
 * Every scrim carries the same z-index, so with two up the one painted on top
 * is simply the later one in the DOM — while openScrim hands the focus trap
 * the EARLIER one. Opening Stream settings and then System:
 *
 *     open: ["health-dlg","stream-dlg"]   topmost: stream-dlg
 *     focus: health-dlg "Done"            after 6 tabs: still health-dlg
 *     Escape closed health-dlg, leaving stream-dlg up
 *
 * The System dialog sat behind the Stream scrim, dimmed and unreachable by
 * mouse, with the keyboard trapped inside it — so you tab around a dialog you
 * cannot see, and Escape shuts the one you were not looking at.
 *
 * The equal z-index is the proof that stacking was never designed, so the fix
 * makes the singular assumption true rather than teaching four consumers to
 * cope with it. After: opening the second closes the first, focus follows it,
 * Escape closes it and hands focus back to the page. Keys still never reach
 * the target while any dialog is up, and reach it again once none is.
 */
test("opening a dialog closes the one already up", () => {
    const helper = js.slice(js.indexOf("function closeOtherDialogs(keep) {"), js.indexOf("/** The dialog currently up"));
    assert.match(helper, /if \(el !== keep && !el\.hidden\) el\.hidden = true;/);
    /* Every place a dialog is shown has to use it. Found by scanning rather
     * than listing them, so a dialog added later without the call fails here
     * instead of quietly reintroducing the stack. */
    const shows = [...js.matchAll(/^\s*(?:if \(dlg\) \{\s*\n\s*)?(\w+)\.hidden = false;/gm)]
        .filter((m) => /dlg/i.test(m[1]));
    assert.ok(shows.length >= 7, `expected every dialog open site, found ${shows.length}`);
    for (const m of shows) {
        const before = js.slice(Math.max(0, m.index - 200), m.index);
        assert.match(before, new RegExp(`closeOtherDialogs\\(${m[1]}\\);\\s*$`),
            `${m[1]}.hidden = false is not preceded by closeOtherDialogs(${m[1]})`);
    }
    // openScrim is unchanged: first in DOM order is correct once there is only one.
    assert.match(js, /function openScrim\(\) \{[\s\S]*?if \(!scrims\[i\]\.hidden\) return scrims\[i\];/);
});

/**
 * Opening a dialog also ends an armed region pick.
 *
 * The OCR pick is a modal MODE, and none of the dialog machinery covered it.
 * Armed, it survived a dialog opening over it — its "Drag over the text to
 * read · Esc to cancel" hint left drawn behind the scrim, on a screen the
 * scrim had just put out of reach — and it owned Escape, so the first press
 * cancelled the pick nobody could see while the visible dialog stayed up:
 *
 *     pick started  : picking=true,  dialogs=[]
 *     dialog on top : picking=true,  dialogs=["stream-dlg"]
 *     Escape        : picking=false, dialogs=["stream-dlg"]
 *     Escape again  : dialogs=[]
 *
 * Opening a dialog is abandoning the aim, so it ends with the rest. After, the
 * dialog cancels the pick as it opens and the first Escape closes the dialog.
 *
 * The pick's own behaviour is untouched, which is what had to be re-checked:
 * armed from the menu with focus on the page, Escape cancels it, sends nothing
 * to the target, and it re-arms. (With focus still in the conversation iframe
 * the parent document never sees the key at all — that is true of every
 * console shortcut, not this one, and clicking the menu moves focus out.)
 */
test("a dialog opening ends an armed OCR pick", () => {
    const helper = js.slice(js.indexOf("function closeOtherDialogs(keep) {"), js.indexOf("/** The dialog currently up"));
    assert.match(helper.replace(/\/\*[\s\S]*?\*\//g, ""), /endOcrPick\(\);/);
    /* Safe from the OCR dialog's own open only because the pick has already
     * ended by then — ocrPointerUp calls endOcrPick before runOcr, and runOcr
     * is what shows that dialog. If those ever swap, this becomes a no-op that
     * closes the dialog it just opened. */
    const up = js.slice(js.indexOf("function ocrPointerUp(e) {"), js.indexOf("function runOcr("));
    assert.match(up, /endOcrPick\(\);\s*\n\s*runOcr\(left, top, right, bottom\);/);
});

/**
 * A paste cannot land in the middle of a running macro.
 *
 * A paste and a macro are both bulk input to the same target, and overlapping
 * them garbles both — which is the judgement ce3cd25 already made about two
 * macros. Nothing said so here. Started a macro of "Ctrl+Alt+Delete, pause
 * 2.5s, type hello, Enter" and pasted during its pause; the target got:
 *
 *     CAD  INTERLEAVED  hello  Enter
 *
 * so on a log-in macro the pasted text lands in the field before the password
 * does. The macro strip greys out while one runs and the paste dialog did not,
 * so the two said different things about the same busy target.
 *
 * Both halves are needed: Ctrl/Cmd+Enter reaches sendPaste without touching
 * the button, so a disabled spec alone would not hold — the same shape as the
 * send-keys menu route into runMacro. Measured:
 *
 *     no macro        : Paste enabled
 *     macro started   : Paste disabled, live, with the dialog already open
 *     ctrl+enter      : blocked with a toast, 0 pastes sent
 *     macro finished  : Paste enabled again
 *     paste now works : 1 paste sent
 */
test("a paste is held back while a macro is running", () => {
    const spec = js.slice(js.indexOf("function pasteActionSpecs() {"), js.indexOf("function repaintPasteActions()"))
        .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(spec, /disabled: !pasteHasText \|\| pasteBusy \|\| !!macroRunning,/);
    const body = js.slice(js.indexOf("function sendPaste() {"), js.indexOf("function sendPaste() {") + 900)
        .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(body, /if \(macroRunning\) \{[\s\S]*?toast\(macroRunning\.label \+ " is still running", true\);[\s\S]*?return;/);
    /* The open dialog has to follow the macro, not just its own state — the
     * macro can start after the dialog is already up. */
    assert.match(js, /macroRunning = macro;\s*\n\s*paintMacroButtons\(\);\s*\n\s*repaintPasteActions\(\);/);
    assert.match(js, /macroRunning = null;\s*\n\s*paintMacroButtons\(\);\s*\n\s*repaintPasteActions\(\);/);
});

/**
 * Input queued during an outage goes stale rather than firing much later.
 *
 * The queue exists so a momentary blip does not swallow a keystroke — the
 * reconnect is on a 1.2s timer, so the gap it is built for is about a second.
 * It had no age limit, so a blip and a Pi reboot were treated identically.
 * Killed the socket, typed a, b and c (nothing delivered, chip correctly
 * reading "input offline"), waited twenty seconds and let it reconnect:
 *
 *     delivered ON RECONNECT, 20s later:
 *     key:KeyA:true, key:KeyA:false, key:KeyB:true, key:KeyB:false,
 *     key:KeyC:true, key:KeyC:false
 *
 * All six fired at once into whatever the target was showing by then. After a
 * reboot that is characters typed at the old screen landing in a boot menu, a
 * login prompt or a shell — and a macro run during the gap would arrive the
 * same way, whole.
 *
 * A release is never dropped, however old. If the down went out before the
 * socket died and the up is discarded as stale, the target holds that key for
 * good, which is far worse than losing a character. send() already carves out
 * exactly this exception for the agent taking over, so the two now share one
 * predicate rather than two copies that could drift.
 *
 * Re-measured both directions:
 *
 *     20s outage : only key:KeyA:false, key:KeyB:false, key:KeyC:false
 *     0.1s blip  : key:KeyX:true AND key:KeyX:false — the queue still works
 */
test("stale queued input is dropped, but releases never are", () => {
    const mod = js.slice(js.indexOf("var hid = (function () {"), js.indexOf("Transient messages"));
    assert.match(mod, /var QUEUE_STALE_MS = 2000;/);
    // Stamped going in, so age is knowable coming out.
    assert.match(mod, /queue\.push\(\{ at: Date\.now\(\), obj: obj \}\)/);
    // Dropped on the way out only if it is old AND not a release.
    assert.match(mod, /if \(isRelease\(item\.obj\) \|\| now - item\.at < QUEUE_STALE_MS\) raw\(item\.obj\);/);
    // One predicate, shared with the agent carve-out that reasons the same way.
    assert.match(mod, /function isRelease\(obj\) \{[\s\S]*?ev\.state === false && \(obj\.event_type === "key" \|\| obj\.event_type === "mouse_button"\)/);
    assert.match(mod, /if \(agentActing\) \{[\s\S]*?if \(!isRelease\(obj\)\) return;/);
});

/**
 * Closing a dialog hands focus back, however it was closed.
 *
 * The scrim observer saves the opener only when the scrim does not yet contain
 * the active element — and its callback is a microtask, so it runs AFTER the
 * synchronous open. Dialogs that set their own initial focus (health focuses
 * Done, paste focuses the textarea, MSD the image picker, the log its seek)
 * had already moved focus by then, the save was skipped, and closing them
 * restored nothing. Measured from a titlebar button:
 *
 *     focus before : "Fit to native resolution (1280 x 720)"
 *     Escape out   : "Fit to native resolution (1280 x 720)"   restored
 *     Done out     : "BODY"                                    lost
 *
 * The same action gave two answers depending only on whether that dialog
 * happened to focus something on open. Landing on BODY is worse than losing
 * your place: BODY is the state where keystrokes go to the TARGET, so the next
 * thing typed after Done went to the remote machine.
 *
 * Captured in closeOtherDialogs instead, which every open path already calls
 * before hidden is cleared and before any focus() of its own. Guarded on
 * nothing being open yet, so opening a second dialog keeps the focus from
 * before the FIRST rather than parking it on a control about to be hidden.
 *
 * All six dialogs now restore, by Escape and by their own button, and opening
 * one over another then closing returns to the anchor from before either.
 */
test("closing a dialog returns focus to whatever opened it", () => {
    const body = js.slice(js.indexOf("function closeOtherDialogs(keep) {"), js.indexOf("/** The dialog currently up"))
        .replace(/\/\*[\s\S]*?\*\//g, "");
    // Through focusAnchor now, which maps a ⋯ menu item to the button that owns
    // the menu — the item is hidden by the same click and cannot take focus back.
    assert.match(body, /if \(!openScrim\(\)\) focusBeforeModal = focusAnchor\(\);/);
    // It has to come before anything is hidden or shown.
    assert.ok(body.indexOf("focusBeforeModal = focusAnchor()") < body.indexOf("querySelectorAll"),
        "focus must be captured before the scrims are touched");
    // The observer still restores it, and still does not clobber a saved anchor.
    assert.match(js, /if \(!focusBeforeModal\) focusBeforeModal = focusAnchor\(\);/);
    assert.match(js, /\} else if \(!scrim && focusBeforeModal\) \{[\s\S]*?restore\.focus\(\);/);
});

/**
 * An armed sticky modifier says so, not just looks it.
 *
 * These are the modifiers in the touch drawer: tap Ctrl, then tap a key, and
 * the chord goes out. Whether Ctrl is armed decides what the NEXT tap does, and
 * that state was carried by a CSS class alone. Measured through the
 * accessibility tree on an armed button:
 *
 *     class "ibtn on"
 *     role=button  properties=["invalid=false","focusable=true"]
 *     aria-pressed / aria-checked / aria-label: all null
 *
 * So the one thing that changes the meaning of the next tap existed only as a
 * colour. On a phone this drawer is the ONLY way to send a modifier, so there
 * is no other route to check it either.
 *
 * aria-pressed rather than a switch role, matching the audio and mic toggles in
 * the titlebar, which are the same kind of control — a local intent you flip.
 * The GPIO rows use role=switch because they report a REMOTE thing's state.
 *
 * After, the same query returns:
 *
 *     role=button name="Ctrl" properties=[…,"pressed=true"]
 *
 * and the chord is unchanged: arming Ctrl then tapping Esc still sends
 * ControlLeft:true, Escape:true, Escape:false, ControlLeft:false.
 */
test("a sticky modifier's armed state reaches assistive technology", () => {
    const paint = js.slice(js.indexOf("function paintMod(codeName, on) {"), js.indexOf("document.querySelectorAll(\"[data-key]\")"))
        .replace(/\/\*[\s\S]*?\*\//g, "");
    // The class and the state are set from the same argument, so they cannot drift.
    assert.match(paint, /btn\.classList\.toggle\("on", on\);/);
    assert.match(paint, /btn\.setAttribute\("aria-pressed", on \? "true" : "false"\);/);
    /* And it is a toggle before it is first pressed — otherwise the first press
     * is the first time anything says the control has two states. */
    const wire = js.slice(js.indexOf('document.querySelectorAll("[data-mod]").forEach'), js.indexOf("var lastTap = 0;"))
        .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(wire, /btn\.setAttribute\("aria-pressed", armed\[codeName\] \? "true" : "false"\);/);
});

/**
 * The drawer's other two toggles announce their state as well.
 *
 * 7c4530c gave the sticky modifiers an aria-pressed and stopped there. Two
 * siblings in the same drawer had the same gap — state carried by the "on"
 * class and nothing else. Measured through the accessibility tree with each
 * turned on, against the fixed Ctrl button as a control:
 *
 *     Ctrl        class "ibtn on"  state=pressed=true
 *     drag lock   class "ibtn on"  state=  NONE
 *     keyboard    class "ibtn on"  state=  NONE
 *
 * Drag lock matters most of the three: it latches the target's LEFT BUTTON
 * DOWN, so whether it is on decides if the next tap drags or clicks — and the
 * target is holding a button the whole time it is engaged.
 *
 * They take different attributes because they are different controls. Drag lock
 * flips a setting, so aria-pressed like the modifiers. The keyboard button
 * DISCLOSES the drawer, so aria-expanded, plus aria-controls naming the region
 * it opens. After:
 *
 *     drag lock   state=pressed=true
 *     keyboard    state=expanded=true,controls=drawer
 *
 * The audio and mic entries were checked too and are NOT part of this: their
 * pip is inside the button, so "Audio output Off" is the accessible name and
 * the state is already in it, which is what paintToggle's comment describes.
 */
test("the drag lock and keyboard drawer announce their state", () => {
    const drag = js.slice(js.indexOf('var dragBtn = document.getElementById("drag-lock");'),
                          js.indexOf("function refocusKbd()")).replace(/\/\*[\s\S]*?\*\//g, "");
    // Announced before first use, and kept in step with the class after.
    const dragSets = drag.match(/dragBtn\.setAttribute\("aria-pressed", dragLock \? "true" : "false"\);/g) ?? [];
    assert.equal(dragSets.length, 2, "drag lock must announce on init and on toggle");
    assert.match(drag, /dragBtn\.classList\.toggle\("on", dragLock\);\s*\n\s*dragBtn\.setAttribute\("aria-pressed"/);
    const kbd = js.slice(js.indexOf('var kbdBtn = document.getElementById("kbd-btn");'),
                         js.indexOf('/* ---- size the split')).replace(/\/\*[\s\S]*?\*\//g, "");
    // A disclosure, not a setting: expanded, and it names what it opens.
    assert.match(kbd, /kbdBtn\.setAttribute\("aria-controls", "drawer"\);/);
    assert.match(kbd, /kbdBtn\.setAttribute\("aria-expanded", app\.classList\.contains\("keys-open"\) \? "true" : "false"\);/);
    assert.match(kbd, /kbdBtn\.classList\.toggle\("on", openK\);\s*\n\s*kbdBtn\.setAttribute\("aria-expanded", openK \? "true" : "false"\);/);
    assert.doesNotMatch(kbd, /aria-pressed/);
});

/**
 * The overflow menu says whether it is open, from every route that closes it.
 *
 * Measured against the keys drawer, which does announce, the button said
 * nothing in either state:
 *
 *     more     name="More"      state=NONE      (closed AND open)
 *     drawer   name="Controls"  state=expanded=false / expanded=true
 *
 * and the menu itself was a bare div with no role and no name, so a screen
 * reader met thirty-five buttons with nothing to say what they belonged to or
 * that anything had opened.
 *
 * aria-expanded and a label, NOT role="menu". The menu is walked with Tab, not
 * arrow keys — checked, ArrowDown does not move between items — so claiming
 * menu semantics would promise a keyboard model that is not implemented. A
 * labelled group of real buttons is what it actually is.
 *
 * The state routes through ONE helper because FOUR places close this menu: the
 * button, picking an item, a tap outside, and Escape. An attribute added to
 * some of them goes stale on the others — which is the same mistake as fixing
 * one of three sibling toggles. Verified all four leave the class and the
 * attribute agreeing:
 *
 *     closed by the button       open=false expanded=false
 *     closed by an item          open=false expanded=false
 *     closed by tapping outside  open=false expanded=false
 *     closed by Escape           open=false expanded=false
 */
test("the overflow menu's open state cannot drift from its button", () => {
    const at = js.indexOf("if (moreBtn && moreMenu) {");
    assert.ok(at > 0, "the overflow menu is not wired");
    const body = js.slice(at, js.indexOf('window.addEventListener("resize"', at)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // One helper owns the class, the announced state and — added later — giving
    // focus back before the items are hidden. Anchored on the two writes being
    // adjacent rather than on the whole body, so the helper can grow.
    assert.match(body, /function setMenuOpen\(open\) \{[\s\S]*?moreMenu\.classList\.toggle\("open", open\);\s*\n\s*moreBtn\.setAttribute\("aria-expanded", open \? "true" : "false"\);/);
    /* And nothing bypasses it. This is the assertion that matters: a fifth
     * close path added later must go through the helper or fail here. */
    assert.doesNotMatch(body, /moreMenu\.classList\.(remove|add)\("open"\)/);
    const closes = body.match(/setMenuOpen\(false\)/g) ?? [];
    assert.equal(closes.length, 3, "the item, outside and Escape paths must all close through the helper");
    assert.match(body, /if \(setMenuOpen\(!moreMenu\.classList\.contains\("open"\)\)\) placeMenu\(\);/);
    // Named, and pointing at what it opens — but not pretending to be a menu.
    assert.match(body, /moreMenu\.setAttribute\("aria-label", "More actions"\);/);
    assert.match(body, /moreBtn\.setAttribute\("aria-controls", moreMenu\.id \|\| "more-menu"\);/);
    assert.doesNotMatch(body, /role", "menu"/);
});

/**
 * The health dialog stops rewriting what has not changed.
 *
 * paintHealth runs on every info, hid and streamer event, and a real Pi sends
 * those constantly. Two things in it were rewritten unconditionally.
 *
 * The About line is the one anyone selects — hostname, kvmd and streamer
 * versions, the string you paste into a bug report — and reassigning a text
 * node destroys any selection inside it. Measured with the line selected and
 * four unrelated hid events pushed:
 *
 *     about rewrites: 4      selection: "" (gone)
 *
 * So the string you were half way through copying vanished the moment the Pi
 * reported anything at all. The problem list was torn down and rebuilt the
 * same way, several times a second.
 *
 * Both now compare first, using the data-set key idiom the GPIO rows and the
 * image picker already use. Re-measured with four IDENTICAL hid events:
 *
 *     about rewrites: 0   problem-list rebuilds: 0   selection intact
 *
 * and real changes still land — a detached HID adds its problem, an
 * undervoltage adds a second and moves the temperature, clearing both empties
 * the list and updates the line.
 *
 * The first version of this test looked like it had failed: the list still
 * rebuilt three times. Those four events alternated `connected`, which genuinely
 * changes the problem set — the guard was working and the fixture was not
 * holding anything still.
 */
test("the health dialog only rewrites what actually changed", () => {
    const about = js.slice(js.indexOf("function paintAbout() {"), js.indexOf("health.onChange(paintHealth);"))
        .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(about, /setText\(el, bits\.join\("  ·  "\)\);/);
    // The empty case too, or a Pi that reports nothing rewrites "" for ever.
    assert.match(about, /setText\(el, ""\);/);
    const list = js.slice(js.indexOf('var list = document.getElementById("health-list");'), js.indexOf("paintGpio();"))
        .replace(/\/\*[\s\S]*?\*\//g, "");
    // Keyed on level AND text, so a warning becoming an error still rebuilds.
    assert.match(list, /return p\.level \+ ":" \+ p\.text;/);
    assert.match(list, /if \(list\.getAttribute\("data-set"\) !== listKey\) \{\s*\n\s*list\.setAttribute\("data-set", listKey\);\s*\n\s*list\.innerHTML = "";/);
});

/**
 * Repaints write text only when it differs.
 *
 * The repaint functions run on every kvmd event — info, hid, streamer, msd,
 * gpio — and a real Pi sends those constantly. Reassigning textContent
 * replaces the text node even when the string is identical, which throws away
 * any selection inside it and, in a live region, announces again. Swept the
 * document with a MutationObserver while pushing five rounds of IDENTICAL
 * state, with each dialog open in turn:
 *
 *     health-ok          30 rewrites
 *     health-hid-state   30
 *     sp-*-value         15 each
 *     msd-status          5
 *     msd-free            5
 *
 * none of which had changed. b767219 fixed two of these one at a time; this is
 * the same rule in one helper, so the next repaint added here gets it by
 * default rather than by someone remembering. After: every one of those is 0.
 *
 * Deliberately NOT applied to paths that rebuild on a user action — the macro
 * editor list, the log body — which rebuild wholesale by design.
 */
test("repaint paths do not rewrite unchanged text", () => {
    const helper = js.slice(js.indexOf("function setText(el, text) {"), js.indexOf("function toast("));
    assert.match(helper, /if \(el && el\.textContent !== text\) el\.textContent = text;/);
    /* Every repaint that writes a status string goes through it. Listed by the
     * element each one targets, so a bare write reintroduced at any of these
     * fails here rather than being caught by another MutationObserver sweep. */
    for (const call of [
        /setText\(status, msd\.summary\(\)\);/,
        /setText\(free, f === null \? "" : humanBytes\(f\) \+ " free"\);/,
        /setText\(ok, health\.reported\(\)/,
        /setText\(stateEl, busy \? word \+ "  ·  busy" : word\);/,
        /setText\(note, !o\.online \? "offline"/,
        /setText\(val, text\);/,
        /setText\(connText, d\.label \+ inputNote\);/,
        /setText\(overlayLabel, d\.label\);/,
        /setText\(el, bits\.join\("  ·  "\)\);/,
    ]) assert.match(js, call);
});
