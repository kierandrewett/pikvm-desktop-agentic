# Pointer: failure modes

Written before the tests. The machine turns pointer events into HID commands; most
of these are bugs the old console already had once. `gestures.test.ts` asserts each
as observable commands (never source text). IDs are referenced from test names.

## Touch gestures (trackpad, absolute Pi)

- P1. A plain tap must be exactly one left click and move nothing: a tap that also moves the cursor lands somewhere the user did not aim.
- P2. Finger wobble up to the touch slop (16 px) is still a tap or a hold; the cursor stays frozen so a long press right-clicks where you aimed.
- P3. Two quick swipes must never press a button: a drag used to start from any touch landing soon after the last tap, so two fast swipes highlighted text. Only a deliberate hold arms a drag.
- P4. Hold still for 450 ms then lift = ONE right click, no left click.
- P5. Hold then move = left button down (once), the cursor drags, lift = left button up and NO click.
- P6. The hold arms at 450 ms, not before; moving past the slop before that cancels the timer for good.
- P7. A cancelled touch (the OS took it for a gesture) must click nothing, whether plain or armed; a cancelled hold-drag still releases the button.
- P8. Two-finger tap (both up within 300 ms, no travel, no pinch/drag decided) = ONE right click. The first finger's release must not also left-click. Slow, or moved, or a pinch whose centre happened not to move = nothing.
- P9. Two fingers decide ONCE between pinch (distance changes > 12 %) and drag (centre moves > 14 px), pinch tested first, and stick to it.
- P10. A pinch never scrolls the target even though no pinch keeps its centre still; a two-finger drag never zooms.
- P11. Two-finger scroll sends one wheel step per 22 px, accumulating the remainder across events, in the finger's direction.
- P12. Pinching zooms around the trackpad cursor on an absolute Pi (and keeps it centred); anywhere the cursor is unknown (direct touch, relative Pi) it zooms under the fingers.
- P13. Zoomed with no known cursor, a two-finger gesture moves the view instead of scrolling the target.
- P14. A third finger is not a gesture: it must not start a new tap that clicks when lifted.
- P15. After a multi-touch gesture, lifting one finger never clicks; the first finger left behind keeps driving the cursor, the second does nothing until lifted.
- P16. A zoomed absolute trackpad follows its cursor; the view stays inside the picture.
- P17. The lens hears every single-finger trackpad move once the finger is more than 4 px from where it touched (before the cursor starts moving at the 16 px slop), with that move's own travel; jitter under 4 px, a direct touch, a two-finger gesture and the mouse send it nothing.

## Relative HID (trackpad pinned to relative)

- R1. Relative travel is the finger's own pixels (REL_SENS 1), whole units sent, the fraction carried to the next move so slow drags still add up.
- R2. kvmd takes at most 127 per report: a fast flick is several reports and the sum is exact.
- R3. A relative Pi that is told absolute moves would ignore them: while the Pi still reports absolute but the trackpad wants relative (and the Pi offers it), moves are HELD as debt, nothing absolute is sent, and the switch is asked for.
- R4. When the Pi reports relative, the debt goes out on the next frame. The debt is bounded (4000) so a switch that never comes cannot bank a screen-crossing jump.
- R5. A Pi with no relative output stays absolute whatever the setting says; nothing is held.
- R6. A relative Pi gets deltas, never absolute moves, even for a mouse-originated flush.

## Direct touch

- D1. A direct tap sends the move THEN the click, at the touch point, once the Pi is absolute.
- D2. Off the picture (letterbox, dark margin of a zoomed view) there is nothing to point at: nothing is sent.
- D3. While the Pi is relative or has not reported its mode, a press would land wherever the cursor already was: steps wait for the absolute report, in order, and the switch is requested.
- D4. Queued taps reach the target as separate clicks, spaced 90 ms apart, never merged or reordered.
- D5. A queued step older than 2.4 s is never sent, and the user is told why (different words for "stayed relative" and "never reported").
- D6. A hold-drag whose finger lifted before the Pi switched must not press afterwards.
- D7. One finger pans a zoomed direct view and sends nothing; unzoomed it moves the pointer, and while a button is held the move is clamped to the picture.
- D8. Drag-lock presses left on touch-down (at the finger, once absolute, in direct mode) and releases on lift; a lift without a move is not also a click.
- D9. A pen points directly even when the touch mode is trackpad.

## Desktop mouse

- M1. Left/middle/right map to HID buttons; the browser's thumb buttons (3, 4) map to nothing: pressing back over the picture must not left-click the target, and their release sends nothing.
- M2. A press in the letterbox is not a KVM click.
- M3. Hover moves are absolute and coalesced to one HID move per frame carrying the latest position.
- M4. A drag that leaves the picture keeps steering, pinned to the nearest edge; a hover outside sends nothing.
- M5. A move reporting `buttons === 0` while a button is held proves the release was lost: release it (and the click modifiers).
- M6. Blur releases held buttons and click modifiers (and touch presses), and sends nothing if nothing is held; modifiers are released in reverse order.
- M7. Click modifiers go down before the button and up after it; a stale set from a lost release is released first.
- M8. While the target shows no live picture a clamped (+/-30) relative nudge accompanies each move so a sleeping target wakes; with a live picture never (the cursor would double). Never from a background window.
- M9. A background desktop window sends no moves.
- M10. Wheel: one step per notch in the notch's direction; Ctrl/Cmd+wheel zooms the local view on the web, and on the desktop wraps the modifier around the wheel for the target.
- M11. A dialog owns the pointer: presses and moves are ignored, and its swallowed release still lets go of whatever the target holds.
- M12. A mouse entering the picture asks the Pi for absolute; the output requests follow the input in use.
- M13. A pane resize while zoomed re-clamps the view.

## The shared cursor (another client moved the pointer)

- S1. An idle client takes the position as its cursor and says it is somebody else's; it sends nothing to the target for it, so no echo can start.
- S2. A client that is moving the pointer (a finger down, a mouse or wheel moving, within the 500 ms hold after) keeps its cursor: the newest position that arrived waits, once, and is taken when it has been still.
- S3. What waited is dropped if this client's own newer move has come back from the host first.
- S4. Two clients moving at once: each follows only its own hand while it moves; the hand-over after is to whoever wrote last.
- S5. Somebody else's pointer is redrawn where it now is when the view or the pane changes, and is gone the moment this client moves it itself.
