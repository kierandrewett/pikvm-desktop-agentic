# Agent chat map (the previous console <-> the upstream chat project)

> **Superseded (2026-11-03).** This map described the Python harness, its `agent/frontend` UI and `packages/chat-ui`, and advised
> reusing them. All three are deleted: Chat is `packages/chat-web` on `packages/chat-server` inside our server, with the
> PiKVM tools in `packages/pikvm-mcp`. See `docs/rebuild/chat-integration.md`. Kept as history only.

Read-only investigation. `[INFERENCE]` marks anything not directly read.
Paths: `PK` = the previous console checkout, `CH` = the upstream chat project.

## 0. Headline findings

1. **PK's agent frontend already IS a full conversation UI with approvals, model picker and a provider-connection dialog**
   (assistant-ui + shadcn/Base UI). The Chat tab mostly needs a *mount point + mobile layout*, not a new chat UI.
2. **The harness never stores secrets and has no OAuth flow.** BYOK = "point at an env-var name" (`credential_env`);
   "login" = reuse a CLI's own saved login (`claude`/`codex`/`gemini`), which the harness never reads. There is no
   endpoint to set an API key value or to start/finish OAuth. Real BYOK/OAuth-in-Settings needs new backend work.
3. **CH has no LLM-provider OAuth either.** Its OAuth is (a) user sign-in via better-auth/OIDC and (b) MCP-server OAuth
   (PKCE). BYOK storage exists in CH but is server-side in its SQLite settings store + a gateway. Reusable: UI patterns
   (SecretRow, provider catalogue/presets), not login flows.
4. CH web is deeply coupled (TanStack Query/Router, Fluent l10n, its own WebSocket protocol, custom Tailwind tokens,
   Phosphor icon package, no LICENSE file). Copy *ideas and small leaf components*, not the thread/composer wholesale.

## 1. The upstream chat project

### Stack
- Bun monorepo: `CH/package.json:5-9` workspaces `apps/*`, `packages/*`, `plugins/*`; TS `^7.0.2` (`:19`).
- `CH/apps/server` Bun + Hono; REST `/api`, WebSocket `/v1/responses`, LLM gateway `/gw` (`CH/AGENTS.md:7-8`). Spawns
  omp (oh-my-pi) agent in a bubblewrap sandbox per conversation (`CH/README.md:3-4,34-43`).
- `CH/apps/web` Vite 8.3.4 + React 19.3.0 (pinned) + TanStack Router 1.170 / Query 5.104 / Virtual 3.13 + Tailwind 4.3.3
  (`@tailwindcss/vite`) + `radix-ui` 1.7.0 (unified pkg) + react-markdown 10.1 + remark-gfm/math + shiki 4.5 + katex +
  Fluent l10n (`@fluent/*`) + better-auth + zod 4.6.5 + lucide-react 1.55 (`CH/apps/web/package.json`). Icons are really
  `@chat/icons` (Phosphor-based, `CH/AGENTS.md:24-26`). No zustand; no shadcn (hand-rolled `components/ui/*`).
- `CH/packages/ui` (`@chat/ui`): tiny - `button, badge, spinner, tooltip, kbd, tailed-surface, tailed-content, portal-layer`
  (`CH/packages/ui/src/`), depends only on `radix-ui` + `@chat/icons`. Most self-contained part of CH.
- `CH/packages/protocol` (`@chat/protocol`): zod wire types (`responses.ts`, `models.ts`, `settings.ts`, `catalog.ts`,
  `model-features.ts`...). Components import its types everywhere.
- Design tokens are custom, not shadcn: `CH/apps/web/src/styles/tokens.css`, `app.css:11+` (`bg-surface`, `text-secondary`,
  `border-default`, `--density`, `--roundness`). PK uses shadcn tokens (`bg-background`, `--radius`) - restyle on copy.
- Product rule: "1:1 copy of the reference app UI", clean-room (`CH/AGENTS.md:9,24-26`); never mention omp/oh-my-pi/reference
  brand in `apps/web`.

### Where each feature lives (`CH/apps/web/src/components/...`)
| Feature | Files | Coupling (imports) |
|---|---|---|
| Turn/message list | `thread/turn.tsx`, `conversation-page.tsx`, `thread/turns.ts`, `thread/minimap.tsx` | HIGH: `lib/live`, `lib/send`, `lib/queries`, l10n `useT`, composer choice, branching/reactions/speech/genui (`turn.tsx:29-62`) |
| Composer | `composer/composer.tsx` (+`controls.tsx`, `effort.tsx`, `attach-sheet.tsx`, `dictation.tsx`, `composer.css`) | VERY HIGH: TanStack Query/Router, `lib/socket`, drafts, agents, MCP menu, uploads (`composer.tsx:52-157`) |
| Markdown | `thread/markdown.tsx` + `thread/markdown/{code-block,blocks,citation,image,link-card,math,env,syntax}.tsx`, `thread/highlight.ts`, `markdown.css` | MEDIUM: react-markdown/remark-gfm/remark-math/shiki; leaks `lib/queries` (session epoch), `lib/session-reset`, `render/text-tools`, `file-icons`, `render/detect` (`markdown.tsx:17-40`, `code-block.tsx:7-15`, `highlight.ts:10-15`) |
| Tool-call cards / activity | `thread/activity.tsx` (1116 lines), `thread/activity/{shared,todo-step}.tsx`, `thread/web-search.tsx`, `subagents.tsx`, `thinking-indicator.tsx` | HIGH: `@chat/protocol` item types, `lib/live` streaming mutation, l10n, plugins (`activity.tsx:16-46`). Design doc: `CH/docs/spec/tool-call-reference-notes.md` |
| Approval tray | `thread/approval-tray.tsx`, `thread/approvals.ts` | MEDIUM-LOW: `ApprovalRequestItem` type, `lib/send.answerApproval`, `useLive`, `useHighlight` (`approval-tray.tsx:9-18`, `approvals.ts:5-10`) |
| Streaming | `lib/socket.ts` (WS `/v1/responses`, reconnect/queue/resume, `:21-23`), `lib/live.ts` (in-place mutation of live items), `lib/send.ts`, `lib/realtime.ts` | server-specific protocol (omp Responses events). Not reusable for PK's SSE |
| Model picker | `model-picker/{model-picker,picker-content,provider-logo,models,search}.tsx`; `model-browser/*` for catalogue browsing | MEDIUM: `ModelInfo` from protocol, radix Popover, `ui/sheet` for mobile, `lib/media.useIsMobile`, l10n (`model-picker.tsx:5-29`). Has mobile Sheet variant |
| Settings shell | `settings/settings-layout.tsx`, `settings/kit/{layout,section-nav,controls,feedback,bound,secret}.tsx`, `settings/pages/*` | MEDIUM: kit is mostly presentational but l10n `useT` + `api`/queries in `bound.tsx` |
| Provider screens (BYOK) | `settings/integrations/providers.tsx` (1179 lines), `common.tsx`, `parts.tsx` (`PresetGallery`, `HealthLine`), `settings/models.tsx`, `role-models.tsx` | HIGH: `api.get("/providers/catalog")` (`providers.tsx:76-80`), `POST /api/providers/test`, `GET /api/providers/:id/models` (`:3-8`), react-query, router |
| API-key field | `settings/kit/secret.tsx` (`SecretRow`) | LOW: 124 lines, only l10n `useT/useLocale` + sibling kit `TextField/Button/SettingRow`. Never displays value; Replace/Remove-with-confirm |
| Mobile shell | `shell/mobile-shell.tsx` (drawer + end-panel gestures, `drawer-gesture.ts`), `mobile-header.tsx`, `ui/sheet.tsx`, `ui/side-panel.tsx` | MEDIUM: `useSetting`, l10n. **No bottom nav bar** (drawer-based) - nothing to steal for KVM|Chat|Settings tabs |
| Theme | `lib/theme.ts`, `theme-sync.tsx`, `styles/tokens.css` | settings-store driven |

### Licence
- **No `LICENSE` file** at `CH/` (glob of `LICENSE*` returned only nothing in repo root); no `"license"` field in
  `CH/package.json`, `apps/web/package.json`, `packages/ui/package.json`.
  `CH/README.md` never mentions a licence. `CH/docs/spec/genui-openui.md:44-46` only discusses third-party MIT deps.
- Ownership: `CH` was written by the same author as this project [INFERENCE - no author/licence metadata read], so copying its
  code was a decision for that author. Its UI is declared a clean-room reproduction of a third-party product from observation
  (`AGENTS.md:24-26`), so a downstream open-source release of PK could inherit that provenance question.
- Third-party icons: Phosphor (MIT) (`CH/docs/spec/file-icons.md:20-22`); Geist/Inter fonts via @fontsource (OFL).

### Best candidates to copy (value/effort)
1. `settings/kit/secret.tsx` - `SecretRow`; drop l10n (replace `t()` strings), swap kit `TextField/Button/SettingRow` for PK's
   `ui/input|button|field`. ~1 hour.
2. Settings layout/IA from `settings/settings-layout.tsx`, `section-nav.tsx`, `kit/layout.tsx` (`SettingsPage/Section/Card/SettingRow`)
   as the *pattern* for an app-like settings page; rewrite in shadcn tokens (CH's `bg-surface/text-secondary` classes won't
   exist in PK). Medium.
3. Provider gallery/health pattern: `settings/integrations/parts.tsx` (`PresetGallery`, `HealthLine`, `GalleryTile`) +
   `providers.tsx` guided setup flow; data comes from CH server `/providers/catalog` (`BUILTIN_PROVIDERS` in
   `CH/apps/server/src/agent/providers.ts:15-28`). PK already has equivalent data in `/api/provider-catalog` + `/api/model-catalog`.
4. Model picker mobile behaviour: `model-picker/model-picker.tsx` (Popover on desktop, `ui/sheet` on mobile via `useIsMobile`).
   PK has `workspace/model-picker.tsx` (Radix Select, `max-w-[38vw]`); a bottom-sheet variant is the only thing worth taking.
5. Markdown/code block polish (`thread/markdown/code-block.tsx`: collapse at 40 lines `:18`, copy, filename) - PK's
   `assistant-ui/markdown-text.tsx` uses `@assistant-ui/react-markdown`; take only CSS/behaviour ideas.
6. `ui/sheet.tsx`, `thread/message-sheet.tsx` (long-press actions), `shell/drawer-gesture.ts` for mobile gestures.
7. DO NOT copy: `composer.tsx`, `turn.tsx`, `activity.tsx`, `socket.ts`, `live.ts` (protocol/query-coupled).

## 2. agent/frontend (PK)

### Stack (`PK/agent/frontend/package.json`)
- React `^19.2.8`, Vite `^8.1.5` (`@vitejs/plugin-react ^5.1.2`), Tailwind `^4.1.18` (`@tailwindcss/vite`), `tw-animate-css`,
  TS `^5.9.3`, vitest `^4` + testing-library + jsdom.
- shadcn-style components (`components.json`) built on **both** `@base-ui/react ^1.6.0` and `@radix-ui/react-{collapsible,dialog,select,slot}`;
  `lucide-react ^0.468.0`, `class-variance-authority`, `clsx`, `tailwind-merge ^3`, `zustand ^5`, `remark-gfm`,
  `@fontsource-variable/geist`.
- Conversation engine: **`@assistant-ui/react ^0.14.28` + `@assistant-ui/react-markdown ^0.14.7`** using
  `useExternalStoreRuntime` (`components/workspace/workspace-shell.tsx:9-16`).

### Entry points / build
- `agent/frontend/index.html` -> `src/main.tsx` (`WorkspaceErrorBoundary` > `WorkspaceShell`, `main.tsx:7-16`) -> entry `app.js`.
- Second entry `src/shared/mount.tsx` -> `shared.js`: sets **`window.pikvmShared = { mountIconButtons, mountButtons }`**
  (`mount.tsx:125`; types `:116-123`). Only buttons/tooltip icon buttons are exposed; it is a plain-JS-to-React seam
  (`createRoot` + `flushSync`, returns `{update, unmount}`). Extend here to expose e.g. `mountBottomNav`, `mountSettings`.
  Console consumers: `src/views/console.js:1779,1955,2093,2224,3962,10593`; loaded at `src/views/console.html:32-33`
  (`/_agent/workspace/styles.css`, `/_agent/workspace/shared.js`, module script). Tailwind v4 layers lose to unlayered
  `console.css` (comment `mount.tsx:14-18`).
- `vite.config.ts`: `base: "./"` (`:21`; document must end with `/`), `outDir: "../pikvm_agent/harness_ui"`, `emptyOutDir`,
  `cssCodeSplit:false`, outputs `app.js`, `shared.js`, `styles.css`, `assets/*` (`:30-55`). Build id `computeUiBuildId`
  -> `__PIKVM_UI_BUILD__` + `version.json`.
- **Build command**: `cd agent/frontend && npm run build` = `tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.node.json && vite build && node scripts/normalize-build.mjs` (`package.json:7`). Tests: `npm test` (vitest).
  Built output committed at `agent/pikvm_agent/harness_ui/` (only `frontend/node_modules`, tsbuildinfo are gitignored,
  `agent/.gitignore:34-37`).

### UI structure (`src/components/...`)
- `workspace/workspace-shell.tsx` (782 lines): whole app; `ThreadList` rail (`hidden md:flex`, mobile gets a Sheet "Open tasks"
  `:417-420`), titlebar 38px (`styles.css:252-268`, `h-dvh`, grid `md:grid-cols-[13.5rem_minmax(0,1fr)]`), computer sheet,
  diagnostics, showcase, provider-connections sheet, auth dialog, badges.
- `assistant-ui/thread.tsx`: `ThreadPrimitive` viewport + `ComposerPrimitive` (input `:285`, send/cancel/dictate `:312-377`),
  user/assistant message, grouped parts (reasoning/tool groups `:491-539`), `--thread-max-width: 38rem`.
- `assistant-ui/{tool-fallback,tool-group,reasoning,markdown-text,attachment,follow-up-suggestions,thread-list}.tsx`.
  Approval cards live in `tool-fallback.tsx` (tests `tool-fallback-approval.test.tsx`).
- `workspace/`: `model-picker.tsx`, `run-control-mode.tsx`, `run-provenance.tsx`, `run-activity.tsx`, `computer-tool-call.tsx`,
  `computer-sheet.tsx`, `diagnostics-sheet.tsx`, `showcase-sheet.tsx`, `provider-connections-sheet.tsx`,
  `provider-connection-dialog.tsx` (665 lines), `provider-logo.tsx`, `auth-dialog.tsx`, `task-restore-state.tsx`.
- State: `hooks/use-harness-workspace.ts` (all fetching/stream/actions), `lib/live-run-reducer.ts`, `lib/run-messages.ts`,
  `lib/model-routes.ts`, `lib/run-timeline.ts`. "Session list" = harness runs (`GET /api/runs`).
- `hooks/use-panel-placement.ts`: desktop-only `globalThis.pikvmPanel` bridge (absent in browser -> controls hidden).

### Talking to the harness
- `lib/harness-api.ts`: `API_BASE = window.__PIKVM_HARNESS_API_BASE__` (`:187-194`), `harnessUrl()` rebases root-relative paths
  (`:202`), every request adds `X-PiKVM-Workspace: 1` (`:216-220`) and `Authorization: Bearer <sessionStorage "pikvm-harness-token">`
  (`:222-241`). **SSE via fetch** (`harnessEventStream`, `:298+`; no WebSocket): `GET /api/runs/{id}/stream?after=<cursor>`
  (`use-harness-workspace.ts:529`).
- Endpoints used (`use-harness-workspace.ts`): `/api/runs` GET/POST (`:272,659`), `/api/runs/{id}` (`:242`), `/steer` (`:651`),
  `/pause` (`:687`), `/continue` (`:700`), `/approvals/{approvalId}` POST (`:711`), `/api/providers` GET (`:273`) and POST (`:791`),
  `/api/provider-catalog` (`:82`), `/api/model-catalog` (`:94`), `/api/tools` (`:106`), `/api/tool-servers` (`:117`),
  `/api/health` (`:126`), `/api/computer-connection` (`:138`); showcases in `showcase-sheet.tsx:173`.
- Host injection: `PK/src/workspace-assets.ts:36-65` injects `window.__PIKVM_HARNESS_API_BASE__="/_agent/harness"` and sets
  `sessionStorage["pikvm-harness-token"]="desktop-managed"` (sentinel = host manages auth). Mount: `WORKSPACE_PREFIX="/_agent/workspace"`
  (`:40`); redirect to trailing slash (`:171-175`).

### Responsive/mobile today
- Only Tailwind `md:` breakpoint for rail hide + `md:pb-6`; `h-dvh`; model picker `max-w-[38vw]`; no bottom nav, no safe-area
  insets, no virtual-keyboard handling in the React app. Console owns phone layout (see 2b).

### 2b. How the console currently hosts chat (needs rework for bottom nav)
- `src/views/console.html:646` `<iframe id="chat-frame" title="Terminal">`; `src/views/console.js:9854-9996`: desktop (Electron)
  and web/mobile both point it at **`/_agent/terminal.html`** (raw terminal). The first-party workspace was deliberately replaced
  on 2026-10-05 (`console.js:9856-9866`). `readState()` (`:9975`) fetches `/_agent/api/state`; `features:{terminal, chat}`
  comes from `src/server.ts:153` (`chat: !!harnessProxy`), so the console already knows if the harness proxy exists.
- Phone mode: `html.touch-dock` (set at `console.js:9175`, `dockMode` `:8935`) -> `.app` grid rows `minmax(0,1fr) minmax(120px,34%) auto`
  (`console.css:2519-2521`), bar (`.bar`) pinned bottom with `env(safe-area-inset-bottom)` (`:2544-2551`); `html.no-terminal`
  hides `.chat` (`:2515`). `--app-height` tracks visual viewport. Only media queries: `max-width:560px` (`:2240`) and 440px (`:2663`).
  A bottom nav must coordinate with `.bar`/`kb-open`.
- Server: `src/server.ts:197-227` serves `/_agent/workspace/*` (`workspaceAssets`) and proxies `/_agent/harness/*` with the
  server-side operator token; requires `x-pikvm-workspace: 1` else 403 (`:29-31,222-223`). `src/web-server.ts:131-153`: headless
  host forwards to desktop via `PIKVM_DESKTOP_URL` + `PIKVM_DESKTOP_TOKEN` (`harnessPrefix: ""`), no browser-visible token.
- SW/PWA: `src/views/sw.js` (scope `/_agent/`), `manifest.webmanifest`.

## 3. Harness (`PK/agent/pikvm_agent`)

### Routes (`harness/api.py`, FastAPI; app built in `harness/server.py`)
- Auth middleware `api.py:342-430`: operator bearer (`PIKVM_HARNESS_TOKEN`), observer (`/api/direct/*`), agent token (`/api/runs*`,
  `/api/agent/*`); `secrets.compare_digest`; Origin allowlist `:427+`; approvals need `x-pikvm-approval-intent` == approval id (`:448-449`).
- Health/config: `GET /api/health :822`, `GET /api/providers :838` (= `models.health()`), `GET /api/computer-connection :842`,
  `GET /api/tools :913`, `GET /api/tool-servers :922`, `GET /api/provider-catalog :947` (`provider_support.public_provider_catalog`
  `provider_support.py:202`), `GET /api/model-catalog :966` (+`/logo/{provider_id} :951`, cached from models.dev),
  showcases `:856-910`.
- **`POST /api/providers :926`** -> `ProviderConnectionManager.connect` (`provider_connections.py:306`). 201 / 409 on conflict or
  budget policy / 503 if no settings path.
- Runs: `POST /api/runs :1102`, `GET /api/runs :1119`, `GET /api/runs/{id} :1128`, `/performance :1153`, `/events :1158`,
  **`/stream :1182` (SSE)**, `/frame :1278`, verification images `:1321-1354`, `/artifact-acceptance :1387`, `/continue :1473`,
  `/start :1505`, `/pause :1532`, `/steer :1556`, **`POST /api/runs/{id}/approvals/{approval_id} :1583`**, `/abort :1665`;
  `/` redirects to `/app/` (`:1706`). Direct-call visibility `/api/direct/*` (`:975-991`).
- Separate legacy daemon: `daemon.py:162-276` (`/status`, `/sessions...`, `/cursor`) - not the chat API.

### Providers / credentials / routing
- `ProviderConnectionRequest` (`provider_connections.py:110-139`): `alias, kind, model, base_url?, credential_env?, profile_home_env?, auth_mode?`
  (`api_key|bearer_env|bearer_command`). Kinds: `openai_responses, anthropic_api, gemini_api, openai_compatible, azure_openai_responses,
  vertex_gemini` + CLI kinds `codex_cli, codex_app_server, claude_cli, gemini_cli` (`:29-60`).
  **Rejects credential values**: `sk-`, `ghp_`, `aiza`, `bearer `, JWTs -> validation error (`:80-99,141-148`).
  Response has `secret_received: Literal[False]` (`:288`), `configured_not_routed: True` (`:287`).
- Secrets storage: **none**. API providers read an env var by name (`api_key_env` / `credential_env`; `config.harness.example.yaml:19-24,
  105-156`) from the harness process env. Cloud auth via fixed commands `az`/`gcloud` (`provider_connections.py:62-79`). So a "paste your
  key in Settings" UI has nowhere to put it today; desktop (`src/harness-manager.ts:106-113`) only passes the 5 harness tokens in env.
- OAuth: only "provider-owned sign-in" via CLIs (`providers.py:3-6`: harness never reads CLI tokens; `ClaudeCodeProvider :513`,
  `CodexAppServerProvider :899`, Gemini CLI `:651`). `harness init --oauth-clis auto` (`onboarding.py:25-90`; invoked from
  `harness-manager.ts:145-158`) seeds `codex-account`, `claude-account`, `gemini-account` if the CLI binaries exist. Managed-run
  isolation symlinks CLI auth files (`managed_client_launcher.py:117-120,464-582`). `grep oauth|device_code` found **no** authorize/token/
  device-code endpoint anywhere in `harness/`. UI label "Provider-owned sign-in"/`saved_cli_login` is metadata (`ui_fixture.py:125-128`).
- Persistence: `_write_config` rewrites the YAML config atomically, chmod 0600 (`provider_connections.py:367-397`); new providers are
  **additive and unrouted** (`adopt_unrouted_provider`, `:346`) - no endpoint edits `routes`, deletes a provider, or sets a key.
  Config path: `deps.configPath` (`harness-manager.ts`), created by `harness init` (`:135-163`).
- Per-role routing: YAML `routes:` ordered fallback lists for `assistant, reasoner, controller, verifier`
  (`config.harness.example.yaml:172-180`; `config.py:889-893`). Per run: `CreateRunBody.model_provider` xor `model_preferences`
  (`api.py:221-237`, expanded by `_expanded_model_route :244` into `RunModelRoute` (`agent_models.py:220`)); frontend
  `lib/model-routes.ts`, `model-receipt.ts`. `mode:"assistant"` runs use the assistant lane (`api.py:1084`).
- Config template: `agent/config.harness.example.yaml` (secret-free; `listen 127.0.0.1:47616`, tokens via env names, budgets
  `:199-215`, assistant MCP tools `:187-195`).

### Gaps for BYOK/OAuth
Needed new harness endpoints: store key (encrypted file/keychain or in-memory env injection + restart), delete/rename provider,
edit `routes`, list CLI login status, start/finish login (spawn `claude login`/`codex login` or implement PKCE). None exist.
Relevant guard: `ProviderConnectionRequest` validators intentionally block secret values; a new "set secret" route must be a
separate, never-logged endpoint (see `harness/redaction.py`).

## 4. CH provider auth (reusable?)
- **BYOK**: server-side. Settings KV (`agent.providers.<id>.apiKey`, `CH/README.md:63-64`; per-user under `users.<id>`). UI
  `SecretRow` (`settings/kit/secret.tsx`) is write-only (value never returned; shows set/unset). Admin (global) keys never reach the
  sandbox: agent calls `/gw/<providerId>` with HMAC token `gw.<userId>.<hmac>` and the gateway swaps in the real key
  (`apps/server/src/agent/providers.ts:1-8,57-65`; `authHeaderFor :38`). Endpoint catalogue `BUILTIN_PROVIDERS :15-28`
  (anthropic, openai, google, openrouter, groq, mistral, xai, deepseek, together, fireworks, cerebras, moonshot).
  Other files: `apps/server/src/models/provider-call.ts`, `auth/secret.ts` (server HMAC secret `secret.key`; no encryption of stored keys read
  here - `grep encrypt|aes` returned nothing in `auth/secret.ts`; storage layer not inspected [INFERENCE: plaintext in `chat.db`]).
- **OAuth**: `apps/server/src/mcp/oauth.ts` (MCP servers: authorization-code + PKCE S256, RFC 7591 dynamic registration, RFC 8707
  `resource`, RFC 9207 `iss`, state single-use 10 min, `:10-14,156,488`) and `mcp/credentials.ts`. User login: better-auth + OIDC with PKCE
  (`apps/server/src/auth/index.ts:63-66`, `packages/protocol/src/settings.ts:251-255`, UI `settings/integrations/auth-providers.tsx`).
  **No Anthropic/OpenAI/Google account OAuth or device-code flow** (grep for device_code/claude.ai/auth.openai/oauth+codex across `apps` +
  `packages`: only the above hits). `mcp/oauth.ts` is a reusable *PKCE-with-discovery* reference if PK implements its own provider OAuth,
  but is Bun/Hono/SQLite-coupled and targets MCP resources.
- UI for provider setup (guided presets, test connection, per-model enable/disable): `settings/integrations/providers.tsx`.

## 5. Blockers / mismatches
- **Versions** (CH -> PK): react 19.3.0 pinned vs ^19.2.8 (OK, caret); vite 8.3.4 vs ^8.1.5; tailwind 4.3.3 vs ^4.1.18; zod 4.6.5 vs
  (PK has zod only transitively); lucide-react **1.55.0 vs ^0.468.0** (major gap; icon names differ; CH actually uses `@chat/icons`
  Phosphor); `radix-ui` unified 1.7.0 vs PK individual `@radix-ui/react-*` + `@base-ui/react` (mixing Radix+BaseUI Popover/Select
  behaviours - pick PK's); TS 7 vs 5.9 (syntax fine, `tsc` flags differ); PK lacks TanStack Query/Router, Fluent, react-markdown (PK uses
  assistant-ui markdown), shiki, katex, `@phosphor-icons/react`. Copying CH components means adding or rewriting these. PK package.json
  scripts type-check strictly (`tsc --noEmit`) so un-adapted CH files (`@chat/*` aliases, `msg()` l10n) will fail the build.
- **Token/CSS mismatch**: CH utilities (`bg-surface`, `text-secondary`, `border-default`, `--density`) absent in PK `styles.css`; PK scopes
  console CSS via Tailwind layers (`mount.tsx:14-18`) - CH global CSS (`app.css`, `tokens.css`, `composer.css`) could leak into the console.
- **Licence**: CH has none stated; provenance is clean-room of a third-party UI (see section 1). Resolve before publishing PK.
- **Server-side**: CH chat transport needs CH's server (WS `/v1/responses`, omp + bwrap). Cannot be reused against PK's harness without a
  rewrite. PK's SSE `/api/runs/{id}/stream` + external-store runtime is already working.
- **Secrets**: backend has no secret store and no OAuth endpoints (sec. 3). `ProviderConnectionRequest` deliberately rejects keys.
  Harness runs with `adoptExisting:false` under desktop; web host has no harness of its own (`web-server.ts:131-153`).
- **Tokens/security**: browser never sees operator token; new settings/credential routes must live behind `/_agent/harness` (header
  `x-pikvm-workspace:1`) or a new `src/server.ts` route behind the same `/_agent/*` auth gate (`server.ts:206-227`).
- **Chat tab hosting**: console currently targets `terminal.html`; switching to workspace must keep desktop `reportWorkspaceRect` native-view
  path (`console.js:9855`) vs web path (`:9953+`) consistent. Workspace must be loaded at a URL ending `/` (`vite.config.ts:13-20`).
- Built bundle is committed; any frontend change needs `npm run build` in `agent/frontend` and committing `agent/pikvm_agent/harness_ui/`.

## 6. Recommended reuse (ranked value/effort)
1. **Reuse PK's own `agent/frontend`** as the Chat tab: load `/_agent/workspace/` in the existing `#chat-frame` (or mount in a pane) when
   `features.chat` is true; add a bottom-nav in plain console JS/CSS (or a new `pikvmShared.mountBottomNav`), toggling KVM/Chat/Settings
   panes; adjust `html.touch-dock` rows (`console.css:2492-2528`). Highest value, lowest effort. Add mobile CSS in `agent/frontend/src/styles.css`
   (`dvh`, `env(safe-area-inset-*)`, VisualViewport keyboard, composer sticky, 44px targets, mobile `Sheet` for model picker).
2. **Settings page in PK's React bundle** (new `components/settings/*`, entry via `shared.js` or a route in `app.js`) using existing `ui/*`,
   `provider-connections-sheet.tsx`, `provider-connection-dialog.tsx`, `provider-logo.tsx`, `/api/provider-catalog|model-catalog|providers`.
   Steal from CH: `SecretRow` (`kit/secret.tsx`), settings layout/section-nav IA, `PresetGallery/HealthLine` (`integrations/parts.tsx`).
3. **BYOK backend (new)**: add harness endpoints (e.g. `PUT /api/providers/{alias}/secret`, `DELETE /api/providers/{alias}`,
   `PUT /api/routes`) storing keys 0600 outside the YAML (or encrypted) and injecting into provider env; keep existing
   `credential_env` path as the "advanced" option. CH's gateway/`SecretRow` write-only model is the design to emulate.
4. **"Log in with provider" (OAuth)**: simplest = CLI-owned login (spawn `claude login` / `codex login` / gemini; poll status); the
   harness already supports these (`claude_cli`, `codex_cli`, `codex_app_server`, `gemini_cli`) and `onboarding.py` seeds them. True browser OAuth
   (PKCE) would be net-new; CH `mcp/oauth.ts` is a pattern reference only.
5. Model picker mobile sheet (CH `model-picker/*`) - small, optional.
6. Markdown/code block styling ideas (CH `thread/markdown/*`) - cosmetic, optional; do not port wholesale.
7. Skip: CH composer/turn/activity/socket/live (tightly bound to CH server protocol and TanStack Query).
