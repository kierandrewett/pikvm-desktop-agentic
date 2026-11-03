# Chat integration plan: an upstream chat project becomes the Chat tab

Status: executed through S6, on branch `feat/app-rebuild`. Written 2026-11-02, status updated 2026-11-03.

| Slice | State |
| --- | --- |
| S0 Phosphor icons | done (`docs/e2e/2026-11-03-icons.md`) |
| S1 chat-protocol, chat-server on Node | done (`docs/e2e/2026-11-03-chat-server-node.md`) |
| S2 PiKVM MCP | done (`docs/e2e/2026-11-03-pikvm-mcp.md`) |
| S3 chat-web lift | done; the dead code of the lift (admin scope, server dictation, side-panel branches, projects, agentic-change, orphan `.ftl`) was pruned in S4 |
| S4 integration | done: the chat server in the host, the agent routes and banner, the Origin check, loopback refusal, Settings pages. Browser evidence: `docs/e2e/2026-11-03-chat-integrated.md` (`apps/web/e2e/chat.e2e.mjs`) |
| S5 packaging | owned by the packaging agent (`docs/e2e/2026-11-03-image-and-appimage.md`) |
| S6 cutover and docs | done: `agent/`, `deploy/agent`, `packages/chat-ui`, the Python-backed Providers page, the harness and daemon proxies and `/app/workspace`, `PIKVM_HARNESS_*` and `PIKVM_DESKTOP_*`, the agent runtime and handoff code in `src/`, `human-typing`, `windmouse`, `scripts/build-agent-runtime.mjs`, the `agent-bundle` target and the `LEGACY_PACKAGES` exemption are deleted; `src/pikvm-control.ts` shrank to the proxy target, the kvmd event socket and the jiggler's nudge; `lucide-react` is in no file or lock entry. `docs/PIKVM_API.md` keeps the kvmd notes the Python agent held. The legacy console lost its agent-status pill, its cursor report and its link to the workspace bundle (its dialogs draw plain buttons) |

Decisions made while executing S4 that this plan did not have:

- External MCP servers are not configurable. Integrations reach the agent through the Executor gateway, which is one
  entry in `packages/chat-server/src/mcp/external.ts` (empty today; how to add it is in the README). The MCP settings
  page is deleted and the server refuses writes to `agent.mcp`.
- The agent runs the computer profile only: `ask`, `todo` and `mcp__pikvm_*`.
- Chat's stylesheet is scoped to `.chat-scope` (its Tailwind theme block is moved there by `apps/web/scope-chat-theme.ts`),
  and the e2e compares the app's computed styles and root variables before and after Chat loads.
- Chat's Settings pages (Providers, Models, Agent) leave their own title to the host's Settings layout.
- The PiKVM card's thumbnail (section 4, "PiKVM card") needed the picture to reach the thread, and `function_call_output.output`
  is a string. So the chat server keeps screenshots itself:
  - Storage: per conversation, `packages/chat-server/src/storage/frames.ts`; at most 60 files and 48 MB, oldest out;
    deleted with the conversation and copied to a fork.
  - Naming: a tool names a kept frame in its result's `_meta["chat/frame"]`; the item carries
    `frame: { id, width, height, url }`, live and from history. The model still gets the image in the result.
  - Serving: `GET /app/chat/api/conversations/:id/frames/:frameId`, only inside the conversation that took the frame.
  - Drawing: pointer tools name the conversation's latest whole-screen frame, so the card draws the click, move, scroll
    or drag on what the agent was looking at.
  - Evidence: `docs/e2e/2026-11-03-chat-integrated.md`.

Not covered by the S4 acceptance run: the `bwrap --unshare-net` loopback test (the image has no sandbox, by decision),
the desktop (Electron) path, which S5 smoke-tests, and a real PiKVM.

This replaces two earlier positions: the "patterns only, do not copy" rule in `docs/PLAN.md` section 3, and the
"reuse `agent/frontend`" advice in `docs/rebuild/agent-chat-map.md` section 6. The decisions:

- The Chat tab takes the whole conversation interface out of the upstream chat project, with its server components, and
  integrates it into our server.
- One Dockerfile for everything, no agent sidecar. The agent is chat's, so everything is TypeScript.
- Computer use is a PiKVM computer-use MCP server in TypeScript, built on `@pikvm/kvm-engine`.
- The upstream chat project has the same author as this one, so copying its code is allowed.
- Phosphor icons across the whole app, through chat's `@chat/icons`.

Evidence markers. **Verified** means read from code, or run on this machine on 2026-11-02. `[INFERENCE]` means not
observed; the slice named beside it must prove it. Paths: `CH` is the upstream chat project, `PK` is this repo.

## 0. The recommendation in one page

1. **Lift, then prune.** Copy chat's protocol, server and conversation UI into workspace packages. Delete what
   one operator does not need: sign-up, admin, quotas, plugins, projects, search, avatars, push, genui, custom
   agents, memory. Section 1 gives a verdict per area.
2. **Run chat's server inside our Node process**, ported from Bun. Not as a Bun child, not as a bundled Bun
   binary. The Bun-only surface that stays is small and mechanical, and Electron's main process is Node.
3. **The agent runtime is omp's standalone binary**, spawned per conversation over RPC. No Bun and no Python
   ship. Upstream CI builds that binary for 8 targets, and the local `omp` is one (277 MB, `v18.14.2-fork.7`).
4. **The agent never holds a secret.** PiKVM credentials and provider keys stay in the server process. The agent
   reaches models and the PiKVM only through a separate listener, the *agent surface*, that needs a bearer token.
5. **The PiKVM MCP server runs in the server process**, mounted on the agent surface. It asks for approval through
   MCP elicitation in the Chat thread. A person moving the mouse ends agent control, detected server-side.
6. **One image**, `deploy/Dockerfile`. A deployment's compose file loses `kvm-agent`. The bubblewrap sandbox is opt-in
   there, because it needs relaxed seccomp.
7. **Slices.** Wave 1 is four independent agents: icons, chat server on Node, PiKVM MCP, chat UI lift. Wave 2 is
   integration, packaging and the cutover that deletes Python and the sidecar.

## 1. Inventory: what to lift from the upstream chat project

Sizes are `wc -l` counts (verified). The chat server is 24,246 lines in `apps/server/src`. The web app is about
90,000 lines in `apps/web/src`.

### 1.1 Shared packages

| CH path | What | Verdict |
|---|---|---|
| `packages/protocol/src` | zod wire types: Responses-style events, REST DTOs, the settings schema | **Keep, trim** to `@pikvm/chat-protocol` |
| `packages/ui/src` | button, badge, spinner, tooltip, kbd, tailed surfaces, portal layer, over `radix-ui` | **Keep** in `packages/chat-web/src/ui` |
| `packages/icons` | rounded Phosphor fork, 1513 generated modules (6.3 MB, tracked in git) | **Keep** as `packages/icons`, used app-wide (S0) |
| `packages/plugin-api`, `plugins/*` | plugin SDK, Docs, Sheets, Slides | **Drop** |

Protocol files to keep: `responses`, `models`, `settings`, `catalog`, `model-features`, `model-order`,
`model-roles`, `composer-features`, `branching`, `realtime`, `chat-urls`, `drafts`, `sidebar-view`.

Protocol files to drop: `admin`, `agents`, `ambient`, `avatar`, `chat-icons`, `genui`, `openui`, `memory`,
`plugin-*`, `plugins`, `preview`, `push`, `search`. Remove their keys from `settings.ts`, plus `policy.*`,
`auth.*`, the `users.*` twins and every `system.*` key except the sandbox and agent-runtime keys.

### 1.2 Server (`apps/server/src`)

| Area | Source | Verdict |
|---|---|---|
| Entry and routing | `index.ts`, `http/context.ts`, `http/static.ts` | **Adapt**: becomes `createChatServer()`; no static serving; constant operator user |
| Agent lifecycle | `agent/sessions.ts` (788), `run.ts` (765), `rpc.ts` (259), `slots.ts` (286), `commands`, `questions`, `subagents`, `todos`, `context-usage`, `retry-limits`, `tool-facts`, `citations` | **Keep, port** (Bun.spawn, ids, hashing). Drop `web-search.ts` |
| Sandbox | `agent/sandbox.ts` (267) | **Adapt heavily**: one binary, `--unshare-net`, socket (2.4) |
| Config generator | `agent/config.ts` (328), `runtime-options.ts`, `mcp-names.ts`, `mcp-catalog.ts`, `mcp-probe.ts` | **Keep, adapt**: every provider via the gateway; PiKVM MCP entry; tool profile |
| Gateway and catalogue | `http/gateway.ts`, `agent/providers.ts`, `models/{catalog,service,match,roles,features,provider-call}`, `http/models-routes.ts`, `catalog-routes.ts` | **Keep**. Drop `models/decisions.ts`, `series.ts`, allow/deny policy |
| MCP wiring | `mcp/*` (gateway, upstream, interactions, credentials, oauth, crypto, net, inspect, chat-servers), `http/mcp-routes.ts`, `mcp-rpc.ts`, `mcp-conversations.ts` | **Keep**. Drop `mcp/catalogue.ts` with its page; drop `/mcp/plugins` |
| Approvals | `agent/run.ts`, `agent/questions.ts`, `mcp/interactions.ts` | **Keep** |
| Streaming | `http/ws.ts` (400), `hub.ts` (174), `sync.ts` (186) | **Keep, port** from `ServerWebSocket` to `ws` |
| Conversations | `conversations/{service,history,titles,export,snippet,slug,versions,branching}`, `http/conversation-routes.ts` | **Keep**. Drop reactions, temporary, icons, preview |
| Storage | `storage/{uploads,attachments}`, `http/upload-routes.ts` | **Keep** uploads. Drop avatars, workspace browser |
| Settings store | `settings/store.ts` (188) | **Keep** store and schema. Drop `toml.ts`, `migrate.ts` |
| Database | `db/*`, `migrations/*` (16 files) | **Adapt** (below) |
| Auth and admin | `auth/*`, `admin/*`, `http/{auth,admin}-routes.ts` | **Drop**, keeping only `auth/secret.ts` |
| Memory | `memory/*`, `http/memory-routes.ts` | **Drop** from the lift (open question 5) |
| Search | `search/*`, `http/search-routes.ts` | **Drop** in the first cut |
| Everything else | `plugins/*`, `genui/*`, `agents/*`, speech, notification, ambient, preview, decisions routes | **Drop** |

Notes on the table:

- Agent lifecycle: one omp process per active conversation, newline JSON RPC with protocol v2 chunking, an idle
  reaper, process limits, a fair queue, a 5 s stop grace, and conversion of runtime frames into Responses events.
- Settings: keep the `userId` parameter on `setting()` and `resolveSetting()` and pass the constant operator id.
  This keeps the lift mechanical and the diff against chat small.
- Database keeps these tables: `users` (one seeded row `operator`, so foreign keys hold), `settings`,
  `conversations`, `conversation_slugs`, `uploads`, `drafts`, `mcp_credentials`, `mcp_oauth_clients`,
  `mcp_chat_servers`.
- Database drops: `sessions`, `accounts`, `verifications`, `passkeys`, `two_factors`, `projects`, `reactions`,
  `search_docs`, `search_state`, `push_subscriptions`. One new squashed `0000_init.sql`.
- Gateway: `/gw/<provider>` swaps a gateway token for the real key. Model metadata and logos come from models.dev
  and are cached under `cache/`.
- MCP wiring: remote servers go through `/mcp/s/<id>` so their tokens stay on the server. Built-in servers such as
  `/mcp/conversations` share `serveMcp` (`http/mcp-rpc.ts`), the stateless streamable-HTTP shell our PiKVM server will reuse.

### 1.3 Web (`apps/web/src`)

The web app shares our stack: React 19, Vite 8, Tailwind 4, TanStack Router and Query. That is why a lift is feasible.
It also carries these dependencies:

- Fluent l10n, the better-auth client, Phosphor icons through `@chat/icons`, zod.
- Rendering: `react-markdown`, `remark-gfm`, `remark-math`, `shiki`, `katex`.
- Lists and editing: `@tanstack/react-virtual` and CodeMirror.

| Area | Source | Verdict |
|---|---|---|
| Thread, markdown, trays | `components/thread/*` (20,186 with CSS), `render/*` (6,529), `file-icons`, `chat-icon` | **Keep**, then prune until `tsc` is clean |
| Tool call cards | `thread/activity.tsx` (1,116), `activity/*`, `web-search.tsx`, `subagents.tsx` | **Keep**; add a PiKVM card in `chat-web` |
| Approvals and questions | `approval-tray`, `approvals.ts`, `elicitation-*`, `question-tray`, `questions/` | **Keep** |
| Composer | `components/composer/*` (6,878) | **Keep**, with `ComposerFeatureOptions` |
| Model picker and browser | `model-picker/*` (2,144), `model-browser/*` (2,232) | **Keep** both |
| Conversation page | `thread/conversation-page.tsx` (726) | **Keep `ConversationPane`** as the core |
| Conversation list | `sidebar/*` (4,279), `sidebar-kit/*` (1,472) | **Adapt** into a pane-local list |
| Mobile shell and gestures | `shell/{mobile-shell,drawer-gesture,mobile-header}`, `ui/{sheet,side-panel}`, `thread/message-sheet.tsx` | **Keep** gestures and sheets; replace the shell |
| Settings pages | `settings/integrations/{providers,parts,common,mcp,mcp-settings}`, `settings/{models,role-models}`, `settings/kit/*`, `pages/chat.tsx` | **Keep**, trim `chat.tsx` into an Agent page |
| Data layer | `lib/{socket,live,send,realtime,queries,api}.ts` | **Keep**, make base paths configurable |
| Theme | `styles/tokens.css` (534), `styles/app.css`, `lib/theme*.ts` | **Adapt** (below) |
| l10n | `l10n/*`, `@fluent/*` | **Keep**, en-GB bundle only |
| Dropped | `components/{agents,ambient,auth,files,genui,header,memory,plugins,search,temporary}`, `boot-shell`, `routes/*` | **Drop** |

Notes on the table:

- **Thread prune list.** Drop `reactions/`, `speech.ts`, `selection-toolbar`, `side-panel-toggle`, `right-panel`
  (workspace files), `panel/` and genui.
- **PiKVM card.** A screenshot thumbnail with the action's point drawn on it, for `mcp__pikvm_*` calls.
- **Composer.** Turn off `fullscreen` and `disclaimer`. Keep model picker, effort, permissions, MCP menu,
  attachments and dictation. Drop the CodeMirror `markdown-editor.tsx` unless wanted.
- **Conversation page.** `ConversationPane` is chat's embedded-host entry: thread, trays and composer, with no header,
  minimap or side panel. `agents/agent-preview.tsx` and `memory/memory-chat.tsx` already embed it. Remove its `useShell` use.
- **Conversation list.** A left column on wide screens, a drawer on phones. Drop projects, search, spaces, agent rows
  and sidebar views.
- **Mobile.** Our shell owns the bottom nav and the keyboard-aware viewport (`app/shell.tsx`, `app/viewport.ts`).
  The drawer and the 1:1 swipe become container-relative: positioned inside the Chat pane, never over the nav.
- **Settings.** Drop every `admin*`, `me*`, `appearance`, `notifications`, `personalization`, `plugins`, `search*`,
  `shortcuts`, `speech` and `general` page, and `integrations/auth-providers.tsx`. Our Display page owns the theme.
- **Data layer.** The WebSocket URL `/v1/responses` and REST base `/api` are hard-coded (`socket.ts:23`, `api.ts`).
  New bases are `/app/chat/ws` and `/app/chat/api`. Drop `query-persist`, `sw-register` and `auth.ts`.
- **Theme.** Every colour in `tokens.css` is a formula over `--seed-surface`, `--seed-ink` and `--seed-accent`.
  Scope the formulas under `.chat-scope`, set the seeds from `--background`, `--foreground` and `--primary`,
  drop `lib/theme.ts`, and inherit our font.
- **l10n.** Fluent's `useT("id")` is in nearly every component. Rewriting the strings is not worth it, so keep Fluent
  with en-GB only and drop the language row.
- **Brand rule.** Chat forbids naming omp or the reference product in `apps/web`. Drop the rule and its lint.

### 1.4 Tests and fixtures worth lifting

| CH path | Use |
|---|---|
| `e2e/fixtures/fake-llm.ts` (709), `chaos.ts` (126 scenarios), `fake-mcp-server.ts` | Replace `tools/fake-model/server.py`; add scenarios that call `mcp__pikvm_*` |
| `e2e/harness.ts`, `e2e/api`, `e2e/ui` | Pattern for E2E against a real server |
| `apps/web/thread-preview-harness.html`, `agent-activity-harness.html` | Develop the lifted UI against canned events |

## 2. Runtime constraints

### 2.1 Bun-only APIs in the kept server code

Verified by grep of `apps/server/src`: 57 lines in 34 files mention `bun:`, `Bun.` or `import.meta.dir`, some in
comments. About 26 remain after the drops in 1.2.

| Bun API | Kept files | Node replacement |
|---|---|---|
| `bun:sqlite`, `drizzle-orm/bun-sqlite` | `db/index.ts` | `node:sqlite` behind `drizzle-orm/sqlite-proxy` and its migrator |
| `Bun.serve`, websocket | `index.ts`, `http/ws.ts`, `hub.ts` | our `node:http` plus `ws` in `onUpgrade` |
| `Bun.spawn` | `agent/rpc.ts`, `sandbox.ts`, `mcp-catalog.ts` | `child_process.spawn` |
| `Bun.which` | `agent/sandbox.ts` | a PATH search, `PATHEXT` aware |
| `Bun.CryptoHasher`, `Bun.hash` | `agent/config.ts`, `sessions.ts`, `mcp-names.ts` | `node:crypto` sha256 |
| `Bun.randomUUIDv7` | `db/index.ts`, `agent/run.ts`, `branching.ts` | a v7 generator in `chat-server/src/ids.ts` |
| `Bun.file` | `history.ts`, `conversation-routes.ts`, `upload-routes.ts`, `ws.ts` | `fs.promises`, `Readable.toWeb` |
| `Bun.sleep` | `conversations/titles.ts` | `timers/promises` |
| `Bun.YAML`, `Bun.Image`, `Bun.build`, `Bun.hash.crc32` | custom agents, avatars, plugins | dropped with those features |
| `import.meta.dir` | `db/index.ts`, `paths.ts` | esbuild bundle; migrations copied to `dist/chat-migrations` |
| TypeScript run directly | everywhere | esbuild, as `scripts/build.mjs` does for `src/` |

Notes on the table:

- **sqlite.** drizzle-orm 0.45.4 has no `node-sqlite` driver. Its drivers are better-sqlite3, bun-sqlite,
  durable-sqlite, expo-sqlite, libsql, op-sqlite, sqlite-core and sqlite-proxy. `better-sqlite3` is rejected: it
  is a native addon that needs a rebuild for Electron's ABI.
- **TypeScript.** Node's plain strip-types mode is not enough for chat code that uses parameter properties
  (`RpcError` in `agent/rpc.ts`), so esbuild does the transform.
- **Hono.** REST routes run on any `fetch(Request)` host. A small Node adapter (`getRequestListener` from
  `@hono/node-server`, or ten lines of our own) mounts them unchanged.
- **Contracts.** Our own API stays Effect HttpApi. The chat API stays Hono and zod, and `@pikvm/chat-protocol` is its
  contract package. That is a deliberate exception to "one contract package".

Verified: Node 22.22.2 here and Electron 39.8.10's Node 22.22.1 both load `node:sqlite`, with an
ExperimentalWarning. The hosted image pins Node 22, which has it too.

### 2.2 Options for running chat's server

| Option | How | For | Against |
|---|---|---|---|
| **A. Port to Node, in process** | `createChatServer()` mounted by our server | One runtime and process; Electron and container run the same code; no IPC | We diverge from chat, which stays on Bun; a one-time port |
| B. Bun child process | Ship a `bun` binary (about 100 MB per platform) and proxy | Code stays verbatim | Two runtimes; the Desk would sit across a process boundary; Windows Bun is least mature |
| C. `bun build --compile` | One extra binary per platform | Verbatim code, no Bun install | Same two-process problems, plus another 100 MB |

Recommendation: **A**. The deciding evidence:

- The kept Bun surface is small and mechanical (table above).
- The desktop's main process is Electron's Node. It cannot execute `bun:sqlite`.
- Credentials stay simpler. In B or C the Desk holding the kvmd password would live in, or call across to, a second
  process, and the chat child would need its own listener that the agent could also reach (section 3).
- The agent does not need Bun, because omp ships standalone binaries (2.3).

### 2.3 omp: install and spawn

Verified facts:

- `@oh-my-pi/pi-coding-agent` 18.11.2 declares `"engines": {"bun": ">=1.3.14"}` and its `dist/cli.js` starts
  with `#!/usr/bin/env bun`. Run as a package, it needs Bun.
- Chat runs it as `[bun, entry, "--config", ...]` with the server's own Bun, and mounts the Bun directory and
  `node_modules` read-only into the sandbox (`agent/sandbox.ts:118-122`).
- Upstream CI builds standalone binaries for darwin x64 and arm64, linux x64 and arm64 with musl variants of each,
  and windows x64 and arm64 (`ci.yml:749-793` in omp's upstream repository).
- A fork of omp (`just build`) builds `dist/omp-linux-x64` (242 MB), and musl variants with `LIBC=musl`.
- An `omp` binary on the build machine's PATH is such a binary. Its `--help` lists `--mode`, `--config`, `--session-dir`, `--tools`,
  `--no-skills`, `--no-rules`, `--no-extensions`, `--approval-mode` and `--restore`.

Decision: spawn the standalone binary as `omp --mode rpc --config <generated> --session-dir <dir> [--resume ...]`.
`locateRuntime()` shrinks to a lookup: `OMP_BIN`, else `<resources>/omp/omp[.exe]`, else `omp` on PATH.

To prove in S1 (`[INFERENCE]` until then):

- The compiled binary speaks `--mode rpc` protocol v2 as chat expects. Chat targets 18.8.x; the fork is 18.14.2.
- `knownRuntimeTools()` can no longer import `src/tools/builtin-names.ts` from a package. Use the static
  `FALLBACK_TOOLS` list, or probe over RPC.
- The binary starts and works with no network and no writes outside its HOME and cwd.

Pinning: `deploy/omp.lock` holds the version and a sha256 per target. The binary is fetched at image or package
build from the fork's releases, whose `SHA256SUMS.txt` is what `omp update` already checks. It is never committed.

### 2.4 Sandbox (bubblewrap)

What chat does today (verified, `agent/sandbox.ts`, `docker-compose.yml`):

- `bwrap --die-with-parent --new-session --unshare-user --unshare-pid --unshare-ipc --unshare-uts --cap-drop ALL`.
- Read-only `/usr` and selected `/etc` files; HOME, workspace and conversations read-write; `--clearenv`; private
  `/tmp`, `/proc`, `/dev`. **The network is shared.**
- Fail closed unless `system.sandbox.mode = none`.
- In Docker it needs `seccomp=unconfined`, `apparmor=unconfined` and `systempaths=unconfined`. Docker's default
  profiles and masked `/proc` block user namespaces and a fresh `/proc`.

Verified here today: `bwrap` is `/usr/bin/bwrap`. `bwrap --unshare-net` gives a namespace whose `lo` is up with
`127.0.0.1/8`, so a forwarder can listen on loopback inside it. `socat` is installed.

What this app needs differently:

1. **The shared network is a hole.** `gate()` in `src/server/auth.ts` exempts loopback, because the desktop talks
   to itself. The web host runs with `accessToken: ""` and relies on oauth2-proxy. A sandboxed agent on a shared
   network could call `127.0.0.1:<port>/api/hid/...`, and the kvmd proxy would attach the PiKVM credentials for it,
   skipping every approval. So the sandbox **must** use `--unshare-net`. Chat notes the same gap: its
   `system.sandbox.network=false` is "only useful with the gateway on a unix socket, which is not built yet".
2. **The agent surface is a unix socket.** The server listens on `<data>/chat/run/agent.sock`, mode 0600. The sandbox
   bind-mounts it and starts a forwarder before omp: `socat TCP-LISTEN:47600,bind=127.0.0.1,fork,reuseaddr
   UNIX-CONNECT:/run/agent.sock &` then `exec omp ...`. Generated config points at `http://127.0.0.1:47600`. The
   forwarder dies with the pid namespace.
3. **Egress is only models, the PiKVM and user-added MCP servers**, all through the gateway. No `curl`, no `git clone`,
   no package installs. That is the intent for a PiKVM operator.
4. **Modes** (`agent.sandbox.mode`): `auto` (default), `required` (fail closed; the only mode where the *full* profile
   may be enabled), `none` (developer escape hatch). `auto` uses bwrap when the probe passes and otherwise runs the
   *computer* profile unsandboxed. The probe result and reason show on the Agent settings page.
5. **Platforms.** Linux with unprivileged user namespaces gets bwrap. In Docker that needs the opt-in options in
   section 7. Flatpak and some distros block nested user namespaces `[INFERENCE]`, and `auto` then falls back.
   **macOS and Windows have no bwrap**: *computer* profile only. We build no `sandbox-exec` or AppContainer layer.
6. **Single operator** means one HOME (`users/operator/home`) and no per-user quotas. Keep the global
   `system.agent.maxProcesses` and the idle reaper.

### 2.5 Tool profiles: what the agent can do without a sandbox

Chat's custom-agent overlay (`renderAgentProfile()` in `agent/config.ts`) already denies every built-in tool outside
a capability list. It is passed as `--config` and mounted read-only.

One verified trap: omp mounts MCP servers and many built-ins as devices at `xd://` URLs. The model reaches them
through the `read` and `write` tools (`CH/docs/spec/custom-agents.md:116`; omp `sdk.ts:4330-4420`). Denying those two
tools would cut MCP too.

The escape hatch is the omp setting `tools.xdev` (boolean, default true, `tools/settings.ts:1012`). Its description:
"Disable to expose every enabled tool top-level".

The **computer** profile is the default on every platform:

- `tools.xdev: false`, so MCP tools appear top-level as `mcp__pikvm_*`.
- Launch with `--tools ask,todo --no-skills --no-rules --no-extensions`, and `mcp.enableProjectConfig: false`.
- `tools.approval` denies every other built-in in `FALLBACK_TOOLS`. Switches `web_search`, `fetch` and `browser` are off.
- omp memory is off. The cwd is an empty per-conversation directory. The environment holds only `HOME`, `PATH`, `LANG`.
- Stdio MCP servers are refused, because without a sandbox they would run as the operator. Remote MCP servers use the gateway.
- `[INFERENCE]` MCP tools stay visible under `--tools`. omp's source says custom and extension tools are always
  included (`sdk.ts:4378-4380`). S1 proves it: the fake model lists its tools, and any name outside the expected set fails the test.

The **full** profile is opt-in. It needs `sandbox.mode=required` and a passing probe. It is chat's normal tool set
inside bwrap with `--unshare-net`. The "Default permissions / Full access" pill maps to `tools.approvalMode` `write`
or `yolo`, as in chat.

Residual risk of the computer profile without a sandbox, stated plainly:

- omp runs as the same OS user as the server, but has no tool that reads files, runs commands or makes requests.
- Reaching `/proc/<pid>/environ`, `pikvm-credentials.json` or `chat.db` would need a bug in omp or a tool we failed to deny.
- The sandbox removes that class of bug, so it is on by default wherever the platform allows it.

## 3. Security boundary

Rule: **PiKVM credentials, the access token and every provider key exist only in the server process.** They are
never in the agent's environment, files, config or prompt.

| Secret | Lives in | Reaches the agent? |
|---|---|---|
| kvmd user and password | `pikvm-credentials.json` (0600, desktop) or `PIKVM_PASSWORD` env (web host), held by the Desk | No. The agent calls MCP tools; the Desk talks to kvmd |
| Access token, oauth2-proxy session | server only | No |
| Provider API keys | settings KV, redacted on read, sealed with `mcp/crypto.ts` | No. Every provider goes through `/gw/<id>` |
| Remote MCP tokens | `mcp_credentials`, sealed | No. Same gateway pattern (`/mcp/s/<id>`) |
| Agent token | minted per start, HMAC of `secret.key` | Yes, but it only opens the agent surface |

Two deliberate changes to chat:

- Chat writes a user-owned provider's key into `models.yml` inside the sandbox (`agent/config.ts:116-124`). We remove
  that branch and treat every provider as chat's "global" kind, served through the gateway.
- Chat stores provider keys unsealed (`settings/store.ts` has no sealing). The lift seals them with `mcp/crypto.ts`,
  AES-256-GCM keyed from `secret.key`.

The **agent surface** (`createAgentSurface`) is the only thing the agent can reach:

- A separate `http.Server`, not a path on the main listener. It serves `/gw/*` and `/mcp/*` and nothing else.
  It has no `/app`, no kvmd proxy and no static files.
- It listens on `<data>/chat/run/agent.sock` when the sandbox uses `--unshare-net`, and on `127.0.0.1:0` otherwise.
- Every request needs `Authorization: Bearer <agent token>`. `X-Chat-Conversation` names the conversation, so
  approvals reach the right thread.
- On the desktop the main listener keeps trusting loopback. The agent has no path to it: the computer profile has
  no network-capable tool, and the full profile has no network.
- On the web host, `PIKVM_AUTH=proxy` must also **refuse requests from a loopback peer** (except the public health
  route). The proxy connects over the compose network, so this costs nothing and closes the shared-namespace hole.

How the MCP server is exposed:

| Option | Verdict |
|---|---|
| In process, no transport | Not possible: omp is a separate process speaking MCP over stdio or HTTP |
| stdio child of omp | **No.** The child would need kvmd credentials in its environment, which is the leak we avoid |
| HTTP on the agent surface (`/mcp/pikvm`) with the token | **Yes.** Same pattern as chat's `/mcp/conversations`, proven with omp |

Other requirements:

- **WebSocket Origin.** `/app/chat/ws` rejects an `Origin` whose host differs from `Host`. Chat's upgrade checks only the
  session. On the desktop the loopback exemption would otherwise let any web page open `ws://127.0.0.1:<port>` and approve actions.
- **CSRF header.** Mutating `/app/chat/api/*` requests need chat's `x-chat-request` header. Browsers cannot set it
  cross-origin without a preflight, which this server never answers. It plays the role `WORKSPACE_HEADER` plays now.
- **No unattended control.** A run starts only from a user message.
- **One desk lease.** A single run holds PiKVM control at a time. Another conversation gets a clear tool error.
- **SSRF.** The gateway forwards to an operator-configured `baseUrl`, and the operator is trusted. Remote MCP servers keep
  the `guardedFetch` rules in `mcp/net.ts`.

## 4. The PiKVM computer-use MCP server

Package `packages/pikvm-mcp` (`@pikvm/mcp`) holds the tool definitions, a `Desk` port, a risk classifier and the MCP
request handler. The server adapter lives in `src/server/agent/`.

```
agent (omp) --HTTP--> agent surface /mcp/pikvm --> @pikvm/mcp handler
                                                    |-- Approver: chat mcp/interactions.ts (elicit)
                                                    '-- Desk: src/server/agent/desk.ts
                                                         |-- kvm-engine target link (ws), HID types, view geometry
                                                         |-- kvmd snapshot over HTTP (the proxy's credentials)
                                                         '-- OperatorPresence: user HID seen by the kvmd proxy
```

### 4.1 Tools

Model-visible names are `mcp__pikvm_<tool>`. Every coordinate is an integer in the reference frame (4.2).

| Tool | Arguments | Does | Risk |
|---|---|---|---|
| `screenshot` | `region?` | Fresh JPEG plus text: frame size, frame id, mouse mode, online state. With `region`, a higher-detail zoom | observe |
| `read_text` | `region?` | OCR through kvmd (`/api/streamer/snapshot?ocr=1`, already in `tools/fake-kvmd`) | observe |
| `mouse_move` | `x, y` | Eased move | input |
| `click` | `x, y, button?, count?` | Move, press, release. `count 2` double clicks; `button right` right clicks | input |
| `drag` | `from, to, button?` | Press, move, release. Always released, also on error | risky |
| `scroll` | `x, y, dx?, dy?` | Wheel at a point | input |
| `type_text` | `text` | Types with the target's keymap; a newline is Enter | input, or risky (4.4) |
| `key` | `keys` | One or more chords such as `ctrl+c`; modifiers always released | risky for the 4.4 list |
| `wait` | `ms?, until_stable?` | Pause, or wait for two identical frames (the existing "settled" rule) | observe |
| `screen_info` | none | Resolution, mouse mode, HID and source online, who holds control | observe |
| `power` | `action` | ATX on, off or reset. Off by default (`agent.pikvm.allowPower`) | always approve |

Not offered: raw HID, virtual media, GPIO, paste-as-print, stream settings. The operator uses the KVM tab for those.

Tools return text errors the model can act on, not protocol errors: `control_released`, `stale_frame`,
`target_offline`, `another_conversation_holds_control`, `approval_denied`.

### 4.2 Coordinate system

- The **reference frame** is the downscaled full-screen image the last `screenshot` returned. Its long edge is at most
  1280 px (`agent.pikvm.maxEdge`), aspect kept. Every result states `W x H`.
- All coordinate arguments use the reference frame. A zoom takes its region in the reference frame and returns a
  larger crop. Click coordinates never use the crop's pixels.
- The Desk maps reference pixels to kvmd absolute units (-32768..32767 per axis) with `@pikvm/kvm-engine/view`
  geometry and the streamer's native resolution. The KVM screen uses the same maths, so agent and person cannot
  disagree about where a pixel is.
- In relative-mouse mode the Desk sweeps to a corner and steps, as the engine's pointer code does
  (`ABS_SWEEP_MS`, `REL_CHUNK`).
- Input is refused with `stale_frame` after the native resolution changes, and before the first screenshot of a conversation.
- Downscaling uses the `ImageOps` seam: `nativeImage` in Electron, `sharp` in the web host. It replaces `noImageOps`.
  `[INFERENCE]` sharp's prebuilt binary installs on bookworm-slim for x64 and arm64; S5 proves it.

### 4.3 Built on the engine

`@pikvm/kvm-engine` provides the target link (`createTargetLink`, a socket factory seam, an outbound queue that
drops stale frames, reconnect), HID wire types, `view` geometry, keyboard maps, macro and paste runners, and test
fakes. It has only a browser socket (`browserSocket`). S2 adds, in new files:

- `target/node-socket.ts`: a `SocketFactory` over `ws` with kvmd auth headers and TLS verification off (the Pi's
  certificate is self-signed). It is exported as `@pikvm/kvm-engine/node`, so the browser bundle never imports `ws`.
- `agent/` (subpath `@pikvm/kvm-engine/agent`): deterministic agent-side input. Eased absolute move, press and
  release with release-always, wheel, chord, and typing through the keymap.

This is not the gesture machine in `pointer/`, which interprets fingers. The `KvmEnginePointer` work owns
`pointer/`. S2 only consumes shared HID types and geometry.

`src/windmouse.ts` and `src/human-typing.ts` are ported if their cadence is wanted, and deleted otherwise.
`PiKvmControl` (`src/pikvm-control.ts`, 1,173 lines) mixes the proxy target, the jiggler's cursor tracking, HID state
and the agent's screenshot, typing and mouse. After S2, whatever the Desk and the jiggler stop calling is deleted,
decided by `tsc` and the tests.

### 4.4 Approvals for risky actions

Approval is **server-side MCP elicitation**, not omp's per-tool gate, because the gate cannot see arguments.

- The handler calls chat's `elicit()` or `confirmDestructive()` (`mcp/interactions.ts`). The form appears in the thread
  of the conversation that made the call, bound to the running tool call by `callFor`.
- With no running response the request is refused, never queued. Nothing waits on a user who is not there.
- omp's own MCP client declares only `roots` (`docs/spec/mcp-support.md` 2.1), which is why chat's gateway adds the
  elicitation capability. Our built-in server talks to the thread directly, so it needs neither that nor the fork's elicitation patches.

Policy `agent.pikvm.approval`:

| Value | Effect |
|---|---|
| `risky` (default) | Ask for the risky set below |
| `always` | Ask before every input action |
| `never` | Never ask |

The composer's permission pill maps "Default permissions" to `risky` and "Full access" to `never`.

Initial risky set, to be tuned from use. The Python harness's `dangerous_commits` and the policy near
`agent.py:3314` are the starting reference.

- Chords: the Windows, Super or Cmd key alone; `ctrl+alt+del`, `alt+f4`, `ctrl+w`, `ctrl+shift+delete`; `ctrl+alt+f1` to `f12`.
- Any `drag`, and any `power` action.
- `type_text` containing a newline, or over 200 characters.
- Any input when the Desk has no screenshot from the last 30 s.

Never asked: `screenshot`, `read_text`, `wait`, `screen_info`, plain `click`, `mouse_move`, `scroll`, and short
single-line `type_text`. A denial returns `approval_denied`, and the model is told not to retry the same action.

### 4.5 Cursor takeover

Today the page reports the person's pointer with `POST /app/daemon/cursor` (from `cursor-report.ts`), and the
Python daemon ends the agent's control.

The server already parses the person's HID frames. `src/server/proxy/kvmd.ts` taps the proxied socket
(`makeHidTap`, `onHidActivity`, `onHidMouseMove`). Agent input does not pass that proxy, because the Desk has its
own link. So the tap sees people only.

The rule, enforced in the Desk and independent of any page:

1. Control is **granted** when a run starts, meaning the person sent a message.
2. Control is **released** by any user mouse move, button, wheel or key seen by the proxy after the grant, by Stop,
   by the run ending, or by the lease timing out.
3. On release the Desk aborts the action in flight through an `AbortSignal`, and releases every held button and key.
   Later calls return `control_released`: "The person took over the mouse. Stop and ask them to hand control back."
4. Control returns only by an explicit act: another message, or **Hand back** in the KVM banner. Moving the mouse never re-grants.
5. The jiggler's `isAgentBusy` becomes `desk.busy()`. It is `() => false` today in `src/server/index.ts`.

This deletes `POST /app/daemon/cursor`, `cursor-report.ts`, `createCursorRelay` and the daemon proxy.

### 4.6 How the KVM tab shows agent activity

Server routes, behind the gate:

- `GET /app/api/v1/agent/activity`: SSE emitting `{state, conversationId, tool?, pointer?, at}`. `state` is one of
  `idle`, `working`, `waiting_approval`, `released`.
- `POST /app/api/v1/agent/stop` aborts the run. `POST /app/api/v1/agent/handback` re-grants control.
- The two POSTs and the event schema are typed in `@pikvm/contracts`.

KVM tab:

- A slim banner chip over the picture: "Agent is working - Stop - Take over".
- The agent's pointer, drawn with the engine's view maths and the existing cursor overlay. An outline on the picture while `working`.
- `waiting_approval` shows "Needs your approval" with a button to the Chat tab. The nav tab gets an attention dot,
  using `apps/web/src/kvm/attention.ts`.

Chat tab: the `mcp__pikvm_screenshot` card shows its thumbnail with the action's point drawn on it.

## 5. Integration into our server and app

### 5.1 Server layout

```
src/server/
  routes.ts      the one route table, edited
  chat/          adapter from node:http to chat-server: REST, upgrade, features probe
  agent/         desk.ts, presence.ts, activity.ts, approver.ts, agent-surface wiring
packages/chat-protocol   zod wire types
packages/chat-server     ported chat server
packages/pikvm-mcp       tool definitions and handler
packages/chat-web        the lifted UI
packages/icons           Phosphor
```

`createChatServer({ dataDir, desk, approver, ... })` returns `handleRest`, `handleUpgrade`, `agentSurface`, `stop`
and `status`. It receives the Desk and Approver as dependencies, so chat-server never imports PiKVM code.

### 5.2 Routes

All under `/app`, in this order in `routes.ts`:

| Path | What |
|---|---|
| `/app/chat/api/*` | Chat REST. Gate, then `x-chat-request` for mutations, then chat's Hono app. Replaces `/app/harness/*` |
| `/app/chat/ws` (upgrade) | Responses-style WebSocket. Gate, Origin check, then `ws`. Today every `/app` upgrade answers 404 |
| `/app/chat/media/*` | Provider logos and upload bytes (GET) |
| `/app/api/v1/state` | Adds `features.chat` and `features.agent` (runtime, sandbox, profile, reason) |
| `/app/api/v1/agent/*` | Activity, stop, hand back (4.6) |
| `/app/chat` | Client route; the app's `index.html` (already in `isAppPage`) |

Removed: `/app/harness/*`, `/app/daemon/*`, `/app/workspace/*`, and the env pairs `PIKVM_HARNESS_URL`,
`PIKVM_HARNESS_TOKEN`, `PIKVM_DESKTOP_URL`, `PIKVM_DESKTOP_TOKEN`.

`features.chat` is now "chat server ready and omp found", replacing "the sidecar answers its health route".
The agent surface is not in this table: it is a second listener (section 3).

### 5.3 Contracts

- Chat REST and the WebSocket use `@pikvm/chat-protocol`.
- `@pikvm/contracts` gains `Features.agent` and the agent activity, stop and hand-back schemas.
- WebSocket events are chat's: `response.create`, `response.cancel`, `mcp_approval_response`, then `response.*`,
  `chat.conversation.updated`, `chat.notice`, `chat.queue`, `chat.sync`. We add none.
- PiKVM state travels on the activity SSE, so the KVM tab never needs the chat socket.

### 5.4 The Chat tab in `apps/web`

- `apps/web/src/chat/chat-route.tsx` shrinks to host states (server unreachable, omp missing, sandbox note) around
  `<ChatPane/>` from `@pikvm/chat-web`, inside `<ChatScope>`. `ChatScope` sets tokens, Fluent, and a query client
  namespace so chat's cache keys cannot collide with ours.
- `@pikvm/chat-web` exports `ChatPane`, the Settings pages and `ChatScope`. `ChatPane` is the conversation list
  plus `ConversationPane` plus composer. It reads `COMPACT_QUERY` and the shell's `--app-height` and safe-area
  variables, and never positions against the window.
- **Keep-mounted tabs.** The AppShell work in progress (`apps/web/src/app/panes.test.tsx` is in the tree) keeps the KVM
  and Chat panes mounted once visited and hides them with `hidden`. The picture, the sockets and a streaming reply
  survive a tab switch. The Chat chunk still loads lazily, then stays mounted.
- **Phone.** The bottom nav stays. The composer sits above it and above the soft keyboard; `useViewportFrame` already
  hides the bar while the keyboard is open. Chat's swipe engages only after a mostly horizontal pan, and not in the
  first 16 px at the screen edge, so it does not fight the OS back gesture.
- **Desktop look.** Our titlebar and rail stay. `ChatScope` sets the three seeds from our theme variables. S3 checks
  light and dark by screenshot.

### 5.5 Settings integration

Our Settings keeps connection, keyboard, input, display, audio, macros, alerts, keep-awake, account and about. It
replaces `settings/providers/*`, which is Python-backed, with pages from `chat-web`, styled by `ChatScope`:

- **Providers**: catalogue gallery, key `SecretRow`, test connection, per-model enable.
- **Models**: default model and roles.
- **MCP servers**: add a remote server, OAuth connect, per-tool policy.
- **Agent**: approval policy, permission default, desk lease, sandbox mode and probe result, and PiKVM switches such
  as `allowPower` and `maxEdge`.

Every key is declared in the `@pikvm/chat-protocol` settings schema, following chat's rule: no ad hoc settings.
Provider keys are write-only from the browser, as `docs/PLAN.md` section 9 already decides.

### 5.6 Data directory

Existing files stay where `SettingsStore` and `target-store` put them. Chat adds one subtree, built only by
`packages/chat-server/src/paths.ts`:

```
<data>/                          PIKVM_DATA_DIR (web host) or the desktop's data dir
  settings.json  macros.json  pikvm.json  pikvm-credentials.json     unchanged
  chat/
    chat.db                      SQLite (node:sqlite), WAL
    secret.key                   0600: gateway tokens, key for sealed secrets
    run/agent.sock               the agent surface when sandboxed
    cache/models.dev.json, cache/logos/
    users/operator/
      home/                      the agent's HOME; .omp/agent/{models.yml,mcp.json,config.yml} are GENERATED
      workspace/chats/<id>/      a conversation's cwd (empty in the computer profile)
      uploads/<id>/<name>        composer uploads
      conversations/<id>/*.jsonl omp session files: the conversation content
```

Back up `<data>/chat` and `<data>/pikvm-credentials.json`. Conversations are plain JSONL.

## 6. Deletions (clean cutover)

Nothing stays as a fallback. Each row names its replacement.

| Delete | Replaced by |
|---|---|
| `agent/` Python package (644 tracked files: harness, daemon, mcp_server, cua, graph, benchmarks, `uv.lock`, `pyproject.toml`, configs, docs, tests, `runtime/`, `runtime-win32-x64/`) | `chat-server`, `pikvm-mcp` |
| `agent/frontend` and the built `agent/pikvm_agent/harness_ui` | the app itself |
| `deploy/agent/` and the `kvm-agent` compose block | `deploy/Dockerfile` |
| `deploy/web/Dockerfile` | `deploy/Dockerfile` |
| `packages/chat-ui` | `packages/chat-web` |
| `apps/web/src/settings/providers/*` and its test | chat-web Providers, Models, MCP and Agent pages |
| `apps/web/src/kvm/cursor-report.ts`, its test and call site | server-side takeover (4.5) |
| `HARNESS_API_BASE`, `HARNESS_MANAGED_TOKEN` in `apps/web/src/host/paths.ts` | `CHAT_API_BASE` |
| `src/server/proxy/{harness,daemon}.ts`, `src/server/workspace.ts` | `src/server/chat/` |
| `src/harness-manager.ts`, `harness-runtime.ts`, `service-manager.ts`, `agent-runtime.ts`, `agent-target.ts`, `mcp-launch-plan.ts` | `createChatServer()` in main |
| `src/mcp-launcher*.ts` (open question 4), `src/endpoint.ts` where only the harness used it | none |
| `src/main.ts` daemon and harness port-walking, `reportMissingAgentRuntime`, handoff files | omp lookup and `features.agent` |
| `src/web-server.ts` `resolveHarnessUpstream`, the harness and desktop env pairs, `noImageOps` | agent options, sharp `ImageOps` |
| `scripts/build-agent-runtime.mjs`, Make targets `agent-runtime`, `agent-bundle`, `web-bundle`, the runtime copy and `--allow-no-runtime` in `scripts/package.mjs`, the runtime step in `.github/workflows/package.yml` | `scripts/fetch-omp.mjs` |
| `tools/fake-model/server.py` | `tools/fake-model/server.ts` |

Tests and docs that only cover the above:

- Tests: `tests/agent-runtime*.test.ts`, `agent-target`, `daemon-proxy`, `harness-manager`, `harness-proxy`,
  `harness-runtime`, `service-manager`, `workspace-assets`, and `mcp-launcher` if it is deleted. Edit the harness
  cases in `routes.test.ts`, `web-auth.test.ts`, `desktop-layout.test.ts` and `desktop-startup.test.ts`.
- Docs: the `*chat-sidecar*` and `*chat-desktop*` records in `docs/e2e/` are regenerated. Mark
  `docs/rebuild/agent-chat-map.md` superseded. Rewrite the agent half of `docs/deploy-web.md`. In `docs/PLAN.md`,
  rewrite phases 3 and 5, domain 6, and the "no licence, patterns only" line.
- Not touched here: the legacy console `src/views/console.*`. The KVM phase already schedules its deletion.

**Keep, and why**

- `tools/fake-kvmd`: the target of every E2E in this plan.
- `src/target-store.ts`: `pikvm.json` plus the 0600 credentials file. The Desk reads from it.
- `src/server/proxy/kvmd.ts` and its HID tap: the takeover rule depends on it.
- `src/mouse-jiggler.ts`: unrelated to the agent. Only `isAgentBusy` is rewired.
- `src/pikvm-control.ts`: still owns the proxy target and the jiggler's tracking. Shrunk, not deleted, until `tsc` says so.
- `agent/docs/PIKVM_API.md` and `CUA.md`: read first, and move any kvmd quirk the Desk needs into `docs/` before deleting.

## 7. The single Dockerfile

`deploy/Dockerfile`, built from the repo root with `docker build -f deploy/Dockerfile .`. It replaces
`deploy/web/Dockerfile`, `deploy/agent/Dockerfile`, `make web-bundle` and `make agent-bundle`.

Stages:

1. `omp`: download the pinned release asset for `TARGETARCH` and verify its sha256 from `deploy/omp.lock`.
2. `build` (`node:22-bookworm-slim`): `corepack enable`, `yarn install --immutable`, `yarn build`, then
   `yarn workspace @pikvm/web build`. Copy the chat migrations to `dist/chat-migrations`.
3. Runtime (`node:22-bookworm-slim`): `apt-get install bubblewrap socat tini ca-certificates`, `npm i --omit=dev sharp`,
   the omp binary at `/opt/omp/omp`, `dist/` and `apps/web/dist`.

Why bookworm and not alpine: omp's glibc binary and sharp's prebuilt are the supported pair. Alpine would need the musl omp build.

Contents: the web host, the web app, the omp binary, and bubblewrap with socat for the optional sandbox. No Python,
no Bun, no provider CLIs, no tesseract. Expect omp (240 MB) plus Node, against about 1.6 GB for the old sidecar alone.

Hardening that stays:

- Non-root (uid 10001, `/data` owned), `read_only: true` with `tmpfs: /tmp`, `cap_drop: [ALL]`, `no-new-privileges`.
- A healthcheck on the public `/app/login`, and `tini` as init.
- The agent surface is a unix socket inside the data volume, never a published port.
- `PIKVM_AUTH=proxy` also rejects loopback peers (section 3).

The sandbox needs more, so it is opt-in:

- User namespaces inside Docker need `seccomp=unconfined`. Chat's compose also sets `apparmor=unconfined` and
  `systempaths=unconfined` for the fresh `/proc`.
- `[INFERENCE]` `cap_drop: ALL` and `no-new-privileges` still allow bwrap, because it uses unprivileged user
  namespaces that need neither. S5 proves it with podman and docker, both installed on the build machine.
- Default for the web host: `agent.sandbox.mode=auto` with stock security options. That means the *computer* profile, and no
  relaxed seccomp on the container that holds the PiKVM password.
- The full profile is a documented override: `security_opt: [seccomp=unconfined, apparmor=unconfined,
  systempaths=unconfined]` with `PIKVM_AGENT_SANDBOX=required`.

Environment:

| Variable | Status | Meaning |
|---|---|---|
| `PIKVM_URL`, `PIKVM_USER`, `PIKVM_PASSWORD`, `PIKVM_AUTH`, `PIKVM_DATA_DIR`, `PORT`, `PIKVM_KEYBOARD_LAYOUT`, `PIKVM_JIGGLER` | unchanged | As today |
| `OMP_BIN` | new | Path to the omp binary; default `/opt/omp/omp` |
| `PIKVM_AGENT_SANDBOX` | new | `auto` (default), `required` or `none` |
| `PIKVM_HARNESS_URL`, `PIKVM_HARNESS_TOKEN`, `PIKVM_DESKTOP_URL`, `PIKVM_DESKTOP_TOKEN` | removed | The host refuses to start if they are set |

**A deployment's compose file** (not applied from this repo):

- Remove the `kvm-agent` service, its data volume and `KVM_HARNESS_TOKEN` from `.env`.
- Remove the two `PIKVM_HARNESS_*` lines on `kvm`.
- `kvm` keeps its data volume; the first start creates `/data/chat`.
- The Python side's `provider-keys.json` and CLI sign-ins are not migrated (open question 1). Enter keys in Settings.
- oauth2-proxy skip routes are unchanged. The agent surface is unreachable from outside the container.

`deploy/e2e/compose.yml` becomes `kvm` (this image) plus `fake-kvmd` and `fake-model`, both Node from this repo.
The old trick of putting the fake model in the sidecar's network namespace goes: chat's gateway accepts any
operator-configured `baseUrl`.

## 8. Desktop (Electron)

- `src/main.ts` calls `createChatServer()` in the main process, beside `startControlServer()`. No daemon, no
  harness, no port walking, no handoff files, no `ManagedService`.
- Data lives in `chat/` under the directory `settings.dir()` returns.
- The omp binary is `process.resourcesPath/omp/omp[.exe]` when packaged, and `OMP_BIN` or PATH in development.
- `scripts/package.mjs` copies the binary for the target, fetched by `scripts/fetch-omp.mjs` with a sha256 check,
  where it now copies CPython. `make agent-runtime` and `--allow-no-runtime` go. A tree without the binary is
  refused, as a tree without the runtime is today.
- Package size drops: the Python runtime was 430 to 800 MB per platform, and omp is about 240 MB.
- The server runs in Electron's Node 22.22.1, which loads `node:sqlite` (verified). No native addon needs an Electron rebuild.
- Sandbox: Linux with working user namespaces gets bwrap (`auto`), in AppImage, deb, rpm and Arch packages. Flatpak
  `[INFERENCE]` probably cannot nest namespaces and falls back. macOS and Windows run the computer profile only.
- The loopback gate exemption stays on the desktop. The WebSocket Origin check is what stops a web page from using it.
- Windows: the agent surface is `127.0.0.1:0` with the token, since omp's MCP config takes a URL. No unix socket, no sandbox.
- `ImageOps` stays `nativeImage`. Window controls, titlebar and attention dot are unchanged.
- Signing and notarisation now cover one more executable: sign `resources/omp/omp` with the app.

## 9. Slices

Ordering keeps the tree working. Nothing in wave 1 changes a route or deletes something the running app uses. Each
slice ends with its tests green and touches only the files it owns.

### Wave 1: four agents in parallel

#### S0. Phosphor icons, app-wide (owner A, independent, can land first)

Lift `CH/packages/icons` to `packages/icons` (`@pikvm/icons`):

- Files: `src/icon.tsx`, `src/index.ts`, `src/generated/*` (committed, 6.3 MB), `scripts/*`, `LICENSE` (MIT, Phosphor),
  `README.md`. `preview.html` is generated and can be dropped.
- Remove `@types/bun` and the `bun` tsconfig type. The `build` script becomes
  `node --experimental-transform-types --disable-warning=ExperimentalWarning scripts/build.ts`.
- Add `@pikvm/icons` to the workspace and to `apps/web`. It exports TypeScript source, like `kvm-engine`.
  `@phosphor-icons/core@2.1.1` and `react` are devDependencies of the package only.

Verified on this machine:

- The generator runs under Node with `--experimental-transform-types` in 17 to 32 s and writes 1513 modules.
- Plain strip-types fails on a parameter property at `scripts/svg-path.ts:18`. `[INFERENCE]` rewriting it as a field
  plus constructor makes strip-types work too.
- Bun's output equals the committed files exactly. Node's output differs in 11 of 1513 files by 0.1 units in a few
  path numbers, which is float rounding between engines (for example `ArrowFatLeft`).
- So regenerate once under Node and commit that. The acceptance check is `node ... scripts/build.ts --output $(mktemp -d)`
  followed by `diff -r` against `src`, with no output.

Replace the hand-drawn glyphs (inline `<svg>` in three files):

- Delete `apps/web/src/ui/icons.tsx`, `apps/web/src/kvm/icons.tsx` and `apps/web/src/settings/providers/icon.tsx`.
- Update the five importers: `app/nav.tsx`, `app/window-controls.tsx`, `settings/pages.tsx` (two) and `settings/settings-layout.tsx`.
- Import Phosphor components directly, for example `<Monitor weight={active ? "fill" : "regular"} />`. Chat's weight rule:
  outline by default, `fill` for active, selected or on.

Where lucide really is, counted in this tree on 2026-11-02:

- 29 files import `lucide-react`, **all in `packages/chat-ui`**. The name also sits in `packages/chat-ui/package.json`
  and `agent/frontend/package.json`. `apps/web` has none.
- Both packages are deleted in S6, so S0 does **not** migrate them; that would be throwaway work.
- If S6 slips past wave 2, run the mapping below over those 29 files before merging. S6's final check proves nothing is left.

Mapping approach: one typed record per file, or a codemod keyed on the import name. These are all 64 lucide names
found, with Phosphor exports that exist in `@pikvm/icons` (each checked against the generated modules except where noted).

| lucide | Phosphor | lucide | Phosphor |
|---|---|---|---|
| Activity | Pulse | MonitorOff | Monitor plus Prohibit badge (no slash variant) |
| AlertCircle, CircleAlert | WarningCircle | MonitorPlay | MonitorPlay |
| Archive | Archive | MoreHorizontal | DotsThree |
| ArrowDown, ArrowUp | ArrowDown, ArrowUp | MousePointer2 | Cursor |
| Bot | Robot | Move | ArrowsOutCardinal |
| Brain | Brain | PanelLeft, PanelRight | SidebarSimple (mirrored for right) |
| Check | Check | Pause, Play | Pause, Play |
| CheckCircle2 | CheckCircle | Pencil | PencilSimple |
| ChevronDown, Right, Up | CaretDown, Right, Up | PictureInPicture2 | PictureInPicture |
| CircleDotDashed | CircleDashed | PlugZap | PlugsConnected |
| Clock3 | Clock | Plus | Plus |
| Command | Command | Radio | Broadcast |
| Copy | Copy | RefreshCw | ArrowsClockwise |
| Crosshair | Crosshair | RotateCcw | ArrowCounterClockwise |
| Download | DownloadSimple | ScanSearch | Scan |
| Eye | Eye | ScrollText | Scroll |
| FileText | FileText | Search | MagnifyingGlass |
| Film | FilmStrip | Settings2 | Sliders |
| GalleryVerticalEnd | Rows, or Images for a media gallery (no exact match) | ShieldAlert | ShieldWarning |
| Gauge | Gauge | Sparkles | Sparkle |
| Grip | DotsSixVertical | Square | Stop for a stop button, else Square |
| Keyboard | Keyboard | SquareTerminal | TerminalWindow |
| Loader, Loader2, LoaderCircle | SpinnerGap, with the existing spin class | TableProperties | Table |
| LockKeyhole | LockKey | Trash | Trash |
| LogOut | SignOut | TriangleAlert | Warning |
| Menu | List | WifiOff | WifiSlash |
| Mic | Microphone | X, XCircle | X, XCircle |
| Monitor | Monitor | | |

The app's own glyphs map as follows:

| Today | Phosphor |
|---|---|
| `MonitorIcon`, `ChatIcon`, `SettingsIcon` | Monitor, ChatCircle, Gear |
| `ChevronRightIcon`, `ChevronLeftIcon`, `ChevronDownIcon` | CaretRight, CaretLeft, CaretDown |
| `LinkIcon`, `KeyboardIcon`, `PointerIcon`, `SunMoonIcon` | Link, Keyboard, Cursor, CircleHalf |
| `SpeakerIcon`, `BoltIcon`, `EyeIcon`, `UserIcon`, `InfoIcon`, `PinIcon` | SpeakerHigh, Lightning, Eye, User, Info, PushPin |
| `MinimiseIcon`, `MaximiseIcon`, `RestoreIcon`, `CloseIcon` | Minus, Square, CopySimple, X |
| `MicIcon`, `ZoomOutIcon`, `PasteIcon`, `MoreIcon` | Microphone, MagnifyingGlassMinus, ClipboardText, DotsThree |
| `HealthIcon`, `PowerIcon`, `KeyIcon` | Heartbeat, Power, Key |

`MacroIcon` renders a stored key from `macros.json`. A typed `Record<string, Icon>` maps each stored key to a Phosphor
icon, and **stored values do not change**:

| Stored key | Phosphor | Stored key | Phosphor |
|---|---|---|---|
| `camera` | Camera | `clipboard` | ClipboardText |
| `monitor` | Monitor | `play` | Play |
| `terminal` | Terminal | `save` | FloppyDisk |
| `power` | Power | `keyboard` | Keyboard |
| `lock` | Lock | `download` | DownloadSimple |
| `refresh` | ArrowsClockwise | `upload` | UploadSimple |
| `folder` | FolderSimple | `star` | Star |
| `search` | MagnifyingGlass | `bell` | Bell |

Any other stored key found in `MACRO_ICONS` gets the nearest Phosphor name in the same record.

The legacy console (`src/views/console.html` has 8 `<svg`, `console.js` has 16) is not touched. The KVM phase deletes it,
and its icons are inline paths, not lucide.

Checks. Add `tests/icons.test.ts`, a permanent `node:test` that fails the build:

1. No `lucide-react` in any `package.json`, in `yarn.lock`, or in `*.ts` and `*.tsx` outside `node_modules`. Before S6 it
   covers only `apps/web`, `src/` and `packages/icons`.
2. No `<svg` in `apps/web/src` or `packages/chat-web/src`, except an explicit allow-list for inline brand logos.
3. Every name imported from `@pikvm/icons` is a real export (`tsc` checks this).
4. `yarn workspace @pikvm/web test` and its typecheck pass.
5. A screenshot of the nav (compact and wide), Settings and the KVM dock, in light and dark, goes in `docs/e2e/`.

Done when `grep -rn "lucide-react" apps src packages/icons packages/kvm-engine packages/contracts` is empty and
`yarn.lock` has no `lucide-react` entry from `apps/web`.

#### S1. chat-protocol and chat-server on Node (owner B)

Owns: `packages/chat-protocol/**`, `packages/chat-server/**`, `tools/fake-model/server.ts`, `deploy/omp.lock`,
`scripts/fetch-omp.mjs`. The first commit is `chat-protocol`, so S3 can import it.

Work:

- Lift and prune per 1.1 and 1.2. Port per 2.1. Squashed `0000_init.sql`. `paths.ts` under `<data>/chat`. Constant operator. Trimmed settings schema.
- `sandbox.ts` rewritten for the binary: modes `auto`, `required`, `none`; `--unshare-net`; socket and forwarder; both profiles (2.5).
- `config.ts` writes every provider as a gateway provider, and injects the `pikvm` MCP entry with a URL the host supplies.
- `agent-surface.ts`, the second listener, and `createChatServer()`.
- The lifted fake-llm, with `pikvm:*` scenarios.

Acceptance, headless, with no `src/` changes:

1. Typecheck and unit tests pass.
2. A script starts `createChatServer` on a temp data dir with the real `omp` binary and the fake model, and runs a
   conversation over the WebSocket: text, a tool call, a stop, a restart with resume from the JSONL, an approval round trip.
3. Tool-list test: in the computer profile the fake model's tool set equals `{ask, todo, mcp__pikvm_*}` exactly.
4. Under `bwrap --unshare-net` the same conversation works through the socket forwarder, and `curl` inside fails.
5. No provider key, token or PiKVM string appears in the omp process's environment, in the generated files, or in prompts.
6. `grep -rn "Bun\." packages/chat-server/src` is empty.

#### S2. PiKVM MCP (owner C)

Owns: `packages/pikvm-mcp/**`, new files in `packages/kvm-engine/src/{target/node-socket.ts,agent/**}`,
`src/server/agent/{desk,presence,activity,approver}.ts`, the HID tap classification in `src/server/proxy/kvmd.ts`, and
`tools/fake-kvmd/**` (resolution control and anything else the tests need).

Work: sections 4.1 to 4.6, a tiny MCP client test helper, and the `Approver` and `Desk` ports so it runs without chat-server.

Acceptance against `tools/fake-kvmd`:

- Each tool produces the exact HID records (`GET /__fake/hid`), including release-always when aborted.
- Coordinate mapping round-trips against the engine geometry at three resolutions and in both mouse modes.
- `stale_frame` fires. A user HID frame through the proxy releases control, held keys and buttons are released, and the next call says so.
- Risky chords ask and never-asked tools do not. A denial or a missing UI refuses.
- Two conversations contend for the lease. `jiggler.isAgentBusy` follows `desk.busy()`.

#### S3. chat-web lift (owner D, starts after S1's first commit)

Owns: `packages/chat-web/**`.

Work:

- Copy and prune per 1.3 until `tsc` is clean. Make the REST and WebSocket bases configurable.
- `ChatScope` (tokens, Fluent en-GB, query client namespace) and the container-relative mobile drawer.
- `ChatPane`, the Settings pages (Providers, Models, MCP servers, Agent), and the `mcp__pikvm_*` tool card.
- Phosphor from `@pikvm/icons`. No `lucide-react`, and no direct `@phosphor-icons/react` import.
- Develop against the lifted `thread-preview-harness` and canned events, then against S1's server through the vite proxy.

Acceptance:

- Lifted unit and component tests pass, and `tsc` is clean.
- A browser run at 390x844 (touch) and 1280x800 shows conversation, streaming, an approval card, the model picker
  (a sheet on phone), the long-press message sheet, the drawer swipe, and the composer above the keyboard inset.
- Light and dark both render. The Chat chunk loads only on first open.

### Wave 2: three agents, after the named wave-1 slices land

#### S4. Integration (needs S1, S2 and S3; owner B or C)

Owns: `src/server/{routes.ts,index.ts,chat/**}`, agent-surface wiring, `src/web-server.ts`, the chat wiring in
`src/main.ts`, `packages/contracts/src/api.ts`, `apps/web/src/{chat,settings,host,api}/**`, a new KVM agent banner, and
`apps/web/src/app/panes.tsx` (coordinate with AppShell, who own it today).

Work: sections 5 and 4.6, the Origin check, loopback refusal under `PIKVM_AUTH=proxy`, `features`, the Settings pages,
the activity SSE and banner, the keep-mounted Chat pane, and removal of the `/app/harness` and `/app/daemon` routes and the cursor reporter.

Acceptance. E2E in `apps/web/e2e` with fake-kvmd, fake-model and the real omp:

- "Please click the centre" in Chat produces a click in `/__fake/hid` with no approval.
- "Please approve" shows an approval card. Approve sends the chord; deny sends nothing.
- Stop mid-run works. Moving the mouse in the KVM tab ends control and the thread says so. Hand back restores it.
- A streaming reply survives KVM, Chat and Settings switches. The phone profile works with the soft keyboard.
- A WebSocket upgrade with a foreign Origin is refused.
- Inside `bwrap --unshare-net`, a connection to `127.0.0.1:<main port>` is refused.

#### S5. Packaging: Docker and desktop (owner C or D)

Owns: `deploy/Dockerfile`, `deploy/e2e/compose.yml`, `deploy/omp.lock`, `Makefile`, `scripts/{package.mjs,build.mjs,fetch-omp.mjs}`,
`pkgsmith.star`, `.github/workflows/package.yml`, `docs/deploy-web.md`.

Acceptance:

- `docker build -f deploy/Dockerfile .` and the e2e compose pass the S4 browser suite on podman and on docker.
- `read_only`, `cap_drop ALL` and `no-new-privileges` hold in the default posture.
- The opt-in override passes the sandbox test, and the answer to the `cap_drop` question is recorded.
- The AppImage and the unpacked tree start Chat with the bundled binary. A tree without the binary is refused.
- Image and package sizes are reported.

#### S6. Cutover and docs (owner D, last)

Owns: every deletion in section 6, `docs/PLAN.md`, `docs/rebuild/agent-chat-map.md` (superseded note),
`docs/rebuild/parity-matrix.md`, `README.md`, `AGENTS.md`, `TODO.md`, and new `docs/e2e/` evidence.

`AGENTS.md` loses `make agent-runtime` and the agent runtime path section, and gains `scripts/fetch-omp.mjs`.

Acceptance:

- `yarn build`, `yarn test`, `yarn workspace @pikvm/web test` and the typechecks pass.
- `grep -rniE "harness|pikvm-agent|pikvm_agent|lucide-react|chat-ui"` over source, config and docs finds only intended
  history: this file and the `docs/e2e/` records.
- `git ls-files agent deploy/agent packages/chat-ui` prints nothing, and no Python remains outside `tools/` history.

#### Shared files

File boundaries above do not overlap, except at two points:

- `apps/web/src/app/panes.tsx` is AppShell's file in progress. S4 reads it and integrates after AppShell commits.
- `packages/kvm-engine` gets new files from S2 only.

## 10. Open questions

Only what the code cannot decide.

1. **Sign in with an account.** The Python harness reused the `claude` and `codex` CLI logins. Chat has no provider
   OAuth; its non-goals say so. omp has its own account logins, and fork patch 0010 is about Anthropic accounts. Should
   Settings drive omp's logins, so a subscription works without an API key? That is a feature, not a port. omp's auth
   store lives in the agent HOME and needs a start and finish flow in the UI.
2. **omp binaries for macOS and Windows.** Upstream CI builds them. A fork of omp (with elicitation, task
   models and sequential accounts) builds only Linux today. Should desktop packages ship upstream's binaries, without
   fork patches, or does the fork get macOS and Windows release builds first? The plan works either way, because
   approvals use our own MCP elicitation.
3. **The full profile.** Are shell and file tools wanted in Chat at all, on Linux with the sandbox? The plan keeps
   them behind `sandbox.mode=required`, shipped off. If the answer is no, bubblewrap, socat, the socket forwarder and
   the seccomp discussion leave the image and S1.
4. **External MCP clients.** `src/mcp-launcher.ts` is a stdio entry for Claude Code and similar clients. Keep a
   `pikvm-mcp` stdio bridge to a running app, or delete it with the harness?
5. **Memory.** Chat's long-term memory (omp's mnemopi bank and an embeddings download) is dropped from the first cut.
   Is it wanted later?
6. **Provenance.** `docs/PLAN.md` said no copying, because chat has no licence and its UI is a clean-room copy of a
   third-party product. The decision was to copy. If PiKVM Desktop is ever published, that needs a licence on chat or a
   re-skin. Nothing in this plan blocks either.
