# E2E run: the one image and the Linux AppImage, Chat with the bundled omp (2026-11-03)

Both ran from a clean detached worktree of `867d7d65` plus the repository's lock regenerated for `chat-web` (the committed lock was
stale for that one commit; `yarn install --immutable` fails against it, so the image build is only valid from a commit whose lock passes it).
Nothing real: `tools/fake-kvmd` stands in for the PiKVM and `tools/fake-model` for the provider. No Python, Bun or provider CLI anywhere.

## The image (`deploy/Dockerfile`)

`make image` (podman, `--format docker` so the `HEALTHCHECK` survives), then `deploy/e2e/compose.yml`: `kvm` (the image) with
`read_only: true`, `tmpfs: /tmp`, `cap_drop: [ALL]`, `no-new-privileges`, plus `fake-kvmd` and `fake-model` (Node, from this repo).
`node deploy/e2e/chat.e2e.mjs` is the client: HTTP and the chat socket only. The same run passed on docker (compose v5).

| Case | Observed | Result |
| --- | --- | --- |
| builds | three stages; the omp stage printed `omp 18.14.2 (linux-x64) installed`, sha256 checked against `deploy/omp.lock` | pass |
| runs read-only, unprivileged, no capability | `ReadonlyRootfs=true`, `User=10001:10001`, `CapDrop` ALL, `no-new-privileges:true` (podman and docker); writing to `/app` gives `Read-only file system` | pass |
| healthcheck | `healthy` after the start period on podman and docker (`GET /app/login` from 127.0.0.1, which the loopback refusal allows) | pass |
| `/app/` loads | 200, `<title>PiKVM`; `/app/chat` renders the conversation page | pass |
| sharp and omp are in the image | `require('sharp')` gives 0.35.5; `/opt/omp/omp --version` gives `omp/18.14.2` | pass |
| a provider can be added | `PUT /app/chat/api/settings/agent.providers` 200; `GET /models` lists `fake/fake-1`, no errors | pass |
| a foreign Origin on the socket | refused | pass |
| a reply streams | `You said: hello from the image` | pass |
| a click acts on the PiKVM | the fake kvmd received 3 HID events | pass |
| a risky key asks first | nothing sent while the card waited; approve: the chord arrived; deny: nothing arrived | pass |
| the browser | a headless Chrome typed into the Chat composer and read `You said: hello from the image` ([image-chat.png](image-and-appimage/image-chat.png)) | pass |
| state | `/data/chat` (`chat.db`, `secret.key` 0600, `run/` 0700, per-user files) is the only writable path besides `/tmp`; `podman diff` shows only podman's own `/etc` entries | pass |

Size: 600 MB by `podman images`, 889 MB by `docker image inspect` (the two count layers differently). The omp binary is 277 MB of it; the old sidecar
alone was about 1.6 GB. A first build put a `chmod -R` in the runtime stage, which copied the binary into a second layer (913 MB): the permission
fix now happens in the build stage.

Two things hit on the way, both fixed: podman's default OCI image format drops `HEALTHCHECK`, and a build stage named `omp` made `COPY --from=omp`
fail under `--format docker` ("no such file") until it was renamed.

## The Linux AppImage

`node scripts/package.mjs --formats appimage` (pkgsmith from `~/dev/pkgsmith`): 290.7 MiB (304,777,720 bytes). `resources/` holds `app`, `apps` and
`omp` (277 MB, `omp/18.14.2`); no `agent/`. The omp step fails the package on a bad checksum: with the pin changed to a wrong sha256 the run
exited non-zero from `fetch-omp.mjs` and no tree was left with an `omp/`.

Run under a headless sway (`WLR_BACKENDS=headless`), `HOME` and `XDG_*` isolated, `PIKVM_CONTROL_PORT=25871`, `env -u ENABLE_VULKAN_RENDERDOC_CAPTURE`,
`APPIMAGE_EXTRACT_AND_RUN=1`, target set by writing `pikvm.json` and `pikvm-credentials.json` into the isolated user data (the fake kvmd).

| Case | Observed | Result |
| --- | --- | --- |
| the app starts with no Python | `[chat] up, agent /tmp/appimage_extracted_*/usr/lib/pikvm-desktop/resources/omp/omp`; the console listens | pass |
| the same four conversation checks as the image | `deploy/e2e/chat.e2e.mjs` against `http://127.0.0.1:25871`: provider added, foreign Origin refused, reply, click arrived (3 HID events), approve and deny | pass |
| the model picker | `GET /models` lists `fake/fake-1` | pass |
| Chat in the window | the Chat tab typed and answered `You said: hello from the appimage` ([appimage-chat-window.png](image-and-appimage/appimage-chat-window.png), the compositor's picture; [appimage-chat.png](image-and-appimage/appimage-chat.png), the page's) | pass |

### A trap, and a bug it hid

`APPIMAGE_EXTRACT_AND_RUN=1` extracts into `/tmp/appimage_extracted_<hash>` and reuses the directory when it exists, and the hash did not change
between two different builds. The second build therefore ran the first one's files, which still had the old model-listing code and showed
`operator/models exited with 2: Error: Built-in tool unavailable in this session: ask`. Deleting that directory ran the new build, where
S4's `--mode rpc-ui` fix (`867d7d65`) lists the model correctly. Clear it between builds when smoke-testing this way.

## Not covered

- macOS and Windows installers (electron-builder): the CI runners only. The Windows space-in-path failure of run 41559113632 is fixed by running
  electron-builder with Node and an argument array (`scripts/builder-cli.mjs`; `tests/packaging.test.ts` runs the real CLI on a spaced path).
- The arm64 image: the Dockerfile selects `linux-arm64` by `TARGETARCH`, but only amd64 was built here.
- Flatpak, rpm, deb and Arch packages: unchanged apart from the resources they now carry; not built in this run.
- The sandboxed profile: there is none (computer profile only, decided in the plan).

## The full browser suites against the image (commit `34ab54c5`)

From a clean detached worktree of `34ab54c5` (`yarn install --immutable` passed, so the committed lock is good), `make image` (podman, 55 s, 600 MB, image id
`6d1e94321ab3`), then the image with the bsociety posture beside `tools/fake-kvmd` and `tools/fake-model`: `deploy/e2e/up-inspectable.sh up`
(read-only root, tmpfs `/tmp`, `--cap-drop ALL`, `no-new-privileges`, `--userns=keep-id:uid=10001` so the suite can read the agent's process and
`/data`, which is a host directory). Chrome 154 through puppeteer-core. Each suite ran against a freshly started container.

| Suite | Result |
| --- | --- |
| `deploy/e2e/chat.e2e.mjs` (curl-level: provider, Origin, reply, click, approve, deny) | 6 of 6 |
| `apps/web/e2e/chat.e2e.mjs phone` (iPhone 13, light and dark) | 14 of 14 |
| `apps/web/e2e/chat.e2e.mjs desktop` (1400x900, light and dark) | 13 of 13 (27 with the phone run) |
| `apps/web/e2e/kvm.e2e.mjs` (both profiles) | 40 of 40 |
| `apps/web/e2e/keep-alive.e2e.mjs` (both profiles) | 26 of 26 |

The secrets case ran against the container: the provider key and the PiKVM password are in no response, page, storage, cookie, cache, socket frame, in the
agent's `environ` and `cmdline` (read from the host through the container's pid) or in the agent's files under `/data`; the fake model received the stored key
upstream from the server and never the gateway's stand-in.

What it took, in order:

- **The suite had to learn the image.** `chat-stack.mjs` only started its own host. With `E2E_WEB` set it now starts nothing and uses the published origins,
  the model URL as the host sees it (`http://fake-model:9000/v1`, typed into Settings), the container's init pid for the process checks and the host directory
  mounted at `/data` for the file checks. Rootless podman's default mapping hides both from the user, which is why `up-inspectable.sh` runs the image
  with `keep-id`. A first attempt through `compose` with `userns_mode` did not apply the option (the container stayed on the private mapping and could
  not write `/data`), and the bind mount needs `label=disable` on Fedora.
- **Run each chat profile on a fresh container.** The first run did both profiles against one container: the phone profile passed 14 of 14, and the
  desktop profile's "add a custom endpoint" case then timed out because the same server already held a provider from the phone profile (and a leftover
  `fake` provider from `deploy/e2e/chat.e2e.mjs` had broken the first attempt the same way). In-process, the suite starts a new stack per profile; the
  external mode cannot, so the profiles are run one per container. This is a property of the suite's setup, not of the image.
- **keep-alive counted Chat's own socket.** "KVM -> Chat -> Settings -> KVM opens no socket" failed with `ws 3->4` on the image: the extra socket is
  `/app/chat/ws`, which Chat opens the first time it is shown. The case predates Chat and counted every non-Janus socket. It now counts the KVM's
  sockets separately and asserts that the chat socket opens at most once after the baseline (it did, once); the KVM sockets, stream requests and fake
  clients are unchanged (`2->2`, `2->2`, `2->2`).

### A finding for the host

When `/data` is not writable by the container's user, the host logs `[chat] did not start: EACCES: permission denied, mkdir '/data/chat/run'` and
carries on serving the KVM, and then, about 30 seconds later, a timer reads a setting from the chat database that never opened and the process dies with
`TypeError: Cannot read properties of undefined (reading 'select')` (`getRow`, `resolveSetting`, `setting`), so the container restarts in a loop. This is
the failure bsociety would hit if the volume's owner is not the container's uid (`/config/apps/kvm` belongs to uid 1000 and the image runs as 10001 unless
`user: "1000:1000"` is set; see the cutover in `docs/deploy-web.md`). Exercised with the image as uid 1000 over a volume holding an old `settings.json` and
`macros.json`: `[chat] up`, `chat/` created 0700, the old files unchanged, `/app/api/v1/state` reports `chat: true`.

## The image to ship: `17317f5b`

Built with docker from a clean detached worktree of `17317f5b` (`yarn install --immutable` passed): `make image IMAGE_TOOL=docker IMAGE=pikvm-kvm:17317f5b`,
then `docker save pikvm-kvm:17317f5b | gzip > ~/.cache/pikvm-wip/pikvm-web-17317f5b.tar.gz` (272,395,213 bytes, sha256
`060eeb4be711a824a0701875efd00cbc5d86636c2cd7543d12b280da4eff9955`). The tested image is that tarball itself: it was loaded into podman
(`gunzip -c … | podman load`, config digest `c47202ce2926…`, the `Config` of the archive's `manifest.json`) and the container's image was checked to be it. Loading
the tarball into docker again gave the id `sha256:035740b003487bc3413501e29782dc3162d81f99ef5a20dcf357be0919911f72` (888 MB), the one `docker image inspect` printed
after the build, so the transfer is faithful. Docker 29 prints the image-index digest as `.Id`; podman prints the config digest.

Each suite on a freshly started container (`deploy/e2e/up-inspectable.sh`, read-only, tmpfs `/tmp`, `--cap-drop ALL`, `no-new-privileges`, fake kvmd and fake model):

| Suite | Result |
| --- | --- |
| `deploy/e2e/chat.e2e.mjs` | 6 of 6 |
| `apps/web/e2e/chat.e2e.mjs phone` | 14 of 14 |
| `apps/web/e2e/chat.e2e.mjs desktop` | 13 of 13 |
| `apps/web/e2e/kvm.e2e.mjs` | 40 of 40 |
| `apps/web/e2e/keep-alive.e2e.mjs` | 26 of 26 |

## The image to ship: `1d49c3e2`

Built with docker from a clean detached worktree of `1d49c3e2` (`yarn install --immutable` passed): `make image IMAGE_TOOL=docker IMAGE=pikvm-kvm:1d49c3e2`,
`docker save pikvm-kvm:1d49c3e2 | gzip > ~/.cache/pikvm-wip/pikvm-kvm-1d49c3e2.tar.gz` (272,404,461 bytes, sha256
`a667b174baf9522244167b5ad3a380f902ba730edb316f138ccf7b7158aeff20`). Reloading the tarball with `docker load` gives `sha256:9b977b949030e3f94b0bd1246054b6ddc2950460ba085f35466538fa41c9ac84`
(888 MB), the id the build printed; podman loads the same tarball with config digest `0ad290a1d98d…`, and the suites ran on that load.

Each suite on a freshly started container (`deploy/e2e/up-inspectable.sh`: read-only, tmpfs `/tmp`, `--cap-drop ALL`, `no-new-privileges`):

| Suite | Result |
| --- | --- |
| `deploy/e2e/chat.e2e.mjs` | 6 of 6 |
| `apps/web/e2e/chat.e2e.mjs desktop` | 16 of 16 |
| `apps/web/e2e/chat.e2e.mjs phone` | 16 of 17, twice (two fresh containers) |
| `apps/web/e2e/kvm.e2e.mjs` | 40 of 40 |
| `apps/web/e2e/keep-alive.e2e.mjs` | 26 of 26 |

The one failure, both times and only on the phone profile: "a reload keeps the pictures: the same cards, the same frames, and the screen is not looked at again"
threw `Node is either not clickable or not an Element`. It is not the image: the same suite against the host started in-process from the same commit (no container,
`node dist/web-server.js`) fails the same case the same way. The case is `apps/web/e2e/chat.e2e.mjs:459` (after the reload it opens the sidebar and taps the first
conversation row on a 390 px screen; the click target is not usable). Desktop passes the case.

### An unwritable `/data/chat`

`/data/chat` was a regular file in the data directory (which also held an old `settings.json`); everything else as above, with a healthcheck of 5 s. After 75 s:

- the container is `running`, 0 restarts, health `healthy`; no `TypeError` or uncaught error in its log, only `[chat] did not start: ENOTDIR: not a directory, mkdir '/data/chat/run'`;
- `GET /app/api/v1/state` answers `"features":{"chat":false,"agent":{"found":false,"reason":"ENOTDIR: not a directory, mkdir '/data/chat/run'"}}`, with the old `settings.json` values intact;
- `/app/` answers 200, and `/app/chat/api/models` answers 503;
- the KVM works: `kvm.e2e.mjs` against this container passed 15 of 15 (desktop) and 25 of 25 (phone), the same cases as the healthy image.

## The image to ship: `10a037e9`

Built with docker from a clean detached worktree of `10a037e9` (`yarn install --immutable` passed): `make image IMAGE_TOOL=docker IMAGE=pikvm-kvm:10a037e9`,
`docker save pikvm-kvm:10a037e9 | gzip > ~/.cache/pikvm-wip/pikvm-kvm-10a037e9.tar.gz` (272,532,724 bytes, sha256
`ee30180861c7310548e169423e0098fb59d7308308413f6abb1ea99e6b4f6cc9`). Reloading the tarball with `docker load` gives
`sha256:05732ac4aaaef1150f25c3a14eaad1032c6ca73f088712ee12555008ff5139e2` (889 MB); the suites ran on the same tarball loaded into podman.

**Unit tests and typechecks** from the same worktree: root `node scripts/test.mjs` 422 of 422; `tsc --noEmit` clean in `chat-protocol`, `chat-server`, `chat-web`,
`icons`, `kvm-engine`, `pikvm-mcp` and `apps/web`; vitest: chat-protocol 9, chat-server 59, chat-web 21, kvm-engine 618, pikvm-mcp 71, apps/web 458, all passing.

**Posture.** `deploy/e2e/up-inspectable.sh` now runs the image as the production user: `--user 1000:1000` (the uid of `/config/apps/kvm` on bsociety; `E2E_UID`),
`PIKVM_AUTH=proxy`, read-only root, tmpfs `/tmp`, `--cap-drop ALL`, `no-new-privileges`, with the fake kvmd, model, push service and OpenRouter beside it. `--userns=keep-id`
maps that uid to the invoking user so the suites can read the agent's process and `/data`. The screen-watch run also gets the watch's pacing and
`PIKVM_PUSH_ALLOW_LOCAL=1` through `E2E_ENV_FILE` (a test-only setting, so a push endpoint on the fake service is accepted); no other suite has them.

Each suite on a freshly started container:

| Suite | Result |
| --- | --- |
| `deploy/e2e/chat.e2e.mjs` | 6 of 6 |
| `apps/web/e2e/chat.e2e.mjs phone` | 17 of 17 |
| `apps/web/e2e/chat.e2e.mjs desktop` | 16 of 16 |
| `apps/web/e2e/kvm.e2e.mjs` (both profiles) | 40 of 40 |
| `apps/web/e2e/keep-alive.e2e.mjs` | 26 of 26 |
| `apps/web/e2e/resume.e2e.mjs phone` | 13 of 13 (12 of 13 once, 13 of 13 on two reruns) |
| `apps/web/e2e/resume.e2e.mjs desktop` | 15 of 15 |
| `apps/web/e2e/lens.e2e.mjs` | 12 of 12 (11 of 12 once, 12 of 12 on two reruns) |
| `apps/web/e2e/watch.e2e.mjs` (the screen watch, against the fakes) | 22 of 22 (20 of 22 once, 22 of 22 on the rerun; in-process from the same commit: 22 of 22) |

**What did not pass at first, and why it is not the image.**
- The first complete matrix ran with a mistake in the helper: `up-inspectable.sh` ran the image as uid 10001 and did not pass the watch environment, and it printed `fetch failed` midway through the desktop resume run. It was discarded and the whole matrix rerun after the fix; the table above is that rerun.
- `lens`, "slow movement is at the full zoom": 4.69x against a bar of the maximum 5x, a marginal timing figure; passed twice on rerun.
- `resume phone`, "only the window gaining focus after a freeze": the screen came back 233 ms after return but with 2 new streams instead of 1; passed twice on rerun.
- `watch`, "the real Chrome got the notification too" and "Send test notification… an expired one (410) is removed": the headless Chrome's own subscription is on Google's real push service (`fcm.googleapis.com`), whose delivery did not arrive within 25 s on that run, and the test then counted that subscription as expired (`devices 4 -> 2`). The next run on the image delivered it (22 of 22), as did the in-process run.

**The screen watch in the read-only container.** `push-vapid.json` is created in `/data` (the volume) by the container's user, mode `600`; its sha256 prefix (`37132c10bc98789b`), its mode and the public key the API reports are identical after `podman restart`, so subscriptions made before a restart keep working. The watch's directory is `700`, its settings, log and subscriptions `600`. `/app` is read-only (`touch /app/x`: `Read-only file system`). The watch survives a restart (the suite's "a restart resumes the watch with no browser open" passed).

**Outbound connections.** Sampled from inside the container's network namespace every 0.4 s through all the suites (about 280 samples of external sockets): every external peer was on port 443, and every other connection was in the compose network (fake kvmd, fake model, fake push, fake OpenRouter). Names from a DNS-logging resolver given to the container:
- idle for 30 s after start: only `models.dev` (the model catalog refresh Chat has had since it was integrated);
- once Chat lists models: `models.dev` and the catalog hosts the agent runtime looks at (`catalog.stencil.so`, `api.venice.ai`, `api.kilo.ai`, `api.commandcode.ai`, `zenmux.ai`, `hyper.charm.land`, `coding-intl.dashscope.aliyuncs.com`), all https;
- when a push is sent to the headless Chrome's subscription: `fcm.googleapis.com`.
OpenRouter is `https://openrouter.ai/api/v1` in the code (`openrouter` preset in `packages/chat-server/src/agent/providers.ts`); the fake runs pointed the provider at the fake instead, so that name was not exercised here. The watch and push code add no other destination: push sends go to the endpoint the browser subscribed with (the vendor's push service, always https outside tests), and nothing in the watch contacts anything but the PiKVM, the model provider and those endpoints.

New with this commit for the helpers: `fake-push` and `fake-openrouter` services in `deploy/e2e/compose.yml`, and an image mode for the watch suite (`E2E_WEB` in `apps/web/e2e/watch-stack.mjs`, see its header).

## The image to ship: `27a64263`

Built with docker from a clean detached worktree of `27a64263` (`yarn install --immutable` passed; root `node scripts/test.mjs` 422 of 422):
`make image IMAGE_TOOL=docker IMAGE=pikvm-kvm:27a64263` (the Makefile passes `PIKVM_BUILD_ID` from the commit),
`docker save pikvm-kvm:27a64263 | gzip > ~/.cache/pikvm-wip/pikvm-kvm-27a64263.tar.gz` (272,536,438 bytes, sha256
`07369e80f4e8c4083f393d396dc1805ef7c84674a18b674daf0b181585eec86c`). Config digest (the archive's `manifest.json` `Config`):
`sha256:4a787a98cf55dea756c8052d514cff0632578f47e1b17bf86c8d7317ae6dfde4`. `docker load` gives
`sha256:0d36e77f4da83457f2e34dcbd991ee9f169995646863d2557bb63185bf61fa0d` (889 MB); the suites ran on the same tarball loaded into podman.

Posture as for `10a037e9`: `deploy/e2e/up-inspectable.sh`, uid 1000, read-only root, tmpfs `/tmp`, `--cap-drop ALL`, `no-new-privileges`, `PIKVM_AUTH=proxy`, a fresh container per suite.

| Suite | Result |
| --- | --- |
| `apps/web/e2e/phone-chrome.e2e.mjs` (all profiles, including the About and update-on-resume cases) | 87 of 87 |
| `apps/web/e2e/kvm.e2e.mjs` | 40 of 40 |
| `apps/web/e2e/resume.e2e.mjs phone` | 13 of 13 |
| `apps/web/e2e/chat.e2e.mjs phone` | 17 of 17 |
| `apps/web/e2e/keep-alive.e2e.mjs` | 26 of 26 |
| `apps/web/e2e/watch.e2e.mjs` | 22 of 22 |

From the running container (outside the suites):

- `GET /app/version.json` answers `{"build":"27a64263.20261103-151351"}`: the commit id, then the time the web app was built.
- `/app/` is 200 and its `index.html` carries `apple-mobile-web-app-status-bar-style` = `black`.
- `Cache-Control: no-cache` on `/app/`, `/app/sw.js`, `/app/version.json` and `/app/manifest.webmanifest`; the hashed asset `/app/assets/index-DGY6tMTP.js` is `public, max-age=31536000, immutable`.
- Settings > About shows the build the host serves in `/app/version.json`: the phone-chrome case "Settings > About shows the build the host serves in /app/version.json" passed against the container.

## The image deployed: `43860abc`

The tarball Main built from a clean worktree of `43860abc`: `~/.cache/pikvm-wip/pikvm-kvm-43860abc.tar.gz`, sha256
`132c9a7a971d277695e449be062aed43ea57dc8fa675dbaa284d0896333031d3`, config digest (manifest.json `Config`)
`sha256:45ade10f81f7352ee583e28944913a074380fdc3076f30d07193136ec05afb20`, tag `pikvm-kvm:43860abc`. It was loaded into podman as it is
(`gunzip -c … | podman load`, image id equal to the config digest) and the suites ran on that load, from a separate clean worktree of the same commit.
Posture as before: `deploy/e2e/up-inspectable.sh`, uid 1000, read-only root, tmpfs `/tmp`, `--cap-drop ALL`, `no-new-privileges`, `PIKVM_AUTH=proxy`, a fresh container per suite.

| Suite | Result |
| --- | --- |
| `apps/web/e2e/phone-chrome.e2e.mjs` (all profiles) | 117 of 117 |
| `apps/web/e2e/desktop-layout.e2e.mjs` (rail, composer width at 1280, 1920, 2560 and the narrow end, phone bar labels) | 20 of 20 |
| `apps/web/e2e/kvm.e2e.mjs` | 40 of 40 |
| `apps/web/e2e/chat.e2e.mjs phone` | 17 of 17 |
| `apps/web/e2e/chat.e2e.mjs desktop` | 16 of 16 |
| `apps/web/e2e/resume.e2e.mjs phone` | 13 of 13 |
| `apps/web/e2e/keep-alive.e2e.mjs` | 26 of 26 |
| `apps/web/e2e/watch.e2e.mjs` | 22 of 22 (20 of 22 on the first run, below) |

The first watch run failed the two cases that depend on the headless Chrome's own subscription on Google's real push service (`fcm.googleapis.com`):
"the real Chrome got the notification too" (no notification within 25 s) and "Send test notification…" (that subscription was counted as expired, `devices 4 -> 2`). Nothing the
image serves is involved; the rerun on a fresh container delivered it and passed 22 of 22, as in the earlier runs of this suite.

Two false starts of the run itself, for whoever repeats it: the e2e helper's fake kvmd runs from the checkout mounted into the container and needs the checkout's `node_modules` (`ws`), so a fresh
worktree needs `yarn install` first (without it the fake exits and every suite reports `fetch failed`); the helpers also share one compose project name and the host ports 18080, 14510, 19090, 14720 and 14730, so two runs at once on one machine collide.
