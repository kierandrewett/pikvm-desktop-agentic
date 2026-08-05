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
    assert.match(js, /overlayLabel\.textContent = d\.label/);
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
    assert.match(js, /hid\.key\(mod, true\);\s*\n\s*hid\.wheel\(0, dy\);\s*\n\s*hid\.key\(mod, false\);/);
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
