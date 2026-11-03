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
