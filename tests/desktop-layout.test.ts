import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const html = readFileSync(resolve(root, "src/views/console.html"), "utf8");
const css = readFileSync(resolve(root, "src/views/console.css"), "utf8");
const js = readFileSync(resolve(root, "src/views/console.js"), "utf8");
const main = readFileSync(resolve(root, "src/main.ts"), "utf8");
const preload = readFileSync(resolve(root, "src/preload-console.ts"), "utf8");

test("desktop exposes one chat workspace and never auto-fits around the remote screen", () => {
    assert.doesNotMatch(html, /role="tablist" aria-label="Workspace"/);
    assert.doesNotMatch(html, />Terminal<\/button>/);
    assert.doesNotMatch(js, /setPanelTab\(/);
    assert.doesNotMatch(preload, /setPanelTab/);
    assert.doesNotMatch(main, /const terminalView = new WebContentsView/);
    assert.doesNotMatch(main, /console:panel-tab/);
    assert.doesNotMatch(js, /autoFitTimer/);
});

test("desktop keeps chat primary while the target preview is collapsible", () => {
    assert.match(css, /grid-column:\s*1;[\s\S]*?\.screen\s*\{[\s\S]*?grid-column:\s*2;/);
    assert.match(css, /\.app\.computer-collapsed/);
    assert.doesNotMatch(css, /\.app\.panel-collapsed/);
    /* The toggle is drawn by the shared component library now, so its label
     * lives in a spec rather than in the markup. It is the ACTION, not the
     * state — "Hide target preview" while the preview is showing — with
     * aria-pressed carrying the state separately. */
    assert.match(js, /label: shown \? "Hide target preview" : "Show target preview"/);
    assert.match(js, /pressed: shown,/);
    assert.match(html, /id="tb-actions-panel"/);
    assert.match(js, /pikvm-chat-workspace-width-v2/);
});

test("desktop keeps healthy status quiet and accessible", () => {
    assert.doesNotMatch(js, /Backend ready/);
    assert.match(html, /role="status" aria-live="polite"/);
    assert.match(css, /\.backend-status\[data-state="ready"\] \.bs-text/);
});

test("VNC lab targets use the snapshot screen transport", () => {
    const consolePure = require(resolve(root, "src/views/console.js"));

    assert.equal(
        consolePure.streamModeForInfo({
            result: { extras: { vnc_lab: { enabled: true } } },
        }),
        "snapshot",
    );
    assert.equal(consolePure.streamModeForInfo({ result: { extras: {} } }), "native");
    assert.match(js, /\/api\/streamer\/snapshot/);
});

test("the panel divider offers only widths the grid will actually render", () => {
    const { panelCeiling } = require(resolve(root, "src/views/console.js"));

    // At the 900px minimum window the grid keeps 300px for the screen, so the
    // panel tops out at 600 — announcing --chat-max here would promise 1100 and
    // leave the last 500px of the drag moving nothing.
    assert.equal(panelCeiling(900, 300, 320, 1100), 600);
    // Wide enough and the static ceiling is the binding one again.
    assert.equal(panelCeiling(1600, 300, 320, 1100), 1100);
    assert.equal(panelCeiling(1400, 300, 320, 1100), 1100);
    assert.equal(panelCeiling(1399, 300, 320, 1100), 1099);
    // Never below the floor, even if the viewport is nonsense or not yet known.
    assert.equal(panelCeiling(400, 300, 320, 1100), 320);
    assert.equal(panelCeiling(0, 300, 320, 1100), 320);
    assert.equal(panelCeiling(undefined, 300, 320, 1100), 320);

    // The reserve is a shared token, so the drag and the grid cannot drift.
    assert.match(css, /--screen-min:\s*300px/);
    assert.doesNotMatch(css, /calc\(100vw - 300px\)/);
    assert.match(js, /aria-valuemax", String\(panelMaxNow\(\)\)/);
});

test("collapsing the preview retires the divider instead of hiding it off-screen", () => {
    // It is absolutely positioned against the conversation, so with the preview
    // collapsed it sits half off the window edge. Visually gone is not enough —
    // it stayed focusable, and one arrow press there rewrote the saved width.
    assert.match(
        css,
        /\.app\.computer-collapsed \.chat-resize\s*\{\s*display:\s*none/,
    );
    // The collapse changes the conversation's width, and the divider announces
    // that width, so the toggle has to repaint it on the way back out.
    assert.match(js, /repaintPanelDivider\(\)/);
    assert.match(js, /repaintPanelDivider = paintResizeValue/);
    // aria-valuenow is clamped into the announced range, so now > max cannot happen.
    assert.match(js, /aria-valuenow",\s*String\(clampPanelWidthNow\(/);
});

test("window controls stay above the modal backdrop", () => {
    // .tb-right is its own stacking context (z-index 1), so a window control
    // inside it is pinned under the scrim no matter what z-index it carries —
    // raising the button alone was measured to do nothing. They have to live in
    // their own group, outside that cluster.
    const right = html.slice(html.indexOf('class="tb-right"'), html.indexOf('class="tb-window"'));
    assert.doesNotMatch(right, /tb-win/, "window controls are back inside .tb-right");
    assert.match(html, /<div class="tb-window"/);
    assert.match(css, /\.tb-window\s*\{[^}]*z-index:\s*70/);
    // The scrim it has to clear.
    assert.match(css, /\.dlg-scrim\s*\{[\s\S]*?z-index:\s*60/);
    // .tb-right lost space-between and needs the auto margin to stay hard right.
    assert.match(css, /\.tb-right\s*\{\s*margin-left:\s*auto/);
});

test("state pushes never rewrite a control the user is holding", () => {
    // A native select closes its dropdown when anything rewrites it, and kvmd
    // pushes streamer/MSD state unprompted, so every such control has to be
    // skipped while focused and repainted on blur.
    assert.match(js, /function controlBusy\(el, repaint\)/);
    assert.match(js, /if \(!controlBusy\(resSel, paintStreamDialog\)\)/);
    assert.match(js, /if \(controlBusy\(el, paintStreamDialog\)\) continue;/);
    assert.match(js, /sel && !controlBusy\(sel, paintMsd\)/);
    assert.match(js, /mode && !controlBusy\(mode, paintMsd\)/);
    // The old ad-hoc guards are gone: the only place that still asks the DOM
    // directly is controlBusy itself, which is the one way to ask.
    const direct = js.match(/document\.activeElement !== el\b/g) ?? [];
    assert.equal(direct.length, 1, "an ad-hoc activeElement guard crept back in");
});

test("screen failures keep the last frame under a one-line overlay", () => {
    assert.match(html, /alt="Remote target screen"/);
    // A spinner and one word. Every state used to carry a title, a body line and
    // its own retry button; none of that is actionable when the reconnect is
    // automatic, and the status chip already names the state precisely.
    assert.match(html, /id="overlay-spinner"/);
    assert.match(html, /id="overlay-label"/);
    assert.doesNotMatch(html, /id="overlay-retry"/);
    assert.doesNotMatch(js, /Waiting for the first screen frame/);
    assert.doesNotMatch(js, /Screen preview unavailable/);
    // The label comes from the chip's own string, so a state cannot be described
    // two different ways in two places.
    assert.match(js, /setText\(overlayLabel, d\.label\)/);
    // No spinner on "no signal": that is a settled answer, not a wait.
    assert.match(js, /overlaySpinner\.hidden = s === "nosignal"/);
    // The last good frame still shows through underneath rather than going black.
    assert.match(css, /\.screen\.has-frame \.overlay/);
});

test("a held button keeps steering the target once the pointer leaves the picture", () => {
    const { fracInBox } = require(resolve(root, "src/views/console.js"));
    const box = { left: 0, top: 38, w: 1920, h: 1080 };

    // Hovering outside the picture is not KVM input and never was.
    assert.equal(fracInBox(box, -500, 578, false), null);
    assert.equal(fracInBox(box, 2720, 578, false), null);
    assert.deepEqual(fracInBox(box, 960, 578, false), { fx: 0.5, fy: 0.5 });

    /* Dragging is different: the browser keeps delivering moves once a button is
     * down, and dropping them froze the remote cursor wherever it crossed the
     * edge — so a window being dragged stuck there. Each side pins to its edge,
     * and a throw at the corner lands in the corner, which is what edge-snapping
     * on the target needs to see. */
    assert.deepEqual(fracInBox(box, -500, 578, true), { fx: 0, fy: 0.5 });
    assert.deepEqual(fracInBox(box, 2720, 578, true), { fx: 1, fy: 0.5 });
    assert.deepEqual(fracInBox(box, 960, -300, true), { fx: 0.5, fy: 0 });
    assert.deepEqual(fracInBox(box, 960, 1518, true), { fx: 0.5, fy: 1 });
    assert.deepEqual(fracInBox(box, 3000, 3000, true), { fx: 1, fy: 1 });
    // Inside is untouched by the clamp.
    assert.deepEqual(fracInBox(box, 960, 578, true), { fx: 0.5, fy: 0.5 });
    // A collapsed or unmeasured box is never a point, clamped or not.
    assert.equal(fracInBox({ left: 0, top: 0, w: 0, h: 0 }, 5, 5, true), null);
    assert.equal(fracInBox(null, 5, 5, true), null);

    // The button state has to come from the event, not from where the pointer is.
    assert.match(js, /var dragging = e\.buttons !== 0;/);
    assert.match(js, /moveTo\(e\.clientX, e\.clientY, false, dragging\)/);
    // Leaving the pane mid-drag must not hide the cursor blob.
    assert.match(js, /if \(e\.buttons !== 0\) return;/);
});

test("a release we never saw does not leave a button down on the target", () => {
    // Clamping the drag to the picture edge made this reachable in normal use:
    // the drag now survives leaving the window, so the physical release can land
    // over another application and its pointerup never arrives. A button left
    // down on the TARGET is worse than a dropped one — the remote window keeps
    // following the cursor with nothing held on this side.
    assert.match(js, /function releaseHeldMouseButtons\(\)/);
    // A move reporting no buttons is proof the release happened.
    assert.match(js, /if \(e\.buttons === 0\) releaseHeldMouseButtons\(\);/);
    // Losing the window mid-drag is the other way the release goes unseen.
    assert.match(js, /window\.addEventListener\("blur", releaseHeldMouseButtons\)/);
    // One way to let go, so a path cannot forget the modifiers half of it.
    const adhoc = js.match(/delete heldMouseButtons\[/g) ?? [];
    assert.equal(adhoc.length, 2, "expected only the helper and the real pointerup");
});

test("the last frame is held while the stream is re-established", () => {
    // Reloading an MJPEG <img> blanks it the instant src is set, so the picture
    // dropped to black on every reconnect — indistinguishable from the target
    // itself going away.
    assert.match(html, /<canvas id="screen-freeze"/);
    assert.match(js, /function freezeFrame\(\)/);
    assert.match(js, /function thawFrame\(\)/);
    // On the state transition, not only in loadStream: loadStream returns early
    // while WebRTC owns the picture, so a WebRTC target would never freeze at all.
    assert.match(js, /if \(s !== "live" && streamState === "live"\) freezeFrame\(\);/);
    assert.match(js, /thawFrame\(\); \/\/ the live source is painting again/);
    // Frozen: the canvas shows and the live element is hidden under it, so a
    // blanked <img> cannot cover the frame being held.
    assert.match(css, /\.screen\.frozen #screen-freeze\s*\{\s*display:\s*block/);
    assert.match(css, /\.screen\.frozen #screen,\s*\n\.screen\.frozen #screen-video\s*\{\s*visibility:\s*hidden/);
    // Same box and same zoom/pan as the live picture, or thawing would snap the view.
    assert.match(css, /#screen,\n#screen-video,\n#screen-freeze \{/);
    assert.match(js, /freezeCanvas\.style\.transform = t;/);
});

test("the centred titlebar title yields rather than overlapping the buttons", () => {
    // It is centred on the WINDOW, so it can run under the clusters: the right
    // one grows with every pinned macro, and at the 900px minimum window "PiKVM"
    // was drawn straight over two macro icons.
    assert.match(js, /function fitTitle\(\)/);
    assert.match(js, /tbTitle\.style\.visibility = clear \? "" : "hidden"/);
    // Measured unhidden, or it could never come back once it went away.
    assert.match(js, /tbTitle\.style\.visibility = "";\n\s+var t = tbTitle\.getBoundingClientRect\(\)/);
    // Watching the clusters, not only the window: pinning a macro, the health
    // warning appearing and the audio pair being revealed all change their width
    // without resizing anything.
    assert.match(js, /new ResizeObserver\(fitTitle\)/);
    assert.match(js, /titleFit\.observe\(tbLeft\)/);
    assert.match(js, /titleFit\.observe\(tbRight\)/);
    assert.match(js, /window\.addEventListener\("resize", fitTitle\)/);
});

test("fit-to-native says when it cannot act instead of doing nothing", () => {
    // fitNativeNow returns false when no frame has arrived, so with no picture
    // the button looked available and silently did nothing at all.
    // Drawn by the shared component library now, so the state lives in its spec
    // rather than being written onto a DOM node.
    assert.match(js, /function viewButtonSpecs\(\)/);
    assert.match(js, /disabled: !dims,/);
    assert.match(js, /waiting for a picture/);
    assert.match(js, /viewButtons\.update\(withTbClass\(viewButtonSpecs\(\)\)\)/);
    // Named the size it would fit to, which is the one thing the label cannot say.
    assert.match(js, /"Fit to native resolution \(" \+ dims\.w \+ " x " \+ dims\.h \+ "\)"/);
    // Repainted from the state machine AND from the sources, because the
    // dimensions can change without the stream state changing at all.
    assert.match(js, /repaintFitButton\(\); \/\/ a picture arriving or going/);
    assert.match(js, /img\.addEventListener\("load", repaintFitButton\)/);
    assert.match(js, /vid\.addEventListener\("resize", repaintFitButton\)/);
});

test("a chosen theme outranks the OS instead of being overwritten by it", () => {
    // Boot used to re-apply the OS theme, and applyTheme persists, so every
    // launch quietly overwrote the user's choice with the system one: the button
    // worked, the value saved, and it was gone by the next start.
    assert.match(js, /function storedTheme\(\)/);
    assert.match(js, /function applyTheme\(t, remember\)/);
    // Only a deliberate choice is written down.
    assert.match(js, /if \(remember\) \{\s*\n\s*try \{\s*\n\s*localStorage\.setItem\("pikvm-console-theme", t\)/);
    assert.match(js, /applyTheme\(currentTheme\(\) === "light" \? "dark" : "light", true\)/);
    // Following the OS records nothing, and only happens without a choice.
    assert.match(js, /if \(!storedTheme\(\)\) applyTheme\(e\.matches \? "dark" : "light", false\)/);
    assert.match(js, /applyTheme\(storedTheme\(\) \|\| \(osThemeMq\.matches \? "dark" : "light"\), false\)/);
    // The unconditional OS override is gone.
    assert.doesNotMatch(js, /overrides any stale saved value/);
});

test("the daemon and the harness resolve one pikvm-agent installation", () => {
    // They are the same install, and the preference order used to be written out
    // twice — one resolver gaining a candidate the other did not is how the two
    // end up launching different builds.
    assert.match(main, /function agentExecutables\(\.\.\.preferred/);
    const resolvers = main.match(/dev\/pikvm-agent\/\.venv\/bin\/pikvm-agent/g) ?? [];
    assert.equal(resolvers.length, 1, "the candidate list is duplicated again");
    // agent/ is in this repo now, so its venv leads; the standalone checkout stays
    // below it so an existing working setup keeps running.
    assert.match(main, /resolve\(__dirname, "\.\.", "agent", "\.venv", "bin", "pikvm-agent"\)/);
    assert.match(main, /return \[\.\.\.preferred, inRepo, standalone\]/);
    // Both resolvers go through it.
    assert.match(main, /agentExecutables\(configured, process\.env\.PIKVM_AGENT_DAEMON_CMD\)/);
    assert.match(main, /agentExecutables\(configured, process\.env\.PIKVM_HARNESS_CMD, process\.env\.PIKVM_AGENT_DAEMON_CMD\)/);
});

test("the operator credential never reaches a renderer", () => {
    /* It used to be a sentinel in the page swapped for the real token by a
     * session header rewrite, which meant the credential existed in the
     * renderer's network stack even if never in its JavaScript.
     *
     * Both hosts of the conversation now load from OUR origin and reach the
     * harness through the /_agent/harness proxy, which drops whatever
     * Authorization a renderer sent and attaches the desktop's own — so the
     * token is only ever in the main process. The rewrite is gone because it
     * could no longer fire, and a rule that cannot fire is not defence in
     * depth, it is a claim about auth that stopped being true. */
    assert.doesNotMatch(main, /onBeforeSendHeaders/);
    assert.doesNotMatch(main, /withHarnessAuthorization/);
    assert.doesNotMatch(main, /seedHarnessAuth/);
    assert.doesNotMatch(main, /agentView/);
    // One URL for both, on our origin.
    assert.match(main, /function workspaceUrl\(\)/);
    assert.match(main, /agentWin\.loadURL\(workspaceUrl\(\)\)/);
    // And the proxy that carries the capability is still wired with both halves.
    assert.match(main, /harnessOrigin,\n\s+harnessToken: harness\.accessToken,/);
});

test("ctrl+scroll belongs to the target on desktop, not to our zoom", () => {
    // Zooming the local picture is a phone affordance: there is no other way to
    // look closer there, and no target application expecting the gesture. On a
    // desktop Ctrl+scroll is how you zoom an editor or a browser over there.
    assert.match(js, /if \(!window\.desktopConsole\) \{\s*\n\s*zoomAround\(/);
    // Bare modifiers are never forwarded, so it has to be wrapped explicitly or
    // the target receives a plain scroll.
    assert.match(js, /var mod = e\.metaKey \? "MetaLeft" : "ControlLeft";/);
    /* Wrapped through owned(), not pressed and released blind.
     *
     * This used to assert the three literal lines hid.key(mod,true) / wheel /
     * hid.key(mod,false), and those lines RELEASED a modifier the user was
     * still holding: the mirror went on believing Ctrl was down, owned()
     * excluded it from every later chord, and the target had it up — so hold
     * Ctrl, scroll, press A, and the target got a plain A.
     *
     * The behaviour to pin is that the wheel is wrapped by whatever the mirror
     * says is OURS to press, which is empty when the user is already holding
     * the key and is the modifier itself for a trackpad pinch. */
    assert.match(js, /var mine = modMirror\.owned\(\[mod\]\);/);
    assert.match(js, /hid\.wheel\(0, dy\);/);
    // key-chord is still the thing that ignores bare modifiers, which is why.
    const chord = readFileSync(resolve(root, "src/views/key-chord.js"), "utf8");
    assert.match(chord, /BARE_MODIFIER\.test\(code\)\) return \{ kind: "ignore"/);
});

test("every titlebar button keeps the console's own button class", () => {
    /* Two things live on .tb-btn and neither is decoration.
     *
     * -webkit-app-region:no-drag — the titlebar IS the window drag region, so a
     * button inside one without this is a surface the window manager takes the
     * click from. CDP cannot catch that: dispatched input goes straight to the
     * renderer and never meets the compositor, so a real click and a scripted
     * one disagree exactly here.
     *
     * And the focus ring. The shared component's own ring resolves against a
     * --ring this document does not define, so it computed to rgba(0,0,0,0) —
     * measured against the window controls, which had kept .tb-btn and showed a
     * solid 2px ring. Twelve buttons had no visible focus at all. */
    assert.match(js, /function withTbClass\(specs\)/);
    assert.match(js, /out\.className = "tb-btn" \+ extra;/);
    // Applied at every mount and every update, so a new button cannot miss it.
    const wrapped = js.match(/withTbClass\(/g) ?? [];
    assert.ok(wrapped.length >= 13, `only ${wrapped.length} spec sites go through it`);
    assert.doesNotMatch(js, /mountIconButtons\([A-Za-z]+Host, [a-zA-Z]+Specs\(\)\)/);
    // The class that carries it must still say why.
    assert.match(css, /-webkit-app-region: no-drag/);
});

test("a dialog never opens with focus on a live slider", () => {
    /* The stream dialog's sliders POST to the target on `change`, and a range
     * input fires change on the FIRST arrow press. Opening with one focused
     * meant a single keystroke retuned the live picture before anyone had
     * decided to — measured: sp-quality held focus the moment the dialog
     * appeared.
     *
     * Nothing else in these dialogs acts on a keystroke that way, so the rule is
     * narrow: skip ranges, take the next thing, and fall back to the dialog
     * itself so it is still announced and the trap still has somewhere to hold. */
    assert.match(js, /function initialFocusIn\(scrim\)/);
    assert.match(js, /if \(items\[i\]\.type !== "range"\) return items\[i\];/);
    assert.match(js, /dlg\.setAttribute\("tabindex", "-1"\)/);
    assert.match(js, /var first = initialFocusIn\(scrim\);/);
    // The old unconditional first-focusable is gone.
    assert.doesNotMatch(js, /var first = focusablesIn\(scrim\)\[0\];/);
});

test("mass storage does not claim absence from missing data", () => {
    /* The dialog can be opened before the first msd event arrives, and the
     * summary treated "no state yet" and "no mass storage" as the same answer —
     * telling the user their PiKVM has none, about hardware they may well have.
     * Those are different sentences and only one of them is knowable. */
    assert.match(js, /if \(!state\) return "Checking the drive…";/);
    assert.match(js, /if \(!state\.enabled\) return "This PiKVM has no mass storage\.";/);
    assert.doesNotMatch(js, /if \(!state \|\| !state\.enabled\) return "This PiKVM has no mass storage/);
});

test("OCR will not copy its own 'nothing here' message", () => {
    /* When the reader finds nothing, the dialog says so — but that line went
     * into the same box as real text, so Copy put the sentence "(no text found
     * in that region)" on the clipboard and reported "Text copied". Both
     * useless and untrue. It is a message, not a result. */
    assert.match(js, /ocrHasText = found\.length > 0;/);
    assert.match(js, /disabled: !ocrHasText,/);
    assert.match(js, /if \(out && ocrHasText\) copyText\(out\.value, "Text copied"\);/);
});

test("the log will not copy its own status messages", () => {
    /* "…", "Loading…", "Loading… 546 KB", "(nothing in this window)" and the
     * read error all land in the same <pre> the log lands in. Copy took
     * whichever was showing and reported "Log copied", so pressing it early put
     * the word "Loading…" on the clipboard with nothing to say it had. */
    assert.match(js, /var logHasText = false;/);
    assert.match(js, /logHasText = !!capped;/);
    assert.match(js, /disabled: !logHasText,/);
    assert.match(js, /if \(body && logHasText\) copyText\(body\.textContent, "Log copied"\);/);
    // Cleared again when a fresh load starts and when one fails.
    const cleared = js.match(/logHasText = false;\s*\n\s*repaintLogActions\(\);/g) ?? [];
    assert.ok(cleared.length >= 2, "a failed or restarted load must disable Copy again");
});

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

test("a dialog's actions stay put when its content has to scroll", () => {
    /* A .dlg caps at 520px and scrolls past that, and .dlg-actions was part of
     * the scrolling content. With nine problems and ten GPIO rows in a 560px
     * window the health dialog pushed Done, Detach and Reset out of sight — so
     * reaching the dialog's own buttons meant scrolling the dialog.
     *
     * Sticky costs nothing when nothing overflows: the row sits where it already
     * sat. The background is not decoration — without it the scrolling content
     * passes visibly under the buttons and reads as a rendering fault. */
    assert.match(css, /\.dlg-actions \{[\s\S]*?position: sticky;[\s\S]*?bottom: 0;[\s\S]*?background: var\(--card\);/);
});

test("the backend pill reports vision as a fact, not as progress", () => {
    /* The daemon reports omniparser reachable true or false and never says it is
     * on its way. The console rendered false as "loading…" — its own guess, and
     * one that read the same after hours of the service simply not running.
     *
     * The pill itself still says "Ready" on s.ok, which is right: the daemon's
     * own needed_for says vision gates autonomous perception only, so the
     * backend genuinely is usable without it. Only the word describing the
     * dependency was wrong, so only that changed. */
    assert.match(js, /"unavailable \(autonomous mode only\)"/);
    assert.doesNotMatch(js, /"Vision: " \+ \(d\.omniparser\.reachable \? "ready" : "loading…"\)/);
    // The overall state still follows the daemon's own verdict.
    assert.match(js, /var ready = !!s\.ok;/);
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
    assert.match(js, /ariaLabel: delta < 0 \? "Move step up" : "Move step down"/);
    assert.match(js, /pendingMacroFocus = \(delta < 0 \? "u" : "n"\) \+ to;/);
    assert.match(js, /stepRoots\.push\(sharedRow\.mountButtons\(actions, actionSpecs\)\)/);
    // A fallback for the window before the bundle has run: buttons drawn the old
    // way beat a row with none. Shared with the dialog rows, which hit the same
    // problem harder — a dialog with no buttons has no Done either.
    assert.match(js, /renderPlainButtons\(actions, actionSpecs\)/);
    assert.doesNotMatch(js, /var move = function \(delta, label\)/);
});


/**
 * Tabbing along the macro strip cannot leave you on a half-clipped button.
 *
 * The strip clips so it can give way instead of pushing the window controls
 * off the bar, and the browser scrolls a focused child back into view by
 * itself — but only one that is ENTIRELY outside the scrollport. The button
 * straddling the clip edge counts as visible and is left where it is.
 * Measured at 900px with sixty pinned macros, focusing each in turn:
 *
 *     macro 16 : 100% visible, scrollLeft=0
 *     macro 17 :  53% visible, scrollLeft=0     <- half cut, half its ring gone
 *     macro 18 : 100% visible, scrollLeft=321
 *
 * That is the one you always land on crossing from the visible macros into
 * the clipped ones, so it is not an edge case, it is the boundary. After:
 * macro 17 comes to 100% at scrollLeft=14, the smallest nudge that works, and
 * every other macro is unchanged. Page scroll stays 0/0 and the titlebar and
 * screen do not move, so "nearest" is not dragging an ancestor around.
 */
test("a macro tabbed to at the clip edge is scrolled fully into view", () => {
    const at = js.indexOf('macroHost.addEventListener("focusin"');
    assert.ok(at > 0, "no focusin handler on the macro strip");
    const body = js.slice(at, at + 400);
    // "nearest" both ways: the minimum scroll, and nothing when already whole.
    assert.match(body, /scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/);
    // Only for buttons in this strip, so a focus elsewhere never moves it.
    assert.match(body, /macroHost\.contains\(btn\)/);
});

/**
 * The simulated cursor does not follow the pointer into the letterbox.
 *
 * .screen is cursor:none, so the blob is the only pointer on screen over the
 * picture — the CSS says as much where it is defined. The drag path already
 * refuses to follow the host pointer out into the letterbox, because the blob
 * is meant to show where the TARGET's cursor is. Hovering had no such rule, so
 * the blob tracked out over the bars while nothing was being sent at all.
 * Measured with a 1280x720 picture letterboxed into a 759x775 box:
 *
 *     inside the picture  : blob shown, 1 move sent
 *     letterbox bar above : blob shown at y=53,  0 moves sent
 *     letterbox bar below : blob shown at y=788, 0 moves sent
 *
 * The one thing telling the user where their input goes, saying it in a place
 * no input goes.
 *
 * Hiding it alone would leave the bars with no pointer at all, so the real one
 * comes back with it — outside the picture you get your own cursor, which is
 * the honest signal that you are off the target. Clamping to the edge instead
 * would be its own lie: no move was sent, so the target's pointer is still
 * wherever it was. After:
 *
 *     inside the picture  : blob block, pane cursor none,    1 move
 *     letterbox bar above : blob none,  pane cursor default, 0 moves
 *     letterbox bar below : blob none,  pane cursor default, 0 moves
 *     back inside         : blob block, pane cursor none,    1 move
 *
 * And the drag is untouched, which is the regression that mattered: pressed
 * inside then dragged into the bar still pins the blob to the picture edge
 * (y=207 against a picture starting at 212) with the real cursor still hidden,
 * and the press/release pair still reaches the target.
 */
test("hovering the letterbox hides the blob and gives back the real cursor", () => {
    const at = js.indexOf("function paintCursor(clientX, clientY, dragging) {");
    assert.ok(at > 0, "paintCursor not found");
    const body = js.slice(at, js.indexOf("pane.addEventListener(\"pointerleave\"", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    // Only when NOT dragging — the drag keeps steering from the edge.
    assert.match(body, /if \(!dragging && offPicture\) \{/);
    assert.match(body, /clientX < offPicture\.left \|\|[\s\S]*?clientY > offPicture\.top \+ offPicture\.h;/);
    // Blob away, real pointer back.
    assert.match(body, /kvmCursor\.style\.display = "none";\s*\n\s*pane\.style\.cursor = "default";/);
    // And restored on the way back in, so the inline style cannot stick.
    assert.match(body, /pane\.style\.cursor = "";/);
    // The drag clamp it defers to is still there.
    assert.match(body, /if \(dragging\) \{[\s\S]*?pictureBox\(\)/);
});

/**
 * Falling back to MJPEG when already on MJPEG reopens the stream for nothing.
 *
 * The WebRTC wrapper reports "error" and keeps retrying, and onStatus calls
 * fallbackToMjpeg() on every one of those while no video has been seen. So on
 * any Pi without a working Janus this ran every few seconds forever.
 * Everything in it is teardown of a session that is not there — except the
 * last two lines, which drop a perfectly good MJPEG connection and reopen it.
 * Counted while the picture never left "live":
 *
 *     +2.4s  /streamer/stream?key=…
 *     +7.5s  /streamer/stream?key=…
 *     +12.7s /streamer/stream?key=…
 *     +17.7s /streamer/stream?key=…
 *     +22.7s /streamer/stream?key=…
 *
 * Five reopens in twenty-five seconds, each freezing the last frame while the
 * <img> reloads — a visible stutter every five seconds during ordinary
 * viewing, on exactly the setups least able to spare the re-encode. The
 * server was holding the stream open the whole time; verified with curl that
 * it survives well past five seconds, so the client was doing this to itself.
 *
 * mjpegPaused is what separates this from a real fallback: WebRTC suspends the
 * MJPEG pipeline when it takes over, so a fallback that has to resume it still
 * has work even though webrtcActive never became true. Only when the pipeline
 * is already running AND there was no session is there nothing to do.
 *
 * After: 0 reopens and 0 freezes over the same 25s, still "live", with the
 * health poll untouched at its 10 polls.
 */
test("falling back to MJPEG does nothing when MJPEG is already running", () => {
    const at = js.indexOf("function fallbackToMjpeg() {");
    assert.ok(at > 0, "fallbackToMjpeg not found");
    const body = js.slice(at, js.indexOf("\n    function revealAvToggles", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    // The guard, and the two facts it is built from.
    assert.match(body, /var was = webrtcActive;/);
    assert.match(body, /if \(!was && !mjpegPaused\) return;/);
    // It has to come before the teardown, or it protects nothing.
    assert.ok(body.indexOf("if (!was && !mjpegPaused) return;") < body.indexOf("webrtcActive = false;"),
        "the guard must precede the teardown");
    // And the reload it exists to prevent is still the last thing it does.
    assert.match(body, /streamUp = false;\s*\n\s*loadStream\(\);/);
});

/**
 * One outage, one message.
 *
 * Three writers describe the same "no picture, retrying" situation with three
 * different names: pollHealth's catch sets "disconnected" every 2.5s,
 * loadStream sets "reconnecting", scheduleReconnect sets "offline". Two of
 * those render the identical word in different colours ("Reconnecting" red for
 * offline, white for reconnecting), and none knew about the others. So a
 * single unchanging outage made the overlay thrash. Recorded over 24s with the
 * streamer refusing every request:
 *
 *     1039ms disconnected  "Screen unavailable" red
 *     1273ms offline       "Reconnecting"       red
 *     3539ms disconnected  "Screen unavailable" red
 *     5756ms reconnecting  "Reconnecting"       white
 *     5772ms offline       "Reconnecting"       red      <- 16ms later
 *     6039ms disconnected  "Screen unavailable" red
 *     ...
 *
 * Nineteen changes in twenty-four seconds, alternating both the wording and
 * the colour, with one-frame white flashes in the middle of it — on the one
 * surface whose job is to explain why there is no picture.
 *
 * serverDown is the health poll's own verdict, so while it holds, that verdict
 * is the only one shown and the retry loop stays quiet. It still retries; it
 * just stops narrating. After, the same outage reads:
 *
 *        0ms live          "Connecting"
 *     1047ms disconnected  "Screen unavailable"
 *
 * and nothing more for the remaining 25s. Recovery is unaffected — a full
 * down-and-up cycle goes disconnected -> reconnecting -> live on its own.
 */
test("a single outage does not make the overlay thrash", () => {
    const load = js.indexOf("function loadStream() {");
    assert.ok(load > 0, "loadStream not found");
    const body = js.slice(load, load + 2200).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(body, /if \(streamState !== "live" && !serverDown\) setState\(/);
    const sched = js.indexOf("function scheduleReconnect() {");
    assert.ok(sched > 0, "scheduleReconnect not found");
    const body2 = js.slice(sched, sched + 700).replace(/\/\/[^\n]*/g, "");
    assert.match(body2, /if \(streamState !== "disconnected" && !serverDown\) setState\("offline"\);/);
    // The health poll is still the one that sets it, and still the one that clears it.
    assert.match(js, /serverDown = true;\s*\n\s*streamUp = false;\s*\n\s*if \(!mjpegPaused\) setState\("disconnected"\);/);
    assert.match(js, /var wasDown = serverDown;\s*\n\s*serverDown = false;/);
});

/**
 * Every menu command reaches something that exists.
 *
 * runCommand's switch delegates several entries to a control elsewhere in the
 * console — audio and mic click their toggles, theme clicks its button — and
 * "fit" delegated to a variable named tbFit that is declared nowhere. One
 * occurrence in the whole file: the read. So choosing "Fit to native
 * resolution" from the ⋯ menu threw ReferenceError and did nothing, while the
 * item sat there enabled whenever the stream reported dimensions.
 *
 * Found by watching Runtime.exceptionThrown while driving every menu command
 * in turn, rather than by reading — the line looks exactly like its working
 * siblings.
 *
 * It now calls fitNativeNow, which is what the titlebar's own fit button
 * calls, rather than a button standing in for it. Both routes verified to
 * produce the identical payload:
 *
 *     titlebar button -> [{"width":1280,"height":720,"chromeWidth":641,"chromeHeight":38}]
 *     ⋯ menu "fit"    -> [{"width":1280,"height":720,"chromeWidth":641,"chromeHeight":38}]
 *
 * with no exception from either.
 */
test("the fit menu command calls something that exists", () => {
    const sw = js.slice(js.indexOf('case "settings":'), js.indexOf('case "full-ui":'));
    const bare = sw.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(bare, /case "fit":\s*\n\s*fitNativeNow\(\);/);
    assert.doesNotMatch(bare, /tbFit/);
    /* The names the other cases delegate to have to exist too. Each is asserted
     * as a declaration rather than merely present, since the bug was a name
     * that appeared exactly once — at its use. */
    for (const name of ["audioBtnEl", "micBtnEl", "themeBtn"]) {
        assert.ok(new RegExp(`\\bvar ${name}\\b`).test(js), `${name} is used by a menu case but never declared`);
    }
    assert.match(js, /function fitNativeNow\(\) \{/);
});

/**
 * The desktop block really is skipped off the desktop.
 *
 * Its header comment says it "runs ONLY inside the Electron desktop window" and
 * that "on any phone or browser this whole block is skipped". The guard that
 * would do that sat ninety-eight lines into the IIFE, after three
 * `if (dc.onAgentAttached)`-style subscriptions that dereference dc at LOAD
 * time. On web and mobile dc is undefined, so the block did not skip — it threw
 * on every page load:
 *
 *     TypeError: Cannot read properties of undefined (reading 'onAgentAttached')
 *
 * and the guard below was then unreachable, so the mechanism the comment
 * describes never ran at all. It was benign only by luck: this IIFE is the last
 * thing in the file, so the abort took nothing else with it. Anything appended
 * to console.js later would have silently not run on web.
 *
 * Moving it was safe because the two statements it now skips do not matter off
 * the desktop: the panel-message listener is answered for EVERY platform by the
 * copy near applyTheme, whose own comment explains that it exists precisely
 * because this block is skipped in a browser; and every html.agent-right rule
 * in console.css is scoped to html.desktop-console, so setting that class on a
 * phone styled nothing. Confirmed after the move: the phone console loads with
 * no exceptions across repeated runs, and the desktop is unchanged.
 *
 * Asserted as a scan rather than a line number, so a dereference added above
 * the guard later fails here instead of throwing on every phone.
 */
test("nothing touches the desktop bridge before the web/mobile guard", () => {
    const at = js.indexOf("(function desktopConsole() {");
    assert.ok(at > 0, "the desktop block is not there");
    const guard = js.indexOf("if (!dc) return;", at);
    assert.ok(guard > at, "the desktop block has no web/mobile guard");
    const before = js.slice(at, guard).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // Only the assignment may mention dc above the guard.
    assert.match(before, /var dc = window\.desktopConsole;/);
    const uses = before.match(/\bdc\s*[.[]/g) ?? [];
    assert.deepEqual(uses, [], `dc is dereferenced ${uses.length} time(s) before the guard`);
});

/**
 * The agent pill announces changes, not the passage of time.
 *
 * It is role="status" aria-live="polite" and VISIBLE on the desktop, so every
 * write to its text is an announcement. pollBackend runs every five seconds
 * and called setBackend unconditionally with whatever it found, so reassigning
 * the same string re-created the text node and announced it again. Counted
 * with a MutationObserver over 22 seconds against a steady Pi:
 *
 *     backend-status  5 mutations   text "Agent ready" throughout
 *     overlay         0
 *     toast           0
 *
 * A screen reader said "Agent ready" every five seconds for as long as the
 * window stayed open. The two live regions that behave are the ones that only
 * write on a real change, which is what this now does.
 *
 * Re-measured across a real transition:
 *
 *     12s steady         0 announcements
 *     daemon goes down   1  ("Agent unavailable")
 *     11s still down     1  (does not repeat)
 *     daemon returns     2  ("Agent ready")
 *
 * dataset.state stays outside the guard: it drives the CSS, an attribute write
 * does not announce, and there is no reason to let the styling drift out of
 * step with the poll.
 */
test("the agent status pill only speaks when it has something new to say", () => {
    const at = js.indexOf("var lastBackend = null;");
    assert.ok(at > 0, "setBackend has no change guard");
    const body = js.slice(at, js.indexOf("var pollBackend", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    // The styling is unconditional; only the announcing writes are guarded.
    assert.match(body, /bsEl\.dataset\.state = state;\s*\n\s*var key = state \+ "\\n" \+ label \+ "\\n" \+ tip;/);
    assert.match(body, /if \(key === lastBackend\) return;\s*\n\s*lastBackend = key;/);
    // And the text write is after the guard, or the guard protects nothing.
    assert.ok(body.indexOf("if (key === lastBackend) return;") < body.indexOf("bsText.textContent = label"),
        "the text must be written only after the change check");
    // The element really is a live region, which is why this matters at all.
    assert.match(html, /id="backend-status"[^>]*role="status"[^>]*aria-live="polite"/);
});

/**
 * The titlebar's status buttons re-render only when their state moved.
 *
 * paintHealth and the ATX painter both end in repaintTbState, and both run on
 * every event of their kind, so an unchanged Pi re-rendered the health and
 * power buttons continuously. Counted titlebar mutations for six IDENTICAL
 * events of each type:
 *
 *     msd 0   streamer 0   gpio 0
 *     info 6   atx 6   hid 6
 *
 * The three that churned are exactly the three that reach here. After, all six
 * are 0.
 *
 * Compared on tbState rather than on the specs: the specs are built from
 * tbState alone, so it answers the same question — would the render differ —
 * without having to compare objects that carry functions.
 *
 * Real changes still land, which is the failure mode a key-based guard has.
 * Walked the states and checked the button labels each time:
 *
 *     power off -> on            "Power — target is off" -> "target is on"
 *     hid detached               health button appears, is-error
 *     + undervolted              label GROWS to carry both problems
 *     atx busy                   "Power — busy"
 *     all clear                  health button gone
 *
 * That fourth step is the one worth checking: both labels start with the same
 * fifty characters, so a guard keyed on anything shorter than the whole string
 * would have swallowed it.
 */
test("the titlebar status buttons skip re-renders that would not change", () => {
    const at = js.indexOf("var lastTbKey = null;");
    assert.ok(at > 0, "repaintTbState has no change guard");
    const body = js.slice(at, js.indexOf("repaintTbState();", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(body, /var key = JSON\.stringify\(\[tbState\.health, tbState\.power\]\);/);
    assert.match(body, /if \(key === lastTbKey\) return;\s*\n\s*lastTbKey = key;/);
    // The update must be after the guard, or it protects nothing.
    assert.ok(body.indexOf("if (key === lastTbKey) return;") < body.indexOf("statusButtons.update"),
        "the re-render must happen only after the change check");
});

test("a repaint never rewrites an attribute with the value it already has", () => {
    // aria-valuetext is what a screen reader reads for a slider, and Chromium
    // raises a value-changed event on the write rather than on the value
    // differing. Every streamer event repaints the stream dialog, and
    // controlBusy only skips a control being DRAGGED, so a slider that was
    // merely focused had its value re-announced on each event. Measured before
    // the fix: six identical pushes, six announcements of an unchanged "80%".
    assert.match(js, /function setAttr\(el, name, value\) \{\s*if \(el && el\.getAttribute\(name\) !== value\) el\.setAttribute\(name, value\);/);
    assert.match(js, /function setProp\(el, name, value\) \{\s*if \(el && el\[name\] !== value\) el\[name\] = value;/);
    assert.match(js, /setAttr\(el, "aria-valuetext", text\)/);
    // And the churn siblings that shared the same repaint.
    assert.match(js, /setProp\(el, "min", String\(range\.min\)\)/);
    assert.match(js, /setProp\(el, "max", String\(range\.max\)\)/);
    assert.match(js, /setProp\(row, "hidden", !have\)/);
    assert.match(js, /setProp\(resRow, "hidden", !hasRes\)/);
    assert.match(js, /setProp\(empty, "hidden", anything\)/);
    assert.match(js, /setProp\(note, "hidden", !note\.textContent\)/);
    // String, not number: el.min reads back as a string, so an unguarded
    // numeric compare never matches and the guard silently does nothing.
    assert.doesNotMatch(js, /setProp\(el, "m(in|ax)", range\.m(in|ax)\)/);
    // No unguarded aria-valuetext write anywhere.
    const raw = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(raw, /setAttribute\("aria-valuetext"/);
});

test("the resolution toast says nothing while it is not on screen", () => {
    // It hides with opacity:0, and opacity does not remove an element from the
    // accessibility tree — so the last resolution it reported stayed readable
    // forever after, and before the first frame it read out an em dash. Exactly
    // inverted: permanently present while invisible, never announced when it
    // actually appeared.
    assert.match(html, /id="res-toast" role="status" aria-live="polite"/);
    // No placeholder to be read before there is anything to say.
    assert.match(html, /<span id="res-toast-main"><\/span>/);
    // Emptied when it hides, which is what makes the NEXT show a real content
    // change in the live region rather than a silent one. Through the shared
    // helper, so it waits out the fade instead of blanking a still-opaque pill.
    assert.match(js, /resToast\.classList\.remove\("show"\);[\s\S]{0,1200}?emptyWhenFaded\(resToast, \[resToastMain, resToastAv\]\);/);
    assert.match(html, /id="toast" role="status" aria-live="polite"/);
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

test("a Pi with no mass storage is not shown the whole drive form greyed out", () => {
    // It said "This PiKVM has no mass storage." and then drew image, mode,
    // writable, mount, delete, upload and image URL underneath it, disabled —
    // 438px of controls for a device that is not fitted, plus a Reset drive
    // button for it. The stream dialog answers the same question the other way,
    // which is what sp-empty is for. Measured after: 139px, one sentence, Done.
    assert.match(html, /<div class="dlg-form" id="msd-form">/);
    assert.match(js, /var have = msd\.available\(\);\s*setProp\(document\.getElementById\("msd-form"\), "hidden", !have\);/);
    // Resetting a drive that is not fitted is not a disabled action.
    assert.match(js, /id: "msd-reset",[\s\S]{0,220}?hidden: !msdAvailable,\s*disabled: !msdResetEnabled,/);
    assert.match(js, /msdAvailable = have;/);
    /* .dlg is a flex column with a 14px gap and these rows used to be its direct
       children. Boxing them up makes them ONE flex child, so the wrapper has to
       carry the same column layout or the spacing between the rows vanishes —
       verified live at 14px between rows, unchanged. */
    const dlgGap = css.match(/^\.dlg \{[\s\S]*?gap: (\d+)px;/m);
    const formGap = css.match(/^\.dlg-form \{[\s\S]*?gap: (\d+)px;/m);
    assert.ok(dlgGap && formGap, ".dlg and .dlg-form must both set a column gap");
    assert.equal(formGap![1], dlgGap![1], ".dlg-form must reproduce .dlg's own row spacing");
    assert.match(css, /^\.dlg-form \{[\s\S]*?flex-direction: column;/m);
});

test("the mass storage note says when the drive is busy", () => {
    // kvmd sets busy while it mounts, unmounts or resets, and paintMsd correctly
    // greys the whole form for the duration — but the note still read "Ready to
    // mount ubuntu.iso", a form claiming to be ready while refusing to act.
    // Measured: busy and busy+connected both left every control dead with no
    // reason anywhere on screen.
    assert.match(js, /if \(state\.busy\) return what \+ " The drive is busy, so nothing can be changed just now\.";/);
    // Appended, not replacing: which image is mounted is still the useful part.
    assert.match(js, /what = "Mounted on the target: "/);
    assert.match(js, /what = "Ready to mount "/);
    assert.match(js, /what = "The drive is idle\.";/);
    assert.match(js, /what = "No image selected\.";/);
    // Offline and not-fitted still answer first — they explain themselves, and
    // "busy" on top of "offline" would be two reasons for one dead form.
    const fn = js.slice(js.indexOf("summary: function () {"));
    const body = fn.slice(0, fn.indexOf("\n            },"));
    assert.ok(
        body.indexOf('return "The drive is offline.";') < body.indexOf("if (state.busy)"),
        "offline must be answered before busy",
    );
    // Each GPIO row already carries its own busy word; this is the same idea.
    assert.match(js, /setText\(note, !o\.online \? "offline" : o\.busy \? "busy" : ""\)/);
});

test("the keyboard and mouse row shows when the Pi is working on it", () => {
    // busy arrives in every hid event and setHid dropped it, so nothing
    // downstream could act on it: mid-reset the row read "attached" and offered
    // to detach, with both buttons live. MSD, ATX and GPIO all thread their own
    // busy through — this was the one that did not.
    assert.match(js, /if \(s\.busy !== undefined\) hidState\.busy = s\.busy;/);
    assert.match(js, /hidBusy: function \(\) \{\s*return !!\(hidState && hidState\.busy\);/);
    assert.match(js, /var word = !known \? "state unknown" : attached \? "attached" : "detached";/);
    assert.match(js, /setText\(stateEl, busy \? word \+ "  ·  busy" : word\)/);
    assert.match(js, /hidToggleState = \{ attached: !!attached, known: !!known, busy: !!busy \};/);
    // The toggle names what it will do, so it cannot stay live while the thing
    // it describes is already moving.
    // (Our own in-flight request was added to the same condition later; what
    // matters here is that the Pi's busy is one of the things that gates it.)
    assert.match(js, /disabled: !hidToggleState\.known \|\| hidToggleState\.busy\b/);
    /* Reset deliberately does NOT gate on busy, unlike its mass storage
       counterpart: it is the recovery lever for a keyboard the target has
       stopped answering, and a Pi stuck reporting busy would take the escape
       hatch away exactly when it is wanted. */
    const specs = js.slice(js.indexOf("function healthActionSpecs()"));
    const reset = specs.slice(specs.indexOf('id: "hid-reset"'), specs.indexOf('id: "health-close"'));
    assert.doesNotMatch(reset, /disabled:/, "hid Reset must stay reachable while the Pi reports busy");
    assert.match(js, /msdResetEnabled = online && !busy && !msdUpload;/, "MSD reset is the counterpart that does gate");
});

test("the paste keymap list follows the Pi instead of only the dialog opening", () => {
    // fillKeymaps ran only from openPasteDialog, so a hid_keymaps event that
    // landed while the dialog was already open never reached the select — it
    // stayed hidden for the life of that dialog. kvmd sends this on every ws
    // connection, so it happens on the first one if the dialog is opened
    // quickly, and again on every reconnect.
    // Comments sit between the two statements, so strip them before asserting
    // the call actually follows the assignment rather than only appearing near it.
    const bare = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.match(bare, /kvmdKeymaps = ed\.keymaps;\s*fillKeymaps\(\);/);
    // Now that an event can drive it, it obeys the same rule as every other
    // native select here: rebuilding one shuts its dropdown under the pointer.
    assert.match(js, /function fillKeymaps\(\) \{\s*if \(!pasteKeymap\) return;[\s\S]{0,400}?if \(controlBusy\(pasteKeymap, fillKeymaps\)\) return;/);
    // Which makes it the fourth select through the one guard, not a new rule.
    for (const call of [
        /if \(!controlBusy\(resSel, paintStreamDialog\)\)/,
        /sel && !controlBusy\(sel, paintMsd\)/,
        /mode && !controlBusy\(mode, paintMsd\)/,
        /if \(controlBusy\(pasteKeymap, fillKeymaps\)\) return;/,
    ]) assert.match(js, call);
});

test("mount and detach cannot be fired three times by one double-click", () => {
    /* canConnect, canDisconnect and the hid toggle's busy are all derived from
       the Pi's own state, which does not arrive until the Pi has answered — so
       between the click and the event every further click went straight out.
       Measured with fetch instrumented, three rapid presses each:
           msd Mount   ["set_connected","set_connected","set_connected"]
           hid Detach  ["set_connected","set_connected","set_connected"]
           gpio Pulse  ["pulse"]                      <- already guarded
       kvmd serialises these, so the redundant ones come back as failures and
       the user gets error toasts for an operation that is in fact working. */
    assert.match(js, /var msdConnectPending = false;/);
    assert.match(js, /function setMsdConnected\(on\) \{\s*if \(msdConnectPending\) return;\s*msdConnectPending = true;\s*repaintMsdBody\(\);/);
    // Released when the request settles, so a deliberate retry still works —
    // verified live: a second click after the first landed sent a second request.
    assert.match(js, /msd\.setConnected\(on\)\.then\(function \(\) \{\s*msdConnectPending = false;\s*repaintMsdBody\(\);/);
    assert.match(js, /disabled: !msdBody\.canConnect \|\| msdConnectPending,/);
    assert.match(js, /disabled: !msdBody\.canDisconnect \|\| msdConnectPending,/);
    // Both buttons go through the helper, so neither can call msd.setConnected raw.
    const bare = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.equal(
        (bare.match(/msd\.setConnected\(/g) ?? []).length,
        1,
        "msd.setConnected must only be reached through setMsdConnected",
    );
    assert.match(js, /var hidTogglePending = false;/);
    assert.match(js, /disabled: !hidToggleState\.known \|\| hidToggleState\.busy \|\| hidTogglePending,/);
    assert.match(js, /setHidConnected\(!isAttached\)\.then\(function \(\) \{\s*hidTogglePending = false;\s*repaintHealthActions\(\);/);
    // The guard these two were copied from.
    assert.match(js, /disabled: o\.busy \|\| !o\.online \|\| !!gpioPending\[name\],/);
});

test("save screenshot cannot be fired three times by one double-click", () => {
    // A full-resolution JPEG handed to the browser's download machinery, with
    // nothing gated on the fetch in flight: three rapid clicks measured three
    // snapshot requests, three downloads and three "Screenshot saved" toasts —
    // three files in the downloads folder, each with its own timestamp, from
    // one slip. It was the last single unconfirmed click without a guard; the
    // rest of the burst sweep is protected by window.confirm.
    assert.match(js, /var screenshotBusy = false;/);
    assert.match(js, /function saveScreenshot\(\) \{\s*if \(screenshotBusy\) return;\s*screenshotBusy = true;\s*repaintStreamActions\(\);/);
    assert.match(js, /\.then\(function \(\) \{\s*screenshotBusy = false;\s*repaintStreamActions\(\);\s*\}\);/);
    // Both ways in: the dialog button disables, and the ⋯ menu entry greys.
    assert.match(js, /id: "sp-screenshot", label: "Save screenshot", disabled: screenshotBusy,/);
    assert.match(js, /id: "screenshot", label: "Save screenshot", enabled: !screenshotBusy/);
    /* And the declaration has to run BEFORE the IIFE that assigns it. var
       hoists but its initialiser does not, so `var streamActions = null` below
       wireStreamDialog let the mount happen and then wiped it — repaint saw
       null forever and the button stayed clickable while its own request was in
       flight, which is the worst shape of all: a live button that ignores you.
       Verified live with the snapshot held open: disabled true during, false
       after. */
    const bare = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const declared = bare.indexOf("var streamActions = null;");
    const assigned = bare.indexOf("streamActions = mountDialogActions(");
    assert.ok(declared > -1 && assigned > -1, "streamActions must be declared and mounted");
    assert.ok(declared < assigned, "var streamActions = null must run before wireStreamDialog assigns it");
});

test("the conversation pane is never a white slab waiting for the daemon", () => {
    /* A frame with no src is not an empty frame — it is about:blank, and that
       document paints its own opaque WHITE base over whatever the element's
       background says. #chat-frame is set to var(--background) for exactly this
       reason and never had a chance: measured with the daemon stopped, the pane
       was a 600px white slab down the right of a black window, and it stayed
       that way until the daemon came back. The frame starts srcless and is
       emptied again on every harness drop, so it showed on a cold start too. */
    assert.match(css, /html\.desktop-console #chat-frame \{\s*background: var\(--background\);/);
    // Hidden until it has something to show, and on every drop after that.
    assert.match(js, /chatFrame\.removeAttribute\("aria-hidden"\);[\s\S]{0,1400}?chatFrame\.hidden = true;/);
    assert.match(js, /chatFrame\.src = WORKSPACE_URL;\s*chatFrame\.hidden = false;/);
    assert.match(js, /chatFrame\.removeAttribute\("src"\);\s*chatFrame\.hidden = true;/);
    /* And it only hides because this sheet forces the attribute to win.
       #chat-frame sets display:block, which beats the UA's [hidden] rule on
       its own — the same trap that once left the MSD progress bar permanently
       on screen. */
    assert.match(css, /\[hidden\] \{\s*display: none !important;/);
});

test("dismissing the overflow menu returns focus to the button that opened it", () => {
    /* The items are display:none'd along with the .open class, so closing with
       focus still inside dropped it on the floor: open the menu, Tab to an item,
       press Escape, and activeElement was the body — a full Tab walk back from
       the top of the document. Measured before the fix:
           focusedItem "Paste text to the target…"  ->  Escape  ->  BODY
       Every dialog here already restores focus to its trigger; this was the one
       dismissable thing that did not. */
    assert.match(js, /if \(!open && moreMenu\.contains\(document\.activeElement\)\) moreBtn\.focus\(\);/);
    /* Guarded on focus actually being inside, and placed BEFORE the class
       toggle. Picking an ITEM also closes the menu, and by then that item's
       handler has opened a dialog and focused it — restoring unconditionally
       would snatch focus straight back out. Verified: choosing "Paste text to
       the target…" leaves focus on #paste-text with the dialog open. */
    const fn = js.slice(js.indexOf("function setMenuOpen(open) {"));
    const body = fn.slice(0, fn.indexOf("\n        }"));
    const bare = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.ok(
        bare.indexOf("moreBtn.focus()") < bare.indexOf("classList.toggle"),
        "focus must move before the items are hidden",
    );
    assert.doesNotMatch(bare, /^\s*moreBtn\.focus\(\);/m, "the restore must stay conditional");
    // The four close paths all go through this one helper.
    assert.match(js, /if \(e\.key === "Escape"\) setMenuOpen\(false\);/);
    assert.match(js, /if \(moreMenu\.contains\(e\.target\) \|\| moreBtn\.contains\(e\.target\)\) return;\s*setMenuOpen\(false\);/);
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

test("a toast stops being readable once it has gone", () => {
    /* Both toasts hide by going to opacity 0, which does not take an element out
       of the accessibility tree — so the last message stayed readable to a
       screen reader for the life of the window. Measured on #toast:
           showing   text "Power action failed (500)" opacity 1.00 role=alert
           long after text "Power action failed (500)" opacity 0.00 role=alert
       role=alert left sitting on stale content is the most urgent thing a page
       can leave lying around. The sticky "Reading the screen…" that OCR
       dismisses through hideToast had the same problem. */
    assert.match(js, /function emptyWhenFaded\(host, els\) \{[\s\S]*?if \(host\.classList\.contains\("show"\)\) return;/);
    assert.match(js, /emptyWhenFaded\(toastEl, \[toastEl\]\)/);
    assert.match(js, /emptyWhenFaded\(resToast, \[resToastMain, resToastAv\]\)/);
    // Both of #toast's hide paths: the auto-hide timer and hideToast().
    assert.equal(
        (js.match(/emptyWhenFaded\(toastEl, \[toastEl\]\)/g) ?? []).length,
        2,
        "the auto-hide timer and hideToast must both empty the toast",
    );
    /* Delayed, not immediate. Clearing as the class comes off empties the pill
       while it is still fully opaque — measured opacity 1.00 with the text
       already gone, so it visibly became an empty rounded box and then faded.
       Verified after: text present at opacity 0.42/0.11/0.01, empty only once
       opacity had reached 0.00. */
    assert.match(js, /var TOAST_FADE_MS = 300;/);
    assert.match(js, /\}, TOAST_FADE_MS\);/);
    // A timer rather than transitionend, which never fires under reduced motion.
    assert.doesNotMatch(js, /addEventListener\("transitionend"/);
});

test("the resize grip is not shown on a layout that cannot be resized", () => {
    /* resizeStart returns early when the desktop media query matches — the
       screen takes the remainder there and there is no vertical split — but the
       grip was still drawn, still pilled, and still carried cursor:row-resize.
       The rule meant to hide it sat inside the media query while .grip's own
       `display: flex` is declared further down the sheet at the SAME
       specificity, so the later one won and the override did nothing.
       Measured on the web layout at 1400x900 with the query matching:
           before  visible=true   drag 120px -> pane 843 unchanged
           after   visible=false
       and stacked at 700x900 the drag still works: pane 394 -> 514. */
    const desktopQuery = css.slice(
        css.indexOf("@media (min-width: 900px) and (orientation: landscape) {"),
        css.indexOf("/* Hidden unless the desktop side-by-side layout is active. */"),
    );
    assert.match(desktopQuery, /\.bar > \.grip \{\s*display: none;/);
    // A bare .grip in here is the dead form this replaced.
    assert.doesNotMatch(desktopQuery, /^\s{4}\.grip \{/m, "a bare .grip override is beaten by the later base rule");
    /* The hazard it guards against: the base rule really does come later and
       really does set a display, so equal specificity would lose. */
    const base = css.indexOf("\n.grip {");
    assert.ok(base > css.indexOf(".bar > .grip"), ".grip's base rule must still come after the override");
    assert.match(css.slice(base, base + 220), /display: flex;/);
});

test("the stacked layout's split can be moved without a pointer", () => {
    /* The grip was drag-only — a bare div with a title — so the balance between
       the live screen and the panel under it could not be changed from the
       keyboard, and a screen reader was told nothing about it. Not only a phone
       problem: any browser window narrower than 900px gets this layout. The
       desktop divider has been a role=separator with an announced range since
       it had the same fault. */
    assert.match(html, /id="grip"[\s\S]{0,140}?role="separator" tabindex="0" aria-orientation="horizontal"/);
    assert.match(html, /aria-label="Target preview height"/);
    assert.match(js, /if \(e\.key === "ArrowUp"\) next = current - step;/);
    assert.match(js, /else if \(e\.key === "End"\) next = clampH\(Number\.MAX_SAFE_INTEGER\);/);
    assert.match(js, /userResized = true; \/\/ same as a drag/);
    /* The ends the arrows reach come out of clampH rather than repeating its
       numbers, so they are by construction the ends the drag is held to. */
    assert.match(js, /setAttr\(gripEl, "aria-valuemin", String\(clampH\(0\)\)\);/);
    assert.match(js, /setAttr\(gripEl, "aria-valuemax", String\(clampH\(Number\.MAX_SAFE_INTEGER\)\)\);/);
    /* --sh is transitioned outside a drag, so reading offsetHeight straight
       after writing it returns the value being animated AWAY from — measured
       ArrowDown moving the pane to 405px while aria-valuenow still said 394.
       The handler announces what it asked for. Verified settled: Home 110/110,
       End 740/740, ArrowUp 728/728. */
    assert.match(js, /paintGripValue\(h\);/);
    assert.match(js, /String\(clampH\(known == null \? pane\.offsetHeight : known\)\)/);
    // Wrapped, or the Event lands in `known` and clamping it announces NaN.
    assert.match(js, /addEventListener\("pointerup", function \(\) \{\s*paintGripValue\(\);/);
    // Keys must not also reach the target: a focusable div is not an editable field.
    const fn = js.slice(js.indexOf('gripEl.addEventListener("keydown"'));
    assert.match(fn.slice(0, fn.indexOf("\n        });")), /e\.preventDefault\(\);\s*e\.stopPropagation\(\);/);
    // A tab stop needs a visible ring, and one on a pseudo-element alone is not provable.
    assert.match(css, /\.grip:focus-visible \{\s*outline: none;\s*box-shadow: 0 0 0 2px/);
});
