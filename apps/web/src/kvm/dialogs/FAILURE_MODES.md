# kvm/dialogs: failure modes

Written before the tests (`*.test.ts(x)` beside the files) and before the components. Each
entry is something the console's dialogs got wrong at some point, or could, and the rule the port
keeps. Models (`model/*.ts`) are pure; the components only wire them to kvmd.

## Shell

1. **A second dialog under the first.** One dialog is open at a time (the seam holds one name).
   An in-dialog confirmation is a layer ABOVE it and takes Escape and Tab first; the dialog under
   it never sees either.
2. **Keys leaking to the target.** Escape, Enter, Tab, letters typed in a field and Ctrl/Cmd+V in a
   dialog must not reach the KVM forwarder (the target would receive them). Key events stop at
   the dialog's own root.
3. **Focus lost.** Focus moves in on open (to the control named, else the first, else the
   panel), Tab wraps inside the panel, and closing returns it to where it was when the dialog
   was opened. A button that disables itself on press does not drop focus to `<body>`.
4. **Backdrop dismissal by a drag.** Only a press that STARTS on the backdrop closes; selecting
   text and releasing outside does not.
5. **A keyboard covering the actions (phone).** The dialog is sized by `--app-height` (the
   visual viewport the shell tracks), actions are sticky at the bottom with the safe area under
   them, and nothing needs a pinch.

## ATX

6. **A stray tap powers the target off.** All three ATX actions ask first, in words that say what
   it costs. The default focus is Cancel; the request is not sent until Confirm.
7. **Double confirm.** Confirm is disabled from the press until the answer, so two taps send one.
8. **Silent failure.** 409 says another client holds the power controls; any other non-2xx says
   its status; a network failure says so. Only a 2xx closes the dialog.

## Paste

9. **Nothing to send.** Paste is disabled for an empty box, while a paste is in flight and while
   a macro runs; Ctrl/Cmd+Enter goes through the same guard (the engine refuses and says why).
10. **A dead keymap picker.** The choice reads kvmd's `available` MAP; one option is shown but
    disabled, none hides the picker; a repaint from a Pi event keeps the user's pick.
11. **Hidden cost.** The count says how long a long paste takes; while it types the dialog says it
    is typing and that closing does not stop it.
12. **Clipboard prefill refused.** Silent: the box is still there to type into.

## Stream settings

13. **Hammering the encoder.** A slider POSTs on release, not on every input; its label is live
    while it drags.
14. **A control that disagrees with the Pi.** A rejected change puts the control back to what the Pi
    has applied; a Pi event never rewrites the control the user is holding.
15. **Rows the Pi cannot honour.** A row shows only if the Pi reports the feature; ranges come from
    its limits. Nothing reportable shows a sentence, not an empty form.
16. **Reset without asking.** Reset stream confirms first.

## System, GPIO and health

17. **"Everything looks fine" before the Pi has said anything.** Said only once something was
    reported; otherwise "Nothing reported from the PiKVM yet."
18. **Input not reaching the Pi** is listed first, as an error, once the socket has settled and is down.
19. **HID attach/detach on a board that says `connected: null`.** An online gadget counts as
    attached; "unknown" only when the Pi says nothing at all; the button is disabled while unknown,
    busy or our own request is in flight.
20. **An unknown GPIO output switching silently.** Every channel asks first except known-harmless
    built-ins (the locator LED); the USB breaker has its own warning. Pulse and switch are guarded
    per channel against double taps.
21. **Offline versus busy.** The row says which; both disable the controls.
22. **ATX LEDs.** Power and drive LEDs are text as well as colour; ATX buttons are absent when the
    Pi reports no wiring.

## Mass storage

23. **"No mass storage" claimed before the first event.** `null` state reads "Checking the drive…".
24. **Changing the drive under a mount.** Image, mode, writable, upload, delete and reset are
    disabled while connected, busy or an upload runs; Mount is also disabled during an upload.
25. **Abort reported as an error.** Aborting an upload is a calm confirmation. A remote download
    shows an indeterminate bar until the Pi reports numbers, then a real one.
26. **Destructive without asking.** Delete image and Reset drive confirm. Closing the dialog does
    not abort an upload.

## Log

27. **Downloading into a closed dialog.** Closing or refreshing aborts the read in flight.
28. **Copying a message.** "Loading…", "(nothing in this window)" and errors are not copyable.
29. **A 1.5 MB layout.** Only the newest 1500 lines render and the count of those dropped is said.

## OCR

30. **Picking forever.** Cancelled pick closes the dialog without a word. No second read while one
    is running.
31. **Copying the "nothing found" sentence.** An empty result shows the sentence and Copy stays off.

## Macros

32. **A new macro deleted by its own save.** A macro or step that would not survive the server's
    validation stays in the local draft while it is being built; only valid parts are PUT; the
    server's reply never replaces the draft mid-edit. Closing drops the drafts.
33. **Two saves racing.** Saves are serialised and coalesced: the last draft wins and an older one
    never lands on top of it.
34. **Failed save loses work.** The draft stays, a toast says it was not saved, the next edit tries again.
35. **Destructive next to harmless.** Delete macro is apart from the add buttons and confirms.
36. **Unreadable chord.** Modifiers are switches that say whether they are on; the step's key list
    keeps a stored code the list does not know.
37. **Reorder losing your place.** Moving a step keeps focus on the moved step's button.
38. **Icon picker as 24 tab stops.** A radiogroup with one tab stop and arrow-key selection; a
    stored icon this build does not know still leaves one tab stop.
39. **Empty name.** Saved as "Macro".
40. **Pinned.** Missing `pinned` counts as pinned, as the toolbar reads it.

## Audio devices

41. **Pinning the moving target.** "default" and "communications" are not offered; a pinned device
    that has gone is named, not silently replaced.
42. **A stream that never hears the change.** Writing a choice also tells the live stream.
