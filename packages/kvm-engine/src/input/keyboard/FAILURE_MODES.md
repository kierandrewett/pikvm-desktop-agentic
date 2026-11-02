# input/keyboard: failure modes

Written before the tests. Test files: `key-chord.test.ts`, `char-map.test.ts`,
`key-queue.test.ts`, `keyboard.test.ts` (the facade the UI drives).

## Decisions (`key-chord.ts`)

1. **A dropped modifier is a different keystroke.** Shift+Enter must not arrive as Enter
   (sends the message instead of breaking the line); Ctrl+Shift+Esc must not decay into
   Ctrl+Esc (Start menu instead of Task Manager). Every control key, function key and
   hardware chord carries every held modifier; Shift is resolved in one place.
2. **Doubled modifiers stick.** An armed Shift plus a held Shift (or a physical ShiftRight
   plus a synthetic ShiftLeft) must press one key once, or it stays down on the target.
3. **Bare modifiers, IME and Caps Lock.** A bare modifier is never sent as its own chord (it
   rides the chord, and is held separately for Ctrl+click); an IME composition is never sent;
   Caps Lock is forwarded bare even with modifiers held; a soft keyboard reporting no `code`
   still resolves a named key; a hardware chord with no code is ignored, not sent as nothing.
4. **Lookup tables with prototype keys.** A key literally named `constructor` or `toString`
   must not be mistaken for a control key (the JS original used a plain object).
5. **Characters with no key.** `charToKey` returns null outside the US/UK maps; the keyboard
   drops them without consuming armed modifiers (they are pasted instead).

## Scheduling (`key-queue.ts`)

6. **Keystrokes the target never sees.** A press whose down and up land between two target
   polls vanishes: 22 ms hold, 4 ms gap. Modifiers get their own settled report 6 ms before the
   key, or BIOS/UEFI/KVM switches apply the key without them.
7. **Interleaving.** Chords play strictly one at a time; modifiers of chord N+1 never go down
   before chord N has fully released. Modifiers come up after the key, in reverse order.
8. **Case decided too early.** A letter's Shift is chosen when the chord PLAYS, against the
   target's Caps Lock then, so a Caps toggle queued ahead of it is already counted ("Hello"
   must not become "hELLO"). Unknown Caps is treated as off. Letters with Shift already present
   are left alone; non-letters ignore Caps.
9. **Caps toggle bookkeeping.** `noteCapsToggle` is called when the CapsLock chord plays, not
   when it is queued.
10. **Releasing a key the user is holding.** A modifier the host is holding is already down on
    the target: the chord neither presses nor releases it (that is what broke Ctrl+click).
11. **Chord-after problems.** `afterKeys` must fire after the LAST release, never from
    `chord()` returning (a macro's next step otherwise starts with modifiers still down); it
    fires on the next tick when idle; a throwing waiter must not strand the others; a runaway
    producer is capped at 600 (oldest dropped).

## Host events (`keyboard.ts`, `dedupe.ts`, `host-caps.ts`)

12. **Double fire.** keydown plus the beforeinput fallback for one press: same code AND same
    modifiers within 60 ms is one press; Shift+Enter straight after Enter is NOT a double;
    typed characters carry no dedupe (fast "aaa" all land); auto-repeat is throttled to the
    queue drain rate (admit only while fewer than 2 chords wait).
13. **Stuck modifiers.** Holding a modifier on the host presses it once however often it
    auto-repeats; keyup releases it exactly once; a release that arrives while its keys are
    still queued waits until they have gone out (Win+Shift+S must not become Win, Shift, S);
    a deferred release is cancelled if the key was pressed again meanwhile; `releaseAll`
    lets go of everything (focus loss, modal).
14. **Host Caps sync overreach.** A soft keyboard reports Caps false always, so only evidence
    from real-keyboard events counts: physical `code`, not keyCode 229, not `Unidentified`,
    not composing, with `getModifierState`. Act on a CHANGE, or a first reading that is ON. Never
    while the LED is unknown or a toggle is pending.
15. **The Caps key's own events lie by platform.** The key is forwarded bare; after 1.4 s, once
    the LED has answered, host and target are compared and one more press fixes a mismatch
    (also covers macOS's lone keyup when turning Caps off). A second event restarts the timer.
16. **Reconcile while pending** is skipped (a toggle in flight would be undone).

## Sticky modifiers (`armed-modifiers.ts`)

17. **Lock semantics.** Arm; a second tap within 350 ms locks; a slow second tap disarms; a tap
    on a locked one unlocks; a key or click clears every armed modifier except locked ones.
    The first tap at clock time 0 must not count as "tapped just before".
18. **Clicks.** Armed modifiers wrap a mouse action and are released in reverse; one the host
    is holding is left alone.

## Soft-keyboard coupling

19. **Caret moved.** Any bare key or shortcut sent through `sendCode` / `sendShortcut` tells
    the field mirror to start over (`onCaretMoved`); typed characters do not.
20. **Plain Backspace** (no ctrl/alt/meta held, none armed) is detectable so the adapter can
    leave it to the field.
