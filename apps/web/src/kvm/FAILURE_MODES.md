# KVM screen: failure modes

What goes wrong in the UI layer, which the engine's own FAILURE_MODES.md files do not cover.
The engine decides (gestures, keys, video, view maths); this layer wires and draws it, so its
bugs are about ownership and timing.

Tests beside the code assert each mode as something a person or the target would observe, never
source text. The end-to-end run (`apps/web/e2e/kvm.e2e.mjs`) covers the same ground against a real
host and the fake kvmd.

## Focus and the soft keyboard

- K1. A tap on any dock button must leave focus on the hidden field, or the system keyboard drops every time a key is used. The press is held off at pointerdown (touch and pen) and at the compatibility mousedown that follows it, and `refocus` gives focus back only if the keyboard was wanted.
- K2. A blur right after a dock tap is that tap passing through, not the user putting the keyboard away; one with no tap in front of it is. Reading focus instead of intent reopened a keyboard the user had just closed.
- K3. The hidden field is uncontrolled. Re-rendering the screen (a toast, a state change) must never reset its value or its caret, or the soft-keyboard diff replays what was already typed.
- K4. Opening the ⋯ sheet puts the keyboard away (the sheet needs the room) and nothing reopens it; closing the sheet by an outside press or Escape leaves the keyboard down.
- K5. A dialog owns the keyboard: what is typed into it must not reach the target, and opening one lets go of every modifier the target is holding.

## Keys

- K6. A modifier tapped on screen is armed (announced as pressed), tapped again quickly is locked (still announced, plus a mark colour alone cannot give), tapped once more is off. The next key consumes an armed one and keeps a locked one.
- K7. The Caps key shows the TARGET's LED, not the last tap: it is `aria-pressed` from the Pi's report, and says so in its title when the Pi has not reported.
- K8. Fn and More are one block at a time. Opening one closes the other, and they never both push the dock past three rows.
- K9. A shortcut key (Ctrl+C, Alt+Tab) goes out as one chord through the engine's queue, with any armed modifier folded in once.

- K21. While the HID socket is down every key in the rows is disabled: a press then goes nowhere, and the offline queue drops anything that old, so offering the key is a promise nobody keeps.

## The sheet and the toolbar

- K10. Touch input and trackpad mouse are stored in this browser under the console's own keys; the second is offered only for the trackpad on a Pi that has a relative output, and shows pending while the Pi has not reported the mode asked for.
- K11. A pinned macro can be started only when nothing else is typing and, for a macro with key steps, the HID socket is open. The button is disabled from the same facts the runner refuses on, so the refusal is visible before the press.
- K12. Speaker and mic exist only while WebRTC carries the picture (MJPEG has no audio). The pressed state follows the audio state, and a failed mic says why on the button.
- K13. The zoom-out button exists only while zoomed in, and pressing it restores the whole picture and hides itself.
- K14. A menu closes on a pick, an outside press and Escape; Escape closes one layer only and returns focus to the button when it was inside.

## Toast and dialogs

- K15. A failure interrupts a screen reader and stays longer than a confirmation; a sticky notice stays until replaced; the text is emptied only after the fade, and not if something newer arrived meanwhile.
- K16. `openDialog(name)` renders whatever is registered under the name; the last registration wins; a name with nothing real behind it still opens a labelled dialog that closes on Escape.
- K17. Paste: nothing to send is not sendable; Ctrl+Enter sends; the dialog closes at once (the paste takes minutes) and the engine's paster refuses while a macro runs.

## Picture, lens and OCR

- K18. The view transform reaches the image, the video and the held frame together, and the zoom state published to the UI is the machine's, not a copy.
- K19. A region picked for OCR is in the picture's own pixels whatever the letterbox or zoom, clipped to the picture, and a tap, a miss or Escape resolve to nothing.
- K20. The link lifecycle is bound once per session: a long stay in the background kicks the socket exactly once, not once per mounted screen.

## Behind another tab

The screen stays mounted for the whole visit (see `app/panes.tsx`), so "mounted" no longer means "in use". `useKvmActive()` says whether it is the tab in front.

- K22. The picture, its stream and the link are never torn down by a tab change: the same `<img>`, the same source, no new socket or stream request, live on return.
- K23. Nothing typed on another tab reaches the target: the hidden field refuses keys, the desktop app's window-level forwarding and host-paste shortcut are off, and the pane is `inert` so no pointer or focus reaches it.
- K24. Changing tab lets go of what the target holds (modifiers) and puts the soft keyboard away, once, from the change itself; the handlers stay bound for the return.
- K25. The pointer machine treats "another tab is in front" like "a dialog is open" (no gestures, no cursor), and a real dialog stays open across the change. No cursor report goes to the agent while hidden.
- K26. The screen wake lock and the document-level handlers (Escape and outside press for menus, the OCR picker's Escape, the Safari pinch guard) follow the tab being in front, not the screen being mounted.

## The shared cursor

- K30. The stream names this page: updates carrying this page's own client id are its own moves coming back, and are never drawn as somebody else's.
- K31. Each update is delivered once and in order (a repeat or a straggler is dropped); a message that is not an update is ignored and the next one still arrives.
- K32. A host that restarted starts its sequence again: after a stream error the next update is taken whatever its number.
- K33. A listener that comes late (the KVM tab mounting after the stream opened) is told the newest position at once; one that leaves while it is being told does not stop the others.
- K34. A hidden page holds no stream and takes a fresh one, which begins with the current position, when it is shown.
- K35. The page's input socket URL carries its client id, so the host can say whose moves are whose.
- K36. The picture draws what it is told: the trackpad blob moves with the cursor, or (mouse, direct touch, a relative trackpad) a distinct marker for somebody else's pointer; the same point of the picture after a resize.
- K37. A page that is moving the pointer is not moved by another client, and nothing it is told is ever sent to the target.

## Audio on a phone

- K38. The picture starts muted, and Safari refuses to unmute it unless the attempt runs inside a real user gesture. A touch counts as one when it is released (`pointerup`, `touchend`, `click`), not when it lands (`pointerdown`), so waiting for the first touch to LAND left an iPhone silent however often it was tapped. The unmute is tried on the first release of a touch, a click or a key press, once, and the waiting stops the moment it has run or is cancelled.
- K39. The camera goes to the target as `capture` on the video track and `cam: true` in the Janus `watch`, and only when the Pi's `features` reply says `cam` (PiKVM V3/V4 with `ucamera` and `otg/devices/camera/enabled`). Without that feature there is no camera button, because a button the Pi cannot honour would turn on a camera that goes nowhere. The camera is chosen where the microphone and speaker are, remembered under `pikvm-console-camera-device`, and pinned with `exact` like the microphone, so an unplugged camera is named ("Camera gone") and never replaced by another; changing the choice while the camera is on restarts the session. The permission prompt is raised first and its tracks are dropped, so a refusal reads "Denied" and a missing device "No camera". The target decides when the stream starts; turning the camera on only allows it. Only the capture constraint is tested; the exchange with the Pi needs a PiKVM with `ucamera`.
