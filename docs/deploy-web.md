# Deploying the web host

One image, `deploy/Dockerfile`, holds everything: the web host (`src/web-server.ts`), which serves the app and
proxies the PiKVM, the chat server it runs in the same process, and omp's standalone binary, which is the agent.
There is no sidecar, no Python and no Bun. The agent is spawned by the host, once per active conversation, and
reaches the PiKVM only through the host's own tools.

```mermaid
flowchart LR
    phone[Browser or PWA] --> caddy[Caddy, private route]
    caddy --> proxy[kvm-oauth2-proxy]
    proxy -->|kvm-internal network only| kvm[kvm: host + chat server + omp]
    kvm --> pi[PiKVM]
    kvm -->|API keys set in Settings| models[Model providers]
```

## The image

```sh
make image                       # podman build --format docker -f deploy/Dockerfile -t pikvm-kvm:local .
make image IMAGE_TOOL=docker     # or docker; IMAGE=name:tag renames the result
```

Built from the repository root, in three stages:

1. **omp.** `scripts/fetch-omp.mjs` downloads the release asset for the image's architecture (`linux-x64` or
   `linux-arm64`, by `TARGETARCH`) and checks it against the sha256 in `deploy/omp.lock`. A mismatch fails the build.
2. **build.** `yarn install --immutable`, `yarn build` and the web app's build.
3. **runtime** (`node:22-bookworm-slim`). `tini`, `ca-certificates`, `sharp` (the build argument `SHARP_VERSION`,
   for screenshot resize and crop; a native addon with a prebuilt binary, so the image is glibc and not alpine),
   `dist/`, `apps/web/dist` and the binary at `/opt/omp/omp`.

It runs as uid 10001, writes only `/data` and `/tmp`, needs no capability, and has a healthcheck on `/app/login`.
The default posture is the one bsociety uses:

```yaml
read_only: true
tmpfs: [/tmp]
cap_drop: [ALL]
security_opt: ["no-new-privileges:true"]
```

podman builds OCI images by default, and OCI has no `HEALTHCHECK`; `make image` passes `--format docker` for podman.

### Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `PIKVM_URL` | yes | The PiKVM, e.g. `https://pikvm.example.ts.net`. |
| `PIKVM_USER` | no | kvmd user (default `admin`). |
| `PIKVM_PASSWORD` | yes | kvmd password. Held by the host only; never in the agent's environment, files or prompt. |
| `PIKVM_AUTH` | for `HOST=0.0.0.0` | `proxy`: an authenticating proxy is in front. The image sets `HOST=0.0.0.0`, so this is required in practice. |
| `PORT` | no | Listen port (default `8080`). |
| `PIKVM_DATA_DIR` | no | The data volume (image default `/data`). |
| `PIKVM_KEYBOARD_LAYOUT`, `PIKVM_JIGGLER` | no | As before. |
| `OMP_BIN` | no | The agent binary (image default `/opt/omp/omp`). |

`PIKVM_HARNESS_URL`, `PIKVM_HARNESS_TOKEN`, `PIKVM_DESKTOP_URL` and `PIKVM_DESKTOP_TOKEN` are gone: there is no
sidecar to point at.

The data volume holds, and is the only thing that needs backing up:

| Path | What |
| --- | --- |
| `settings.json` | The host's settings. |
| `chat/` | The chat database, per-conversation files, the agent's `HOME`, and provider keys entered in Settings (mode 0600, write-only from the browser). |

Model providers are set in the app: Settings, then Providers, then add a base URL and key. Sign-in with a provider
account (the old Claude and Codex CLI flows) is not part of this image.

## The bsociety cutover

Not applied from this repo: these are the exact steps for `/srv/machines/bsociety/kvm/compose.yml`. The cutover replaces two
containers (`kvm`, `kvm-agent`) with one and takes a few seconds of downtime. Everything before step 3 changes nothing that runs.

What is on bsociety today (read 2026-11-03): `kvm` from `pikvm-web:latest` (203 MB, built from `./app`, user `node`, uid 1000) with
`/config/apps/kvm:/data` (owned by `kieran`, uid 1000, mode 755: `settings.json`, `macros.json`), and `kvm-agent` from
`pikvm-agent:latest` (1.61 GB) with `/config/apps/kvm-agent:/data` (uid 10001, mode 700).

### How the image gets there: `docker save | ssh docker load`

Build it here, from a clean checkout of the commit that was tested, and send the image itself. Why, and not a build on bsociety
from a `git archive`:

- What is deployed is byte-for-byte what the e2e suites ran against: the image id is compared after the load (step 1).
- A build on bsociety needs the toolchain's network at that moment (npm registry, GitHub for omp, Debian mirrors) and a build
  cache on the production host, and a failure there leaves a half-built tag. A transfer is one compressed stream of the final image.
- The compose file stops building anything (`build:` goes), so nothing on bsociety can drift from the repository.

The cost is that the image is rebuilt on a workstation with docker; the tag carries the commit so it is never ambiguous.

### 1. Build and load the image (no downtime)

```sh
# on the workstation, in a clean checkout of the commit to ship (not a dirty tree)
git status --short                                  # must print nothing
SHA=$(git rev-parse --short=8 HEAD)
make image IMAGE_TOOL=docker IMAGE=pikvm-kvm:$SHA   # about a minute; fails if omp's sha256 does not match deploy/omp.lock
docker image inspect -f '{{.Id}}' pikvm-kvm:$SHA    # note this id
docker save pikvm-kvm:$SHA | gzip | ssh bsociety 'gunzip | docker load'
ssh bsociety "docker image inspect -f '{{.Id}}' pikvm-kvm:$SHA"   # must be the same id
```

### 2. Keep the way back (no downtime)

```sh
# on bsociety
cd /srv/machines/bsociety
docker tag pikvm-web:latest   pikvm-web:pre-chat
docker tag pikvm-agent:latest pikvm-agent:pre-chat
cp -a kvm/compose.yml kvm/compose.yml.pre-chat
cp -a .env .env.pre-chat                    # holds KVM_HARNESS_TOKEN, which the rollback needs
cp -a /config/apps/kvm /config/apps/kvm.pre-chat   # settings.json and macros.json only: small
docker image ls | grep -E 'pikvm-(web|agent)'      # pre-chat and latest show one image id each
```

`/config/apps/kvm-agent` (the old provider keys and CLI sign-ins) is left exactly as it is.

### 3. Edit `kvm/compose.yml`

On `kvm`:

- delete the `build:` block, and set `image: pikvm-kvm:<SHA>` (the tag from step 1);
- delete `PIKVM_HARNESS_URL` and `PIKVM_HARNESS_TOKEN` (and their comment);
- add `user: "1000:1000"`. This is required: the image's own user is 10001, but `/config/apps/kvm` belongs to uid 1000 (the old
  image ran as `node`, uid 1000). Without it Chat cannot create `/data/chat` and the host stops. With it the volume needs no
  `chown`, and the old image can still use it, which is what makes the rollback a pure file swap;
- keep `PIKVM_URL`, `PIKVM_USER`, `PIKVM_PASSWORD`, `PIKVM_AUTH: proxy`, `PIKVM_KEYBOARD_LAYOUT`, `PORT`, the `/config/apps/kvm:/data`
  volume, `kvm-internal`, `read_only`, `tmpfs: /tmp`, `cap_drop: [ALL]` and `no-new-privileges`. No capability, no `seccomp` change.

Delete the whole `kvm-agent` service. `kvm-oauth2-proxy` is untouched, and so are its `SKIP_AUTH_ROUTES`: Chat's API and socket are under
`/app/` and stay behind the sign-in. Leave `KVM_HARNESS_TOKEN` in `.env` until the soak is over (step 6): the rollback needs it.

Result:

```yaml
    kvm:
        image: pikvm-kvm:<SHA>
        user: "1000:1000"
        container_name: kvm
        restart: unless-stopped
        environment:
            PIKVM_URL: https://pikvm.tail93a99.ts.net
            PIKVM_USER: admin
            PIKVM_PASSWORD: <as it is now>
            PIKVM_AUTH: proxy
            PIKVM_KEYBOARD_LAYOUT: us
            PORT: "8080"
        volumes:
            - /config/apps/kvm:/data
        networks:
            - kvm-internal
        read_only: true
        tmpfs:
            - /tmp
        cap_drop:
            - ALL
        security_opt:
            - no-new-privileges:true
```

### 4. Switch

```sh
cd /srv/machines/bsociety/kvm
docker compose config -q && echo compose ok         # the file parses and no ${VAR:?} is missing
docker stop kvm-agent && docker rm kvm-agent        # the service is gone from the file, so compose would only warn about it
docker compose up -d kvm                            # recreates kvm from the new image; kvm-oauth2-proxy is not restarted
```

### 5. Verify

```sh
docker inspect -f '{{.State.Health.Status}} {{.HostConfig.ReadonlyRootfs}} {{.Config.User}}' kvm   # healthy true 1000:1000 (after ~15 s)
docker logs kvm 2>&1 | grep -E '\[web\]|\[chat\]'    # "[web] console on http://0.0.0.0:8080/ ..." and "[chat] up, agent /opt/omp/omp"
ls -ld /config/apps/kvm/chat                         # created by the container: owner kieran, mode 700
curl -sI https://kvm.drewett.dev/app/manifest.webmanifest | head -1                 # HTTP/2 200 (the signed-out route)
```

Then in a signed-in browser at `https://kvm.drewett.dev/app/`:

1. The KVM tab shows the picture, and macros and the jiggler setting are as they were (`settings.json` and `macros.json` are read as before).
2. Settings, Providers: add the model key again (the old sidecar's keys are not migrated). The models appear in Chat.
3. Chat: send a message and read the reply. If Chat says it is offline, the socket was refused: it needs the browser's `Origin` to equal the
   `Host` it reaches the container with, or `X-Forwarded-Host`; Caddy and oauth2-proxy keep the original `Host` by default, so this only
   happens if a hop was changed. `docker logs kvm` shows nothing for a refused socket; the browser's network panel shows a 403 on `/app/chat/ws`.
4. Ask the agent to look at the screen. The KVM tab shows "Agent is working", a tap on the picture takes control back, and Stop ends the run.

`docker stats kvm --no-stream` once while a conversation runs: the container now holds the host plus one omp process per active conversation,
and the compose file sets no memory limit.

### Rollback

At any time, and the data stays compatible because the container ran as the volume's own uid and nothing else wrote to it:

```sh
cd /srv/machines/bsociety
docker compose -f kvm/compose.yml stop kvm && docker rm kvm
cp kvm/compose.yml kvm/compose.yml.chat                  # keep the edited file for the next attempt
cp kvm/compose.yml.pre-chat kvm/compose.yml
cp .env.pre-chat .env                                     # only if .env was edited
docker tag pikvm-web:pre-chat   pikvm-web:latest          # in case `latest` moved
docker tag pikvm-agent:pre-chat pikvm-agent:latest
cd kvm && docker compose up -d kvm kvm-agent              # no --build: the images are the ones tagged above
docker inspect -f '{{.State.Health.Status}}' kvm kvm-agent   # healthy healthy
```

`/config/apps/kvm/chat/` stays behind and is ignored by the old image. `settings.json` and `macros.json` are read by both; if the old host
misreads `settings.json` after a run of the new one, restore the copy from step 2:
`mv /config/apps/kvm /config/apps/kvm.post-chat && cp -a /config/apps/kvm.pre-chat /config/apps/kvm` (macros edited since step 2 are in
`kvm.post-chat/macros.json`). `/config/apps/kvm-agent` was never touched, so the old Chat history and keys are as they were.

### 6. After the soak (a week of use, no rollback needed)

```sh
# on bsociety
sed -i '/^KVM_HARNESS_TOKEN=/d' /srv/machines/bsociety/.env
rm -rf /srv/machines/bsociety/kvm/agent-app /srv/machines/bsociety/kvm/app
docker rmi pikvm-agent:latest pikvm-agent:pre-chat pikvm-web:pre-chat pikvm-web:latest
rm -rf /config/apps/kvm.pre-chat
# /config/apps/kvm-agent holds provider keys and CLI sign-ins in the clear: copy anything wanted, then
sudo rm -rf /config/apps/kvm-agent
```

The model needs outbound internet; `kvm-internal` has it because it is not declared `internal`.

## Sandboxing the agent

The agent runs the *computer* profile: its tools are `ask`, `todo` and the PiKVM tools (`mcp__pikvm_*`). It has no
tool that reads files, runs commands or makes requests, and there is no process sandbox in the image (no bubblewrap,
no socat), so no relaxed seccomp on the container that holds the PiKVM password. The residual risk is a bug in omp or
in the tool allow-list, which is the reason to keep the container's default hardening.

## Verified how

`docs/e2e/2026-11-03-image-and-appimage.md` records the image and the Linux AppImage running against a fake kvmd and
a scripted model.

`deploy/e2e/compose.yml` is that stack for a person: `make image`, then `podman compose -f deploy/e2e/compose.yml up`,
then Settings, Providers, base URL `http://fake-model:9000/v1`. `deploy/e2e/up-inspectable.sh up` runs the same image with its
processes and `/data` readable by the invoking user, which `apps/web/e2e/chat.e2e.mjs` needs to inspect the agent (see
`docs/e2e/README.md`).

## Known limits

- Sizes: see the e2e record. omp's binary is about 277 MB of the image.
- The image is `linux/amd64` or `linux/arm64`; omp has no other Linux build pinned.
- `docker compose` and `podman compose` both work.
