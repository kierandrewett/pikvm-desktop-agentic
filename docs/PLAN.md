# PiKVM app rebuild

Branch `feat/app-rebuild`. The main checkout keeps uncommitted work untouched; this
branch merges when the rebuild is done.

Inputs, kept beside this plan while it is in flight:
- `docs/rebuild/console-inventory.md`: every console feature, endpoint, route, IPC
  channel, test pin and dead path, with file:line.
- `docs/rebuild/agent-chat-map.md`: the old agent workspace and the upstream chat project (superseded; see below).
- `docs/rebuild/chat-integration.md`: how Chat, the agent and the PiKVM MCP were integrated, with the deletions (done).

## 1. What the product is

One remote-control surface for one target machine, driven through PiKVM, with an
agent that can operate the same target. It runs in three places that must behave
the same:

| Host | Shell | Has |
|---|---|---|
| Desktop (Electron) | native window | the chat server and agent (omp, bundled), native menus, window focus |
| Web host (container) | browser, an authenticating proxy in front | KVM; Chat and its agent in the same container |
| Phone | installed PWA | touch, soft keyboard, dictation, background suspends |

Today it is a set of parts bolted together: an 11k-line closure (`console.js`)
holding every concern in shared mutable state, a separate React workspace, a
second settings window, a proxy that injects UI into pages, and routes spread
over several files under a `/_agent` prefix. The work is to give it one shape.

## 2. Domains

Each domain owns its state and exposes a narrow interface. Nothing reaches into
another domain's state.

1. **Target link**: the kvmd connection. One event socket is the single source of
   truth for device state (HID mouse mode and LEDs, ATX, MSD, GPIO, streamer,
   health, keymaps, OCR). Owns connect, heartbeat, reconnect and the outbound
   HID channel with its ordering rules.
2. **Video**: picture source selection (WebRTC via Janus, MJPEG, snapshot),
   fallback, freeze-frame, signal states, audio and mic.
3. **Input**: turning human intent into HID commands. Keyboard (chords,
   modifiers, Caps sync, layout maps), soft keyboard and dictation (field
   mirror), pointer (mouse absolute, trackpad, direct touch, hold-to-drag, wheel),
   macros, paste. Pure interpreters: event in, commands out.
4. **View**: zoom, pan, clamp, cursor, lens, coordinate mapping between screen,
   picture and HID units. Pure maths plus one transform.
5. **Device control**: ATX, mass storage, GPIO, stream settings, OCR, logs,
   health. Request/response over kvmd HTTP plus state from the target link.
6. **Agent**: the chat server (`packages/chat-server`, from an upstream chat project) inside our Node process, omp as the agent
   program, the PiKVM computer-use MCP (`packages/pikvm-mcp`, on `@pikvm/kvm-engine`), conversation, approvals,
   providers and models. Chat's pane and settings pages are `packages/chat-web`.
7. **Host**: settings, auth, PWA lifecycle (wake lock, visibility, offline),
   desktop capabilities (window, menus). A `Host` interface with a web
   and a desktop implementation replaces `if (window.desktopConsole)` scattered
   through the code.

## 3. Design rules

- **Functional core, effectful shell.** Input interpreters, view maths and the
  key-queue scheduler are pure and unit-tested. Sockets, timers and DOM live at
  the edges.
- **Effect where lifetimes and failure matter**: the target-link socket
  (reconnect, heartbeat, interruption), video fallback, the HID queue's timing,
  and the server API (Schema-validated, typed errors, typed client). Not in
  render code. React components read state through small hooks.
- **TanStack Router** for the three areas and settings sub-pages; **TanStack
  Query** for request/response data (settings, macros, device state snapshots,
  the Chat server's lists). Socket-driven state goes through a store, not Query.
- **One contract package** (`packages/contracts`): Effect Schemas for our API and
  the kvmd messages we read and send. Server and client import the same types.
- **One route table** on the server, in one file, reviewed as a whole.
- **Same look as the desktop app**: its tokens, titlebar language, density. The
  conversation interface and its server come out of an upstream chat project as
  workspace packages (`chat-protocol`, `chat-server`, `chat-web`); Phosphor is the icon set.

## 4. Target layout

```
apps/web/                 the app (Vite, React 19, Tailwind 4, TanStack, Effect)
  src/app/                shell, router, nav (bottom bar on phone, rail on desktop)
  src/host/               Host interface; web and desktop implementations
  src/target/             kvmd client: event socket, HID channel, device state store
  src/video/              WebRTC/MJPEG/snapshot sources, fallback machine, audio
  src/input/              keyboard, soft-keyboard mirror, pointer/touch machines, macros
  src/view/               coordinate maths, zoom/pan/clamp, cursor, lens
  src/kvm/                KVM screen: picture, dock, key rows, sheets, dialogs
  src/chat/               the Chat route (host states around @pikvm/chat-web's ChatPane)
  src/settings/           settings pages
packages/contracts/       Effect Schemas: our API + kvmd messages
packages/chat-protocol/   the chat wire protocol (from an upstream chat project)
packages/chat-server/     the chat server, run inside our process; spawns omp per conversation
packages/chat-web/        the conversation pane and the Providers, Models and Agent settings pages
packages/pikvm-mcp/       the PiKVM computer-use MCP server
packages/kvm-engine/      the KVM engine, shared by the app and the agent's Desk
packages/icons/           Phosphor icons
src/server/               one Node server for desktop and web host
  routes.ts               the route table
  api/                    Effect HttpApi handlers for /app/api/v1/*
  proxy/                  kvmd passthrough (HTTP + WS)
  chat/                   the chat server and the PiKVM MCP on its agent listener
  agent/                  the Desk, presence and activity
  sync/                   the state server: the probe client, the forwarder, `/servers` logic
  auth.ts                 the one gate
src/desktop/              Electron main + one preload
tools/fake-kvmd/          a kvmd simulator for end-to-end tests
```

## 5. Routes

kvmd owns `/`, `/kvm/`, `/login/`, `/api/`, `/streamer/`, `/janus/`, `/share/`,
`/extras/`. Ours all live under `/app`:

| Path | What |
|---|---|
| `/app/` and client routes `/app/kvm`, `/app/chat`, `/app/settings/*` | the SPA (PWA scope) |
| `/app/assets/*` | built assets, immutable, hashed |
| `/app/api/v1/*` | our API (state, settings, macros, session, agent activity) |
| `/app/chat/api/*`, `/app/chat/ws` | the chat server's REST routes and socket |
| `/app/sw.js`, `/app/manifest.webmanifest`, icons | PWA files, public |
| `/` | redirect to `/app/` |
| anything else | kvmd passthrough |

Clean cutover: the desktop, the web host, oauth2-proxy skip routes, the PWA
manifest and the docs move in the same change. `/_agent/*` goes away.

## 6. The riskiest parts, and how they are made safe

| Risk | Why | Safety |
|---|---|---|
| HID ordering and timing | keys lost or reordered, modifiers stuck | key queue as a pure scheduler with tests written from its failure list first; release-always semantics kept |
| Soft keyboard / dictation | iOS focus ownership, composition, diff replay | mirror logic pure and tested against recorded event sequences; one focus owner |
| Gesture machine | taps vs drags vs holds vs pinch | explicit state machine (idle, pending, armed, dragging, pinching), table-tested |
| Video fallback | WebRTC flakiness | explicit machine, same timeouts as today |
| Socket dropouts | phone suspends, proxies idle-kill | heartbeat + silence watchdog kept, owned by the target-link service |
| Losing a feature | 11k lines of edge cases | parity checklist from the inventory; each item ticked with evidence |

## 7. Verification

- Unit tests for the pure cores, failure modes listed before tests are written.
- **A fake kvmd** (`tools/fake-kvmd`): event socket, HID sink that records what
  it receives, MJPEG and snapshot, the HTTP endpoints the app calls. This makes
  real end-to-end tests possible (the app's HID output can be asserted) without
  touching the real target, which is somebody's working machine.
- Browser E2E (phone and desktop profiles) against the fake kvmd, recorded under
  `docs/e2e/`.
- Each phase is deployed behind the authenticating proxy and checked there signed in.

## 8. Phases

Each ends committed, deployed and working.

1. **Foundations.** `packages/contracts`, the server route table under `/app`,
   Effect HttpApi for our API, one auth gate, the fake kvmd. Remove dead code
   (proxy UI injection, legacy native UI, dead IPC, dead guards). The existing
   console is served from the new paths so nothing user-facing changes yet.
2. **App shell and Settings.** `apps/web` with nav and the Settings pages
   (connection, keyboard layout, jiggler, touch, trackpad mouse, theme, audio
   devices, macros, account). The KVM tab hosts the existing console until 4.
3. **Chat.** The conversation inside the app, phone layout, on the chat server in our process (done).
4. **KVM.** Engine modules (target, video, input, view) with tests, then views,
   feature by feature against the parity checklist. The old console is deleted.
5. **Providers.** Chat's Providers, Models and Agent settings pages on the chat server's write-only key store
   (done). Signing in with an account instead of a key is an open question in `docs/rebuild/chat-integration.md`.
6. **Desktop.** Electron loads `/app/`, one slim preload, the settings window
   goes. Packaging moves to **pkgsmith** (https://github.com/kierandrewett/pkgsmith): one `pkgsmith.star` producing the major formats for
   each OS from per-platform Electron builds (Linux: rpm, deb, Arch, AppImage,
   Flatpak; macOS: dmg; Windows: msi and nsis). It replaces scripts/make-rpm.mjs.

## 9. Decisions

- Same behaviour, new code: console.js is ported, not wrapped.
- Providers are API keys and gateways held by the chat server; no home-grown OAuth against model vendors. The
  Python agent and its provider CLIs are gone (see `docs/rebuild/chat-integration.md`).
- BYOK keys are write-only from the browser: set, replace, remove, never read back.
