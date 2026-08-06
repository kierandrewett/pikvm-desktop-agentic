import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/* Macros: the editor, the step list, the icon picker, the pinned strip in
   the titlebar, and what happens when one is playing. Third and last lift
   out of desktop-layout.test.ts, which had grown to 121 tests across eight
   subjects. */
const root = process.cwd();
const css = readFileSync(resolve(root, "src/views/console.css"), "utf8");
const html = readFileSync(resolve(root, "src/views/console.html"), "utf8");
const js = readFileSync(resolve(root, "src/views/console.js"), "utf8");

test("pinned macros cannot push the window controls off the titlebar", () => {
    /* Macros are the one cluster with no upper bound — a user can pin as many
     * as they like. A flex item defaults to min-width:auto, so the strip refused
     * to shrink below its content and shoved its siblings instead: measured with
     * fifteen macros in a 900px window (this app's minimum), maximise and close
     * sat at x=892 and x=925 against a 900px viewport. Gone. The window could
     * not be closed from its own titlebar.
     *
     * min-width:0 on the strip is not enough on its own — the cluster AROUND it
     * was flex:none, so it kept its content width and overflowed regardless of
     * what its children permitted. Both have to give. */
    /* This asserted the presence of min-width:0 and overflow:hidden and stopped
     * there, which is why it passed while the bug was live. Neither does
     * anything until something asks the box to be smaller than its content, and
     * the cluster rule above set flex:none on it — flex-shrink:0 — so nothing
     * ever did. Re-measured with forty pinned macros, the strip was 1329px wide
     * at 1400px, 1100px and 900px alike: through the window controls and 499px
     * past the right edge. So the shrink itself is the thing to pin. */
    assert.match(css, /\.tb-macros \{[^}]*flex: 0 1 auto;[^}]*min-width: 0;[^}]*overflow: hidden;/);
    assert.match(css, /\.tb-right \{\s*\n\s*flex: 0 1 auto;\s*\n\s*min-width: 0;/);
    /* And the shrink has to land on the macros ALONE. Flexbox shares it out
     * across every shrinkable sibling, and the .tb-shared hosts had no rule at
     * all, so they took a share they could not afford: a block box of
     * inline-flex buttons has a min-content width of one button, so a
     * two-button host went 60x30 -> 30x60 and wrapped onto a second row of a
     * 38px bar, spilling 12px above the window edge and 11px over the video. */
    assert.match(css, /\.tb-shared,\s*\n\s*html\.desktop-console \.tb-sep \{\s*\n\s*flex: none;/);
    // The window controls are what is being protected, so they never give ground.
    assert.match(css, /\.tb-window \{[^}]*flex: none;/);
});

test("the macro step list survives its own repaint with focus intact", () => {
    /* Every modifier press saves, and every save repaints the whole list, so
     * building one chord means several rebuilds in a row. Two things have to
     * hold for focus to come back to the button you just pressed.
     *
     * The render must be synchronous — React schedules rather than performs, so
     * a scheduled render leaves the lookup searching a DOM that is not written
     * yet. That is flushSync in the shared mount.
     *
     * And where focus IS must be read before anything is unmounted. Dropping the
     * roots destroys the focused button, so asking afterwards always answers
     * "the body" — measured: focusKept false, with the toggle itself working
     * perfectly, which is exactly how this hides. */
    assert.match(js, /var active = document\.activeElement;[\s\S]{0,400}?dropStepRoots\(\);/);
    assert.doesNotMatch(js, /dropStepRoots\(\);\s*\n\s*var active = document\.activeElement;/);
    // Roots are tracked so a rebuild cannot orphan them.
    assert.match(js, /function dropStepRoots\(\)/);
    assert.match(js, /stepRoots\.push\(shared\.mountButtons\(mods, modSpecs\)\)/);
    // Either attribute, so a row can mix drawn and hand-built controls.
    assert.match(js, /\[data-fk="' \+ key \+ '"\]/);
    assert.match(js, /\[data-tb="' \+ key \+ '"\]/);
});

test("the macro step rows are drawn by the shared library", () => {
    /* The reorder pair and Remove, which finishes the step list. The reorder
     * buttons needed an accessible name separate from their label — "↑" is a
     * glyph, not a name — so the spec carries one.
     *
     * Focus follows the STEP through a reorder rather than staying at the index,
     * so a second press keeps moving the same step instead of whatever slid into
     * the slot under the pointer. */
    // Named, because "↑" is a glyph. It says which step as well now, like every
    // other control in the row — asserted in full further down.
    assert.match(js, /ariaLabel: "Move step " \+ \(index \+ 1\) \+ \(delta < 0 \? " up" : " down"\),/);
    assert.match(js, /pendingMacroFocus = \(delta < 0 \? "u" : "n"\) \+ to;/);
    assert.match(js, /stepRoots\.push\(sharedRow\.mountButtons\(actions, actionSpecs\)\)/);
    // A fallback for the window before the bundle has run: buttons drawn the old
    // way beat a row with none. Shared with the dialog rows, which hit the same
    // problem harder — a dialog with no buttons has no Done either.
    assert.match(js, /renderPlainButtons\(actions, actionSpecs\)/);
    assert.doesNotMatch(js, /var move = function \(delta, label\)/);
});


test("a macro tabbed to at the clip edge is scrolled fully into view", () => {
    const at = js.indexOf('macroHost.addEventListener("focusin"');
    assert.ok(at > 0, "no focusin handler on the macro strip");
    const body = js.slice(at, at + 400);
    // "nearest" both ways: the minimum scroll, and nothing when already whole.
    assert.match(body, /scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/);
    // Only for buttons in this strip, so a focus elsewhere never moves it.
    assert.match(body, /macroHost\.contains\(btn\)/);
});

test("a macro whose text step is refused stops and says so", () => {
    // A 4xx/5xx RESOLVES a fetch, so the lone .catch on this call never saw one:
    // with kvmd answering 500 the run finished and toasted "<macro> sent" — a
    // positive claim that the text reached the target when nothing was typed.
    // Measured over CDP: HTTP 500 received, "Short 0 sent" shown.
    assert.match(js, /if \(r\.status === 413\) \{\s*stopped\("that step is too much text to type in one go"\);/);
    assert.match(js, /if \(!r\.ok\) \{\s*stopped\("text step failed \(" \+ r\.status \+ "\)"\);/);
    assert.match(js, /stopped\("text step failed: " \+ \(e && e\.message \? e\.message : "network error"\)\)/);
    // The rejection handler is the second argument to then, not a trailing
    // .catch — otherwise a throw inside next() is reported as a failure to type.
    assert.doesNotMatch(js, /\.catch\(function \(\) \{\s*toast\("Macro text failed to send", true\);/);
    // A failed step ends the run: the later steps assume it landed. Verified on
    // the wire — the seeded chord/delay/text/Enter macro sent Ctrl+Alt+Delete
    // and then no Enter, against a healthy control that sent both.
    assert.match(js, /var stopped = function \(problem\) \{\s*var left = macro\.steps\.length - i;/);
    assert.match(js, /" later step" \+ \(left === 1 \? "" : "s"\) \+ " not sent\."/);
    // Both endings clear macroRunning through one helper, so a stopped run
    // cannot leave every macro button disabled for good.
    assert.match(js, /var done = function \(\) \{\s*macroRunning = null;\s*paintMacroButtons\(\);\s*repaintPasteActions\(\);\s*\};/);
    const raw = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // One assignment inside runMacro (done), plus the declaration.
    assert.equal(
        (raw.match(/(?<!var )macroRunning = null;/g) ?? []).length,
        1,
        "macroRunning is cleared in exactly one place",
    );
});

test("the macro editor stacks instead of hiding its buttons on a phone", () => {
    /* Two columns stop being two columns long before the dialog runs out of
       room. Measured at a 390px viewport, via the overflow menu on the web
       path: the grid resolved to 140px + 156px and the step-action row measured
       431px inside that 156px column, so Add key combo, Add text, Add pause and
       Delete macro sat outside it — reachable only by dragging a nested box
       sideways with nothing on screen to say it scrolled. The Name field and
       the icon grid were cut off the same way. */
    assert.match(css, /@media \(max-width: 560px\) \{[\s\S]*?\.macro-body \{\s*grid-template-columns: minmax\(0, 1fr\);/);
    assert.match(css, /@media \(max-width: 560px\) \{[\s\S]*?#macro-step-actions \{\s*flex-wrap: wrap;/);
    // The list's divider follows the stack, or it rules down the middle of nothing.
    assert.match(css, /@media \(max-width: 560px\) \{[\s\S]*?\.macro-list \{[\s\S]*?border-right: 0;[\s\S]*?border-bottom: 1px solid var\(--border\);/);
    // One scroll container on a small screen, not three nested ones.
    assert.match(css, /@media \(max-width: 560px\) \{[\s\S]*?\.macro-edit \{\s*max-height: none;\s*overflow: visible;/);
    // Above the breakpoint it is still two columns — verified unchanged at 900 and 1400.
    assert.match(css, /\.macro-body \{\s*display: grid;\s*grid-template-columns: minmax\(140px, 34%\) minmax\(0, 1fr\);/);
    /* The precedent: a chord row already wraps because its five modifier
       toggles plus a key list are wider than the dialog. The grid around it and
       the row of buttons under it never got the same treatment. */
    assert.match(css, /\.macro-step \{[\s\S]*?flex-wrap: wrap;/);
});

test("the macro editor's panes fill the row they are given", () => {
    /* The row is held open at a floor so a Pi with two macros does not draw a
       dialog three lines tall, and the panes are capped at 46vh so a Pi with
       sixty does not draw one taller than the screen. Below about a 565px-tall
       viewport those two stopped agreeing: 46vh fell under the floor, the panes
       capped short, and the row stayed open around them. Measured on a
       landscape phone (844x390):
           body 260px, list 179px, edit 179px, dead band 81px, BOTH scrolling
       — 23% of the dialog empty in the one layout with no room to spare. */
    assert.match(css, /\.macro-body \{[\s\S]*?--macro-pane-min: 260px;\s*min-height: var\(--macro-pane-min\);/);
    assert.match(css, /\.macro-list \{[\s\S]*?max-height: max\(46vh, var\(--macro-pane-min\)\);/);
    assert.match(css, /\.macro-edit \{[\s\S]*?max-height: max\(46vh, var\(--macro-pane-min\)\);/);
    /* One number used twice, so the floor and the cap cannot drift apart again —
       the same reason --screen-min is a token rather than a repeated literal. A
       bare 46vh reintroduced on either pane brings the dead band back. */
    const paneRules = css.slice(css.indexOf(".macro-body {"), css.indexOf(".macro-steps {"));
    assert.doesNotMatch(paneRules, /max-height: 46vh;/, "a pane cap escaped the shared floor");
    // Verified after: 0px dead band at 844x390, and 1024x600 / 1400x900 unchanged.
});

test("the macro editor says which modifiers are in the chord", () => {
    /* Which modifiers are armed IS the step — "Ctrl+Alt+Delete" and "Delete"
       differ by nothing else — and it was carried by a colour alone. Measured on
       the seeded chord with Ctrl and Alt held:
           Ctrl is-on  aria-pressed=null
           Alt  is-on  aria-pressed=null
           Shift off   aria-pressed=null
       All five read identically, so the chord could not be read back at all.
       After: role=switch with aria-checked true/true/false, and toggling Shift
       flips the class and the announced state together. */
    const chord = js.slice(js.indexOf('if (step.type === "chord") {'), js.indexOf("var keySel = document.createElement"));
    assert.match(chord, /role: "switch",\s*checked: on,/);
    assert.match(chord, /className: "dlg-btn macro-mod" \+ \(on \? " is-on" : ""\),/);
    /* role=switch rather than aria-pressed because that is what this renderer
       supports — mountButtons maps role+checked and ignores `pressed`, which
       only mountIconButtons reads. Both were probed. renderPlainButtons maps the
       same pair, so the no-bundle path says the same thing. */
    assert.match(js, /if \(spec\.role\) \{\s*b\.setAttribute\("role", spec\.role\);\s*b\.setAttribute\("aria-checked", spec\.checked \? "true" : "false"\);/);
    // The same pairing every GPIO row already uses through the same function.
    assert.match(js, /role: "switch",[\s\S]{0,200}?checked: o\.on,/);
    // And the touch drawer's sticky modifiers, which are direct DOM nodes.
    assert.match(js, /btn\.setAttribute\("aria-pressed", on \? "true" : "false"\)/);
});

test("deleting the last macro leaves focus somewhere in the dialog", () => {
    /* Deleting the LAST macro hides the whole form and takes the button that
       was just pressed with it, so focus fell to the body while the dialog was
       still open. Measured with one macro, Delete macro focused and clicked:
           list 0, "No macros yet.", form hidden, activeElement BODY
       Every other action here already lands somewhere — removing a step goes to
       the row that replaced it, and Delete keeps its own button while other
       macros remain (re-verified: macro-new, add-chord, add-delay, Remove step
       1, macro-delete). After: focus lands on macro-new. */
    assert.match(js, /var emptied = !macros\.length;\s*saveMacros\(\)\.then\(function \(\) \{\s*if \(!emptied\) return;/);
    assert.match(js, /var add = dialogControl\("macro-new"\);\s*if \(add && add\.focus\) add\.focus\(\);/);
    /* dialogControl, not getElementById: these buttons are drawn by the shared
       component library as data-tb and by the fallback as data-fk, so a plain id
       lookup resolves nothing. */
    assert.match(js, /function dialogControl\(key\) \{[\s\S]*?document\.querySelector\('\[data-tb="' \+ key \+ '"\]'\)[\s\S]*?document\.querySelector\('\[data-fk="' \+ key \+ '"\]'\)/);
    // The step-level machinery that could not cover this case.
    assert.match(js, /pendingMacroFocus \|\|\s*\(active && steps\.contains\(active\)/);
    assert.match(js, /\{ id: "macro-new", label: "New macro", onSelect: newMacro \}/);
});

test("the overflow menu's macro list greys while a macro plays", () => {
    /* pinnedMacroSpecs says of its own disabled flag that it "is also the only
       feedback that one is running" — and the ⋯ list, which is the ONLY way to
       run a macro on a phone, had none of it. Measured through a macro with a
       2.5s pause:
           desktop strip   all four :off while it ran
           web menu        all four :on  throughout, no toast, nothing
       so on the layout where the feedback matters most there was none until the
       run finished. After: both grey and both restore. */
    assert.match(js, /var busy = typingBusy\(\);\s*\[\]\.forEach\.call\(host\.querySelectorAll\("button"\), function \(btn\) \{\s*setProp\(btn, "disabled", busy \|\| macroBlocked\(btn\.__macro\)\);/)
    // The titlebar's equivalent, which this mirrors.
    assert.match(js, /disabled: typingBusy\(\) \|\| macroBlocked\(m\),\s*onSelect: function \(\) \{\s*runMacro\(m\);/);
    /* Outside the rebuild branch. The set of macros has not changed while one
       plays — only whether they can be pressed — and that branch returns early
       when the labels match, so a disabled flag set inside it would never run. */
    const fn = js.slice(js.indexOf("function paintMacroMenu()"));
    const body = fn.slice(0, fn.indexOf("\n    }"));
    assert.ok(
        body.indexOf('host.setAttribute("data-set", key)') < body.indexOf("var busy = typingBusy()"),
        "the disabled pass must come after the rebuild branch, not inside it",
    );
    assert.match(body, /if \(host\.getAttribute\("data-set"\) !== key\) \{/);
    // Both ends of the run repaint it.
    assert.match(js, /macroRunning = macro;\s*paintMacroButtons\(\);/);
    assert.match(js, /macroRunning = null;\s*paintMacroButtons\(\);/);
});

test("every route to a macro shows when one is already playing", () => {
    /* There are three ways to start a macro and they disagreed. Recorded
       through a macro with a 2.5s pause, with popupMenu intercepted so no
       native menu opened:
           titlebar strip     off, off, off
           ⋯ menu list        greyed (fixed in 496f5d3)
           send-keys menu     every entry enabled: undefined
       runMacro refuses either way and says so; these are the affordance, so the
       answer arrives before the press rather than as an apology after it. */
    assert.match(js, /items\.push\(\{ id: "macro:" \+ m\.id, label: m\.label, enabled: !typingBusy\(\) && !macroBlocked\(m\) \}\);/);
    // The two it now matches.
    assert.match(js, /disabled: typingBusy\(\) \|\| macroBlocked\(m\),\s*onSelect: function \(\) \{\s*runMacro\(m\);/);
    assert.match(js, /var busy = typingBusy\(\);\s*\[\]\.forEach\.call\(host\.querySelectorAll\("button"\), function \(btn\) \{\s*setProp\(btn, "disabled", busy \|\| macroBlocked\(btn\.__macro\)\);/)
    // And the guard behind all three, which is what actually protects the target.
    assert.match(js, /if \(macroRunning\) \{[\s\S]{0,400}?toast\(macroRunning\.label \+ " is still running", true\);/);
    /* A single shortcut from that same menu is deliberately NOT gated: the rule
       here is about BULK input — a second macro, or a paste — not about one
       chord the user chose, which is no different from typing. */
    const fn = js.slice(js.indexOf("function runShortcut(sid)"));
    assert.doesNotMatch(fn.slice(0, fn.indexOf("\n        }")), /macroRunning/);
    assert.match(js, /disabled: !pasteHasText \|\| pasteBusy \|\| !!macroRunning,/);
});

test("a slow macro says it is running, like a long paste does", () => {
    /* A macro's text step posts to the same endpoint at the same rate as the
       paste dialog, so a macro carrying 5,000 characters occupies the target
       for a minute and a half. The paste dialog says so; a macro run said
       nothing at all until it finished and toasted "<label> sent". The only
       sign it was running was the macro buttons going disabled — invisible from
       the ⋯ menu and from the send-keys menu, both of which can start one.

       Same sibling-paths divergence as the keymap: two ways into one operation,
       only one of them telling the truth about it. */
    assert.match(js, /function macroDuration\(macro\) \{/);
    assert.match(js, /else if \(s\.type === "text"\) ms \+= String\(s\.text \|\| ""\)\.length \* PASTE_DELAY_S \* 1000;/,
        "a text step costs what the same text costs the paste dialog");
    assert.match(js, /if \(s\.type === "delay"\) ms \+= Number\(s\.ms\) \|\| 0;/);
    assert.match(js, /else ms \+= MACRO_CHORD_MS;/);
    assert.match(js, /toast\("Running " \+ macro\.label \+ " — " \+ humanDuration\(runFor\) \+ "…", false, true\);/);

    /* Only when it is slow enough to be worth a word: Ctrl+Alt+Delete is over
       in a tenth of a second, and a notice appearing and being overwritten in
       that time is a flicker, not information. */
    assert.match(js, /var MACRO_NOTICE_MS = 2000;/);
    assert.match(js, /if \(runFor >= MACRO_NOTICE_MS\) \{/);
    /* Sticky, and always replaced: both endings toast — "<label> sent" and
       "<label> stopped: …" — and toast() clears the pending timer as it writes,
       so it never needs an explicit hide. */
    assert.match(js, /toast\(macro\.label \+ " sent"\);/);
    assert.match(js, /macro\.label \+ " stopped: " \+ problem/);

    // One formatter behind both this and the paste estimate.
    assert.match(js, /function humanDuration\(ms\) \{/);
    assert.match(js, /return ms < 10000 \? "" : humanDuration\(ms\);/);

    /* Driven over CDP with the print request held open server-side, reading the
       toast mid-run:
         1 chord (~0.12s)        "…cluster 3 sent"          — no notice at all
         2.5s delay + 4 steps    "Running …cluster 1 — about 3s…"
         5,000-character text    "Running …cluster 5 — about 2 min…"
       and after that last one finished, "…cluster 5 sent". */
});

test("a macro cannot start while a paste is still typing", () => {
    /* The guard existed in one direction only. sendPaste has always refused
       while a macro runs; nothing refused a macro while a paste was in flight —
       and a paste holds the target for as long as it takes, over four minutes
       for 12,000 characters.

       Reproduced over CDP with the print request held open server-side: start a
       paste, press Cancel (which closes the dialog and, by design, leaves the
       paste typing), then run a macro from the ⋯ menu. The wire carried both
         print:limit=0&delay=0.02:the quick brown fox
         print:limit=0&delay=0.02:xxxxxxxx…
       at once, so kvmd typed them into the target interleaved. A macro like
       "type the username, Tab, type the password, Enter" landing inside a paste
       is exactly the hazard the macro-vs-macro guard was written for. */
    assert.match(js, /if \(pasteBusy\) \{\s*toast\("A paste is still typing on the target", true\);\s*return;\s*\}/);

    /* And made visible, not just refused on the click. One predicate behind all
       three surfaces that can start a macro — the pinned buttons, the rendered
       list, and the native send-keys menu — so they cannot disagree about what
       busy means. */
    assert.match(js, /function typingBusy\(\) \{\s*return !!macroRunning \|\| !!pasteBusy;\s*\}/);
    assert.equal((js.match(/typingBusy\(\)/g) ?? []).length, 5,
        "the declaration, the three surfaces that start a macro, and the comment naming it");
    assert.doesNotMatch(js, /disabled: !!macroRunning,/);
    assert.doesNotMatch(js, /disabled: typingBusy\(\),$/m);
    assert.doesNotMatch(js, /var busy = !!macroRunning;/);
    assert.doesNotMatch(js, /enabled: !macroRunning \}/);

    /* Repainted at both ends of a paste, or the controls would stay clickable
       through it and only refuse on the click. */
    assert.match(js, /pasteBusy = true;\s*repaintPasteActions\(\);[\s\S]{0,400}?paintMacroButtons\(\);/);
    assert.match(js, /pasteBusy = false;\s*paintMacroButtons\(\);/);
    /* Re-run after the fix, same sequence: the macro item came up disabled, the
       click did nothing, and the wire carried one request. Once the paste
       finished the item was enabled again. */
});

test("the macro icon picker has the keyboard model its role promises", () => {
    /* The grid is marked up as a radiogroup of role=radio buttons, and behaved
       like a row of plain buttons: every one of the twenty-three icons was its
       own tab stop and the arrow keys did nothing. Measured in the editor — 25
       tab stops between the Name field and the next control, and ArrowRight on
       the checked icon moved neither focus nor the selection.

       That is the worse of the two possible mistakes. A screen reader announces
       "radio, 21 of 23" and then arrows do not work; everyone else Tabs
       twenty-four times to get past the picker to "Show in the titlebar". */
    assert.match(js, /noIcon\.tabIndex = iconSet \? -1 : 0;/);
    assert.match(js, /choice\.tabIndex = macro\.icon === name \? 0 : -1;/);
    assert.match(js, /function wireIconRovingFocus\(host\) \{/);
    assert.match(js, /e\.key === "ArrowRight" \|\| e\.key === "ArrowDown" \? 1 : e\.key === "ArrowLeft" \|\| e\.key === "ArrowUp" \? -1 : 0/);
    assert.match(js, /else if \(e\.key === "Home"\) next = all\[0\];/);
    assert.match(js, /else if \(e\.key === "End"\) next = all\[all\.length - 1\];/);
    // Arrows move the SELECTION, not just focus — that is what a radiogroup does.
    assert.match(js, /next\.focus\(\);\s*next\.click\(\);/);

    /* Wired once per host, not once per repaint. #macro-icons persists across a
       save — only its children are replaced — so calling this each time stacked
       another keydown listener on the same element, and one ArrowRight walked
       two steps, then three: measured going command -> settings and command ->
       star instead of one neighbour either way. */
    assert.match(js, /if \(host\.getAttribute\("data-roving"\) === "1"\) return;\s*host\.setAttribute\("data-roving", "1"\);/);

    /* Focus survives the rebuild the selection triggers. A token set at the
       keypress is consumed by the first repaint and a second repaint still
       lands on the body, so the live focus is re-read here as well — the same
       shape as the steps list re-finding its control by data-fk. */
    assert.match(js, /var focusedIcon = icons\.contains\(document\.activeElement\)/);
    assert.match(js, /var wanted = pendingIconFocus \|\| focusedIcon;/);

    /* Driven in the editor after the fix, each key from a known icon:
         Tab from Name     -> command, then macro-pinned  (one stop for 23 icons)
         ArrowRight        command -> trash
         ArrowLeft         command -> maximize
         ArrowLeft         "No icon" -> settings   (wraps)
         ArrowRight        settings -> "No icon"   (wraps)
         Home / End        -> "No icon" / settings
       and clicking an icon still selects it. */
});

test("the macro editor lands on the control it just created", () => {
    /* Every creating action left focus on the button pressed, and the new row
       renders ABOVE that row of buttons — so the only way to the field you had
       just asked for was Shift+Tab, backwards, past however many controls the
       earlier steps carry. Measured in the editor: New macro, Add text, Add
       pause and Add key combo all reported focus still on a BUTTON. */
    assert.match(js, /var index = macro\.steps\.length;/);
    assert.match(js, /pendingMacroFocus = "k" \+ index;/);
    assert.match(js, /pendingMacroFocus = "t" \+ index;/);
    assert.match(js, /pendingMacroFocus = "d" \+ index;/);
    /* k/t/d are the keys the rows are already built with, and the list already
       restores focus by data-fk after every repaint — this only names the
       control that should have it. */
    assert.match(js, /keySel\.setAttribute\("data-fk", "k" \+ index\);/);
    assert.match(js, /text\.setAttribute\("data-fk", "t" \+ index\);/);
    assert.match(js, /ms\.setAttribute\("data-fk", "d" \+ index\);/);

    /* A new macro's label is the literal placeholder "New macro", so the first
       thing anyone does is replace it. Selected, not just focused, or typing
       would append to the placeholder instead of replacing it. */
    assert.match(js, /var name = document\.getElementById\("macro-label"\);\s*if \(name\) \{\s*name\.focus\(\);\s*name\.select\(\);/);
    assert.match(js, /label: "New macro",/);

    /* Driven in the editor after the fix:
         New macro      -> INPUT#macro-label, with "New macro" selected whole
         Add text       -> INPUT "Text for step 2"
         Add pause      -> INPUT "Pause for step 3, milliseconds"
         Add key combo  -> SELECT "Key for step 4"
       Removing a step was checked too and deliberately left as it was: focus
       lands on the Remove of the row that took its place, which is the ordinary
       convention for deleting down a list. */
});

test("a macro step's move buttons say which step they move", () => {
    /* Every other control in a step row names its step — the key select says
       "Key for step 3", the text field "Text for step 3", the pause field
       "Pause for step 3, milliseconds", the modifier group "Modifier keys for
       step 3", and Remove beside them says "Remove step 3". The two move
       buttons said "Move step up" and "Move step down" and nothing else.

       Measured on a four-step macro: eight buttons carrying two names between
       them — "Move step up" x4 and "Move step down" x4 — so a screen reader
       walking the rows could not tell which step any of them belonged to. The
       comment on that very line already said "↑ is a glyph, not a name"; it
       stopped one step short. Same reasoning the GPIO Pulse button spells out:
       a list of identically named buttons names nothing you could tell apart. */
    assert.match(js, /ariaLabel: "Move step " \+ \(index \+ 1\) \+ \(delta < 0 \? " up" : " down"\),/);
    assert.doesNotMatch(js, /ariaLabel: delta < 0 \? "Move step up" : "Move step down",/);
    // The siblings it now matches.
    assert.match(js, /ariaLabel: "Remove step " \+ \(index \+ 1\),/);
    assert.match(js, /keySel\.setAttribute\("aria-label", "Key for step " \+ \(index \+ 1\)\);/);
    assert.match(js, /mods\.setAttribute\("aria-label", "Modifier keys for step " \+ \(index \+ 1\)\);/);

    /* The id stays the focus key, so following the step to its new position
       still works — that is what makes a second press keep moving the SAME
       step rather than whatever slid into the slot. */
    assert.match(js, /pendingMacroFocus = \(delta < 0 \? "u" : "n"\) \+ to;/);
    /* Driven on a four-step macro afterwards: "Move step 1 up" disabled,
       "Move step 4 down" disabled, no repeated accessible names left among the
       step controls, and moving step 3 up reordered Keys/Text/Pause/Keys to
       Keys/Pause/Text/Keys with focus landing on "Move step 2 up". */
});

test("the titlebar's pinned macros show when the row was cut", () => {
    /* The second strip that shows less than it holds. It is overflow:hidden by
       design — that is what lets it give way rather than push the window
       controls off the bar, and the send-keys menu lists every macro by name as
       the complete route to the rest.

       What was missing was any sign it had been cut. Measured with forty pins:
       at 1400px, 32 whole, 1 clipped, 7 gone; at 900px, 17 whole, 1 clipped, 22
       gone — and the clipped one rendered as the single letter "R", which reads
       as a macro simply named R rather than as "RE" with its end taken off. */
    assert.match(js, /function paintMacroStripOverflow\(\) \{\s*paintEdgeFade\(document\.getElementById\("tb-macros"\)\);/);
    assert.match(js, /m\.addEventListener\("scroll", paintMacroStripOverflow, \{ passive: true \}\);/);
    assert.match(js, /window\.addEventListener\("resize", paintMacroStripOverflow\);/);
    // Pinning or unpinning changes what fits, so the repaint drives it too.
    assert.match(js, /macroButtonsRoot\.update\(withTbClass\(pinnedMacroSpecs\(\)\)\);\s*\/\/ Pinning or unpinning changes what fits\.\s*paintMacroStripOverflow\(\);/);
    // One helper behind both strips, so the two cannot drift apart.
    assert.match(js, /function paintEdgeFade\(el\) \{/);
    assert.match(js, /function paintDrawerOverflow\(\) \{\s*paintEdgeFade\(document\.getElementById\("drawer"\)\);/);

    /* It still moves, because Tab walking into the clipped part scrolls the
       strip under the focus ring — the scrollIntoView already there for exactly
       that. Measured at 900px with forty pins: focusing the 31st left the strip
       at scrollLeft 717 of 751 with both edges faded. */
});

test("the macro icon picker keeps a tab stop when nothing is selected", () => {
    /* A regression from giving the grid a roving tabindex, caught by opening a
       macro whose stored icon is not one this build knows about.

       The tabindex is worked out per button from whether it is the chosen one.
       An unrecognised icon name matches nothing, and "No icon" is not chosen
       either — there IS an icon, just not one in this list — so all twenty-three
       came out at -1. Measured on a macro carrying "not-a-real-icon": checked
       [], active [], tabbable []. The picker was unreachable by keyboard
       entirely, where before the roving tabindex it had been 23 tab stops and
       at least usable. Making a group better for the common case and unusable
       for an uncommon one is a bad trade. */
    assert.match(js, /var rovers = icons\.querySelectorAll\('\[role="radio"\]'\);/);
    assert.match(js, /if \(!hasStop && rovers\.length\) rovers\[0\]\.tabIndex = 0;/);
    // It runs before the roving handler and the focus restore, so the stop is
    // in place by the time either looks for one.
    const guard = js.indexOf("if (!hasStop && rovers.length) rovers[0].tabIndex = 0;");
    assert.ok(guard > 0 && guard < js.indexOf("wireIconRovingFocus(icons);", guard - 400) + 400);

    /* Driven on the two cases:
         icon "not-a-real-icon"  checked [] active [] tabbable ["No icon"]
         icon "command"          checked/active/tabbable all ["command"]
       and arrowing from the unselected group recovers it: ArrowRight off
       "No icon" left checked, active and tabbable all on "camera". */
});

test("a macro whose keys cannot arrive is refused, not reported as sent", () => {
    /* Chord steps go over the HID socket; text steps POST to /api/hid/print and
       are unaffected by it. So with the socket killed, a chord-only macro put
       NOTHING on the wire and the console toasted "…cluster 3 sent" — a
       positive claim that the keys had reached the target.

       Same family as two things already fixed here. The macro's own text step
       used to toast "sent" on a 500 — "a positive claim that the text reached
       the target when nothing had been typed at all" — and Save screenshot
       reported a disk write it never observed. This was the socket half of the
       same macro, still claiming. */
    assert.match(js, /function macroNeedsInput\(macro\) \{[\s\S]*?if \(steps\[i\]\.type === "chord"\) return true;/);
    assert.match(js, /function macroBlocked\(macro\) \{\s*return macroNeedsInput\(macro\) && !hid\.isOpen\(\);/);
    assert.match(js, /if \(macroBlocked\(macro\)\) \{\s*toast\(macro\.label \+ " has key steps and input is offline", true\);/);

    /* Checked before the run starts, because it cannot be noticed afterwards:
       sendChord queues and drainKeys fires from a timer whatever the socket is
       doing, which is exactly what stops a run stalling. */
    assert.match(js, /drainKeys always fires from a timer/);

    /* Per macro, not for all of them. A text-only macro works perfectly well
       over the print endpoint with the socket down, and refusing it would block
       something that would have succeeded. */
    assert.match(js, /disabled: typingBusy\(\) \|\| macroBlocked\(m\),/);
    assert.match(js, /enabled: !typingBusy\(\) && !macroBlocked\(m\) \}/);
    assert.match(js, /setProp\(btn, "disabled", busy \|\| macroBlocked\(btn\.__macro\)\);/);
    // Repainted from the same hook that greys the drawer.
    assert.match(js, /paintDrawerEnabled\(\);\s*\/\/ Chord macros go dead with the socket[\s\S]{0,60}?paintMacroButtons\(\);/);

    /* Driven over CDP with the socket killed, six macros seeded:
         chord-only          [off], and clicking it did nothing
         chord + text        [off]
         text-only           [on], ran, wire carried its print, "Short 4 sent"
       and after the socket recovered every one was [on] again with the chip
       back to "Live". Before the fix the chord-only one was [on], sent nothing,
       and toasted "…cluster 3 sent". */
});

test("the macro being edited is marked, not just coloured", () => {
    const at = js.indexOf("function paintMacroEditor() {");
    assert.ok(at > 0, "paintMacroEditor not found");
    const body = js
        .slice(at, js.indexOf("btn.addEventListener(\"click\"", at))
        .replace(/\/\*[\s\S]*?\*\//g, ""); // the comment beside it names aria-selected
    assert.match(body, /btn\.className = m\.id === macroSelected \? "active" : "";/);
    assert.match(body, /if \(m\.id === macroSelected\) btn\.setAttribute\("aria-current", "true"\);/);
    // Not the semantics this list does not implement.
    assert.ok(!/aria-selected/.test(body), "aria-selected promises an arrow-key model this list has not got");
});

