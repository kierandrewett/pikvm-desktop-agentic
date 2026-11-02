# @pikvm/web

The PiKVM app: the shell (navigation, layout), Settings, and for now frames that host the
existing console and agent workspace until phases 3 and 4 replace them. Vite, React 19,
Tailwind 4, TanStack Router and Query, Effect. Served by the host under `/app/`.

## Develop

```sh
# from the repo root, once
yarn install

# a running web host (or the desktop app's server) on 127.0.0.1:8099
yarn workspace @pikvm/web dev        # http://localhost:5173/app/
```

The dev server forwards what it cannot serve itself to the host, so dev behaves like the real
origin (same paths, same cookies, no CORS): `/app/api`, `/app/legacy`, `/app/workspace`,
`/app/harness`, `/api` (WebSocket too), `/streamer`, `/janus` and `/oauth2`. Point it at a
different host with `PIKVM_WEB_HOST=http://127.0.0.1:9000 yarn workspace @pikvm/web dev`.

The KVM tab frames the host's `/app/legacy/` and the Chat tab its `/app/workspace/`. Both
paths are constants in `src/host/paths.ts` and can be overridden with `VITE_LEGACY_CONSOLE_PATH`
and `VITE_WORKSPACE_PATH`. Without a host behind the proxy the shell, navigation and Settings
still load; their data shows its error state.

## Build and check

```sh
yarn workspace @pikvm/web build       # typecheck, then static assets in apps/web/dist
yarn workspace @pikvm/web typecheck
yarn workspace @pikvm/web test        # vitest + testing-library
```

`base` is `/app/`, so the server serves `apps/web/dist` at `/app/` with `index.html` as the
fallback for `/app/kvm`, `/app/chat` and `/app/settings/*`, and `/app/assets/*` as immutable.

## Layout

```
src/main.tsx            entry: theme, query client, router
src/app/                shell, route table, navigation (bar on phones, rail when wide), viewport hooks
src/api/                typed client over @pikvm/contracts, and the Query bindings
src/settings/           the Settings list and one page per section
src/kvm/ src/chat/      TEMPORARY frames around the existing console and workspace
src/host/paths.ts       every server path the app depends on
src/theme.ts            the stored theme, shared with the console's key
src/ui/                 icons and the grouped-list controls
src/styles.css          tokens (the desktop app's palette) and component classes
```

## Behaviour notes

- **Theme** is stored under the console's key `pikvm-console-theme`; "System" stores nothing so
  the OS keeps being followed. Both `data-theme` and the `dark` class are set.
- **Touch input and trackpad mouse** are stored in this browser under `pikvm-touch-mode`
  (`trackpad` | `direct`) and `pikvm-touch-hid` (`abs` | `rel`), the console's own keys.
- **Keyboard layout** and **keep awake** are `PATCH /app/api/v1/settings` with only the field
  that changed. While a save is in flight the control shows the value being saved and is
  disabled; a refused save restores the held value and shows the server's reason.
- **Audio** devices are listed through `navigator.mediaDevices` and stored under the console's
  `pikvm-console-mic-device` / `pikvm-console-speaker-device` keys. The page is absent in
  browsers that cannot enumerate devices.
- **Account** appears only when `HEAD /oauth2/userinfo` answers with a non-HTML success, i.e. the
  host sits behind oauth2-proxy. Its sign-out link is `/oauth2/sign_out`.
- **Phone layout** is chosen by `(pointer: coarse), (max-width: 719px)`. The bottom bar hides
  while the soft keyboard is up, judged from `visualViewport` the way the console does: more
  than 150px lost from the tallest height seen since the last orientation change.
