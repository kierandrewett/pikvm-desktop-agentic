# E2E run: copy and paste on the KVM screen (2026-11-05)

Host under test: `node dist/web-server.js` (http://127.0.0.1:8099) in front of `tools/fake-kvmd` (http://127.0.0.1:4510), in headless Chrome through puppeteer-core (key presses are real CDP key events, so Chrome's own paste handling runs). Script: `apps/web/e2e/clipboard.e2e.mjs`; how to run it: `docs/e2e/README.md`.

Ctrl+C and Ctrl+V on the screen are the target's: they arrive as keys and this machine's clipboard is never typed. This machine's clipboard reaches the target only through "Type text on the target", which types what a keyboard can.

| Case | Observed | Result |
| --- | --- | --- |
| the hidden field has the keyboard after a click on the picture | active element is the hidden field: true | pass |
| control: the same Ctrl+V with the paste command DOES paste this machine's clipboard into an ordinary text box | an ordinary input now holds "THIS MACHINES CLIPBOARD"; so a paste that does not reach the page's field was stopped by the page | pass |
| Ctrl+V reaches the target as keys, with the paste command attached; nothing is typed from this machine's clipboard and the hidden field gains nothing | key ControlLeft down, key KeyV down, key KeyV up, key ControlLeft up; typed on the target: 0 requests; hidden field 4 characters before, 4 after | pass |
| Ctrl+C reaches the target as keys, with the copy command attached, and this machine's clipboard is not replaced | key ControlLeft down, key KeyC down, key KeyC up, key ControlLeft up; this machine's clipboard still "THIS MACHINES CLIPBOARD" | pass |
| a paste that comes by another road (Shift+Insert with the paste command, as a menu would) types nothing | typed 0; hidden field 4 characters before, 4 after | pass |
| a clipboard of curly quotes, an em dash, an ellipsis, CRLF, an emoji and a zero-width mark types the plain text, and the dialog says what was adjusted and what was left out | typed "\"Hi\" - it's...\nend"; dialog: "5 characters (curly quotes, long dashes, ligatures and the like) will be typed as their plain equivalents." "1 character the keyboard cannot type (emoji, arrows and the like) will be left out.", "18 characters" | pass |
| plain text, tabs and a trailing newline are typed exactly | typed "echo 'a b' && ls -la\n\tindented line\n" | pass |
| a broken surrogate, a byte order mark, a NUL, an escape and an arrow are gone; the words stay | typed "start  middle  end" | pass |
| a large pile of mixed rubbish types only what a keyboard can: no CR, no zero-width or format characters, no emoji, and the words are all there | 1240 characters typed in one request; "word" appears 34 times; forbidden character present: false | pass |
| a clipboard that is only emoji sends nothing, and the dialog says why | button disabled true; typed 0; dialog says "Nothing in this text can be typed on the target." | pass |
| no page errors | clean | pass |

11 of 11 passed.

## How this run was made

```sh
PUPPETEER_CORE=/home/kieran/dev/sidekick/node_modules CHROME=/usr/bin/google-chrome KVM_WEB=http://127.0.0.1:8099 KVM_FAKE=http://127.0.0.1:4510 \
    node apps/web/e2e/clipboard.e2e.mjs --out docs/e2e
```

- Repository commit: `29723deb` plus uncommitted changes to the tracked files (the host was built from this tree with `yarn workspace @pikvm/web build && yarn build`).
- Browser: Chrome/155.0.8043.0, headless, through puppeteer-core 24.35.0; Node v22.22.2 on linux x64.
- The web host ran with its own empty data directory and home, with `OMP_BIN` pointing at nothing, so no chat agent or user configuration was reachable; the fake kvmd was started fresh and reset at the start of the run.
- Chrome's paste and copy commands were attached to the key events (see the control case), because a bare CDP key press does not run them.
