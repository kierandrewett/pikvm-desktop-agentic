# input/macros: failure modes

Written before the tests (`runner.test.ts`, `catalog.test.ts`). Shares the one-at-a-time gate
(`../typing-gate.ts`) with paste.

## Running (`runner.ts`)

1. **The next step starts too early.** A chord is played out of a queue over several timeouts;
   advancing when `sendChord` returns started the next step with the modifiers still down, so
   "Ctrl+Alt+Delete, then type hi" arrived as Ctrl+Alt+h, Ctrl+Alt+i. Chord steps wait for
   `afterKeys`, i.e. the last release.
2. **A failed step carries on.** A 4xx/5xx from `/api/hid/print` RESOLVES, so checking only the
   rejection let a 500 end in a positive "sent" for text that was never typed. Any non-2xx (413
   worded separately) or rejection stops the run, says how many later steps were not sent
   (singular and plural, no suffix when none remain), and never toasts "sent".
3. **Stranded gate.** Every ending (sent, stopped on 413/500/network) releases the target, or
   macros stay disabled for good.
4. **Two runs at once.** Three clicks 120 ms apart on a macro with a pause gave CAD CAD CAD,
   then all the typing: the pause was honoured once and the password typed into whatever the
   other runs left. A second macro is refused, naming the one running.
5. **Macro during a paste** puts a second POST on `/api/hid/print`; kvmd types both
   interleaved. Refused.
6. **Reporting success with an empty wire.** Chord steps go over the HID socket, which the run
   cannot notice dying afterwards (the queue plays from a timer regardless). A macro with key
   steps is refused up front when the socket is down, with a notice; a text-only macro still runs
   (print is HTTP). A refused run must not claim the target.
7. **Layout drift between paste and macro.** Text steps use the same keymap as the paste
   control, read at the moment each step is sent.
8. **Odd data.** An unknown step type is skipped, an empty macro is "sent", a missing chord
   `mods` means none, a non-numeric delay is 0, `null` is refused.
9. **Silent long runs.** A run estimated at 2 s or more shows a sticky "Running ... about N s"
   notice; a quick one says nothing until "sent" (a notice that flickers is not information).

## Catalog (`catalog.ts`)

10. **The editor offers a key the server rejects.** The picker is a hand-written list and the
    validator a regex; an offered code that fails it drops the step, and a macro left with no
    steps is dropped whole, silently deleting the user's macro. Every offered key and modifier
    must match the server's shape, with no duplicate codes, covering a full keyboard (F13-F24,
    numpad); AltGr is offered separately from Alt.
11. **Unrecognised icon.** A non-empty but undrawable icon name must fall back to the label's
    initials; one or two characters (including emoji) is a glyph someone meant.
12. **Estimates.** Chords cost a flat 120 ms, text the paste rate, delays as given; junk adds 0.
    "Needs input" only when a chord step exists.
