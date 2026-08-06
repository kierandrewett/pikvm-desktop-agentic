import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/* The embedded terminal: its tab strip, its notices, and the wire it speaks to
   terminal-server. Split out of desktop-layout.test.ts for the same reason as
   the startup tests - that file had grown to eight subjects, and the terminal
   is its own surface with its own renderer (src/terminal/main.ts) rather than
   part of the console's layout. Each test reads the files it needs locally. */
const root = process.cwd();

test("the terminal says when its socket is down instead of swallowing clicks", () => {
    const term = readFileSync(resolve(root, "src/terminal/main.ts"), "utf8");
    const termHtml = readFileSync(resolve(root, "src/views/terminal.html"), "utf8");
    /* send() drops anything written while the socket is not OPEN, so with the
       terminal service unreachable New shell did exactly nothing: no tab, no
       message, no error, and the reconnect loop ran on unseen. Measured against
       a host with no terminal backend — the websocket opened, failed, and the
       page still read "+" and nothing else.
       Every other surface reports this: the console chip says "Live · input
       offline", the conversation "Updates offline", the pill "Agent
       unavailable". This was the one that stayed quiet. */
    assert.match(termHtml, /<span id="term-status" role="status" aria-live="polite" hidden><\/span>/);
    assert.match(term, /const setLinkUp = \(up: boolean\): void => \{\s*newTabBtn\.disabled = !up;\s*statusEl\.hidden = up;/);
    assert.match(term, /"Terminal disconnected — reconnecting…"/);
    // Both ends of the socket's life drive it, and it starts closed so the
    // button never invites a click it would swallow.
    // Not pinned to the first line of onopen: the reconnect backoff resets
    // there too. What matters is that opening the socket says so.
    assert.match(term, /ws\.onopen = \(\) => \{[\s\S]{0,240}?setLinkUp\(true\);/);
    assert.match(term, /ws\.onclose = \(\) => \{\s*ws = null;\s*setLinkUp\(false\);/);
    // It runs once at module scope, before the first connect, not only inside
    // the two socket handlers.
    const bare = term.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.match(bare, /^setLinkUp\(false\);$/m);
    assert.equal((bare.match(/setLinkUp\(false\);|setLinkUp\(true\);/g) ?? []).length, 3,
        "the initial close, plus one call at each end of the socket's life");
    // Written only when it changes, like every other status string here.
    assert.match(term, /if \(statusEl\.textContent !== text\) statusEl\.textContent = text;/);
    /* Verified live across the whole lifecycle by capturing the frame's sockets:
         connected  status hidden, New shell enabled, 1 socket
         dropped    "Terminal disconnected — reconnecting…", disabled, 3 sockets
         recovered  hidden, enabled again */
});

test("the terminal tab strip can be worked from the keyboard", () => {
    const term = readFileSync(resolve(root, "src/terminal/main.ts"), "utf8");
    const termHtml = readFileSync(resolve(root, "src/views/terminal.html"), "utf8");
    /* The strip was mouse-only. Each tab was a bare <div class="tab"> with a
       mousedown listener and a <span class="close">✕</span>; no role, no
       tabindex, no accessible name. Measured over CDP with six shells open:
       every focusable control in the frame was ["New shell", "Terminal input"],
       so a keyboard user could open shells and then neither switch nor close
       one, and a screen reader heard nothing but the glyph. */
    assert.match(termHtml, /<div id="tablist" role="tablist" aria-label="Terminal sessions"><\/div>/);
    // The tabs get their own container: a tablist may only own tabs, and this
    // strip also carries New shell and the status text.
    assert.match(termHtml, /#tablist \{/);
    assert.match(term, /const tabsEl = document\.getElementById\("tablist"\)!;/);

    assert.match(term, /tab\.setAttribute\("role", "tab"\);/);
    assert.match(term, /tab\.setAttribute\("aria-controls", el\.id\);/);
    assert.match(term, /el\.setAttribute\("role", "tabpanel"\);/);
    assert.match(term, /el\.setAttribute\("aria-labelledby", tab\.id\);/);

    // Roving tabindex, so Tab does not have to walk past every open shell.
    assert.match(term, /v\.tab\.setAttribute\("aria-selected", String\(on\)\);/);
    assert.match(term, /v\.tab\.tabIndex = on \? 0 : -1;/);

    // The close control is a button with a name, not a span holding "✕".
    assert.match(term, /const close = document\.createElement\("button"\);/);
    assert.match(term, /close\.tabIndex = -1;/);
    assert.match(term, /v\.close\.setAttribute\("aria-label", `Close \$\{title\}`\);/);
    // And the state a sighted user reads from colour is said out loud.
    assert.match(term, /v\.exited \? " \(exited\)" : v\.id === controlOwner \? " \(has KVM control\)" : ""/);

    // Arrows/Home/End/Delete on the focused tab.
    for (const key of [/e\.key === "ArrowRight"/, /e\.key === "Home"/, /e\.key === "End"/, /e\.key === "Delete"/]) {
        assert.match(term, key);
    }
    /* Arrowing selects WITHOUT focusing the terminal: xterm swallows arrow
       keys, so focusing it on each step would end the walk at the first press
       and strand the keyboard in whichever shell it landed on. */
    assert.match(term, /setActive\(next\.id, \{ focusTerm: false \}\);\s*next\.tab\.focus\(\);/);
    assert.match(term, /if \(opts\?\.focusTerm !== false\) v\.term\.focus\(\);/);
    // Closing the focused tab must not drop focus to <body>.
    assert.match(term, /const hadFocus = v\.tab\.contains\(document\.activeElement\);/);
    assert.match(term, /const landing = active \? views\.get\(active\)\?\.tab : newTabBtn;/);

    // The focused tab has to be findable, and its close button stops hiding.
    assert.match(termHtml, /\.tab:focus-visible \{/);
    assert.match(termHtml, /\.tab:focus-visible \.close,/);
    /* Driven live over CDP with six shells: focus the selected tab, then
         ArrowRight  shell s6 -> s1 (wraps), aria-selected and panel follow
         ArrowRight  s1 -> s2
         Home        s2 -> s1
         Delete      s1 closed, focus lands on s2, five tabs left
       and :focus-visible matched with a 3px ring on the focused tab. */
});

test("a terminal tab whose shell has exited says so", () => {
    const term = readFileSync(resolve(root, "src/terminal/main.ts"), "utf8");
    const termHtml = readFileSync(resolve(root, "src/views/terminal.html"), "utf8");
    /* paintTabs toggled an "exited" class that no rule ever matched, so a dead
       shell was pixel-identical to a live one: with ten tabs open and three of
       them finished, the only way to find one was to click in and read the last
       line. Its sibling state, the KVM control lease, has had a marker all
       along. */
    assert.match(termHtml, /\.tab\.exited \.dead \{[\s\S]*?display: inline;/);
    assert.match(term, /dead\.textContent = "exited";/);
    assert.match(term, /tab\.append\(label, ctrl, dead, close\);/);
    // The tooltip carries the restart, which is otherwise only discoverable by
    // reading the dead shell's own last line.
    assert.match(term, /dead\.title = "This shell has exited — press Enter in it to restart";/);
    assert.match(term, /dead\.setAttribute\("aria-hidden", "true"\);/);

    /* The word is the cue, not the colour. Dimming the label instead was
       measured at 2.36:1 (light) to 3.62:1 (dark) against the tab it sits on —
       subdued past readable — so the label keeps its full weight and the marker
       does the work. */
    assert.doesNotMatch(termHtml, /\.tab\.exited \.label \{[\s\S]*?opacity/);
    /* Both markers are mixed toward the foreground: the raw tokens are 3.85:1
       (danger) and 3.94:1 (primary) on the light strip, under AA for 10px text.
       Measured after the mix: 4.59 and 4.53 on the strip, 4.69 and 4.63 on the
       active tab. */
    assert.match(termHtml, /\.tab \.ctrl \{\s*color: color-mix\(in srgb, var\(--primary\) 90%, var\(--foreground\)\);/);
    assert.match(termHtml, /\.tab \.dead \{\s*color: color-mix\(in srgb, var\(--danger\) 88%, var\(--foreground\)\);/);
    /* Dashed rather than red-bordered: a shell exiting is ordinary, and a strip
       of red-outlined tabs reads as alarm. */
    assert.match(termHtml, /\.tab\.exited \{\s*border-style: dashed;\s*border-color: color-mix\(in srgb, var\(--foreground\) 22%, var\(--border\)\);/);
    /* Rendered in both themes over CDP with a shell killed on arrival: the live
       tab plain, the lease-holder blue-bordered with CTL, the dead one
       dash-bordered with EXITED, and the accessible names
       "shell s2 (has KVM control)" / "shell s3 (exited)". */
});

test("the terminal is not a keyboard trap, and says how to get out", () => {
    const term = readFileSync(resolve(root, "src/terminal/main.ts"), "utf8");
    const termHtml = readFileSync(resolve(root, "src/views/terminal.html"), "utf8");
    /* xterm sends Tab, Shift+Tab, Escape and F6 to the PTY, so once focus was in
       the terminal nothing moved it out again — measured over CDP, all four left
       activeElement on the helper textarea. WCAG 2.1.2, and now that the tab
       strip hands focus over deliberately it is a trap people reach. */
    assert.match(term, /const bareTab = e\.key === "Tab" && !e\.ctrlKey && !e\.shiftKey && !e\.altKey && !e\.metaKey;/);
    assert.match(term, /if \(bareTab && Date\.now\(\) <= escapeArmedUntil\) \{[\s\S]*?v\.tab\.focus\(\);/);
    /* Escape then Tab, not a chord: every unmodified key belongs to the PTY and
       Ctrl+Shift+Tab is browser-reserved on the web console this file also
       serves. It steals nothing on its own — Escape is still forwarded, and only
       a Tab inside the window after one is taken. */
    assert.match(term, /escapeArmedUntil =\s*e\.key === "Escape"[\s\S]*?Date\.now\(\) \+ ESCAPE_HATCH_MS : 0;/);

    /* WCAG allows a non-standard way out only if the user is told about it, and
       neither audience can guess this one. */
    assert.match(termHtml, /id="term-hatch" class="sr-only">Press Escape then Tab to move focus out of the terminal\.</);
    assert.match(term, /helper\.setAttribute\("aria-describedby", "term-hatch"\);/);
    assert.match(termHtml, /id="term-hint" aria-hidden="true" hidden>Esc then Tab to leave the terminal</);
    // On screen only for whoever needs it: someone who clicked in was never
    // stuck, and standing advice above a shell you are working in is noise.
    assert.match(term, /helper\.addEventListener\("focus", \(\) => showEscapeHint\(cameByKeyboard\)\);/);
    assert.match(term, /document\.addEventListener\("mousedown", \(\) => \{ cameByKeyboard = false; \}, true\);/);
    /* Measured live: entering by Enter on a tab raised the hint and set the
       description, a bare Tab still reached the PTY, Escape alone stayed in,
       Escape then Tab landed on the tab and cleared the hint, and after the
       window lapsed Tab went back to the PTY. */
});

test("the terminal tab strip keeps New shell and its notices on screen", () => {
    const term = readFileSync(resolve(root, "src/terminal/main.ts"), "utf8");
    const termHtml = readFileSync(resolve(root, "src/views/terminal.html"), "utf8");
    /* The strip scrolled as a whole, so everything after the tabs left the
       frame once there were enough shells to overflow. Measured with eleven
       open in a 399px panel: the hint was one letter at the right edge and the
       disconnect notice was past it entirely — a message that only appears when
       something is wrong, arriving where it could not be read. */
    assert.match(termHtml, /#tabs \{[\s\S]*?overflow: hidden;\s*\}/);
    assert.match(termHtml, /#tablist \{[\s\S]*?flex: 0 1 auto;\s*min-width: 0;\s*overflow-x: auto;/);
    // 0 1 auto rather than 1, so New shell still sits just after the last tab
    // when there is room instead of pinning to the right.
    assert.doesNotMatch(termHtml, /#tablist \{[\s\S]*?flex: 1 1 auto;/);

    /* The tabs yield the width, because they scroll and a sentence does not.
       Left to shrink proportionally the hint came out 45px — "Esc…" — beside
       298px of tabs. */
    assert.match(termHtml, /#term-status,\s*#term-hint \{[\s\S]*?flex: 0 0 auto;\s*max-width: calc\(100% - 104px\);/);
    assert.match(termHtml, /#term-status,\s*#term-hint \{[\s\S]*?text-overflow: ellipsis;/);
    assert.match(term, /if \(statusEl\.title !== text\) statusEl\.title = text;/);
    // One row, two messages, and losing the socket outranks advice about focus.
    assert.match(term, /if \(!up\) showEscapeHint\(false\);/);

    /* Anything that resizes the row can push the selected tab out of the
       scrolled region: setActive scrolled it into view and then focused the
       terminal, which raised the hint, which shrank the strip by 178px and put
       the tab back out of sight — twelve shells open, selected tab at 266..355
       against a strip ending at 173. So the reveal runs after each of them, on
       the next frame. */
    assert.match(term, /function revealActiveTab\(\): void \{\s*requestAnimationFrame\(\(\) => \{/);
    assert.match(term, /v\?\.tab\.scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\);/);
    assert.equal((term.match(/revealActiveTab\(\);/g) ?? []).length, 3,
        "setActive, the hint and the disconnect notice all resize the row");
    /* Re-measured after the fix, eighteen shells in a 399px panel: strip
       8..173 scrolled to its end, selected tab 84..173 in view, New shell
       179..209, hint 213..391 in full. */
});

test("the terminal tab strip says when tabs continue past the edge", () => {
    const term = readFileSync(resolve(root, "src/terminal/main.ts"), "utf8");
    const termHtml = readFileSync(resolve(root, "src/views/terminal.html"), "utf8");
    // Same 2px dead zone and the same class names as console.js's paintEdgeFade.
    assert.match(term, /tabsEl\.classList\.toggle\("more-before", max > 2 && tabsEl\.scrollLeft > 2\);/);
    assert.match(term, /tabsEl\.classList\.toggle\("more-after", max > 2 && tabsEl\.scrollLeft < max - 2\);/);
    // Every way the strip can change: the user scrolling it, the window
    // resizing, and tabs opening or closing (neither of the first two fires).
    assert.match(term, /tabsEl\.addEventListener\("scroll", paintTabOverflow, \{ passive: true \}\);/);
    assert.match(term, /window\.addEventListener\("resize", paintTabOverflow\);/);
    assert.match(term, /new ResizeObserver\(paintTabOverflow\)\.observe\(tabsEl\)/);
    // scrollIntoView moves the strip without a scroll event necessarily
    // landing before the frame, so the reveal repaints it itself.
    assert.match(term, /scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\);\s*\n[\s\S]{0,180}?paintTabOverflow\(\);/);
    // Same 32px fade as the drawer and the macro strip in console.css.
    assert.match(termHtml, /#tablist\.more-after \{\s*\n\s*mask-image: linear-gradient\(to right, #000 calc\(100% - 32px\), transparent\);/);
    assert.match(termHtml, /#tablist\.more-before \{\s*\n\s*mask-image: linear-gradient\(to right, transparent, #000 32px\);/);
    assert.match(
        termHtml,
        /#tablist\.more-before\.more-after \{\s*\n\s*mask-image: linear-gradient\(to right, transparent, #000 32px, #000 calc\(100% - 32px\), transparent\);/,
    );
});

test("the shell-exited notice goes in the session buffer, not one client's terminal", () => {
    const server = readFileSync(resolve(root, "src/terminal-server.ts"), "utf8");
    const term = readFileSync(resolve(root, "src/terminal/main.ts"), "utf8");
    // Through the same append+broadcast the PTY's own output uses, so it lands
    // in the scrollback in the right place and survives a reconnect.
    assert.match(server, /const notice = `\\r\\n\\x1b\[90m\[Shell exited \(code \$\{info\.code\}\) - press Enter to restart\]\\x1b\[0m\\r\\n`;/);
    assert.match(server, /this\.append\(s, notice\);\s*\n\s*this\.broadcast\(\{ t: "data", id, data: notice \}\);/);
    // Appended BEFORE the exit is announced, so the text is in the buffer by the
    // time any client reacts to the state change.
    const onExit = server.slice(server.indexOf("term.onExit((info) => {"));
    assert.ok(
        onExit.indexOf("this.append(s, notice)") < onExit.indexOf('this.broadcast({ t: "exit"'),
        "the notice must be buffered before the exit is broadcast",
    );
    // And the client no longer writes its own, or it would print twice.
    const exitCase = term.slice(term.indexOf('case "exit": {'), term.indexOf('case "image": {'));
    assert.ok(!/term\.write\(/.test(exitCase), "the client is writing the notice again — it will double up");
    assert.match(exitCase, /v\.exited = true;\s*\n\s*paintTabs\(\);/);
});

