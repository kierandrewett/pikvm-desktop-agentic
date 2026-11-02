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

- L1. The first speed sample has no previous time: assume one frame (16 ms), never divide by zero; dt is at least 1 ms.
- L2. A finger that stops sends no moves, so the speed must decay on its own.
- L3. Size runs 168 px (slow) down to 64 px (fast) monotonically and never outside that range.
- L4. Jitter must not pulse the size: a candidate within 18 px of the target is ignored, a new one must hold 160 ms, and a candidate that moves resets the wait.
- L5. Easing converges on the target and snaps once within half a pixel.
- L6. Magnification is max(1, 4/scale); under 1.2 (picture zoom >= 3.34x) the lens hides.
- L7. No lens where the cursor position is a guess (relative mouse), with the socket down, under a dialog, with no picture, before a real frame (< 32 px), or after the linger time.
- L8. At the picture's edge only the part inside the picture is sampled; wholly outside, nothing is.

## cursor.ts (blob and host pointer)

- C1. Dialog open or background window: blob hidden and the host pointer handed back.
- C2. Input socket down: blob hidden and the pointer says not-allowed (the blob must not claim a remote cursor that has stopped).
- C3. Hovering in the letterbox: blob hidden, real pointer returns (no move was sent, so clamping would lie).
- C4. Dragging outside the picture: blob pinned to the edge.
- C5. The trackpad blob only shows for a known (absolute) position; a mouse-owned blob is left alone.
