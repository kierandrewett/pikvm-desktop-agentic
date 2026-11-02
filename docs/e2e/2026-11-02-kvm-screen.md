# E2E run: the native KVM screen (2026-11-02)

Host under test: `node dist/web-server.js` (http://127.0.0.1:8099) in front of `tools/fake-kvmd` (http://127.0.0.1:4510).

Browser: headless Chrome through puppeteer-core. Profiles: iPhone 13 (390x844, touch, coarse pointer) and desktop 1400x900. Script: `apps/web/e2e/kvm.e2e.mjs`; how to run it: `docs/e2e/README.md`.

Every case drives the page the way a person would and asserts what the fake kvmd RECEIVED, so a pass means the target would have seen it.

Touch is sent as raw CDP touch events, two fingers included. The fake has no Janus, so the picture is MJPEG: WebRTC and the audio buttons that depend on it are covered by component tests, not here.

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| iPhone 13 | resolution toast names the picture and its source | "320 × 180  ·  MJPEG" | pass |
| iPhone 13 | touch dock layout | pointer:coarse true; dock true | pass |
| iPhone 13 | tap = one left click, no move | button left down, button left up | pass |
| iPhone 13 | hold, then drag = left held, cursor moves, released, no right click | hold cue true; 9 events: button left down ... button left up | pass |
| iPhone 13 | hold, then lift = one right click | button right down, button right up | pass |
| iPhone 13 | two-finger tap = right click | button right down, button right up | pass |
| iPhone 13 | two-finger drag scrolls the target, no clicks, no zoom | 4 wheel steps (wheel 0,1), no buttons, picture scale 1 | pass |
| iPhone 13 | pinch zooms the picture; the zoom-out button restores it | scale 4.20, zoom-out button true, restored true (translate(0px, 0px) scale(1)), hidden after true, 0 HID events | pass |
| iPhone 13 | keyboard button focuses the hidden field | focused true | pass |
| iPhone 13 | typing Hi | key ShiftLeft down, key KeyH down, key KeyH up, key ShiftLeft up, key KeyI down, key KeyI up | pass |
| iPhone 13 | soft-keyboard diff typing: insert, then the keyboard rewrites a word | target text "hello world" after 3 Backspaces | pass |
| iPhone 13 | Ctrl tap, then c | key ControlLeft down, key KeyC down, key KeyC up, key ControlLeft up; armed true, cleared false, keyboard kept true | pass |
| iPhone 13 | Win + Shift + S chord | key MetaLeft down, key ShiftLeft down, key KeyS down, key KeyS up, key ShiftLeft up, key MetaLeft up; still held on target: 0 | pass |
| iPhone 13 | Caps key toggles the fake LED and lights | LED true, key true/true; then LED false, key false/false | pass |
| iPhone 13 | Fn and More rows open one at a time | F-keys 12, F1 after opening More 0, shortcut keys 13 | pass |
| iPhone 13 | alt+tab shortcut key sends the chord | key AltLeft down, key Tab down, key Tab up, key AltLeft up | pass |
| iPhone 13 | macro tile in the ⋯ sheet runs on the target | key MetaLeft down, key KeyR down, key KeyR up, key MetaLeft up; typed "calc"; 3 separators in the sheet | pass |
| iPhone 13 | touch (direct) mode: a tap points at the finger, then clicks | move 10082,-11949, button left down, button left up | pass |
| iPhone 13 | trackpad pinned to relative: the Pi is switched, then the drag goes out as relative moves | Pi switched true (absolute false); 10 relative moves, 75 px right, no absolute moves | pass |
| iPhone 13 | trackpad back to absolute: the Pi is switched back by the first touch | absolute true | pass |
| iPhone 13 | socket drop recovers, input works again | offline seen, recovered in 1216 ms, then button left down, button left up | pass |
| iPhone 13 | no page errors | clean | pass |
| desktop 1400x900 | resolution toast names the picture and its source | "320 × 180  ·  MJPEG" | pass |
| desktop 1400x900 | picture fills the area, letterbox-correct | pane 1336x862, picture 320x180 object-fit contain | pass |
| desktop 1400x900 | click on the picture = move, then left down and up | move 0,0, button left down, button left up | pass |
| desktop 1400x900 | hover moves absolutely, one per frame | 5 moves, last move 4905,4360 | pass |
| desktop 1400x900 | wheel scrolls the target; Ctrl+wheel zooms the picture (web only) | plain wheel wheel 0,1; Ctrl+wheel scale 1.21, wheel events sent 0 | pass |
| desktop 1400x900 | click focuses the hardware keyboard; typing Hi | focused true; key ShiftLeft down, key KeyH down, key KeyH up, key ShiftLeft up, key KeyI down, key KeyI up | pass |
| desktop 1400x900 | Ctrl + C from a real keyboard | key ControlLeft down, key KeyC down, key KeyC up, key ControlLeft up | pass |
| desktop 1400x900 | Win + Shift + S from a real keyboard | key MetaLeft down, key ShiftLeft down, key KeyS down, key KeyS up, key ShiftLeft up, key MetaLeft up; held after: 0 | pass |
| desktop 1400x900 | the CapsLock key is forwarded and flips the fake LED | key CapsLock down, key CapsLock up; LED true | pass |
| desktop 1400x900 | the on-screen Caps key (toolbar strip) toggles the LED and lights | was false; LED true, key true; then LED false, key false | pass |
| desktop 1400x900 | pinned macro in the toolbar runs on the target | key MetaLeft down, key KeyR down, key KeyR up, key MetaLeft up; typed "calc" | pass |
| desktop 1400x900 | Send keys menu: shortcut goes out | key ControlLeft down, key AltLeft down, key Delete down, key Delete up, key AltLeft up, key ControlLeft up | pass |
| desktop 1400x900 | More menu: full screen with Keyboard Lock is offered | Paste text to the target… \| Stream settings… \| Save screenshot \| System, GPIO & health… \| Mass storage… \| Read text from the screen… \| PiKVM log… \| Macros… \| Full screen (send Win and Alt keys) \| Toggle theme \| Full PiKVM UI | pass |
| desktop 1400x900 | socket drop recovers, input works again | offline seen, recovered in 1228 ms, then move 0,-5232, button left down, button left up | pass |
| desktop 1400x900 | no page errors | clean | pass |

37 of 37 passed.

## Screenshots

- [desktop-keys-strip](kvm-screen/desktop-keys-strip.png)
- [desktop-more](kvm-screen/desktop-more.png)
- [desktop-send-keys](kvm-screen/desktop-send-keys.png)
- [desktop-toolbar](kvm-screen/desktop-toolbar.png)
- [phone-caps-on](kvm-screen/phone-caps-on.png)
- [phone-dock](kvm-screen/phone-dock.png)
- [phone-more-keys](kvm-screen/phone-more-keys.png)
- [phone-sheet](kvm-screen/phone-sheet.png)
- [phone-zoomed](kvm-screen/phone-zoomed.png)
