# View: failure modes

Written before the tests. Each line is something that went wrong in the old console
(or would, if the maths were done twice in two places). The tests in `*.test.ts`
beside this file assert each one as behaviour.

## geometry.ts (letterbox box, fractions, HID units)

- G1. An element with no area (collapsed pane, display:none) divides by zero: there must be no box at all.
- G2. Wrong letterbox axis: a wider element gets side bars, a taller one top and bottom bars, an exact-aspect one none.
- G3. A click in the letterbox is not a KVM point: unclamped, it maps to nothing.
- G4. A held-button drag that leaves the picture is still the same gesture: clamped, it pins to the nearest edge on each axis independently.
- G5. HID range: 0 maps to -32767, 1 to 32767, and nothing ever leaves -32768..32767, whatever the input.
- G6. Client -> HID -> client must round-trip (to the rounding of fracToNorm), or the blob drifts from the target's cursor.
- G7. Before the first frame the intrinsic size is 0: fall back to 16:9 rather than dividing by zero.
- G8. The box under zoom/pan is derived from the transformed element rectangle, so the cursor blob, the lens and the HID coordinates all come from the same box.

## transform.ts (zoom, pan, clamp, follow)

- T1. At scale <= 1 a stale pan (left over from zooming out) must snap back to 0,0.
- T2. The pan bound is the PICTURE, not the element: a letterboxed picture zoomed a little must not show the bars.
- T3. Each axis is decided on its own: where the zoomed picture is still smaller than the pane it is centred, where it is at least as big it covers the pane edge to edge.
- T4. Zoom keeps the anchor point over the same content; scale is clamped to 1..ZMAX; re-asking for the current scale changes nothing (same object back).
- T5. An unmeasured pane (0x0) must not produce NaN or move the view.
- T6. Narrowing the pane while zoomed and panned into a corner strands the picture outside it unless the view is re-clamped against the new size (measured: 3.13x, 800 -> 400).
- T7. Following the trackpad cursor centres it, and stops at the picture's edge instead of dragging background into view.
- T8. Every picture element carries the same CSS transform string, formatted to fixed precision.

## lens.ts (magnifier)

The lens is an aid for precision: it stays out of the way while travelling and appears
only once the finger has shown fine-adjustment intent. Speeds are the existing unit,
finger px per ms, smoothed with a 140 ms time constant. Fast = smoothed >= 0.45 px/ms
(450 px/s) or one event >= 1.2 px/ms (a flick); fine = smoothed < 0.25 px/ms.

- L1. The first speed sample has no previous time: assume one frame (16 ms), never divide by zero; dt is at least 1 ms.
- L2. A finger that stops sends no moves, so the smoothed speed must decay on its own.
- L3. Fast movement never shows the lens, and never grows it: a swipe or a flick (even a single big event the average has not caught up with) keeps it hidden.
- L4. It appears only after ~1 s (1000 ms) of SUSTAINED fine movement: a run of moves each under the fine speed, no gap over 400 ms, and a path no longer than 160 px (a slow glide across the screen is travelling, not adjusting). Before that it is hidden, whatever else is true.
- L5. Any fast move hides it at once and RESTARTS the 1 s timer from scratch; an in-between speed (0.25-0.45) before it has appeared restarts the timer too, but once it is up it does not flicker out.
- L6. It starts small (40 px) and grows smoothly (eased, 450 ms) to its full size of 96 px (down from 168): never jumps, never overshoots, never exceeds full size.
- L7. A pause longer than 400 ms before the lens has appeared breaks the run (the finger stopped adjusting); a touch that merely rests, or a tap, never shows it.
- L8. A new touch starts from nothing: a lens lingering from the last gesture is dropped and the dwell restarts.
- L9. After lift it lingers 1.4 s then hides (while a finger rests on the trackpad it keeps lingering). Fast movement during the linger still hides it.
- L10. Magnification is max(1, 5/scale) (the picture's own zoom counts towards the total); under 1.2 (picture zoom >= 4.17x) the lens hides. A smaller lens at 5x still shows ~19 px around the cursor: enough for small targets.
- L11. No lens where the cursor position is a guess (relative mouse), with the socket down, under a dialog, with no picture, before a real frame (< 32 px), or after the linger time.
- L12. At the picture's edge only the part inside the picture is sampled; wholly outside, nothing is.

## cursor.ts (blob and host pointer)

- C1. Dialog open or background window: blob hidden and the host pointer handed back.
- C2. Input socket down: blob hidden and the pointer says not-allowed (the blob must not claim a remote cursor that has stopped).
- C3. Hovering in the letterbox: blob hidden, real pointer returns (no move was sent, so clamping would lie).
- C4. Dragging outside the picture: blob pinned to the edge.
- C5. The trackpad blob only shows for a known (absolute) position; a mouse-owned blob is left alone.
