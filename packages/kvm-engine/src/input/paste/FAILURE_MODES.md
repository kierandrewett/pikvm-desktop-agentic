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
