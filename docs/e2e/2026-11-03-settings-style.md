# E2E run: Settings in Chat's style (2026-11-03)

Every Settings page of apps/web now looks and behaves like ~/dev/chat's settings. This record: what was decided, the browser run, and the screenshots (every page, phone and desktop, light and dark, beside the matching ~/dev/chat screen).

## Decisions

- **One home for the primitives: `packages/chat-web`.** It already held a faithful copy of Chat's settings kit (rows, sections, cards, Switch, Segmented, Select, TextField, sheets, dialogs) for Providers, Models and Agent, and it is the package that carries Chat's tokens and utilities scoped to `.chat-scope`. A second copy in apps/web would have had to carry the same tokens, the same Tailwind scoping and the same fixes twice. The kit now has a subpath entry, `@pikvm/chat-web/settings`, with a hand-written declaration (`packages/chat-web/settings.d.ts`, checked against the source by `src/test/host-types.ts`) for the app's stricter TypeScript, as `host.d.ts` does for the pane.
- **`SettingsScope`** (`pane/kit-scope.tsx`) is the scope element, theme mirror, portal layer, tooltips and toasts, without the chat server; `ChatScope` is it plus `ChatServices` (query client, socket, undo). The agent's pages bring `ChatServices` with them, so they sit in the same scope as every other page.
- **Navigation as Chat does it.** Wide: a 320px column of grouped sections (Chat's sidebar rows: 36px, 20px icons filled when current, collapsible section labels) beside the page column. Phone: the list is the page; a row pushes its page, whose header has Chat's back button; Back reveals the list. The routes stay (`/settings`, `/settings/<page>`), so the Settings tab still returns to the page that was open. Not ported: Chat's settings search (it is built on Chat's row registry) and the profile card; the sidebar's windowing, filtering and the edge fade on the list (the installed app keeps masks off the top of the page).
- **Pages**: every page is `SettingsPage > SettingsSection > SettingsCard > SettingRow`; a section's note is Chat's (under the group on a narrow column); values are secondary text at the row's end; destructive actions are `variant="danger"` behind a confirm (kit `ConfirmDialog`: a dialog on desktop, a sheet on a phone); a Select opens Chat's menu (desktop) or option sheet (phone). Macros is a list of rows with one macro's editor behind it (back to the list), on the editor hook it shares with the KVM screen's Macros dialog (`kvm/dialogs/use-macro-editor.ts`). The one native control left is the macro key picker, a `<select>` with option groups (about 120 keys), drawn with the kit's field class.
- **Removed**: `ui/controls.tsx`; the `.page-title/.group-*/.row*/.segmented/.switch/.field-*/.inline-error/.status-dot/.settings-note` rules; DialogShell's `page` presentation and its CSS; the "host draws the title" mode of the kit.
- **Two things the scoped port needed**: `settings.css` now sits inside `.chat-scope[data-theme]` (the scoped utilities are one class more specific than in Chat's app and later in the sheet, so `display: grid` on a section lost to `flex` and the phone's footers and picker rows did not apply), and the stylesheet is imported by the scope component (a side-effect import in a re-export module was dropped from the build).

## The two-tap bug

Reported on the installed iPhone app: after switching to Settings from KVM or Chat, a Settings row needs two taps. Headless Chrome with real touch events does not reproduce it (the first of the cases below passes before and after), because the cause is iOS's: a tap is first a hover, and when `:hover` restyles something (`a.row:hover` and `.nav-tab:hover` changed a background and showed a tip, with transitions) iOS treats the tap as that hover and sends no click. What was done: the old `a.row`/`button.row` hover rules are gone with the old rows; the new rows hover only through `hover-device:` (hover: hover and pointer: fine); `.nav-tab:hover`, `.nav-tab:hover .nav-tip`, `.tb-btn:hover`, `.btn:hover`, `.btn-primary:hover` and `.window-close:hover` are inside `@media (hover: hover) and (pointer: fine)`. The e2e asserts the cause (no `:hover` rule of the chrome or the kit outside such a query, read from the live stylesheets) and the symptom with real CDP touch events from each starting point; NativeFeel's `native-feel-build.test.ts` audits the whole built CSS. **iOS's hover-on-first-tap cannot be emulated here; confirm on the device.**

## Run

Host: `node dist/web-server.js` in front of `tools/fake-kvmd`; headless Chrome through puppeteer-core; iPhone 13 (touch, installed-app flag) and 1280x800 / 1920x1080 windows. Script: `apps/web/e2e/settings-style.e2e.mjs` (`checks` runs the cases, `shots` the screenshots and side-by-sides).

| Profile | Case | Observed | Result |
| --- | --- | --- | --- |
| iPhone 13 standalone | one tap on About opens it: coming from the KVM tab | after ONE touch tap: /app/settings/about; the row was under the finger: /app/settings/about; page errors 0 | pass |
| iPhone 13 standalone | one tap on About opens it: coming from the CHAT tab | after ONE touch tap: /app/settings/about; the row was under the finger: /app/settings/about; page errors 0 | pass |
| iPhone 13 standalone | one tap on About opens it: from a fresh load of Settings | after ONE touch tap: /app/settings/about; the row was under the finger: /app/settings/about; page errors 0 | pass |
| iPhone 13 standalone | no :hover rule in the settings and navigation styles sits outside a (hover: hover) media query | every :hover rule of the app's chrome and the settings kit is inside (hover: hover) | pass |
| iPhone 13 standalone | the page slides in from the list (a view transition, forward) and back out (back) | forward {"n":1,"dir":"forward"}; back {"n":2,"dir":"back"}; after {"n":2,"dir":null} | pass |
| iPhone 13 standalone | reduced motion: the page just changes (no view transition, no direction) | view transitions started 0; direction null | pass |
| iPhone 13 standalone | edge swipe from x=2: the page follows the finger, and released past a third it goes back | page 178px right with the finger at 180; after release /app/settings; the list is showing: true | pass |
| iPhone 13 standalone | a short, slow swipe is cancelled: the page springs back and stays | dragged to 78px; released short of a third (130px): /app/settings/about, page at 0px | pass |
| iPhone 13 standalone | a fast flick back is honoured even when short | 110px in 36ms: /app/settings | pass |
| iPhone 13 standalone | a swipe that starts away from the edge, or goes up, is left alone (the page scrolls) | from x=120: /app/settings/about; from the edge but upward: /app/settings/about | pass |
| iPhone 13 standalone | the swipe is not attached on the KVM or Chat tabs | kvm: /app/kvm, settings page moved false; chat: /app/chat, settings page moved false | pass |
| Desktop 1280x800 | no slide on desktop: choosing a page changes it, with no view transition | view transitions 0; direction null | pass |
| Desktop 1280x800 | keyboard: the list comes first in the tab order, Enter opens a page and the focus stays on its link | nav links at 0..16, the page's first control at 17; focus after Enter on /app/settings/input, outline solid | pass |
| Desktop 1280x800 | a macro's delete still asks first, and Cancel keeps it | asked: "Delete the macro “Login”?This removes it from the "; macros after Cancel: 2 | pass |

14 of 14 passed.

Also run against this build, green: `settings-macros.e2e.mjs` (phone and desktop, 9 cases each), `phone-chrome.e2e.mjs` (the About build row and Display report cases; its one red case, no mask in the top 60px, was the settings list's edge fade, removed), `watch.e2e.mjs` (22 cases, the Notifications page). Unit tests: `apps/web/src/settings` 88 passed; `packages/chat-web` 21 passed.

## Screenshots

`settings-style/<page>-<viewport>-<theme>.png` for connection, keep-awake, notifications, keyboard, input, macros (plus `macros-editor-…`), providers, models, agent, display, audio, account, about; viewports `phone` (iPhone 13), `desktop-1280x800`, `desktop-1920x1080`; themes `light` and `dark`; `list-phone-…` is the phone's list. Account is listed only behind a sign-in proxy: the run answers the proxy probe like oauth2-proxy does.

Beside ~/dev/chat (`settings-style/side-by-side-<page>-<viewport>-<theme>.jpg`, ours left, Chat's right; Chat's screens are in `settings-style/chat-ref/`, taken from ~/dev/chat's own web app in an isolated stack with its e2e harness, signed in as a throwaway admin; sources: `apps/web/src/components/settings/{settings-layout,settings-section}.tsx`, `kit/*`, `sidebar-kit/sidebar-kit.tsx` in ~/dev/chat):

| Ours | Chat's |
| --- | --- |
| notifications | notifications |
| display | appearance |
| providers | providers |
| models | chat |
| account | me |
| list (phone) | list (phone) |

Pages without a Chat counterpart (connection, keep awake, keyboard, touch and mouse, macros, audio, about) are drawn with the same kit and have no pair.
