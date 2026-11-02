# input/soft-keyboard: failure modes

Written before the tests. `field-mirror.test.ts` covers the pure core; `hidden-field.dom.test.ts`
drives the DOM adapter on a jsdom input wired to a real keyboard and asserts on the wire.

The principle: a phone keyboard does not describe what it types, so the field is the record and
every change is replayed as a diff. Reading events one by one loses keys.

1. **Rewrites.** Dictation correcting a word, a swipe suggestion replacing one, the iOS space-bar
   caret: all arrive as "the value changed". The diff backs up (one Backspace per removed code
   point after the common prefix) and retypes the rest. Comparison is by code point, never UTF-16
   unit.
2. **Backspace on an empty field fires no event** on Gboard. The pad (four zero-width spaces)
   gives it something to delete; deleting a pad character still sends one Backspace; pad
   characters are never typed.
3. **iOS dictation placeholder.** U+FFFC holds the caret while listening; it is stripped before
   diffing so it types nothing and is not retyped when it disappears.
4. **Typographic substitutions.** Smart quotes, en/em dash, ellipsis and NBSP are folded to ASCII
   (`don't` must keep its apostrophe) and deleting one sends as many Backspaces as it typed
   (em dash 2, ellipsis 3).
5. **Characters with no key** (accents, emoji) are never sent, and deleting them sends no
   Backspace (the target never received them).
6. **Newline** becomes Enter (armed modifiers apply) and does not reset the field.
7. **Composition.** Never replace the field value while an IME is composing (it aborts the word);
   `isComposing` input marks composition even without `compositionstart`; `compositionend`
   replays the committed text then settles; blur ends composition and clears.
8. **Settling.** Restore the pad when it was eaten into; start a fresh buffer past 96 characters
   but only at a word boundary (never mid-word). After any reset the next diff starts from the pad.
9. **Blocked.** While a modal or the full PiKVM UI owns the keyboard, input is discarded and the
   field reset, never replayed.
10. **Plain Backspace is left to the field** (no ctrl/alt/meta, nothing armed), so the field stays
    an exact record. It is stopped before the chord handler and does not propagate (no second
    forwarder sends it again). Ctrl+Backspace IS a chord.
11. **Printable keydown on the hidden field** is left alone: beforeinput/input produce the character.
12. **Keys the target took from keydown** (arrows, Tab, Enter, Ctrl+X, any data-key button via
    `sendCode`) move its caret away from the end of the field, so the field starts over.
13. **Enter fallback.** `insertLineBreak`/`insertParagraph` sends Enter once and cancels the event,
    unless keydown just sent that key (Shift+Enter must not be followed by a bare Enter).
14. **Unbind** removes every listener and the caret subscription.
