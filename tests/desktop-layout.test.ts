import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const html = readFileSync(resolve(root, "src/views/console.html"), "utf8");
const css = readFileSync(resolve(root, "src/views/console.css"), "utf8");
const js = readFileSync(resolve(root, "src/views/console.js"), "utf8");
const main = readFileSync(resolve(root, "src/main.ts"), "utf8");

test("desktop exposes one chat workspace and never auto-fits around the remote screen", () => {
    assert.doesNotMatch(html, /role="tablist" aria-label="Workspace"/);
    assert.doesNotMatch(html, />Terminal<\/button>/);
    assert.doesNotMatch(js, /setPanelTab\(/);
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
    /* aria-valuenow is clamped into the announced range, so now > max cannot
       happen. Asserted on the clamp and on what is announced, rather than on
       one literal expression: the value is computed into a local now so that
       aria-valuetext can carry the same figure with its unit, and pinning the
       old inline shape failed that refactor for no behavioural reason. */
    assert.match(js, /var now = String\(clampPanelWidthNow\(chatEl \? chatEl\.offsetWidth : PANEL_MIN_W\)\);/);
    assert.match(js, /setAttr\(chatResize, "aria-valuenow", now\);/);
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
    // end up launching different builds. The ORDER itself is tested properly in
    // agent-runtime.test.ts against the real function; what matters here is that
    // main.ts still has exactly one place that builds the candidate list.
    const lists = main.match(/agentExecutablePaths\(resolve\(__dirname/g) ?? [];
    assert.equal(lists.length, 1, "the candidate list is duplicated again");
    assert.match(main, /function agentRuntime\(\.\.\.preferred/);
    assert.match(main, /resolveDaemonRuntime\(configured\?: string\)/);
    assert.match(main, /resolveHarnessRuntime\(configured\?: string\)/);
    const throughIt = main.match(/return agentRuntime\(configured/g) ?? [];
    assert.equal(throughIt.length, 2, "both resolvers must go through agentRuntime()");
});

test("a missing agent runtime is reported, never spawned as a bare name", () => {
    /* The old resolvers ended `return { command: "pikvm-agent" }` and handed that
     * to spawn(). On a machine with no runtime that produced an ENOENT buried in
     * a log and a panel that never appeared — which is what the packaged RPM did
     * on every machine but the one it was built on. */
    assert.doesNotMatch(main, /return \{ command: "pikvm-agent"/);
    assert.doesNotMatch(main, /return "pikvm-agent";/);
    // Both services check before starting, and both report through one function.
    assert.match(main, /if \(!harnessRuntime\.found\)/);
    assert.match(main, /if \(!daemonRuntime\.found\)/);
    const reports = main.match(/reportMissingAgentRuntime\(/g) ?? [];
    assert.equal(reports.length, 3, "one definition plus one call per service");
    // Losing the agent must not take the rest of the app with it.
    assert.match(main, /daemon: null/);
    assert.match(main, /backend\?\.daemon\?\.stop\(\)/);
    assert.match(main, /backend\?\.harness\?\.stop\(\)/);
});

test("the operator credential never reaches a renderer", () => {
    /* It used to be a sentinel in the page swapped for the real token by a
     * session header rewrite, which meant the credential existed in the
     * renderer's network stack even if never in its JavaScript.
     *
     * The conversation loads from OUR origin and reaches the harness through
     * the /app/harness proxy, which drops whatever Authorization a renderer
     * sent and attaches the desktop's own — so the token is only ever in the
     * main process. The rewrite is gone because it could no longer fire, and a
     * rule that cannot fire is not defence in depth, it is a claim about auth
     * that stopped being true. */
    assert.doesNotMatch(main, /onBeforeSendHeaders/);
    assert.doesNotMatch(main, /withHarnessAuthorization/);
    assert.doesNotMatch(main, /seedHarnessAuth/);
    assert.doesNotMatch(main, /agentView/);
    // No second window loads the conversation, so nothing else needs the credential.
    assert.doesNotMatch(main, /agentWin|preload-agent/);
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

test("a dialog's actions stay put when its content has to scroll", () => {
    /* A .dlg caps at 520px and scrolls past that, and .dlg-actions was part of
     * the scrolling content. With nine problems and ten GPIO rows in a 560px
     * window the health dialog pushed Done, Detach and Reset out of sight — so
     * reaching the dialog's own buttons meant scrolling the dialog.
     *
     * Sticky costs nothing when nothing overflows: the row sits where it already
     * sat. The background is not decoration — without it the scrolling content
     * passes visibly under the buttons and reads as a rendering fault. */
    /* The pin is one dialog-padding BELOW zero now: bottom:0 rests on the scroll
     * container's padding box, which left a strip under the bar for the content
     * to scroll through. Asserted as the token rather than the number so this
     * and the padding that compensates it cannot drift. */
    assert.match(css, /\.dlg-actions \{[\s\S]*?position: sticky;[\s\S]*?bottom: calc\(-1 \* var\(--dlg-pad\)\);[\s\S]*?background: var\(--card\);/);
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
    /* To the next function, not a fixed byte count: a 2200-character window
       silently stopped covering the assertion below the moment loadStream grew
       a comment, which is a test failing for a reason that has nothing to do
       with what it checks. */
    const body = js
        .slice(load, js.indexOf("function scheduleReconnect() {", load))
        .replace(/\/\*[\s\S]*?\*\//g, "");
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
    /* The terminal that used to fill this pane is gone: the pane is never given
       a terminal page to load. */
    assert.doesNotMatch(js, /terminal\.html/);
    assert.doesNotMatch(js, /WORKSPACE_URL/);
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
    /* The four close paths all go through this one helper. Escape peels one
       layer — the audio device popout is layered on this menu — and then falls
       through to it; the pointerdown path exempts that popout, which is outside
       the menu in the DOM but belongs to it. */
    assert.match(js, /if \(e\.key !== "Escape"\) return;\s*if \(closeDevMenu\(true\)\) return;\s*setMenuOpen\(false\);/);
    assert.match(
        js,
        /if \(moreMenu\.contains\(e\.target\) \|\| moreBtn\.contains\(e\.target\)\) return;\s*if \(devMenuContains\(e\.target\)\) return;\s*setMenuOpen\(false\);/,
    );
});

test("switching microphone takes a chevron, not the dialog, and never toggles the mic", () => {
    /* Changing which microphone is being sent used to cost four steps: ⋯ ->
       "Audio devices…" -> a modal -> a <select>. The list itself is two entries
       on a normal machine. So each toggle grew a chevron that opens the same
       choice in place, and the dialog stays for everything the popout has no
       room for — what is missing, why the names are numbered, how to fill them
       in.

       The crux is that it is a SPLIT control, two buttons, not one button that
       guesses. Measured over CDP with a stubbed four-device set, opening the mic
       picker from the ⋯ menu and reading the computed accessible NAME out of
       Accessibility.getPartialAXTree rather than textContent:

           #mic-btn        role=button  name="Microphone Off"
           #mic-dev-chev   role=button  name="Choose microphone"  expanded=true
                                        controls="av-dev-menu"
           #av-dev-menu    role=group   name="Choose microphone"
           .dev-item       role=button  name="Logitech C920 microphone"

       and the toggle stayed untouched across the whole flow — pip "Off",
       webrtc setMic never called (micCalls 0) — which is the thing that would
       break if the chevron shared a hit area with it.

       The titlebar carries the same pair, drawn by the shared library:
       data-tb audio(30px) / out-dev(16px) / mic(30px) / mic-dev(16px), names
       "Audio output" / "Choose audio output" / "Microphone" / "Choose
       microphone".

       A pick goes through chooseDevice, the same call the dialog's <select>
       change makes, so it persists and applies identically. Verified both ways
       round: picking MIC-WEBCAM in the popout left #ad-mic reading "Logitech
       C920 microphone", and changing #ad-mic to MIC-WEBCAM moved the popout's
       aria-current onto that row. */
    const bare = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    // Two controls with two names, in both mount points.
    assert.match(html, /id="mic-dev-chev" aria-label="Choose microphone"/);
    assert.match(html, /id="out-dev-chev" aria-label="Choose audio output"/);
    assert.match(bare, /label: which === "mic" \? "Choose microphone" : "Choose audio output"/);
    // The chevron opens the picker; only the toggle's own handler toggles.
    assert.match(bare, /toggleDevMenu\(which, chev\)/);
    assert.doesNotMatch(bare, /mic-dev-chev"\)[\s\S]{0,200}?micBtn\.click\(\)/);

    /* One path to the choice. chooseDevice takes an id, not the <select> it came
       from, which is what lets the popout reuse it rather than reimplement the
       persistence, the setMicDevice restart and the setSinkId. */
    assert.match(bare, /function chooseDevice\(which, id\) \{/);
    assert.match(bare, /chooseDevice\("mic", micSel\.value\)/);
    assert.match(bare, /chooseDevice\("out", outSel\.value\)/);
    assert.match(bare, /if \(id !== current\) chooseDevice\(which, id\);/);
    // Both surfaces repaint from the one painter, so neither can go stale.
    assert.match(bare, /paintDevMenu\(\);\s*paintDevPickers\(\);/);

    /* aria-current, not aria-selected — a group of buttons with no listbox
       keyboard model behind it, same call the pinned-macro list makes. */
    assert.match(bare, /setAttr\(items\[j\], "aria-current", "true"\)/);
    assert.doesNotMatch(bare, /aria-selected/);
    assert.match(html, /id="av-dev-menu" role="group"/);
    assert.doesNotMatch(bare, /aria-haspopup/);

    // A device that has gone stays on the list and says so, as in the dialog.
    assert.match(bare, /text: \(choice\.label \|\| "The device you chose"\) \+ " \(not connected\)", gone: true/);
    assert.match(css, /\.dev-item\.gone \.dev-name \{\s*color: var\(--warn\);/);

    /* Keyboard. Focus goes INTO the list on open, because one popout serves
       four chevrons and so lives at the end of the document — measured before
       that: Tab from the mic chevron landed on "Audio devices…" and the next
       Enter opened the Paste dialog. Escape puts it back on the chevron. */
    assert.match(bare, /devMenu\.querySelector\('\.dev-item\[aria-current="true"\]'\) \|\| devMenu\.querySelector\("\.dev-item"\)/);
    assert.match(bare, /if \(restoreFocus && devMenu\.contains\(document\.activeElement\) && anchor && anchor\.getClientRects\(\)\.length\) anchor\.focus\(\);/);
    // Tabbing off the end closes it; a window blur must not.
    assert.match(bare, /if \(!devMenuWhich \|\| !document\.hasFocus\(\)\) return;/);

    // The ⋯ menu's placement is shared rather than copied for the popout.
    assert.match(bare, /function placePopover\(anchor, menu\)/);
    assert.match(bare, /placePopover\(anchor, devMenu\)/);
    // The dialog is a shortcut FROM, not a replacement: it is still wired.
    assert.match(html, /id="audio-dev-btn"/);
    assert.match(bare, /audioDevBtn\.addEventListener\("click", openAudioDialog\)/);
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

test("a dialog opened from the overflow menu gives focus back to the menu button", () => {
    /* closeOtherDialogs remembers where focus was so closing can return it, and
       what it remembered on the web layout was the ⋯ MENU ITEM the user had
       just clicked — an element the same click display:none's. Focusing a
       hidden element does nothing, so the restore silently landed on the body.
       Measured, opening each from the menu and pressing Escape:
           msd -> BODY    stream -> BODY    log -> BODY
       and after: all three -> #more-btn. */
    assert.match(js, /function focusAnchor\(\) \{[\s\S]*?if \(a\.closest && a\.closest\("\.more-menu"\)\) return document\.getElementById\("more-btn"\) \|\| a;/);
    // Both record sites go through it, or the two disagree about the anchor.
    assert.match(js, /if \(!openScrim\(\)\) focusBeforeModal = focusAnchor\(\);/);
    assert.match(js, /if \(!focusBeforeModal\) focusBeforeModal = focusAnchor\(\);/);
    const bare = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(bare, /focusBeforeModal = document\.activeElement/, "a record site bypassed focusAnchor");
    /* The desktop pops a native menu and never reaches that branch, so its
       trigger is still the anchor — re-verified across all nine dialog/close
       combinations after this change. */
    assert.match(js, /if \(restore && restore\.focus && document\.contains\(restore\)\) restore\.focus\(\);/);
});

test("the upload progress bar says what it is measuring", () => {
    /* Measured mid-upload before: role=progressbar, value=37, name="" — the one
       control in this dialog without a name, beside a URL field whose label
       wording was chosen for exactly that reason. Worse in the phase before it:
       while the Pi fetches the image the bar is INDETERMINATE, so it carries no
       value either and announced nothing at all, while "the Pi is downloading
       it…" sat in a span nothing pointed at. After:
           indeterminate  name="Upload progress"  desc="the Pi is downloading it…"  value none
           determinate    name="Upload progress"  desc="37% · 1.0 GB of 2.8 GB"     value 37 */
    assert.match(html, /<progress id="msd-progress"[\s\S]{0,160}?aria-label="Upload progress" aria-describedby="msd-progress-value"/);
    // The description has to point at something that exists and carries the text.
    assert.match(html, /<span class="dlg-hint" id="msd-progress-value"><\/span>/);
    assert.match(js, /setMsdProgress\(pct, pct \+ "%  ·  " \+ humanBytes\(tr\.written\) \+ " of " \+ humanBytes\(tr\.size\)\)/);
    assert.match(js, /setMsdProgress\(undefined, "the Pi is downloading it…"\)/);
    // Hidden between uploads, so none of it is left in the tree to be read.
    assert.match(html, /<div class="dlg-row" id="msd-progress-row" hidden>/);
});

test("aborting your own upload is a confirmation, not an error", () => {
    /* xhr.onabort reported through the error channel, so pressing Abort answered
       with a red toast at role=alert and aria-live=assertive held for six
       seconds. Measured before and after, aborting a genuinely in-flight
       request:
           before  role=alert   live=assertive  is-error=true
           after   role=status  live=polite     is-error=false
       toast itself states the rule — errors interrupt, everything else waits —
       and nothing else here treats a deliberate cancel as a fault: closing the
       log mid-load and escaping an OCR pick both say nothing at all. */
    assert.match(js, /xhr\.onabort = function \(\) \{[\s\S]*?done\("Upload aborted", null\);/);
    // The real failures stay errors — verified: a 500 still gives role=alert.
    assert.match(js, /else done\(null, "Upload failed \(" \+ xhr\.status \+ "\)"\);/);
    assert.match(js, /xhr\.onerror = function \(\) \{\s*done\(null, "Upload failed: network error"\);/);
    // The routing that makes the distinction mean something.
    assert.match(js, /if \(errMsg\) toast\(errMsg, true\);\s*else if \(okMsg\) toast\(okMsg\);/);
    assert.match(js, /toastEl\.setAttribute\("role", error \? "alert" : "status"\);/);
    assert.match(js, /toastEl\.setAttribute\("aria-live", error \? "assertive" : "polite"\);/);
});

test("mass storage actions that replace themselves keep focus in the dialog", () => {
    /* These withdraw or disable the control that was just pressed, and the
       browser drops focus the moment a focused control becomes disabled — so
       focus ended on the body with the dialog still open. Measured, each with
       the button focused first so the loss is real rather than an artefact of a
       synthetic click:
           Mount        -> BODY   (msd-connect disabled by the pending guard)
           Unmount      -> BODY   (once the Pi answered)
           Delete image -> BODY   (once the Pi reported it gone)
       After: Start upload -> msd-abort, and the rest -> msd-close. Never BODY. */
    assert.match(js, /var MSD_PAIRS = \{\s*"msd-connect": "msd-disconnect",\s*"msd-disconnect": "msd-connect",\s*"msd-upload": "msd-abort",\s*"msd-abort": "msd-upload",/);
    // Disabled counts as lost: the element is still in the host but cannot hold focus.
    assert.match(js, /if \(owner\.contains\(now\) && !now\.disabled\) return;/);
    // The partner has to be present AND usable before it is worth aiming at.
    assert.match(js, /partner && !partner\.disabled && partner\.getClientRects\(\)\.length \? partner : dialogControl\("msd-close"\)/);
    /* Done rather than the next button along: that row also holds Delete image,
       and landing a keyboard user on a destructive action they did not choose is
       worse than the lost focus this is fixing. */
    const fn = js.slice(js.indexOf("function repaintMsdBody()"));
    const body = fn.slice(0, fn.indexOf("\n    }"));
    assert.doesNotMatch(body, /querySelector\("button:not\(\[disabled\]\)"\)/, "must not fall back to the next action in the row");
    // The pairing this leans on is the one msdBody already documents.
    assert.match(js, /a pair of buttons occupying one slot, which is why they are\s*\*\s*hidden rather than disabled/);
});

test("a pending guard hands focus back to the control it disabled", () => {
    /* The double-click guards disable the button just pressed, and the browser
       drops focus from a control the moment it becomes disabled. Measured, each
       focused first so the loss is real:
           HID Detach   -> BODY and stayed there
           GPIO Pulse   -> BODY and stayed there
           GPIO switch  -> BODY and stayed there
       Unlike the mass storage pair these keep the SAME element and re-enable it
       a moment later, so focus goes back where it was. After: hid-toggle,
       "Pulse rack pdu 1", gpio-switch-rack_pdu_1. */
    assert.match(js, /function pendingFocusHold\(\) \{\s*var el = document\.activeElement;/);
    // Only from the body: a user who tabbed on in the meantime is left alone.
    assert.match(js, /if \(!el \|\| !el\.focus \|\| document\.activeElement !== document\.body\) return;/);
    // And never onto something that cannot take it.
    assert.match(js, /if \(el\.disabled \|\| !el\.getClientRects\(\)\.length\) return;/);
    // All three guards capture before disabling and release after re-enabling.
    assert.match(js, /var back = pendingFocusHold\(\);\s*hidTogglePending = true;/);
    assert.match(js, /var back = pendingFocusHold\(\);\s*gpioBusy\(name, true\);\s*gpio\.pulse\(name\)/);
    assert.match(js, /var back = pendingFocusHold\(\);\s*gpioBusy\(name, true\);\s*gpio\.switchTo\(name, !cur\.on\)/);
    assert.equal((js.match(/\s+back\(\);/g) ?? []).length, 3, "every hold must be released");
    // The guards themselves still hold — re-verified at one request per triple click.
    assert.match(js, /disabled: o\.busy \|\| !o\.online \|\| !!gpioPending\[name\],/);
    assert.match(js, /disabled: !hidToggleState\.known \|\| hidToggleState\.busy \|\| hidTogglePending,/);
});

test("the health dialog's two hidden flags go through the same guard as the rest", () => {
    /* 44ca10d established that a repaint never rewrites an attribute with the
       value it already has, and guarded six sites with setProp/setAttr. These
       two were missed, and they are the ones paintHealth and paintGpio touch on
       every info, hid, streamer and gpio event. Measured with the elements in
       their HIDDEN state — el.hidden = false on an already-visible element
       writes nothing, so the churn only shows when they are hidden:
           health-ok 8 no-op writes, gpio-section 8, over four rounds of six events
       After: zero, in all six dialog configurations. No user-visible change;
       this is the rule being applied where it already claimed to be. */
    assert.match(js, /setProp\(ok, "hidden", problems\.length > 0\);/);
    assert.match(js, /setProp\(section, "hidden", outs\.length === 0\);/);
    // The line right below the first one was already guarded, which is what
    // made the pair look converted when only half of it was.
    assert.match(js, /setProp\(ok, "hidden"[\s\S]{0,120}?setText\(ok, health\.reported\(\)/);
    /* And no bare .hidden left in either painter, with one exception that is
       not a repaint at all: paintGpio initialises `hidden` on a span it has
       just created, where there is nothing to compare against and setProp would
       write the same attribute anyway. Counted rather than banned, so a second
       bare write still fails here. Dialog open/close and one-shot reveals are
       state changes rather than repaints and are deliberately left alone. */
    const painterBody = (name: string) => {
        const fn = js.slice(js.indexOf(name));
        return fn.slice(0, fn.indexOf("\n    }")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    };
    assert.equal((painterBody("function paintHealth()").match(/\b\w+\.hidden\s*=/g) ?? []).length, 0);
    const gpioBare = painterBody("function paintGpio()").match(/\b\w+\.hidden\s*=/g) ?? [];
    assert.deepEqual(gpioBare, ["note.hidden ="], "only the freshly-created note may be written directly");
});

test("a long paste says it is happening", () => {
    /* kvmd types the string itself at 20ms a key and answers when it is done,
       so a paste is a LONG operation — 12,000 characters is about four minutes.
       Nothing said so. Measured with the request held open: the dialog sat
       there with Paste greyed, no message, no progress, no toast, looking
       exactly like a dialog that had done nothing. Cancel then closed it and
       the target carried on typing with the last trace gone from the screen. */
    /* Not pinned to one line any more: the message also carries how long the
       typing will take. Still the same three things — the count, the target,
       and the sticky flag that keeps it up for the whole operation. */
    /* The count goes through humanCount now, so this pins the toast's SHAPE —
       sticky, naming the target — rather than one spelling of the number. */
    assert.match(js, /toast\(\s*"Typing " \+\s*humanCount\(text\.length\) \+[\s\S]{0,200}?" on the target"[\s\S]{0,120}?false,\s*true,\s*\)/);
    // Sticky, because it has to outlast the ordinary dwell — the same call OCR
    // makes for the same reason.
    assert.match(js, /toast\("Reading the screen…", false, true\);/);
    /* The success and failure toasts replace it rather than needing a hide:
       toast() clears the pending timer as it writes. Verified live — success
       leaves "Typed 5 characters on the target" and it is gone 3s later, a 500
       leaves "Paste failed (500)" at role=alert and it is still up. */
    assert.match(
        js,
        /toast\(\s*"Typed " \+ humanCount\(text\.length\) \+ \(text\.length === 1 \? " character" : " characters"\) \+ " on the target",\s*\);/,
    );
    assert.match(js, /toast\("Paste failed \(" \+ r\.status \+ "\)", true\);/);
    // It is fired before the request, so there is no window where the dialog
    // looks idle with a paste already under way.
    const fn = js.slice(js.indexOf("pasteBusy = true;"));
    const head = fn.slice(0, fn.indexOf("fetch(\"/api/hid/print?"));
    assert.match(head, /toast\(\s*"Typing "/, "the in-flight message must precede the request");
});

test("a scrolling dialog's action bar covers the content to its bottom edge", () => {
    /* .dlg-actions pins itself so Done stays reachable when a dialog scrolls,
       and its own comment says the opaque background exists because otherwise
       "the scrolling content passes visibly underneath the buttons, which reads
       as a rendering fault". It covered upwards and not downwards: bottom:0
       rests on the scroll container's PADDING box, so the bar stopped 20px
       above the dialog's real edge. Measured with thirty GPIO channels in a
       600px window:
           bar bottom 560, dialog bottom 580
           "rack pdu outlet 14" and its Pulse/Off visible in the 20px between
       After: gap 0, nothing below the bar. */
    assert.match(css, /\.dlg \{[\s\S]*?--dlg-pad: 20px;\s*padding: var\(--dlg-pad\);/);
    assert.match(css, /\.dlg-actions \{[\s\S]*?bottom: calc\(-1 \* var\(--dlg-pad\)\);/);
    assert.match(css, /\.dlg-actions \{[\s\S]*?padding-bottom: var\(--dlg-pad\);\s*\/\*[\s\S]*?\*\/\s*margin-bottom: calc\(-1 \* var\(--dlg-pad\)\);/);
    /* The pull-back is not optional. padding alone made every dialog that does
       NOT overflow 20px taller — measured 40px from button to edge where the
       dialog's own padding is 20 — so paste, stream and health each grew a
       band of dead space. With both, all three are back to 20. */
    assert.match(css, /\.dlg-actions \{[\s\S]*?padding-top: 12px;\s*margin-top: -12px;/);
    // One token, so the pin and the padding it compensates cannot drift apart.
    const actions = css.slice(css.indexOf(".dlg-actions {"), css.indexOf(".dlg-btn {"));
    assert.doesNotMatch(actions, /bottom: -20px|padding-bottom: 20px/, "the bar must read the dialog's own padding token");
});

test("every socket to the Pi backs off instead of hammering it", () => {
    /* Two sockets talk to the same host: the video stream and the HID socket (a
       terminal socket did too, until the chat replaced it). Only the stream backed off — 800ms grown by 1.7 to a 8s
       ceiling, reset on success. The other two retried flat, forever: 1200ms
       and 1000ms. A Pi that is off, rebooting, or behind a dropped VPN took
       roughly 100 failed connects a minute between them for as long as the
       window stayed open, on a device with one core. */
    assert.match(js, /var HID_RETRY_MIN_MS = 1200;/);
    assert.match(js, /\}, retryMs\);\s*retryMs = Math\.min\(Math\.round\(retryMs \* 1\.7\), HID_RETRY_MAX_MS\);/);
    // The stream's own loop is what these copy; it must keep its shape.
    assert.match(js, /retryMs = Math\.min\(Math\.round\(retryMs \* 1\.7\), 8000\);/);
    // Neither may go back to a constant.
    assert.doesNotMatch(js, /\n\s*\}, 1200\);/);

    /* A connection that lands starts the next outage from the short wait again,
       so a brief blip still recovers promptly. Without this the first drop
       would leave every later one waiting 8s. */
    assert.match(js, /retryMs = HID_RETRY_MIN_MS;\s*if \(onStatus\) onStatus\(true\);/);

    /* Measured over CDP by killing each socket server-side and counting
       Network.webSocketCreated:
         HID       6 attempts in 30s, gaps 2.1 3.4 6 8 8 (was ~25 at a flat 1.2s)
       (the terminal's 5 attempts in 26s are gone with the terminal). */
});

test("both console disclosures name the region they open", () => {
    /* The console's two chrome buttons each declare aria-controls and each
       pointed at an unnamed generic.

       #drawer had no accessible name at all — measured role generic, name "".
       Activating "Controls" announced "expanded" and then dropped you into a
       run of L / M / R / Escape / Tab / Ctrl buttons with nothing saying where
       you were.

       #more-menu did carry aria-label="More actions", but on a bare <div>,
       which maps to role=generic — and ARIA prohibits naming a generic. Chrome
       computed the name anyway (measured: role generic, name "More actions"),
       which is Chrome being lenient rather than a guarantee any screen reader
       repeats it. */
    assert.match(html, /<div class="bar-keys" id="drawer" role="group" aria-label="Controls">/);
    assert.match(js, /moreMenu\.setAttribute\("role", "group"\);\s*moreMenu\.setAttribute\("aria-label", "More actions"\);/);

    /* group, not menu: the menu is walked with Tab, not arrow keys, and the
       existing comment says so. group carries a name without promising a
       keyboard model that is not there. And not region either — these are sets
       of related controls inside the bar, not landmarks. */
    assert.doesNotMatch(js, /moreMenu\.setAttribute\("role", "menu"\)/);
    assert.doesNotMatch(html, /id="drawer"[^>]*role="region"/);

    // The triggers were already right and must stay that way.
    assert.match(js, /kbdBtn\.setAttribute\("aria-controls", "drawer"\);/);
    assert.match(js, /moreBtn\.setAttribute\("aria-controls", moreMenu\.id \|\| "more-menu"\);/);
    /* Re-read from the accessibility tree over CDP with both open:
         #drawer     group | name "Controls"
         #more-menu  group | name "More actions"
       where before they were generic/"" and generic/"More actions". */
});

test("save screenshot reports what the download did, not that it started", () => {
    /* a.click() HANDS the file to the download machinery and returns. The next
       line toasted "Screenshot saved" — so a save dialog the user cancelled, or
       a full or read-only disk, still reported success. It was the one place in
       the console that reported an outcome it never observed. */
    assert.doesNotMatch(js, /a\.click\(\);[\s\S]{0,200}?toast\("Screenshot saved"\)/);
    assert.match(js, /awaitScreenshotSave\(name\);/);

    // Matched by filename, because will-download fires for any download.
    assert.match(js, /if \(!pendingShot \|\| !info \|\| info\.name !== pendingShot\.name\) return;/);
    assert.match(js, /if \(info\.state === "completed"\) toast\("Screenshot saved"\);/);
    assert.match(js, /else if \(info\.state === "cancelled"\) toast\("Screenshot not saved"\);/);
    assert.match(js, /else toast\("Screenshot save failed", true\);/);

    /* Two fallbacks, both deliberate. The web build has no main process and no
       such event, so it keeps the immediate toast — there the browser owns the
       download UI and reports its own failures. And on desktop, an event that
       never arrives times out into the old wording, because silence would be a
       worse regression than the claim this replaces. */
    assert.match(js, /if \(!window\.desktopConsole \|\| !window\.desktopConsole\.onDownloadDone\) \{\s*toast\("Screenshot saved"\);\s*return;\s*\}/);
    assert.match(js, /var DOWNLOAD_WAIT_MS = 20_000;/);

    /* Driven over CDP against a stand-in bridge, in desktop mode, invoking the
       real "screenshot" menu command: no toast on the click, then
         completed    -> "Screenshot saved"
         cancelled    -> "Screenshot not saved"
         interrupted  -> "Screenshot save failed"
       and with no bridge at all the immediate "Screenshot saved" is unchanged.
       The Electron half of this (a will-download relay) left with the legacy
       preload; the web app's own screenshot does not wait for it. */
});

test("text is typed with the same keymap wherever it is typed from", () => {
    /* The paste dialog sent keymap=<chosen>; a macro's text step did not. The
       same string typed two ways came out two ways — the dialog honoured the
       layout you picked, the macro fell back to whatever kvmd defaults to,
       which on a target that is not the default layout is wrong characters.
       The macro path's own comment called it "layout-correct".

       Measured on the wire with the Pi offering en-us/en-gb/de/fr and "de"
       chosen in the dialog:
         before  paste  print:limit=0&keymap=de&delay=0.02:grussen
                 macro  print:limit=0&delay=0.02:hello
         after   paste  print:limit=0&delay=0.02&keymap=de:grussen
                 macro  print:limit=0&delay=0.02&keymap=de:hello */
    assert.match(js, /function printQuery\(\) \{/);
    assert.match(js, /if \(km\) q\.push\("keymap=" \+ encodeURIComponent\(km\)\);/);
    assert.equal((js.match(/fetch\("\/api\/hid\/print\?" \+ printQuery\(\)/g) ?? []).length, 2,
        "the paste dialog and the macro text step, and nothing else");
    assert.doesNotMatch(js, /\/api\/hid\/print\?limit=0&delay=0\.02/, "no hand-built print query");

    /* The choice is a fact about the TARGET, not about the dialog it is chosen
       in — which is why the select already keeps the pick across rebuilds. Read
       by id at call time rather than off the cached element: that handle is
       assigned some three thousand lines below the macro runner, and reaching
       back for it would make this depend on load order for no gain. */
    assert.match(js, /function typingKeymap\(\) \{\s*var el = document\.getElementById\("paste-keymap"\);/);
    const decl = js.indexOf("function typingKeymap()");
    const macroUse = js.indexOf('fetch("/api/hid/print?" + printQuery()');
    assert.ok(decl > 0 && decl < macroUse, "declared before the first caller reads it");
});

test("an unknown GPIO channel asks before it fires", () => {
    /* Only __v3_usb_breaker__ confirmed, so every USER-DEFINED channel fired on
       a single click. On a PiKVM those are relays, and a relay is almost always
       wired to a machine's power or reset button — the dangerous case, not the
       safe one. The console cannot tell what any of them do, and the comment
       above the pulse guard already said as much: on a relay wired to a power
       button a pulse "is three presses of it... and neither has any
       confirmation to slow it down". */
    assert.match(js, /var GPIO_NO_CONFIRM = \{ __v4_locator__: true \};/);
    assert.match(js, /function gpioConfirm\(name, label, action, turningOn\) \{\s*if \(GPIO_NO_CONFIRM\[name\]\) return true;/);
    // The default is now ask; the exemption list is the exception.
    assert.match(js, /var warn = GPIO_CONFIRM\[name\];\s*if \(!warn\) \{/);
    assert.match(js, /A pulse is a momentary contact closure\./);
    assert.match(js, /The console cannot tell what this output is wired to\./);
    // The breaker keeps its own, better sentence.
    assert.match(js, /__v3_usb_breaker__: "Switch the target's USB power\?/);

    // Both actions go through it, and neither reads the old map directly.
    assert.match(js, /if \(!gpioConfirm\(name, o\.label, "pulse"\)\) return;/);
    assert.match(js, /if \(!gpioConfirm\(name, o\.label, "switch", !cur\.on\)\) return;/);
    assert.equal((js.match(/GPIO_CONFIRM\[name\]/g) ?? []).length, 1,
        "only gpioConfirm reads the per-channel overrides");

    /* Driven over CDP with the Pi reporting __v3_usb_breaker__, __v4_locator__
       and a user channel rack_pdu_1, recording every confirm():
         pulse rack_pdu_1    "Pulse \"rack pdu 1\"? … that is a press of it."
         switch rack_pdu_1   "Turn \"rack pdu 1\" on? …"
         switch locator      (none)
         switch breaker      its own USB-power sentence
       and declining left the wire empty where accepting sent
       gpio:pulse:channel=rack_pdu_1. */
});

test("a health problem's level is not carried by colour alone", () => {
    /* Both markers were the same 7px dot, one in --warn and one in --danger. So
       the only thing separating "The Pi is undervolted" from "The Pi was
       throttled recently" was amber against red at seven pixels — the pair
       red/green colour vision most often cannot tell apart. WCAG 1.4.1, and
       this console already avoids colour-only state elsewhere: the GPIO switch
       carries aria-checked "so the state is not carried by the fill colour
       alone", and a dead terminal tab says the word "exited". */
    const marker = css.slice(css.indexOf(".dlg-list li::before {"), css.indexOf("/* ---- mass storage dialog ---- */"));
    assert.match(marker, /border: 2px solid var\(--warn\);/);
    assert.doesNotMatch(marker, /background: var\(--warn\)/, "warning is a ring, not a filled dot");
    assert.match(marker, /\.dlg-list li\.is-error::before \{\s*border-color: var\(--danger\);\s*background: var\(--danger\);/);
    // box-sizing, or the 2px border would make the error marker bigger than the
    // warning one for the wrong reason.
    assert.match(marker, /box-sizing: border-box;/);

    /* And said out loud. The marker is a ::before with no text, so a screen
       reader heard a flat run of sentences with nothing marking which were
       errors — the level lived only in the CSS. */
    assert.match(js, /\(problems\[i\]\.level === "error" \? "Error: " : "Warning: "\) \+ problems\[i\]\.text/);
    /* Verified over CDP: rendered under achromatopsia emulation the warning is
       visibly a ring and the errors filled discs, with hue entirely removed;
       and the row reads out of the accessibility tree as
       listitem | "Warning: The Pi was throttled by heat recently". */
});

test("a paste says how long it will take before you commit to it", () => {
    /* A paste is not a click. kvmd types the string itself at 20ms a key and
       answers when it is done, so 12,000 characters is a little over four
       minutes — during which the target is being typed into, and Cancel only
       closes the dialog, it does not stop the typing. The row said "12805
       characters" and left the operator to work that out. The arithmetic was
       already in this file's own comment; the screen never did it. */
    assert.match(js, /var PASTE_DELAY_S = 0\.02;/);
    assert.match(js, /var q = \["limit=0", "delay=" \+ PASTE_DELAY_S\];/,
        "the rate on the wire and the estimate on screen come from one constant");
    assert.match(js, /function pasteDuration\(n\) \{\s*var ms = n \* PASTE_DELAY_S \* 1000;/);

    // Shown where the decision is made, and again while it runs.
    assert.match(js, /humanCount\(n\) \+ \(n === 1 \? " character" : " characters"\) \+ \(hint \? " · " \+ hint : ""\)/);
    assert.match(js, /\(typingFor \? " — " \+ typingFor : ""\)/);

    /* Quiet under ten seconds: a number beside every short paste is noise, and
       noise would make the ones that matter easier to miss. */
    assert.match(js, /return ms < 10000 \? "" : humanDuration\(ms\);/);
    assert.match(js, /if \(secs < 90\) return "about " \+ secs \+ "s";/);

    /* Driven over CDP at three lengths, reading the count row:
         120 chars    "120 characters"                  (2.4s — says nothing)
         600 chars    "600 characters · about 12s"
         12805 chars  "12805 characters · about 4 min"
       and with the request held open, the sticky toast read
       "Typing 12805 characters on the target — about 4 min…". */
});

test("a second screen read cannot start while one is still running", () => {
    /* runOcr had no guard at all, and ocrPicking clears the moment the drag
       ends — so a second region could be picked while the first read was still
       on the wire. Measured with the Pi's answer held open: two drags a second
       apart put ocr_left=256 and ocr_left=384 in flight together, on a
       single-core device where one full-screen read already takes about six.

       Two things then went wrong. The first response calls hideToast(), so the
       sticky "Reading the screen…" disappeared while the other read was still
       running — exactly the silence that toast exists to prevent, and its own
       comment says so. And the text landing in the dialog was whichever request
       returned last, which is not necessarily the region drawn last: the run
       above ended showing region 384 after the user's last drag was 384 only by
       luck of ordering. */
    assert.match(js, /var ocrBusy = false;/);
    assert.match(js, /function startOcrPick\(\) \{\s*if \(ocrBusy\) \{\s*toast\("Still reading the screen", true\);\s*return;\s*\}/);
    assert.match(js, /ocrBusy = true;\s*paintOcrAvailability\(\);\s*fetch\("\/api\/streamer\/snapshot\?"/);
    // Cleared on both outcomes, or one failed read would disable it for good.
    assert.match(js, /\.then\(function \(\) \{\s*ocrBusy = false;\s*paintOcrAvailability\(\);\s*\}\);/);

    /* Refused AND shown as refused, like a paste greys the macro controls.
       Without this the button stayed live through a six-second read and only
       said no on the click. Both routes in — the button and the ⋯ menu. */
    assert.match(js, /function paintOcrAvailability\(\) \{/);
    assert.match(js, /setProp\(btn, "disabled", ocrBusy\);/);
    // Not pinned to what follows: the full-UI gate is a later condition on the
    // same line and is that test's business, not this one's.
    assert.match(js, /enabled: screenHasPicture\(\) && !ocrBusy/);

    /* Re-driven after the fix, same two drags: one request on the wire
       (ocr_left=256), the picker refusing to engage the second time, and the
       dialog showing region 256 — the region actually drawn. */
});

test("the controls drawer shows that its keys continue past the edge", () => {
    /* The drawer holds 21 controls and scrolls, with its scrollbar hidden on
       both engines — scrollbar-width: none and a ::-webkit-scrollbar rule. So
       at 900px it showed nine: 933px of content in a 399px box, with the twelve
       past the edge given away by nothing at all. The ones lost were the arrows,
       Backspace, Enter, Del, Home, End, Ctrl+Alt+Del and both scroll buttons.

       Worse than a plain cut: the last visible key ends with a gap after it, so
       the row reads as finished rather than as continuing. */
    assert.match(css, /\.bar-keys \{[\s\S]*?scrollbar-width: none;/, "the scrollbar is still deliberately hidden");
    assert.match(css, /\.bar-keys\.more-after,\s*html\.desktop-console \.tb-macros\.more-after \{\s*mask-image: linear-gradient\(to right, #000 calc\(100% - 32px\), transparent\);/);
    assert.match(css, /\.bar-keys\.more-before,\s*html\.desktop-console \.tb-macros\.more-before \{/);
    assert.match(css, /\.bar-keys\.more-before\.more-after,\s*html\.desktop-console \.tb-macros\.more-before\.more-after \{/);

    /* Driven from the scroll position rather than left on permanently, so the
       ends of the row are not dimmed once there is nothing more to reach. */
    assert.match(js, /el\.classList\.toggle\("more-before", max > 2 && el\.scrollLeft > 2\);/);
    assert.match(js, /el\.classList\.toggle\("more-after", max > 2 && el\.scrollLeft < max - 2\);/);
    assert.match(js, /d\.addEventListener\("scroll", paintDrawerOverflow, \{ passive: true \}\);/);
    assert.match(js, /window\.addEventListener\("resize", paintDrawerOverflow\);/);
    /* And measured when it opens, not before: a display:none row reports a
       scrollWidth equal to its clientWidth and would never fade. */
    assert.match(js, /if \(openK\) paintDrawerOverflow\(\);/);

    /* Driven over CDP at 900px, 933px of keys in a 399px strip:
         scrollLeft 0    -> more-after            (right edge fades)
         scrollLeft 260  -> more-before more-after (both fade)
         scrollLeft 534  -> more-before            (left edge only)
       and screenshotted at each: "Win" trails off at the start where it used to
       end cleanly. */
});

test("the titlebar buttons that open a menu say so", () => {
    const mount = readFileSync(resolve(root, "agent/frontend/src/shared/mount.tsx"), "utf8");
    /* Three titlebar buttons open a menu rather than doing something: More
       actions, the send-keys list, and ATX power. On the desktop all three open
       a NATIVE menu through the main process, so there is no element to point
       aria-controls at and no open state this side to report — but that is no
       reason to say nothing. Read out of the accessibility tree, all three came
       back as plain buttons with only "invalid" and "focusable" on them. */
    assert.match(mount, /haspopup\?: boolean;/);
    assert.match(mount, /\{\.\.\.\(b\.haspopup \? \{ "aria-haspopup": "menu" as const \} : \{\}\)\}/);
    assert.match(js, /id: "more",\s*label: "More actions",[\s\S]{0,400}?haspopup: true,/);
    assert.match(js, /id: "keys",\s*label: "Send a keyboard shortcut to the target",[\s\S]{0,80}?haspopup: true,/);
    assert.match(js, /id: "power",[\s\S]{0,220}?haspopup: true,/);
    assert.equal((js.match(/haspopup: true,/g) ?? []).length, 3, "the three that open a native menu, and nothing else");

    /* aria-expanded is deliberately NOT claimed with it. The web console's own
       ⋯ button carries expanded and aria-controls because its menu is a real
       element it owns; these hand off to the OS and would be reporting a state
       they cannot see. haspopup is the part that stays true either way.

       Verified from the accessibility tree with ATX pushed so Power is on
       screen: button "More actions" / "Send a keyboard shortcut to the target"
       / "Power — target is on", each carrying hasPopup="menu". */
    assert.doesNotMatch(js, /id: "more",\s*label: "More actions",[\s\S]{0,400}?expanded: true/);
});

test("the on-screen keys stop offering clicks that cannot reach the target", () => {
    /* Every button in the Controls drawer sends a HID event, and send() drops
       anything written while the socket is not OPEN. Measured with the socket
       killed server-side: all 21 stayed enabled, pressing Escape put nothing on
       the wire and raised no toast, and the only sign was "Live · input
       offline" in the status chip at the other end of the window.

       That is the same silent no-op the terminal's New shell was fixed for
       earlier in this session — "send() drops anything written while the socket
       is not OPEN, so with the terminal service unreachable New shell did
       exactly nothing: no tab, no message, no error" — and it deserves the same
       answer. The chip already says why; the controls stop pretending. */
    assert.match(js, /function paintDrawerEnabled\(\) \{[\s\S]*?var up = hid\.isOpen\(\);/);
    assert.match(js, /setProp\(b, "disabled", !up\);/);
    // Driven by the same status hook that already refreshes the chip, and run
    // once at startup so a console that opens with the socket down is right.
    assert.match(js, /paintHealth\(\);\s*paintDrawerEnabled\(\);[\s\S]{0,420}?\}\);\s*paintDrawerEnabled\(\);/);

    /* Driven over CDP: socket up, 21 buttons and 0 disabled; socket killed, 21
       and 21 disabled with the chip reading "Live · input offline"; socket
       allowed back, 21 and 0 again. */

    /* The physical-keyboard path is deliberately left alone. #kbd stays enabled
       and its keystrokes are still dropped while the socket is down — disabling
       a textarea someone is typing into moves their focus and gives no reason,
       which is worse than the chip they already have. Worth revisiting if that
       chip proves too quiet. */
    assert.doesNotMatch(js, /setProp\(kbd, "disabled"/);
});

test("the picture says when the pointer cannot reach the target", () => {
    /* The last of the input-offline family, and the most used path. send()
       drops everything while the socket is down, so a click on the picture goes
       nowhere — measured with the socket killed: empty wire, no toast. Mean-
       while the blob kept following the host pointer, which is the one claim
       paintCursor exists to avoid: it "is meant to show where the TARGET's
       cursor is", and the target's had stopped moving. */
    assert.match(js, /if \(!hid\.isOpen\(\)\) \{\s*kvmCursor\.style\.display = "none";\s*pane\.style\.cursor = "not-allowed";/);
    /* not-allowed rather than the "" the two cases beside it use. Those hand the
       pointer back because it is legitimately aiming at local UI; here it is
       over the target picture and can do nothing. */
    assert.match(js, /if \(window\.desktopConsole && !windowFocused\) \{\s*kvmCursor\.style\.display = "none";\s*pane\.style\.cursor = "";/);
    /* And applied without waiting for a mouse move, or a socket dropping while
       the pointer is still would leave the blob sitting on the picture. */
    assert.match(js, /function paintCursorForInput\(\) \{/);
    assert.match(js, /if \(pane\.style\.cursor === "not-allowed"\) pane\.style\.cursor = "";/);
    assert.match(js, /paintMacroButtons\(\);[\s\S]{0,180}?paintCursorForInput\(\);/);
    /* Driven over CDP across an outage, reading #screen-pane:
         socket up    cursor "none"          blob shown on move
         socket down  cursor "not-allowed"   blob hidden
         recovered    cursor "none"          blob shown again */
});

test("the keys drawer makes room for the panel instead of sitting on it", () => {
    /* The drawer is absolutely positioned at the top of the chat column, and
       #chat-frame fills that same column from inset:0 — so opening the
       on-screen keyboard covered whatever the panel put in its first 48px.

       Measured with shells open: drawer 276..324 against a terminal tab strip
       at 276..312, so every tab AND the New shell button were hidden and
       unclickable for as long as the keyboard was up. The same at 1200px with
       four shells, drawer 0..48 over a strip at 0..36. On a phone the drawer is
       the only way to send Esc or Ctrl, so this is the state you are in exactly
       when you also want to switch shell. */
    assert.match(css, /\.app\.keys-open #chat-frame \{\s*top: var\(--keys-h\);\s*height: calc\(100% - var\(--keys-h\)\);/);
    /* The height as well as the top: with top, bottom and height all set the
       browser drops `bottom`, so the frame would start 48px down and still be
       100% tall, hanging the same 48px off the end. */
    assert.match(css, /#chat-frame \{\s*position: absolute;\s*inset: 0;/);

    /* One token, because the whole bug was two heights that had to agree and
       were written down separately. */
    assert.match(css, /--keys-h: 48px;/);
    assert.match(css, /\.bar-keys \{[\s\S]*?height: var\(--keys-h\);/);
    assert.doesNotMatch(css, /\.bar-keys \{[\s\S]*?height: 48px;/);

    /* Re-measured after the fix, drawer open:
         390px   drawer 276..324, strip 324..360   coversTabs false
         1200px  drawer 0..48,    strip 48..84     coversTabs false
       and screenshotted on the phone layout: the exited tab, three shells and
       the New shell button all visible under the keys. */
});

test("a two-finger gesture sends only what it means to send", () => {
    /* Driven with real touch events on the picture at phone size, reading the
       HID wire. Before:

         two-finger drag   wheel, then right down/up AND left down/up
         two-finger tap    right down/up AND left down/up
         slow scroll       wheel, then left down/up

       So every two-finger gesture put a stray left click on the target, and a
       quick one added a right click. On a remote machine a stray left click is
       how you activate whatever happens to be under the pointer.

       Two separate causes, both about a flag never being set.

       `moved` is only ever assigned by the single-finger branch, and that branch
       returns early while two fingers are down — so the first finger always
       released as "a tap that never moved" and tapClick("left") fired on top of
       whatever the gesture had already done. A second finger landing now
       disqualifies the tap outright.

       And twoStart.moved was measured against pinchCx/pinchCy, which are
       rewritten at the end of every move because the scroll and the pan both
       work off the delta since the last one. That asked "did this event jump 8
       pixels?", not "has the gesture travelled 8 pixels" — so a scroll made of
       many small moves never counted as moved, and lifting inside the 300ms
       window read as a two-finger tap. It measures from the start of the
       gesture now, exactly as the single-finger branch measures from startPt. */
    assert.match(js, /if \(twoStart && Math\.hypot\(c\.x - twoStart\.cx, c\.y - twoStart\.cy\) > MOVE_SLOP\) twoStart\.moved = true;/);
    assert.doesNotMatch(js, /Math\.hypot\(c\.x - pinchCx, c\.y - pinchCy\) > MOVE_SLOP/);
    assert.match(js, /A second finger means this is not a tap any more\./);

    /* The single-finger measurement it now matches, and the deliberate gestures
       that must survive: a two-finger tap is still a right click, and so is a
       long press. Verified on the wire after the fix:
         two-finger drag  wheel only
         slow scroll      2 wheels, no buttons at all
         two-finger tap   right down/up, nothing else
         long press       right down/up
         single tap       left down/up
         single drag      relative mouse_move only */
    assert.match(js, /var movedDist = Math\.hypot\(e\.clientX - startPt\.x, e\.clientY - startPt\.y\);/);
    assert.match(js, /if \(!twoStart\.moved && Date\.now\(\) - twoStart\.t < 300\) tapClick\("right"\);/);
});

/**
 * Pinching in made the touch trackpad coarser, not finer.
 *
 * relMove() converted finger pixels to cursor travel against the stream
 * element's LAYOUT box (offsetWidth/offsetHeight). offsetWidth ignores CSS
 * transforms, and zoom is a transform, so the divisor stayed at the un-zoomed
 * width however far in you had pinched. Measured over the same 60px drag on a
 * 390x844 phone, gain in normalised units:
 *
 *     1.00x zoom   7259
 *     3.13x zoom   7259   <- identical, so the cursor flew 3.13x further than
 *                            the finger did across the magnified picture
 *
 * You pinch in on a KVM precisely because the target you want is small. Making
 * the pointer three times harder to place at that moment is backwards. The
 * absolute (mouse) path never had this: it maps through pictureBox(), which is
 * built from getBoundingClientRect() and so carries the transform. Two paths
 * into one operation, measuring two different boxes. After sharing pictureBox()
 * the same drag gives 7271 at 1x and 2320 at 3.13x — a ratio of 3.13, i.e. the
 * cursor tracks the picture under the finger 1:1 at any zoom.
 */
test("the touch trackpad measures the zoomed picture box, not the layout box", () => {
    const at = js.indexOf("function relMove(dx, dy) {");
    assert.ok(at > 0, "relMove not found");
    const body = js.slice(at, js.indexOf("function tapClick(", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    // The transformed box the absolute path already maps through.
    assert.match(body, /var box = pictureBox\(\);/);
    assert.match(body, /var w = \(box && box\.w\) \|\| pane\.clientWidth/);
    assert.match(body, /var h = \(box && box\.h\) \|\| pane\.clientHeight/);
    // The layout box is transform-blind, so it must not come back as the divisor.
    assert.ok(!/offsetWidth|offsetHeight/.test(body), "relMove is back on the layout box");
});

/**
 * Resizing the pane while zoomed stranded the picture off the edge.
 *
 * clampPan() bounds the pan at pane.width * (scale - 1), and it only ran from
 * zoomAround() and the two-finger pan. Nothing re-ran it when the pane itself
 * changed size, so the transform stayed where it was while the box it had been
 * clamped against shrank underneath it. Zoomed to 3.13x and panned into the
 * bottom-right corner, then narrowing the viewport 800 -> 400:
 *
 *     translate(-1054.1px, -680px) scale(3.1333)   pane 800x450   uncovered 0
 *     translate(-1054.1px, -680px) scale(3.1333)   pane 400x225   uncovered r:201 b:200
 *
 * Just under half of a 400x225 pane showing background instead of the target.
 * A window resize, a phone rotating and dragging the agent panel divider all
 * reach it, and the only way back was pinching out to 1 (which zeroes the pan).
 * A ResizeObserver on the pane re-clamps against the box that exists now:
 * after, translate(-853.3px, -480px), which is exactly 400*2.1333 by
 * 225*2.1333 — the corner still, nothing uncovered.
 */
test("zoomed pan is re-clamped when the pane resizes", () => {
    const at = js.indexOf("if (typeof ResizeObserver !== \"undefined\") {");
    assert.ok(at > 0, "pan-clamp ResizeObserver not found");
    const body = js.slice(at, js.indexOf("function zoomAround(", at));
    assert.match(body, /\.observe\(pane\)/);
    // Only meaningful while zoomed; unzoomed pans are pinned to 0,0 already.
    assert.match(body, /if \(scale <= 1\) return;/);
    assert.match(body, /clampPan\(\);/);
    // Repaint only when the clamp actually moved something.
    assert.match(body, /var before = tx \+ ","? ?\+ ty;[\s\S]*?if \(tx \+ ","? ?\+ ty !== before\) applyXform\(\);/);
});

/**
 * "Full PiKVM UI" was a one-way door into a window with no chrome.
 *
 * The menu item was <a href="/?native=1">, and picking it replaced this
 * document with the Pi's own web UI. On Linux and Windows the console window
 * is created frame:false, so the titlebar THIS document draws is the entire
 * window chrome — drag region, minimise, maximise, close. The Pi's UI carries
 * none of it. What you were left with could not be moved, could not be closed
 * from inside, and had no route back to the console; only the window manager
 * could recover it. On the web the same door had a softer floor: no way back
 * short of editing the URL by hand.
 *
 * It is framed under the titlebar now. Measured at 1400x820 in desktop mode,
 * with the native menu command driving it:
 *
 *     titlebar visible  true      frame top 38   height 782
 *     title             "PiKVM — full UI"
 *     menu item         "Back to console"
 *
 * 38 is exactly the titlebar's height, so the frame starts where the bar ends
 * and covers everything below it.
 */
test("the full PiKVM UI is framed under the titlebar, not navigated to", () => {
    const bare = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    // No navigation left anywhere: an <a href> here is the bug returning.
    assert.ok(!/id="full-ui"[^>]*href=/.test(html), "full-ui is a link again");
    assert.match(html, /<button class="more-item" id="full-ui">Full PiKVM UI<\/button>/);
    assert.match(html, /<iframe id="full-ui-frame"[^>]*hidden/);
    assert.ok(!/location\.href = "\/\?native=1"/.test(bare(js)), "still navigating to the native UI");
    // Both entry points — the HTML menu (web/mobile) and the native menu
    // (desktop) — go through the one toggle.
    assert.match(js, /case "full-ui":\s*\n\s*setFullUi\(!fullUiActive\(\)\);/);
    assert.match(js, /fullUiToggleBtn\.addEventListener\("click", function \(e\) \{[\s\S]*?setFullUi\(!fullUiOn\);/);
    // The frame covers the app area only. Absolute inside .app, which has to be
    // the containing block for that to mean anything.
    assert.match(css, /#full-ui-frame,\s*\n\.full-ui-note \{\s*\n\s*position: absolute;\s*\n\s*inset: 0;/);
    assert.match(css, /\.app \{[\s\S]*?position: relative;\s*\n\}/);
});

/**
 * Leaving has to be reachable, and reachable from a failure too.
 *
 * The menu item flips to "Back to console" rather than carrying aria-pressed
 * alongside it — both would announce "Back to console, toggle button, pressed",
 * which says neither where you are nor what the button does.
 *
 * The note is the other half: a same-origin iframe pointed at an unreachable Pi
 * fires no error event and simply never loads, so without a deadline the only
 * thing on screen would be an empty rectangle under a titlebar. It carries its
 * own way out, because at that point the menu is the only other one.
 */
test("full UI announces which way it goes and can always be left", () => {
    assert.match(js, /btn\.textContent = fullUiOn \? "Back to console" : "Full PiKVM UI";/);
    const bare = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    assert.ok(
        !/aria-pressed/.test(bare(js.slice(js.indexOf("function paintFullUiToggle"), js.indexOf("function setFullUiNote")))),
        "aria-pressed is back alongside the label",
    );
    // Native menu label tracks it too, or the desktop item lies about state.
    assert.match(js, /id: "full-ui", label: fullUiActive\(\) \? "Back to console" : "Full PiKVM UI"/);
    // A deadline, because there is no error event to wait for.
    assert.match(js, /fullUiTimer = setTimeout\(function \(\) \{[\s\S]*?did not load/);
    assert.match(html, /id="full-ui-back">Back to console<\/button>/);
    // Recovery control on a failure screen: a full 44px target.
    assert.match(css, /\.full-ui-back \{[\s\S]*?min-height: 44px;/);
});

/**
 * Framing the Pi's UI must not leave our own stream running behind it.
 *
 * Both are the same camera over the same link, so a console still streaming
 * behind an opaque frame pays for the picture twice to look at one of them.
 *
 * The guard belongs in loadStream() and not in mjpegPaused. Parking that flag
 * was the first attempt and it did not hold: fallbackToMjpeg() clears it
 * whenever WebRTC gives up, which happened mid-session, and the stream came
 * straight back up behind the frame. Measured by polling the <img> src every
 * 2s for 28s inside the full UI — fourteen samples, all "closed" after the
 * fix, and "OPEN" again on the way out. loadStream() is the only place the
 * MJPEG connection is opened, so it is the only place that needs to know.
 */
test("the console's own stream is released while the full UI is up", () => {
    const at = js.indexOf("function loadStream() {");
    assert.ok(at > 0, "loadStream not found");
    const guard = js.slice(at, js.indexOf("freezeFrame();", at));
    assert.match(guard, /if \(fullUiOn\) return;/);
    // Entering drops the connection; leaving asks loadStream for it back, which
    // self-guards so WebRTC's picture is not trampled.
    assert.match(js, /img\.removeAttribute\("src"\);\s*\n\s*setFullUiNote\("Loading the PiKVM UI…"\);/);
    assert.match(js, /fullUiFrame\.removeAttribute\("src"\);[\s\S]*?loadStream\(\);/);
    // mjpegPaused is explicitly NOT the mechanism any more.
    const bare = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const body = bare(js.slice(js.indexOf("function setFullUi(on) {"), js.indexOf("if (fullUiFrame) {")));
    assert.ok(!/mjpegPaused/.test(body), "setFullUi is back on mjpegPaused");
});

/**
 * The framed full UI left the keyboard with two owners.
 *
 * #kbd is a 1x1 invisible textarea, and refocusKbd() hands it the focus back
 * for as long as the on-screen keys drawer is open. So: open the keys, pick
 * Full PiKVM UI, and every keystroke still went to the target through a
 * control that was no longer on screen — while the Pi's own UI, the thing you
 * were actually looking at, captures the keyboard too. Measured on the wire
 * with the frame up:
 *
 *     key b   ->  ["key:KeyB:true", "key:KeyB:false"]
 *
 * Blocking input alone would have been the wrong half of the fix: with #kbd
 * still holding focus the keys get swallowed at a control the user cannot see
 * and passed to nobody, so the frame reads as broken instead of the target
 * being typed at twice. Entering hands focus over — measured activeElement
 * "kbd" before, "full-ui-frame" after — and blockKvmInput is the backstop for
 * anything that grabs it back. After the fix, with #kbd force-focused, key c
 * put nothing on the wire; leaving restored it and key d landed normally.
 */
test("the full UI owns the keyboard while it is framed", () => {
    // One gate for every input entry point.
    assert.match(js, /function blockKvmInput\(e\) \{\s*\n\s*if \(!fullUiOn\) return false;/);
    // Nothing hands the hidden textarea its focus back underneath the frame.
    const refocus = js.slice(js.indexOf("function refocusKbd() {"));
    assert.match(refocus.slice(0, refocus.indexOf("}")), /if \(fullUiOn\) return;/);
    // Entering lets go of what is physically held and gives up the focus.
    const enter = js.slice(js.indexOf("releaseAllMods();"), js.indexOf("setFullUiNote(\"Loading"));
    assert.match(enter, /releaseHeldMouseButtons\(\);/);
    assert.match(enter, /if \(document\.activeElement === kbd\) kbd\.blur\(\);/);
    // ...and the frame takes it, so typing works without clicking into it first.
    assert.match(js, /setFullUiNote\(null\);[\s\S]{0,200}?fullUiFrame\.focus\(\);/);
});

/**
 * Reading text from the screen armed an invisible mode under the full UI.
 *
 * "Read text from the screen…" asks you to drag a rectangle over the text you
 * want. With the Pi's own UI framed on top, the picture is still there but
 * completely covered, so that aim is no more possible than aiming at a picture
 * that never arrived — which the existing !screenHasPicture() guard already
 * refuses for exactly that reason.
 *
 * It did not fail cleanly, it armed. Measured with the frame up, invoking it
 * put ocr-picking on the pane and rendered its "Drag over the text to read ·
 * Esc to cancel" hint, both underneath the frame where they cannot be seen and
 * where the drag that would finish them lands on the frame instead. A pick
 * already running survived entering the full UI the same way:
 *
 *     picking in console   true   hint true
 *     after entering       true   hint true    <- still armed, now invisible
 *     ocr while framed     true   toast null   <- armed again, silently
 *
 * And because ocrPickingNow() diverts pointer events on the pane, the first
 * click after coming back went to the picker rather than the target. After:
 *
 *     after entering       false  hint false
 *     ocr while framed     false  toast "Leave the full PiKVM UI to read…"
 *     ocr after leaving    true   hint true
 */
test("reading the screen is refused, not armed, under the full UI", () => {
    const at = js.indexOf("function startOcrPick() {");
    assert.ok(at > 0, "startOcrPick not found");
    const body = js.slice(at, js.indexOf("ocrPicking = true;", at));
    // Refused with a reason, not silently, and before the picker can arm.
    assert.match(body, /if \(fullUiActive\(\)\) \{\s*\n\s*toast\("Leave the full PiKVM UI to read from the screen", true\);\s*\n\s*return;/);
    assert.ok(body.indexOf("fullUiActive()") < body.indexOf("screenHasPicture()"), "the full-UI refusal must come before the no-picture one");
    // Not offered in the first place while the frame is up.
    assert.match(js, /id: "ocr"[^}]*enabled: screenHasPicture\(\) && !ocrBusy && !fullUiActive\(\)/);
    // And a pick already running does not outlive the picture being covered.
    assert.match(js, /endOcrPick\(\); \/\/ a half-finished region pick cannot outlive the picture/);
});

/**
 * Launching a second copy killed it with a raw stack trace.
 *
 * There was no single-instance lock, so a second launch booted all the way to
 * server.listen() on a port the first copy already held. listen() reports
 * asynchronously through an "error" event and nothing was listening for it, so
 * Node re-raised EADDRINUSE as an uncaught exception — which in an Electron
 * main process is the modal "A JavaScript error occurred in the main process"
 * box, containing:
 *
 *     Error: listen EADDRINUSE: address already in use 0.0.0.0:25650
 *         at Server.setupListenHandle [as _listen2] (node:net:1940:16)
 *
 * Accurate and useless. It names nothing the user can act on, and it arrives
 * before any window does, so there is no context around it either.
 *
 * Three separate things had to be true for that to be the outcome, so all
 * three are fixed: the lock (a second launch is someone reaching for the
 * window they already have), the port walk (something ELSE can hold 25650 —
 * an orphan from a copy that was killed rather than closed), and a listen
 * error that is reported rather than thrown.
 *
 * Measured against a real busy port, with 1.12.3 holding 0.0.0.0:25650:
 *
 *     [control] 25650 is in use, serving on 25651 instead
 *     PiKVM backend listening on http://0.0.0.0:25651
 *
 * and a second copy of the new build exited 0 at once, starting no server,
 * while the first carried on.
 */
/**
 * A disabled action button let focus out of the modal.
 *
 * FOCUSABLE spells out :not([disabled]) on every tag it names and then ends
 * with [tabindex]:not([tabindex="-1"]), which tests no such thing. The shared
 * component library stamps tabindex="0" on its buttons, so a DISABLED action
 * button matched that final clause and walked straight back into the list.
 *
 * It landed as `last`, and the browser will never focus a disabled control, so
 * the wrap could not fire: Tab off the final ENABLED control went somewhere the
 * trap was not watching and left the dialog. Measured on the paste dialog,
 * whose Paste button is disabled until you type — which is the state it opens
 * in, so this was the first Tab a keyboard user pressed:
 *
 *     trap saw   ["paste-text", "Cancel", "Paste[DISABLED]"]
 *     tab walk   paste-text -> Cancel -> BODY / titlebar "Controls"
 *
 * Out onto the live surface behind the modal, which is the exact thing the
 * trap's own comment says it exists to stop — and that surface types at the
 * remote machine. After, the same walk cycles paste-text <-> Cancel and never
 * leaves, shift-Tab included; once text makes Paste enabled it joins the cycle
 * as the third stop.
 */
test("the modal focus trap ignores disabled controls", () => {
    const at = js.indexOf("function focusablesIn(scrim) {");
    assert.ok(at > 0, "focusablesIn not found");
    const body = js.slice(at, js.indexOf("var focusBeforeModal", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    // Disabled is decided in JS, because the selector cannot express it.
    assert.match(body, /if \(el\.disabled \|\| el\.getAttribute\("aria-disabled"\) === "true"\) return false;/);
    // The visibility filter it already had stays.
    assert.match(body, /return el\.offsetParent !== null;/);
    // The trap still wraps at both ends off that list.
    assert.match(js, /\} else if \(!e\.shiftKey && active === last\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*first\.focus\(\);/);
    assert.match(js, /\} else if \(e\.shiftKey && active === first\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*last\.focus\(\);/);
});

/**
 * Neither load-failure ceiling had ever counted past one.
 *
 * Chromium loads an error PAGE when a navigation fails, and that error page
 * finishes loading like any other — so did-finish-load fires right after
 * did-fail-load. The reset lived in did-finish-load, unconditionally, which
 * zeroed both counters after every single failure.
 *
 * So the local branch retried every 600ms forever, and the remote branch's
 * "three tries then a recovery dialog" could never reach three either. Measured
 * with the console load forced to fail:
 *
 *     before   46 attempts in 30s, against a ceiling of 20, still climbing
 *     after    21 attempts, then the dialog
 *
 * A flag scoped to the current navigation is what makes the ceilings real: an
 * error page finishing is not the console loading.
 */
/**
 * The local console retried forever behind an empty window.
 *
 * The remote branch three lines below already stopped after three tries and put
 * up a native recovery dialog. The local branch — the DEFAULT path, the one
 * every ordinary install takes — just called setTimeout(connect, 600) with no
 * counter at all, so a console that could not load left a blank window retrying
 * behind it with nothing on screen and nothing to act on. Measured: 34 attempts
 * in 22 seconds, no ceiling, no dialog, no message.
 *
 * ~12s of quiet retrying first, because on a cold boot the local server really
 * is still coming up and a dialog then would be noise. After that it is not
 * coming up on its own and saying so beats an empty window.
 */
/**
 * The terminal's tab strip scrolled with nothing saying so.
 *
 * #tablist is overflow-x:auto, and its scrollbar is hidden on both engines
 * (scrollbar-width:none plus a ::-webkit-scrollbar display:none). So a strip
 * with more shells than room simply ended at a hard edge, which reads as
 * finished rather than cut. Measured with eight shells at 420px wide — the
 * terminal column on a phone — 372px of tabs off the right and nothing on
 * screen indicating it.
 *
 * The console already answers this question for the keys drawer and the macro
 * strip, with the same two classes and the same 32px fade. This is a separate
 * document so it needs its own copy; keeping it identical is what stops one
 * question having two answers. After, at 420px:
 *
 *     scrollLeft 0      before false  after true    fade on the right
 *     scrollLeft 186    before true   after true    both ends
 *     scrollLeft 372    before true   after false   fade on the left
 *     1200px wide       before false  after false   mask: none
 */
/**
 * "press Enter to restart" lived in one browser, not in the session.
 *
 * The notice was written client-side, in the terminal's handler for the "exit"
 * message. The tab grows an "exited" badge whose tooltip says the same thing,
 * but that badge is aria-hidden and its tooltip is hover-only — which is why
 * terminal/main.ts's own comment says "the restart is only discoverable by
 * reading the dead shell's last line". That line was missing in the two cases
 * where you most need it:
 *
 *   - open the terminal AFTER a shell exited and you get the session list with
 *     exited:true and no "exit" message at all, so the pane is dead with no way
 *     out of it named anywhere on screen;
 *   - reconnect after a blip, because ws.onopen resets every term and redraws
 *     from the server's buffer — which did not contain the notice, so a dropped
 *     socket silently erased instructions from a pane that already had them.
 *
 * Driven against a real PTY, exiting a shell and then attaching a fresh client:
 *
 *     before   notice in live stream 0    notice in replay 0
 *     after    notice in live stream 1    notice in replay 1
 *
 * Zero in both before, because it was never on the wire at all — it only ever
 * existed inside the one browser that happened to be watching.
 *
 * Asserted on source rather than executed: the test runner bundles into a temp
 * directory, where @lydell/node-pty cannot resolve its native binding, which is
 * why nothing else in this suite imports terminal-server either. The numbers
 * above came from running the same flow from inside the repo, where it does
 * resolve.
 */
/**
 * The agent panel vanished with no explanation when a stale harness owned the port.
 *
 * Hit for real: an app started at 14:30 against a harness left running from
 * 20:33 the previous night. The app generates a fresh access token, finds the
 * harness port already healthy, and — correctly — refuses credential-blind
 * adoption, then cannot spawn its own on a taken port. So every workspace call
 * is signed with a token the surviving harness has never seen:
 *
 *     GET /app/harness/api/runs?limit=1
 *     401 {"detail":"valid harness bearer token required"}
 *
 * The panel is gated on that call, so it simply never appeared. Everything else
 * was healthy — daemon /healthz 200, every workspace asset 200 with real bytes —
 * which is what made it a twenty-minute mystery rather than an obvious outage.
 *
 * main.ts knows all of it. Its own comment says the failure is "worth
 * reporting, because the console can only say 'not yet' while this knows the
 * harness never started at all", and then console.error()s it where nobody
 * looks.
 *
 * The status code already on the wire separates the two cases, so no new
 * channel is needed: a network error or 502 means not started YET (normal on a
 * cold boot, worth nothing to interrupt for), while 401/403 means running and
 * refusing us, which never fixes itself. Measured after: note shown filling the
 * panel box at 401, and silent on an unreachable harness.
 */
test("the desktop panel does not wait on the harness", () => {
    /* It used to frame the first-party chat workspace, which needed the
       harness. A harness left over from an earlier run held the socket and
       refused this run's token, so the panel showed "The agent panel could not
       start" (seen 2026-10-05, from an orphan of 2026-09-21). Since then the
       panel is the terminal, served by this app's own process, so there is
       nothing to poll and no refusal to report. */
    assert.doesNotMatch(js, /harnessAnswering/);
    assert.doesNotMatch(js, /ws-note/);
    assert.doesNotMatch(html, /ws-note/);
    assert.doesNotMatch(css, /\.ws-note/);
});

/**
 * A daemon orphaned on 47615 took the whole agent stack down with it.
 *
 * The daemon is configured adoptExisting:false on purpose - it must never talk
 * to one whose credential it cannot prove - so a leftover from a previous run
 * holding the port meant the app could neither adopt it nor spawn its own, and
 * the agent panel never appeared.
 *
 * It walks to the next free port now, and the WALK IS NOT ENOUGH ON ITS OWN.
 * `pikvm-agent daemon` reads its host and port from its own config file, so
 * spawning a bare "daemon" while this side had moved left the two disagreeing.
 * Measured, before the args were passed:
 *
 *     [daemon] 127.0.0.1:47615 is in use, using http://127.0.0.1:47617 instead
 *     [daemon] starting: …/pikvm-agent daemon
 *     [daemon] ERROR: [Errno 98] … bind on address ('127.0.0.1', 47615) …
 *     [daemon] exited unexpectedly (code=1 signal=null)      x5, then gave up
 *
 * The app waited on 47617 while the child kept charging at the very orphan the
 * walk existed to avoid. After passing --host/--port:
 *
 *     [daemon] starting: …/pikvm-agent daemon --host 127.0.0.1 --port 47617
 *     [daemon] Uvicorn running on http://127.0.0.1:47617
 *
 * with zero Errno 98 and no exits.
 */
/**
 * Two probes run back to back both see the same port as free, because a probe
 * closes its socket before returning. The first version of the walk handed the
 * daemon and the harness the SAME port:
 *
 *     [daemon]  127.0.0.1:47615 is in use, using http://127.0.0.1:47617
 *     [harness] 127.0.0.1:47616 is in use, using http://127.0.0.1:47617
 *
 * which is a worse failure than the orphan it was written to route around.
 */
/**
 * The panel divider re-announced itself for changes that were not about it.
 *
 * paintResizeValue() used raw setAttribute while setAttr — written for exactly
 * this, three functions away — sat unused. Chromium raises a value-changed
 * event on the WRITE, not on the value differing, which is the whole reason
 * that helper exists; its own comment records the stream sliders announcing
 * "80%" six times for six identical streamer pushes.
 *
 * The divider had the same fault from window resizes. Measured over six 1px
 * resizes with the divider untouched and merely focused:
 *
 *     before   15 attribute writes   values 320 / 600 / 1099 / 1100
 *     after     5 attribute writes   values 1099 / 1100
 *
 * min ("320") and now ("600") never changed value once across all fifteen. The
 * five that remain are the max genuinely tracking the window.
 *
 * Both separators also announced a naked number: aria-valuenow is what gets
 * read, and "600" is not a width. The stream sliders already carried
 * aria-valuetext for precisely this reason, so these two were the only numeric
 * controls left without it.
 */
test("the resize separators announce a unit, and only when something changed", () => {
    // Guarded writes, so an unchanged value is not re-announced.
    const paint = js.slice(js.indexOf("function paintResizeValue() {"), js.indexOf("function cresizeEnd()"));
    assert.ok(!/chatResize\.setAttribute\(/.test(paint), "the divider is back on raw setAttribute");
    assert.match(paint, /setAttr\(chatResize, "aria-valuemin", String\(PANEL_MIN_W\)\);/);
    assert.match(paint, /setAttr\(chatResize, "aria-valuemax", String\(panelMaxNow\(\)\)\);/);
    assert.match(paint, /setAttr\(chatResize, "aria-valuenow", now\);/);
    // A width, not a number.
    assert.match(paint, /setAttr\(chatResize, "aria-valuetext", now \+ " pixels"\);/);
    // The vertical grip on the phone layout says it the same way.
    const grip = js.slice(js.indexOf("function paintGripValue(known) {"), js.indexOf("if (gripEl) {"));
    assert.match(grip, /setAttr\(gripEl, "aria-valuenow", now\);/);
    assert.match(grip, /setAttr\(gripEl, "aria-valuetext", now \+ " pixels"\);/);
});

/**
 * Which macro the editor was showing rode on a background colour alone.
 *
 * The list is a role=group of plain buttons and the open one got
 * className = "active" — nothing else. Tabbing it gave six buttons that sound
 * alike ("Short 0", "Reboot the production database cluster 1", "Short 2"…)
 * with no way to tell which one the fields beside them belonged to. Measured
 * before: every button reported aria-current null and aria-selected null, with
 * only a computed backgroundColor separating the active row.
 *
 * aria-current rather than aria-selected, deliberately. aria-selected belongs
 * to listbox and tab semantics, and claiming those would promise an arrow-key
 * model this list does not have — the same reasoning the ⋯ menu uses for being
 * a labelled group instead of a role=menu. Set only on the current button,
 * because absent already means "not current".
 *
 * Verified as an attribute: it appears on exactly one button, and follows the
 * selection (Short 0 at open, Short 2 after clicking it, count still 1).
 *
 * NOT verified in the accessibility tree, and worth stating: Chromium's
 * Accessibility.getPartialAXTree does not surface aria-current in its property
 * list, so the current and non-current buttons dump identically over CDP. That
 * is a limit of the CDP enum rather than evidence the attribute does nothing —
 * unlike aria-describedby on the sign-in page, which that same call did show.
 */
/**
 * On a chord step it was the up/down/remove buttons that wrapped, not the keys.
 *
 * .macro-step was a flex row with flex-wrap, and a chord row carries five
 * modifier toggles AND a key list. Wrapping is deliberate — the comment on that
 * rule records that squeezing them onto one line collapsed the key list to
 * about 55px, enough for "L" but not for "Print Screen" — but what actually
 * dropped to the second line was the action box. It landed between its own row
 * and the next one with nothing saying which step it acted on, and it was the
 * only step type where that happened, so the row where reordering is fiddliest
 * was also the one where its controls moved.
 *
 * Measured at the default dialog width, before:
 *
 *     row 554px wide, chord content wants 694px
 *     (kind 72 + mods 257 + key list 211 + actions 154)
 *     chord row h=71  actions wrapped=true   text rows h=32  wrapped=false
 *
 * The wrap moves off the row and onto a box holding just the step's own
 * controls, so the key list is what goes to the second line and the actions stay
 * pinned to the first. After: chord row h=69, wrapped=false, and the key list
 * gets the body's full width rather than the 211px it was squeezed into — more
 * readable, which is what the original rule was protecting.
 *
 * align-items:flex-start on the row so the actions sit level with the first
 * line, which is the one they label.
 */
test("a chord step wraps its key list, not its step controls", () => {
    // The controls the step owns live in their own box...
    assert.match(js, /var body = document\.createElement\("div"\);\s*\n\s*body\.className = "macro-step-body";/);
    // ...which is what everything between the kind label and the actions joins.
    assert.match(js, /body\.appendChild\(mods\);/);
    assert.match(js, /body\.appendChild\(keySel\);/);
    assert.match(js, /body\.appendChild\(text\);/);
    assert.match(js, /body\.appendChild\(ms\);/);
    assert.match(js, /body\.appendChild\(unit\);/);
    // Row order stays kind, body, actions.
    assert.match(js, /row\.appendChild\(body\);\s*\n\s*row\.appendChild\(actions\);/);
    // The wrap is on the body now, and the row does not wrap at all.
    assert.match(css, /\.macro-step-body \{[\s\S]*?flex-wrap: wrap;[\s\S]*?flex: 1 1 auto;[\s\S]*?min-width: 0;/);
    // Just the row's own rule: .macro-step-body follows it and legitimately wraps.
    const rowStart = css.indexOf(".macro-step {");
    const rowRule = css.slice(rowStart, css.indexOf("}", rowStart));
    assert.ok(!/flex-wrap/.test(rowRule), "the row must not wrap — that is what dropped the actions");
    assert.match(rowRule, /align-items: flex-start;/);
});

/**
 * Mount stayed live while an image was still being written to storage.
 *
 * Every other control in the mass-storage dialog is gated on `settable`, whose
 * comment states the rule: while the drive cannot take a change "kvmd rejects
 * any change, so the controls that would make one are disabled rather than left
 * to fail". canConnect was the one flag that did not include !msdUpload, so
 * mounting the PREVIOUS image on the target in the middle of an upload was
 * offered — a change kvmd will not perform.
 *
 * Measured with an upload in flight against the harness (which holds
 * /api/msd/write_remote open for 30s for exactly this):
 *
 *     before   Mount on the target            Delete image [disabled]
 *              Abort                          Reset drive  [disabled]
 *     after    Mount on the target [disabled] Delete image [disabled]
 *              Abort                          Reset drive  [disabled]
 *
 * The URL field was already disabled and Start upload already flipped to Abort,
 * so Mount was the single control left out of an otherwise complete set.
 */
test("mounting is refused while an upload is still running", () => {
    assert.match(
        js,
        /msdBody\.canConnect = !!\(online && d\.image && !connected && !busy && !msdUpload\);/,
    );
    // The neighbours it now matches, so the set stays complete if one changes.
    assert.match(js, /var settable = online && !connected && !busy && !msdUpload;/);
    assert.match(js, /msdBody\.canRemove = !!\(settable && d\.image && d\.image\.removable\);/);
    assert.match(js, /msdResetEnabled = online && !busy && !msdUpload;/);
});

/**
 * Half the paste line was written for a human and half was not.
 *
 * The console formats a duration (humanDuration → "about 4 min") and a size
 * (humanBytes → "3.7 GB"), but the character count printed beside them was raw.
 * Measured across the range the field accepts:
 *
 *     40        "40 characters"
 *     600       "600 characters · about 12s"
 *     12000     "12000 characters · about 4 min"      <- unreadable half
 *     200000    "200000 characters · about 67 min"    <- unreadable half
 *
 * The two that are hard to read at a glance are exactly the ones where the
 * number matters, because those are the pastes worth thinking twice about
 * before starting — 200,000 characters is over an hour of the target being
 * typed at, and kvmd owns that typing once it begins, so there is no stopping
 * it from here. After: "12,000 characters · about 4 min" and "200,000
 * characters · about 67 min", with 40 and 600 unchanged.
 *
 * All three places that print a count go through it, including the sticky
 * toast that deliberately outlives the dialog.
 */
test("character counts are formatted like every other quantity", () => {
    assert.match(js, /function humanCount\(n\) \{\s*\n\s*return typeof n === "number" && isFinite\(n\) \? n\.toLocaleString\(\) : String\(n\);/);
    // The count under the field.
    assert.match(js, /\? humanCount\(n\) \+ \(n === 1 \? " character" : " characters"\) \+ \(hint \? " · " \+ hint : ""\)/);
    // The sticky toast while it types...
    assert.match(js, /"Typing " \+\s*\n\s*humanCount\(text\.length\) \+/);
    // ...and the one that reports it finished.
    assert.match(js, /"Typed " \+ humanCount\(text\.length\) \+/);
    // No raw text.length left in a sentence.
    const paste = js.slice(js.indexOf("pasteBusy = true;"), js.indexOf("var pasteBtn = document.getElementById"));
    assert.ok(
        !/"Typing " \+\s*\n?\s*text\.length/.test(paste) && !/"Typed " \+ text\.length/.test(paste),
        "a raw count is back in one of the paste messages",
    );
});

/**
 * A mouse's thumb buttons sent left clicks to the target.
 *
 * The mapping was `e.button === 2 ? "right" : e.button === 1 ? "middle" :
 * "left"`, which is not a mapping so much as "left unless proven otherwise".
 * Most mice have two more buttons — 3 and 4, the thumb pair browsers use for
 * back and forward — and both fell through to "left". Measured on the wire,
 * pressing each of them over the remote screen:
 *
 *     back     mouse_button:left:true, mouse_button:left:false
 *     forward  mouse_button:left:true, mouse_button:left:false
 *
 * On a KVM that is not cosmetic. It lands wherever the pointer happens to be,
 * on a machine someone is usually part-way through something on, and the press
 * that caused it was aimed at the browser rather than at the target at all.
 *
 * MouseButton in pikvm-control.ts is "left" | "right" | "middle" and kvmd takes
 * no more, so there is nothing to forward these to. null, and both callers do
 * nothing with it.
 */
test("only the three buttons the HID can carry are sent", () => {
    assert.match(
        js,
        /function hidButtonFor\(e\) \{\s*\n\s*if \(e\.button === 0\) return "left";\s*\n\s*if \(e\.button === 1\) return "middle";\s*\n\s*if \(e\.button === 2\) return "right";\s*\n\s*return null;\s*\n\s*\}/,
    );
    // Press: nothing is sent and nothing is recorded as held.
    assert.match(js, /var b = hidButtonFor\(e\);\s*\n\s*if \(!b\) return; \/\/ a thumb button the target's HID cannot carry/);
    // Release: nothing was pressed for it, so nothing is released.
    assert.match(js, /var b = hidButtonFor\(e\);\s*\n\s*if \(!b\) return; \/\/ nothing was pressed for it, so nothing to release/);
    // The old fall-through must not come back on either path.
    const bare = js.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(
        !/e\.button === 2 \? "right" : e\.button === 1 \? "middle" : "left"/.test(bare),
        "the left-unless-proven-otherwise mapping is back",
    );
    // The protocol this is matching stays the source of truth.
    const control = readFileSync(resolve(root, "src/pikvm-control.ts"), "utf8");
    assert.match(control, /export type MouseButton = "left" \| "right" \| "middle";/);
});

/**
 * The harness can route around an orphaned port now that its child can be told.
 *
 * This is the failure that took the agent panel down: a harness left running
 * from a previous session still owned 47616, the app correctly refused
 * credential-blind adoption of it, and could not spawn its own on a taken port —
 * so every workspace call was signed with a token that harness had never seen
 * and came back 401, with the panel simply absent.
 *
 * The daemon's port walk could not be copied here at the time, because the
 * harness takes its bind address from a YAML that ensureConfig() writes only
 * when the file does not already exist. On any install that had run once, the
 * app would have picked a free origin while the child charged at the old one —
 * the same "[Errno 98] address already in use" crash loop the daemon had before
 * it was told its port.
 *
 * `harness serve --listen HOST:PORT` closes that: one run's bind, no rewrite of
 * a file that carries the operator's provider settings. Measured with both
 * orphans still holding their ports:
 *
 *     [daemon]  127.0.0.1:47615 is in use, using http://127.0.0.1:47617 instead
 *     [harness] 127.0.0.1:47616 is in use, using http://127.0.0.1:47618 instead
 *     [harness] starting: …/pikvm-agent harness serve --config … --listen 127.0.0.1:47618
 *
 *     GET /app/harness/api/runs?limit=1   ->  200   (was 401)
 *     GET 47618/api/health                   ->  200
 *
 * with zero Errno 98, zero adoption refusals and zero startup failures in the
 * log.
 */
/**
 * The microphone was never pinned, so it drifted.
 *
 * Turning the mic on ran getUserMedia({ audio: true }) purely as a permission
 * pre-flight, stopped the tracks, and handed off to webrtc.js. `true` does not
 * name a device — it means "whatever the OS calls default at the moment you
 * ask" — so the capture followed the system default wherever it went. Plug a
 * headset in mid-session, let Bluetooth reconnect, let a call app take the
 * line, and the microphone being sent to the target changed with nobody having
 * asked for it.
 *
 * The capture is not opened here. It is opened inside janus.js, from webrtc.js's
 * createAnswer({ tracks: [{ type: "audio", capture: allowMic }] }), and
 * janus.js's trackConstraints puts that `capture` value straight into
 * constraints.audio before calling getUserMedia — so a device constraint IS
 * honoured end to end, but webrtc.js hardcodes the boolean and takes no device.
 * The one point both calls pass through is getUserMedia itself, so console.js
 * wraps it. Measured in the harness with three stubbed inputs, watching what
 * reached the underlying getUserMedia:
 *
 *     before   mic on                   { audio: true }
 *     after    mic on, headset pinned    { audio: { deviceId: { exact: "MIC-HEADSET" } } }
 *     after    switch device while live  setMic calls 1 -> 2, new constraint applied
 *     after    reload                    { audio: { deviceId: { exact: "MIC-HEADSET" } } }
 *
 * `exact` on purpose: a pinned device that has gone away has to fail loudly,
 * because the quiet fallback to some other microphone is the bug. Unplugging it
 * measured pip "Mic gone", the toggle in warn, an assertive toast naming the
 * device, and the dialog keeping the option as "Jabra Evolve 65 headset (not
 * connected)" rather than silently reselecting the default.
 *
 * Output is ours, so it goes through setSinkId directly: pinning measured
 * sinkId "OUT-HDMI" and it was re-applied on the next load.
 */
test("the microphone and the speaker are pinned to a device, not to the system default", () => {
    // Both halves persist, and the label rides along so an UNPLUGGED device —
    // which is not in enumerateDevices at all — can still be named.
    assert.match(js, /var MIC_DEVICE_KEY = "pikvm-console-mic-device";/);
    assert.match(js, /var OUT_DEVICE_KEY = "pikvm-console-speaker-device";/);
    assert.match(js, /if \(choice\.id\) localStorage\.setItem\(key, JSON\.stringify\(choice\)\);/);

    // The constraint the choice becomes, and the wrap that gets it to the
    // capture janus.js opens.
    assert.match(js, /return micChoice\.id \? \{ audio: \{ deviceId: \{ exact: micChoice\.id \} \} \} : \{ audio: true \};/);
    assert.match(js, /merged\.deviceId = \{ exact: micChoice\.id \};/);
    /* The device reaches the capture through the wrapper that owns it, NOT by
       patching a browser API. The first version of this monkey-patched
       navigator.mediaDevices.getUserMedia, because webrtc.js hardcoded `capture`
       as a boolean and there was no other shared point; that reached every
       caller on the page to influence one of them. */
    const webrtc = readFileSync(resolve(root, "src/views/webrtc.js"), "utf8");
    assert.match(webrtc, /setMicDevice: function \(deviceId\) \{/);
    assert.match(webrtc, /capture: allowMic\s*\n\s*\? micDeviceId\s*\n\s*\? \{ deviceId: \{ exact: micDeviceId \} \}\s*\n\s*: true\s*\n\s*: false,/);
    assert.match(js, /micDeviceId: micChoice\.id,/);
    assert.match(js, /if \(stream && stream\.setMicDevice\) stream\.setMicDevice\(choice\.id\);/);
    // ...and nothing reassigns getUserMedia any more.
    assert.ok(
        !/mediaDevices\.getUserMedia\s*=/.test(js.replace(/\/\*[\s\S]*?\*\//g, "")),
        "getUserMedia is being monkey-patched again",
    );
    // The pre-flight pins explicitly, so it fails where the capture would.
    assert.match(js, /\.getUserMedia\(withMicDevice\(micConstraints\(\)\)\)/);

    // A "default"/"communications" entry is an alias for the moving target, not
    // a device, so pinning to one would have been the same drift wearing a name.
    assert.match(js, /var DEVICE_ALIASES = \["default", "communications"\];/);
    assert.match(js, /if \(DEVICE_ALIASES\.indexOf\(d\.deviceId\) >= 0\) continue;/);

    // The list follows the hardware, and a device that has gone is REPORTED.
    assert.match(js, /md\.addEventListener\("devicechange", function \(\) \{\s*\n\s*refreshAudioDevices\(true\);/);
    assert.match(js, /lost\.textContent = \(choice\.label \|\| "The device you chose"\) \+ " \(not connected\)";/);
    assert.match(js, /if \(micGone !== micWasGone\) paintToggle\(micBtn, micPip, micOn, micGone, micGone \? "Mic gone" : ""\);/);
    // Unplugged is not denied, and saying so sends people to the right place.
    assert.match(js, /var gone = name === "OverconstrainedError" \|\| name === "NotFoundError" \|\| name === "DevicesNotFoundError";/);

    // A change while the mic is running re-runs the capture rather than waiting
    // for the next toggle.
    /* Superseded: the restart is setMicDevice's job now, since it is the wrapper
       that knows whether a capture is live and what it was capturing from. */
    assert.match(webrtc, /if \(allowMic && \(janus \|\| handle\)\) restart\(\);/);
    // Output is this window's <video>, so it is pinned directly.
    assert.match(js, /vid\.setSinkId\(want\)/);

    // Every control is labelled, and the dialog is built like its neighbours.
    assert.match(html, /<label class="dlg-label" for="ad-mic">Microphone<\/label>/);
    assert.match(html, /<select id="ad-mic" class="dlg-select dlg-grow"><\/select>/);
    assert.match(html, /<label class="dlg-label" for="ad-out">Audio output<\/label>/);
    assert.match(html, /<select id="ad-out" class="dlg-select dlg-grow"><\/select>/);
    assert.match(html, /id="audio-dlg"[\s\S]*?aria-labelledby="audio-dlg-title"/);
    // The desktop replaces the HTML ⋯ menu wholesale, so an entry only added
    // there is unreachable in the packaged app.
    assert.match(html, /<button class="more-item" id="audio-dev-btn" hidden>Audio devices…<\/button>/);
    assert.match(js, /items\.push\(\{ id: "audio-devices", label: "Audio devices…" \}\);/);
    assert.match(js, /if \(id === "audio-devices"\) \{\s*\n\s*openAudioDialog\(\);/);

    // The unpinned pre-flight is back if the mic toggle stops naming a device.
    // Comments first: the ones above it quote the very call being ruled out.
    const bare = js.replace(/\/\*[\s\S]*?\*\//g, "");
    const toggle = bare.slice(bare.indexOf("if (micBtn) {"), bare.indexOf("var MIC_DEVICE_KEY"));
    assert.ok(!/getUserMedia\(\{ audio: true \}\)/.test(toggle), "the mic toggle is pre-flighting an unpinned device again");
});

/**
 * A collapsed preview kept streaming a picture with no width.
 *
 * Collapsing takes the pane off screen but left the MJPEG connection open
 * behind it — 3.97 MB over six seconds for a pane nobody can see. The full UI
 * already refuses to stream behind an opaque frame for the same reason; a
 * zero-width pane is the same situation reached a different way.
 *
 * The reason this sat unfixed is that it looked like a three-way conflict:
 * screen-change alerts SAMPLE this stream, so stopping it would have made the
 * "pulse the taskbar when the screen changes" checkbox a lie. It is not a
 * conflict, because alerts only ever fire when the desktop window is in the
 * BACKGROUND — which is exactly when nobody can see the pane anyway.
 * watchingForChange() is already that condition, so the rule is one predicate:
 *
 *     stop the stream when the picture is not on screen
 *     AND nothing is watching it for changes
 *
 * Focus is half of that condition, so it has to be re-evaluated on focus as
 * well as on collapse. Measured over CDP at 1300x800 with the desktop shim:
 *
 *     expanded          OPEN
 *     collapsed         closed
 *     collapsed + blur  OPEN      <- alerts can fire, so the stream is needed
 *     collapsed + focus closed
 *     expanded again    OPEN
 */
test("a collapsed preview stops streaming unless alerts are watching", () => {
    // One predicate for both ways the picture can be off screen.
    assert.match(js, /function pictureHidden\(\) \{\s*\n\s*return !!fullUiOn \|\| app\.classList\.contains\("computer-collapsed"\);/);
    assert.match(js, /if \(pictureHidden\(\) && !watchingForChange\(\)\) return;/);
    // Applied in both directions, not just on the way down.
    assert.match(js, /function applyStreamNeed\(\) \{[\s\S]*?if \(img\.getAttribute\("src"\)\) img\.removeAttribute\("src"\);[\s\S]*?if \(!img\.getAttribute\("src"\)\) loadStream\(\);/);
    // Collapse changes the answer...
    assert.match(js, /app\.classList\.toggle\("computer-collapsed", !show\);\s*\n\s*\/\/ The picture just appeared or disappeared; the stream follows\.\s*\n\s*applyStreamNeed\(\);/);
    // ...and so does focus, because it is half of watchingForChange().
    assert.match(js, /windowFocused = focused;[\s\S]{0,260}?applyStreamNeed\(\);/);
});

/**
 * The audio dialog's live region read its own help text out as news.
 *
 * One <p role="status" aria-live="polite"> carried four different kinds of
 * message: a pinned device having vanished, two standing facts about the
 * browser's capabilities, a hint about device labels, and — as the fallback
 * when none of those applied — a thirty-word paragraph explaining what the
 * dialog is for.
 *
 * So unplugging a pinned headset and plugging it back in announced the warning
 * (right), and then announced the entire explainer (wrong), because to a live
 * region that is simply the text changing again. The standing facts had the
 * same problem in reverse: "this browser will not list audio devices" is true
 * of the browser, not something that just happened, and announcing it beside a
 * device going missing buries the thing that actually changed.
 *
 * Two elements now. #ad-status is live and EMPTY unless something is wrong;
 * #ad-note is standing text with no role at all. That is the split the terminal
 * already uses, whose own comment says its status is "empty while the
 * connection is healthy so there is nothing to read". Measured:
 *
 *     at rest              status ""                          note <explainer>
 *     pinned mic unplugged status "The microphone you chose…"  note ""
 */
test("only what is wrong goes in the audio dialog's live region", () => {
    assert.match(html, /<p class="dlg-note" id="ad-status" role="status" aria-live="polite"><\/p>/);
    // The standing text is NOT a live region.
    assert.match(html, /<p class="dlg-note" id="ad-note"><\/p>/);
    // Wrong goes to the live one...
    assert.match(js, /var wrong = \[\];\s*\n\s*if \(micGone\) wrong\.push\(goneSentence\("microphone", micChoice\)\);\s*\n\s*if \(outGone\) wrong\.push\(goneSentence\("audio output", outChoice\)\);\s*\n\s*setText\(adStatus, wrong\.join\(" "\)\);/);
    // ...and the explainer only when nothing is wrong, so the two never stack.
    assert.match(js, /else if \(!wrong\.length\) \{\s*\n\s*notes\.push\("Both choices are remembered/);
    assert.match(js, /setText\(adNote, notes\.join\(" "\)\);/);
    // The warn styling follows the live one, since that is what carries a fault.
    assert.match(js, /adStatus\.classList\.toggle\("is-warn", wrong\.length > 0\);/);
});

/**
 * The two LOCAL services live on unix sockets, in a directory the app makes
 * 0700. The control server does NOT: it binds 0.0.0.0 on purpose so a phone on
 * the LAN can load the console from it, and there is no address a browser can
 * put in its address bar that reaches a socket.
 *
 * Measured on a real start (`npx electron dist --user-data-dir=/tmp/pkvm-udd`):
 *
 *     PiKVM backend listening on http://127.0.0.1:25692 (… daemon
 *         unix:/tmp/pkvm-udd/run/daemon.sock)
 *     [daemon]  starting: …/pikvm-agent daemon --uds /tmp/pkvm-udd/run/daemon.sock
 *     [harness] starting: …/pikvm-agent harness serve --config … --uds
 *                         /tmp/pkvm-udd/run/harness.sock
 *
 *     ss -lx   u_str LISTEN 2048 /tmp/pkvm-udd/run/daemon.sock
 *              u_str LISTEN 2048 /tmp/pkvm-udd/run/harness.sock
 *     stat     drwx------ 700 /tmp/pkvm-udd/run
 *              srw-rw-rw- 666 /tmp/pkvm-udd/run/{daemon,harness}.sock
 *
 *     GET :25692/app/harness/api/runs?limit=1  ->  200
 *     GET :25692/app/daemon/healthz            ->  200
 *
 * The sockets themselves are world read/write and that is not an oversight:
 * uvicorn chmods a uds to 0666 AFTER binding it, so the directory is the only
 * boundary available and the bearer tokens remain the real check.
 */
test("the two local services get sockets in a 0700 directory, the control server keeps its port", () => {
    assert.match(main, /const LOCAL_SOCKETS_SUPPORTED = process\.platform !== "win32";/);
    assert.match(main, /mkdirSync\(directory, \{ recursive: true, mode: 0o700 \}\);/);
    assert.match(main, /if \(process\.platform !== "win32"\) chmodSync\(directory, 0o700\);/);
    assert.match(main, /const daemonSocket = socketDirectory && socketEndpoint\(socketDirectory, "daemon\.sock"\);/);
    assert.match(main, /const harnessSocket = socketDirectory && socketEndpoint\(socketDirectory, "harness\.sock"\);/);
    // sun_path holds 108 bytes. The first real run of this used a settings
    // directory 118 bytes deep, silently went back to ports, and looked exactly
    // like the socket work not having landed — hence the log line.
    assert.match(main, /if \(Buffer\.byteLength\(path\) > 100\) \{/);
    assert.match(main, /too long for a unix socket — using a port instead/);
    // The control server is untouched: still a port, still the bind host.
    assert.match(main, /CONTROL_PORT,\s*\n\s*bindHost,/);
    // Comments first, or this file's own prose about sockets trips it.
    const source = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.equal(/socketEndpoint\([^)]*control/i.test(source), false);
    // The scheme is never hand-spliced; one place builds it, so one place
    // decides what an endpoint string looks like.
    assert.equal(source.includes('"unix:'), false);
});
