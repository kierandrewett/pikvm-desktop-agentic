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
- K39. The camera goes to the target as `capture` on the video track and `cam: true` in the Janus `watch`, and only when the Pi's `features` reply says `cam` (PiKVM V3/V4 with `ucamera` and `otg/devices/camera/enabled`). Without that feature the camera button is drawn but disabled with the reason (K53), because a camera the Pi cannot honour would be turned on and go nowhere. The camera is chosen where the microphone and speaker are, remembered under `pikvm-console-camera-device`, and pinned with `exact` like the microphone, so an unplugged camera is named ("Camera gone") and never replaced by another; changing the choice while the camera is on restarts the session. The permission prompt is raised first and its tracks are dropped, so a refusal reads "Denied" and a missing device "No camera". The target decides when the stream starts; turning the camera on only allows it. The exchange with a real Pi needs a PiKVM with `ucamera`; the camera control end to end is run against a fake Janus (`~/.cache/pikvm-e2e/webcam-control/`).

## Recording the session

Code: `recorder/` (recorder.ts, uploader.ts, api.ts). The Recordings page is `../recordings/` (its failure modes are K58 onwards). The wire protocol is `packages/contracts/src/recordings.ts`.

- K40. Only a WebRTC picture has a MediaStream to record. With MJPEG (or before WebRTC has started) the Record button is disabled and its title says why; it never records the `<img>`, and a press that cannot start says so instead of making an empty recording.
- K41. The audio graph never reaches `ctx.destination`. The `<video>` already plays the target's sound, so a second path to the speakers would play everything twice. The graph is target tracks -> a one-channel gain -> merger input 0 (left), microphone -> a one-channel gain -> merger input 1 (right) -> a two-channel `MediaStreamAudioDestinationNode` and nothing else.
- K42. The microphone is optional. If `getUserMedia` is refused or the pinned device is gone, recording goes ahead with a silent right channel and says so once in a notice, rather than refusing to record the target. The pinned device is read with `exact` from the same choice as the live microphone, so a gone headset is named and never replaced.
- K43. The `AudioContext` is made and resumed at the start of the click, before any await: one made after an await may be refused sound, and a suspended context records silence.
- K44. The picture machine adds and removes tracks from a script, which fires no event on a MediaStream. The recorder looks every half second: the target's audio tracks that came or went are re-wired into the left channel, and a video track that has ended or left the stream ends the recording at once (saved up to that point, with a notice), because a MediaRecorder with no video would carry on writing a file that looks recorded.
- K45. Chunks go to the host one at a time, in order, each with `x-pikvm-recording: 1`. A failed chunk (unreachable, 5xx, 408, 429) is tried again with a growing pause while later chunks wait in memory, up to 48 MB; past that the recording stops with a sentence that says the host stayed out of reach, and sends nothing more. Any other 4xx stops it at once with the host's own reason.
- K46. A 409 carries how many chunks the host holds. Holding exactly this one plus one means the answer was lost, not the chunk: it counts as sent and is never stored twice. Holding fewer means the host lost some: the last eight acknowledged chunks are kept for this and sent again from there; if the one wanted is no longer kept, or the host holds MORE than was sent, or the same chunk is refused six times, the recording stops with a sentence rather than uploading a file with a hole in it.
- K47. 507 on create (the disk limit) is shown as the host's own sentence and nothing is recorded; 507 on a chunk stops the recording the same way. A stopped recording is closed with what the host holds (finish with the duration of the last acknowledged chunk), or removed when it holds nothing.
- K48. On `pagehide` the page may be gone before a normal request is sent. The chunks still waiting and the finish go out with `keepalive`, which the browser caps at about 64 KiB for all of a page's requests: what does not fit is lost, and the recorder is idle afterwards (the page may come back from the back/forward cache with no recording running). The host closes an unfinished recording on its own.
- K49. Finish is tried again if its answer is lost; a 409 on finish means it already happened, and the recording's own view is read instead. The duration sent is the real elapsed time, not a count of chunks.
- K50. A browser's MediaRecorder writes a file with no length, and a `<video>` will not seek in one. The player asks for a time far past the end once, which makes it read to the end and learn the length, and puts the position back at 0; transcript lines seek from then on.
- K51. The Recordings page reads the list when it opens and each time it comes to the front, and then only polls (every 3 s) while a recording is being made or transcribed, and stops by itself. A poll that fails keeps the list on screen and says it is stale; a first load that fails shows the error, not an empty list. Delete asks first, with Cancel focused.
- K52. A host that cannot transcribe (no models, no ffmpeg) is said so on the page with its reason; there is no Transcribe button, and playing, searching titles and deleting still work.

## The camera control

Code: `camera.ts` (presets, per-camera prefs, the view every placement reads), `camera-control.tsx` (toggle, menu, sheet row), `camera-panel.tsx` (preview and options), `camera-preview.ts` (the self-view's lifecycle), `janus-stream.ts` (what is sent), `picture-controller.ts` (state, unplug and permission handling).

- K53. The camera control is always drawn, in the toolbar (toggle and arrow), the dock and the sheet, whatever the Pi says, because a button that appears only on a PiKVM V3/V4 with `ucamera` looks to everyone else like a missing feature. When the camera cannot be turned on it is `aria-disabled` (not `disabled`, so a tap still lands and a phone is told why) and its title, pip and the menu's note give the reason, in this order: the page is not secure ("Needs HTTPS": there is no `mediaDevices`), the Pi's `features` reply has no `cam` ("Unavailable on this PiKVM": it needs a V3 or V4 with the `ucamera` package and the OTG camera enabled, with links to the PiKVM handbook and the README), no WebRTC session has answered yet, so the picture is MJPEG or the Pi has not been asked ("Needs WebRTC"; once a session has answered, a restart of the session, which every camera change causes, never blocks the button). A press on a disabled camera sends nothing and says the reason in a notice. The `features` check stays the gate for sending: nothing is captured or offered to a Pi that did not say `cam`, a camera left on from an earlier session is turned off when a new session reports no `cam`, and a camera that is already on can always be turned off. The menu and its preview work in every one of these states, so someone can see their camera before it can be sent anywhere.
- K54. The self-view exists only while the camera menu (or the sheet's unfolded options) is on screen: `getUserMedia` on mount, every track stopped on unmount or when the camera or quality choice changes, and a capture that resolves after the menu closed is stopped as it arrives. It is never opened when the browser lists no camera, or the camera chosen by name is not in the list (asking would raise a permission prompt for nothing); it says so instead. A refusal ("Camera access was refused"), another app holding the camera ("In use"), a missing device, a page that cannot open a camera and any other failure each have their own sentence on the preview and, where asking again can help, a "Try again". Camera names stay empty until a camera has been allowed once, so the list is read again as soon as the preview opens.
- K55. What is sent is a quality preset, a size (360p, 480p or 720p) and a frame rate (30 or 15 fps); 720p at 30 fps is the default, remembered for each camera under `pikvm-console-camera-prefs` with its mirror choice. Nothing above 1280x720 is offered: the PiKVM handbook gives that as the most the USB camera takes (640x480 in its safe mode), and the `features` reply is only a yes or no, so there is no larger limit to read from it. The size and rate are `ideal`, so a camera without the mode gives its nearest, and the menu shows what the browser really opened (the preview's chip, and "Asked for ... ; this camera opened at ..." when they differ) and what the session is ready to send (the track's own settings, read after the answer is made). Mirroring is the preview only: the target always sees the true picture. A changed preset restarts a live camera, the same as a changed device.
- K56. A camera that is on and then goes away is turned off with the reason, not left "sending" a dead track. The session watches the camera track's `ended` event (unplugged, or permission withdrawn) and the page watches `devicechange`; the reason is read, in order, from the Permissions API ("Denied": allow it in the browser's site settings), then the device list ("Camera gone" when a camera chosen by name is missing, "No camera" when none is left), else "Stopped". Turning the camera on again is left to the person: a camera that comes back (or a permission that is allowed again, which the page sees through the permission status `change` event, since it raises no `devicechange`) clears "Camera gone", "No camera" or "Denied" and says so once, but does not switch itself on.
- K57. A session made after a drop (the page came back, the network returned) carries the camera again: it is created wanting what the camera button says, not off. Without that the button said On while nothing was sent.
- K73. Chromium lists no camera at all while the camera permission is blocked, so an empty list can mean two faults. The page reads the Permissions API first: blocked is "Denied" (a warning, not a block: a press asks again, which is how a fixed setting is noticed, and the preview says "Camera access was refused" with Try again), and only an empty list with the permission not blocked is "No camera" (disabled, with the reason, before anything is pressed). A failed press is always shown as a notice as well as a pip, because on a phone nobody hovers a title.

## The Recordings library and search

Code: `../recordings/` (the page: library-view, search-results, watch-view, menu, poster, find, transcript-export) and, on the host, `src/server/recordings/search-index.ts`. The wire protocol is `packages/contracts/src/recordings.ts`. Proof: `~/.cache/pikvm-e2e/recordings-library/e2e.mjs`.

- K58. The search index is a copy, never the truth. It is made again at start when it is missing, of another `user_version`, not a database, or older than a transcript: each recording's `transcript.json` modification time and size are kept in the index and compared, a changed or never-indexed transcript is read again, and rows of recordings that are no longer on disk are dropped. A rebuilt index answers every query exactly as the kept one did.
- K59. A host that cannot open the index (no FTS5, a directory where `index.db` should be, a read-only disk) still starts: recording, playing, renaming and deleting work, `GET /search` is 503 with the reason, and the page says "The search could not be made" with that reason and still lists. Failing to remove a bad `index.db` must not stop the host starting.
- K60. What a person types is only words. Every word is quoted before it reaches FTS5, so `OR`, `NEAR(`, `col:x`, `*`, quotes, parentheses, SQL and control characters are words or nothing, never an operator or a 5xx. Empty, white space, nothing but punctuation, more than 200 characters, a limit outside 1 to 100, a negative offset, a bad date and a speaker over 100 characters are 400 with a sentence. Only the last word is a prefix, and only when the text does not end in a space or a quote, so "monit " does not find "monitoring" but "monit" does.
- K61. A snippet is plain text and ranges, never HTML. The page wraps the ranges in `<mark>` elements it makes itself, and a title or a transcript that says `<img onerror=...>` is drawn as those characters. The marker characters used to find the matches (U+0001, U+0002) are replaced by spaces in anything indexed. Ranges of words separated only by white space (a phrase) are one range, and a long segment is cut around the first match with an ellipsis and ranges that still point at the right words.
- K62. A recording's rows leave the index when it is deleted (one at a time, in bulk, by retention), and its segments leave when it is transcribed again, so a search never finds words of a recording that is gone or whose transcript is being replaced. A transcription that finishes after its recording was deleted indexes nothing: the check and the write are one synchronous step.
- K63. A rename is one line of at most 200 characters (runs of white space, tabs and newlines become one space); `null` or empty is the default name ("Recording, <date>"). It is saved in `meta.json` first and then in the index, so a failed index write is logged and the next start fixes it, never a lost title. In the page, Enter and leaving the field save once (not twice), Escape saves nothing, an unchanged name sends nothing, and a refused save puts the old name back and says why.
- K64. The address is the state: `/recordings?q=&filter=&sort=` and `/recordings/<id>?t=&q=`. The router reads `t=95` and `q=2024` as numbers, so every value is read back through `route-state.ts`. A reload, the back button and a pasted link keep the query, the filter, the sort and the second. The page is kept mounted while another tab is in front: it keeps what it showed, pauses its player, reads the list again when it returns and takes no `/` key while away.
- K65. A link that names a second (`?t=21`) lands there, paused, with that line marked, even in a file with no length (K50: the player learns the length first and only then goes to the second). The match shown first is the one at that second, not just the first one in the transcript. A recording that does not exist (deleted, or past retention) says so and offers the way back, rather than a blank player.
- K66. A thumbnail is the first frame, taken in the browser with a hidden video and a canvas: only once the row is near the screen, two at a time, kept in memory (at most 150) and given up when the recording is deleted. A recording that is still being made, empty, failed, or in a codec this browser cannot decode shows a film-strip icon, never a broken image and never a request per redraw.
- K67. Bulk delete asks first with the count, Cancel focused (Escape cancels); the rows it could not delete stay, and the first reason is said; a recording already gone counts as deleted. Rows that leave the list (the sweep, another tab) leave the selection; Shift extends from the last box; the header box is indeterminate for some.
- K68. `/` puts the cursor in the search box only when nothing that takes text has focus, no dialog or menu is open and the page is in front. Escape empties the box, and on an empty box leaves it. A pause of 250 ms, not each key, puts the text in the address; text typed while an earlier settle is still coming back is never overwritten.
- K69. Menus (row, sort, download) are drawn in a layer of their own placed from the button, open upwards when there is no room below, close on Escape (focus back on the button), Tab, an outside press, a scroll and a resize, move with the arrows, Home and End, skip disabled items, and carry `menuitem` or `menuitemradio` roles. Arrow keys move between the row titles; a title is a real link (Enter, middle click).
- K70. On a narrow page (by the width of the page, not the device) a row is a card; nothing overflows sideways at 390 px; on a coarse pointer buttons and chips are 44 px high and a row has no hover-only pencil (Rename is in its menu). Hover styles apply only on a fine hovering pointer. With reduced motion, the live-recording pulse and the loading shimmer stop.
- K71. The line being played follows playback only while "Follow playback" is on; scrolling the transcript by hand, or moving between matches, turns it off, and pressing a line or the toggle turns it on. Moving between matches seeks the player without starting it. Following also starts when play starts far from the visible lines.
- K72. Copy, .txt, .srt and .vtt are made from the segments in the browser: SubRip uses `,` and WebVTT `.` before the milliseconds, a cue is never empty and never holds a blank line, WebVTT text is escaped (`&`, `<`, `>`, `-->`) and the speaker is a voice tag. A clipboard the browser refuses says so instead of "Copied".
