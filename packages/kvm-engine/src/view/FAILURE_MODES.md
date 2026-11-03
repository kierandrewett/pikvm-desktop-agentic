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

The lens is a precision aid whose zoom is tied directly to how fast the finger moves. There
is no hold time and no distance gate beyond a few pixels. Speed is the finger's px/s,
averaged over ~70 ms (decayed distance / decayed time); zoom is `lensZoomForSpeed`: 5x total at <= 60 px/s,
1x at >= 360 px/s, a smoothstep between. Every constant is the tuning block at the top of
`lens.ts`. The desktop mouse has no lens and is unaffected.

- L1. Zoom is MAX at or under the slow speed, 1 at or over the fast speed, monotonic non-increasing in between, and always within 1..MAX.
- L2. No step anywhere on the curve (flat at both ends, smooth between): it is continuous, so the lens never jumps in zoom.
- L3. The speed average: the first sample IS the speed (averaging it against the 0 of "no data" would show the lens at the start of every swipe); events at the same instant do not spike it; a steady speed reads as itself however unevenly the events arrive (distance and time are decayed together, so a late or bunched event cannot make the zoom jitter); it follows a change of speed within the 70 ms time constant in both directions; a pause is not averaged into the speed of the move that ends it (a gap, and the first move of a gesture, count as at most 50 ms: some browsers hold the first move back until the finger has left its touch slop, and a 15 px jump is not then a flick); the moves are timed by the events\' OWN timestamps, not by when they were handled, because a browser hands a frame\'s worth of moves over together.
- L4. A finger that stops sending moves HOLDS its speed: a swipe that ends with the finger resting must not have the lens creep in afterwards, and a nudge that ends resting keeps its zoom.
- L5. Nothing before the finger has moved: a resting finger or a tap (jitter under LENS_ENGAGE_PX, 4 px, inside the 16 px tap slop) never shows it.
- L6. No delay: the first slow move after engaging shows it on the first frame, at the zoom its speed asks for.
- L7. Fast movement never shows it, from the first event (a single flick event is already past the fast speed).
- L8. Slowing down zooms in and speeding up zooms out, frame by frame without a jump; fast hides it within a few frames and slowing again brings it straight back.
- L9. It opens small (56 px) and eases to 96 px within 160 ms: never shrinks, never overshoots.
- L10. A nudge that ends with the finger resting keeps its zoom (see L4).
- L11. A new touch starts from nothing: the last gesture's lens and speed are dropped, and a first fast move is not averaged against an old slow speed.
- L12. Hysteresis on the lens magnification: it appears at 1.3x and goes only below 1.12x, so a finger hovering on the threshold does not flicker.
- L13. Magnification is max(1, zoom / pictureScale) (the picture's own zoom counts towards the total); where the picture alone is as close as the lens could make it (scale > 5 / 1.3 = 3.85) the lens never shows.
- L14. No lens where the cursor position is a guess (relative mouse), with the socket down, under a dialog, with no picture, before a real frame (< 32 px), or after the linger time (1.4 s after the last touch activity; while a finger rests on the trackpad it keeps lingering).
- L15. At the picture's edge only the part inside the picture is sampled; wholly outside, nothing is.

## cursor.ts (blob and host pointer)

- C1. Dialog open or background window: blob hidden and the host pointer handed back.
- C2. Input socket down: blob hidden and the pointer says not-allowed (the blob must not claim a remote cursor that has stopped).
- C3. Hovering in the letterbox: blob hidden, real pointer returns (no move was sent, so clamping would lie).
- C4. Dragging outside the picture: blob pinned to the edge.
- C5. The trackpad blob only shows for a known (absolute) position; a mouse-owned blob is left alone.
