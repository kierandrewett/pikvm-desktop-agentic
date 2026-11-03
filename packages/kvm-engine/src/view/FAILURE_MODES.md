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

The lens is deliberately plain: one fixed size (96 px) and one fixed zoom (3x total, the picture's own zoom
counted), a short fade, nothing inside it but the magnified picture and the cursor point. It is on while one
finger is down on the trackpad and moving slowly, off when the finger speeds up or lifts. Speed decides only
that. Every number is in the tuning block at the top of `lens.ts`. The desktop mouse has no lens.

- L1. The finger's speed (px/s, averaged over ~70 ms as decayed distance / decayed time, from the events' OWN timestamps) is the same however unevenly the events arrive: the first move is the speed itself (counted as 50 ms), events at the same instant do not spike it, a steady speed reads as itself, it follows a change within the time constant in both directions, and a pause (a gap counts as at most 50 ms) is not averaged into the move that ends it. A browser hands a frame's worth of moves over together, so timing by when they are handled made it jump.
- L2. One threshold to show (300 px/s) and a higher one to hide (420 px/s).
- L3. Nothing before the finger has moved: a touch alone, a tap or a hold (jitter under 4 px, inside the 16 px tap slop) and the first move alone show nothing. No wait beyond that: it shows on the second move of a slow finger.
- L4. A fast finger never shows it, from the first move (a flick from standing included); speeding up hides it within a few moves and slowing down brings it back.
- L5. A finger that stops sending moves keeps the decision: a swipe that ends with the finger resting never lets the lens creep in, a nudge that ends resting keeps it.
- L6. Hysteresis: between the two thresholds it stays as it was, so a finger hovering on the threshold does not flicker.
- L7. Magnification is max(1, 3 / pictureScale); where that is under 1.2 (picture zoom over 2.5x) the lens never shows. No size or zoom animation: only a CSS fade.
- L8. Placement is fixed: 24 px above the cursor (its bottom edge 24 px over it, so the finger and hand are clear and the cursor stays in view), following it sideways but held inside the pane. It goes below only where it would not fit above (in a pane too short for either side, on whichever has more room), and comes back above only with 40 px to spare, so it does not hop at the edge.
- L9. Only while exactly ONE finger is down (a lift or a pinch hides it at once, no linger), and never where the cursor position is a guess (relative mouse), with the socket down, under a dialog, with no picture, before a real frame (< 32 px).
- L10. At the picture's edge only the part inside the picture is sampled; wholly outside, nothing is.

## cursor.ts (blob and host pointer)

- C1. Dialog open or background window: blob hidden and the host pointer handed back.
- C2. Input socket down: blob hidden and the pointer says not-allowed (the blob must not claim a remote cursor that has stopped).
- C3. Hovering in the letterbox: blob hidden, real pointer returns (no move was sent, so clamping would lie).
- C4. Dragging outside the picture: blob pinned to the edge.
- C5. The trackpad blob only shows for a known (absolute) position; a mouse-owned blob is left alone.
