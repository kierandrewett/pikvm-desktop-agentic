# input/paste: failure modes

Written before the tests (`paste.test.ts`). Numbering continues from `../macros/FAILURE_MODES.md`.

13. **One query shape.** `POST /api/hid/print` takes `limit=0&delay=0.02` and an optional
    URL-encoded `keymap`; paste and macro text steps must build it in one place or they drift.
14. **Hidden cost.** kvmd types the string itself at 20 ms a key and answers when done: 12,000
    characters is over four minutes, and closing the dialog does not stop it. The duration is
    stated for anything of ten seconds or more (never for shorter: noise hides the ones that
    matter), in seconds under 90 and minutes after.
15. **A keymap list read as an array.** kvmd's `hid_keymaps.available` is a MAP of name to
    details; reading it as an array left one option and a disabled select, so the target's real
    layout could not be chosen. Both shapes are accepted, names are sorted, the Pi's default is
    always in the list, one option is shown but not a choice, none hides the control, and the
    option set has a stable identity so a repaint keeps the user's pick.
16. **Success claimed for a failure.** 413 reads "too much text"; any other non-2xx reports its
    status; a rejection reports its message or "network error". Only a 2xx says "Typed".
17. **Paste over a macro.** Refused, naming the macro (Ctrl/Cmd+Enter reaches the sender
    without touching the disabled button, so the guard cannot live in the control alone).
18. **Paste over a paste.** The original allowed a second send while the first was in flight
    (its busy flag was cleared by any input event); that puts two POSTs on the endpoint and kvmd
    types both interleaved. Refused here, deliberately.
19. **Stranded busy flag.** Released on success, HTTP failure and network failure alike.
20. **Stale keymap.** Read at send time, not captured when the dialog opened.
21. **The clipboard is anything.** CRLF, CR and the Unicode line ends are one Enter each (never two); curly quotes,
    dashes, the ellipsis, bullets, PDF ligatures and full-width ASCII are their plain equivalents; spaces of every
    width are a space; zero-width and bidi marks, BOM, soft hyphen, NUL, ESC, DEL, the C1 block and lone surrogates
    vanish; text is put in NFC so a letter plus a combining mark is the one character a keymap knows. kvmd would skip
    what it cannot type without a word, so the engine does it first and can say how many characters went.
22. **Emoji and symbols.** Every character above U+FFFF, and the BMP arrows, math, box, dingbat and private-use
    blocks, have no key: they are left out, counted once per character (a ZWJ family is three, not one), and said in the
    dialog and the notice. Text that is nothing but these sends nothing.
23. **Too much.** More than `MAX_TYPED_CHARS` (100,000, over half an hour at 20 ms a key) once cleaned is refused
    before anything is sent, with how long it would take. The limit counts what is typed, not what was on the clipboard.
24. **Ctrl+C and Ctrl+V on the screen are the target's.** They are sent as keys (the engine's chord path, default
    prevented). Nothing on the screen reads this machine's clipboard; a paste or a drop that reaches the hidden field by
    another road (menu, long press, Shift+Insert) is refused in `beforeinput`, `paste` and `drop`, so the field's diff
    never types it. This machine's clipboard reaches the target through "Type text on the target" and nowhere else.
