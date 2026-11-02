# E2E run: Settings -> Macros (2026-11-02)

Host under test: `node dist/web-server.js` (http://127.0.0.1:8191) in front of `tools/fake-kvmd` (http://127.0.0.1:4591).

Browser: headless Chrome through puppeteer-core. Profiles: iPhone 13 (390x844, touch, coarse pointer) and desktop 1400x900. Script: `apps/web/e2e/settings-macros.e2e.mjs`; how to run it: `docs/e2e/README.md`.

Settings -> Macros is the same component as the KVM screen's Macros dialog. Each case drives it as a person would and asserts what the server STORED and what the fake kvmd RECEIVED.

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| iPhone 13 | empty list says how to start; the page is a page (no dialog, no Done) | "No macros yet.Use New macro to add one.New macro"; dialogs 0; Done false | pass |
| iPhone 13 | create: name, Super+R, text and pause are stored by the server | {"id":"macro-mvztmgvb","label":"Run box","icon":"command","pinned":true,"steps":[{"type":"chord","mods":["MetaLeft"],"code":"KeyR"},{"type":"text","text":"calc"},{"type":"delay","ms":300}]} | pass |
| iPhone 13 | edit: an icon, a step moved up, pin switched off and on | icon terminal; steps text,chord,delay; unpinned true; repinned true | pass |
| iPhone 13 | run from Settings: keys over the socket, text through kvmd, the page stays | key MetaLeft down, key KeyR down, key KeyR up, key MetaLeft up; typed "calc"; still on /app/settings/macros; toast "Run box sent" | pass |
| iPhone 13 | second macro, then reorder: the list on the server follows | Run box > Task manager  ->  Task manager > Run box | pass |
| iPhone 13 | pin: both macros are tiles in the KVM's menu, in list order | Task manager, Run box | pass |
| iPhone 13 | unpin in Settings: it leaves the tiles / toolbar | Run box | pass |
| iPhone 13 | delete asks first: Cancel keeps the macro, Delete removes it from the server | after Cancel both kept; after Delete: Run box | pass |
| iPhone 13 | no page errors | clean | pass |
| Desktop 1400x900 | empty list says how to start; the page is a page (no dialog, no Done) | "No macros yet.Use New macro to add one.New macro"; dialogs 0; Done false | pass |
| Desktop 1400x900 | create: name, Super+R, text and pause are stored by the server | {"id":"macro-mvztmpar","label":"Run box","icon":"command","pinned":true,"steps":[{"type":"chord","mods":["MetaLeft"],"code":"KeyR"},{"type":"text","text":"calc"},{"type":"delay","ms":300}]} | pass |
| Desktop 1400x900 | edit: an icon, a step moved up, pin switched off and on | icon terminal; steps text,chord,delay; unpinned true; repinned true | pass |
| Desktop 1400x900 | run from Settings: keys over the socket, text through kvmd, the page stays | key MetaLeft down, key KeyR down, key KeyR up, key MetaLeft up; typed "calc"; still on /app/settings/macros; toast "Run box sent" | pass |
| Desktop 1400x900 | second macro, then reorder: the list on the server follows | Run box > Task manager  ->  Task manager > Run box | pass |
| Desktop 1400x900 | pin: both macros are in the KVM toolbar, in list order | Task manager, Run box | pass |
| Desktop 1400x900 | unpin in Settings: it leaves the tiles / toolbar | Run box | pass |
| Desktop 1400x900 | delete asks first: Cancel keeps the macro, Delete removes it from the server | after Cancel both kept; after Delete: Run box | pass |
| Desktop 1400x900 | no page errors | clean | pass |

18 of 18 passed.

## Screenshots

- [desktop-confirm](settings-macros/desktop-confirm.png)
- [desktop-created](settings-macros/desktop-created.png)
- [desktop-empty](settings-macros/desktop-empty.png)
- [desktop-reordered](settings-macros/desktop-reordered.png)
- [desktop-run](settings-macros/desktop-run.png)
- [desktop-strip](settings-macros/desktop-strip.png)
- [phone-confirm](settings-macros/phone-confirm.png)
- [phone-created](settings-macros/phone-created.png)
- [phone-empty](settings-macros/phone-empty.png)
- [phone-reordered](settings-macros/phone-reordered.png)
- [phone-run](settings-macros/phone-run.png)
- [phone-tiles](settings-macros/phone-tiles.png)
