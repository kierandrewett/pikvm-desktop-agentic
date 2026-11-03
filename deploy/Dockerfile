# The headless PiKVM host and its chat agent, one image: the web host (src/web-server.ts, which
# also serves the chat API), the web app, and omp's standalone binary as the agent runtime.
# No Python, no Bun.
#
#   make image                      # podman or docker build -f deploy/Dockerfile .
#
# Built from the repository root. Everything that is not in the repo is fetched here and
# checked: yarn's lockfile for the build, deploy/omp.lock's sha256 for the agent binary.
# glibc (bookworm), not alpine: omp's linux binary and sharp's prebuilt are the supported pair.

# ── 1. the agent binary ──────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS ompbin
ARG TARGETARCH
WORKDIR /src
COPY deploy/omp.lock deploy/omp.lock
COPY scripts/fetch-omp.mjs scripts/fetch-omp.mjs
RUN set -eu; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
        amd64) target=linux-x64 ;; \
        arm64) target=linux-arm64 ;; \
        *) echo "no omp binary for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    node scripts/fetch-omp.mjs --target "$target" --out /out; \
    test -x /out/omp

# ── 2. the build ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    YARN_ENABLE_TELEMETRY=0 \
    CI=1
WORKDIR /repo
RUN corepack enable
COPY . .
RUN yarn install --immutable
# The commit the app is built from: the image has no .git, so `make image` passes it in; Settings > About shows it.
ARG PIKVM_BUILD_ID=
ENV PIKVM_BUILD_ID=$PIKVM_BUILD_ID
RUN yarn build && yarn workspace @pikvm/web build
# Readable by the unprivileged user whatever umask the build ran under (a 077 build once shipped files
# only root could open), and no source maps. Done here, because a chmod in the runtime stage would copy
# every file it touches into a new layer.
RUN find dist -name '*.map' -delete && chmod -R a+rX dist apps/web/dist

# ── 3. the runtime ───────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
# sharp resizes and crops the screenshots the agent sees. It is a native addon with a prebuilt
# binary per platform, so it is installed here, beside the bundle, and the bundle leaves it external.
ARG SHARP_VERSION=0.35.5
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN npm install --omit=dev --no-save --no-audit --no-fund --ignore-scripts=false "sharp@${SHARP_VERSION}" \
    && npm cache clean --force \
    && rm -f package.json package-lock.json
COPY --from=ompbin /out/omp /opt/omp/omp
# dist/ is the host bundle, the console views and assets, and the chat server's SQL migrations;
# apps/web/dist is the web app, found beside dist/ (served at /app/).
COPY --from=build /repo/dist ./dist
COPY --from=build /repo/apps/web/dist ./apps/web/dist

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    PIKVM_DATA_DIR=/data \
    OMP_BIN=/opt/omp/omp

# One fixed unprivileged user that owns /data. Nothing but /data (and tmpfs /tmp) is ever written,
# so the root filesystem can be read-only and every capability dropped.
RUN useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin pikvm \
    && mkdir -p /data && chown 10001:10001 /data
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/app/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/web-server.js"]
