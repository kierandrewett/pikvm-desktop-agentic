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

# ── 1b. the OCR models ───────────────────────────────────────────────────────────────────────
# Fast alerts read a pop-up with PP-OCRv4 on this host (src/server/watch/ocr-*.ts): nothing from the screen goes to a model
# service for it. The models are fetched here, never at runtime, and checked against deploy/ocr.lock's sha256.
FROM node:22-bookworm-slim AS ocrmodels
WORKDIR /src
COPY deploy/ocr.lock deploy/ocr.lock
COPY scripts/fetch-ocr.mjs scripts/fetch-ocr.mjs
RUN node scripts/fetch-ocr.mjs --out /out/models \
    && test -s /out/models/ch_PP-OCRv4_det_infer.onnx && test -s /out/models/ch_PP-OCRv4_rec_infer.onnx && test -s /out/models/ppocr_keys_v1.txt

# ── 1c. the speech models ────────────────────────────────────────────────────────────────────
# Session recordings are transcribed on this host (src/server/recordings): speech recognition, voice activity and speaker diarization
# models, all ONNX files. Fetched here, never at runtime, and checked against deploy/asr.lock's sha256. bzip2 is only for unpacking
# the model archives and stays in this stage.
FROM node:22-bookworm-slim AS asrmodels
WORKDIR /src
RUN apt-get update \
    && apt-get install -y --no-install-recommends bzip2 \
    && rm -rf /var/lib/apt/lists/*
COPY deploy/asr.lock deploy/asr.lock
COPY scripts/fetch-asr.mjs scripts/fetch-asr.mjs
RUN node scripts/fetch-asr.mjs --out /out/models \
    && test -s /out/models/parakeet-tdt-110m/encoder.int8.onnx && test -s /out/models/silero_vad.onnx \
    && test -s /out/models/pyannote-segmentation-3.0.int8.onnx && test -s /out/models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx

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
    && apt-get install -y --no-install-recommends tini ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# onnxruntime-node is the OCR's engine (the same kind of native addon as sharp, so also external to the bundle). Its package carries every
# platform's binaries and the CUDA provider (about 570 MB); only this architecture's CPU library stays. The tarball is checked against
# the integrity in deploy/ocr.lock before it is installed.
#
# sherpa-onnx-node is the speech transcriber's engine (session recordings; src/server/recordings): an addon with its own onnxruntime, in
# two packages, the addon and the library for this architecture. Both tarballs are checked against the integrities in deploy/asr.lock, and
# installed in the same npm command (a second `npm install --no-save` would remove the first's packages).
COPY deploy/ocr.lock /tmp/ocr.lock
COPY deploy/asr.lock /tmp/asr.lock
RUN set -eu; \
    lock() { node -p "JSON.parse(require('fs').readFileSync('$1', 'utf8'))$2"; }; \
    integrity() { node -p "'sha512-' + require('crypto').createHash('sha512').update(require('fs').readFileSync('$1')).digest('base64')"; }; \
    ORT_VERSION="$(lock /tmp/ocr.lock .onnxruntime.version)"; \
    ORT_INTEGRITY="$(lock /tmp/ocr.lock .onnxruntime.integrity)"; \
    case "$(dpkg --print-architecture)" in amd64) keep=x64 ;; arm64) keep=arm64 ;; *) echo "no onnxruntime or sherpa-onnx for this architecture" >&2; exit 1 ;; esac; \
    SHERPA_VERSION="$(lock /tmp/asr.lock .sherpa.version)"; \
    SHERPA_INTEGRITY="$(lock /tmp/asr.lock .sherpa.integrity)"; \
    SHERPA_LIB="$(lock /tmp/asr.lock ".sherpa.platforms.${keep}.package")"; \
    SHERPA_LIB_INTEGRITY="$(lock /tmp/asr.lock ".sherpa.platforms.${keep}.integrity")"; \
    export ONNXRUNTIME_NODE_INSTALL_CUDA=skip; \
    cd /tmp && npm pack --silent "onnxruntime-node@${ORT_VERSION}" "sherpa-onnx-node@${SHERPA_VERSION}" "${SHERPA_LIB}@${SHERPA_VERSION}" && \
    test "$(integrity "/tmp/onnxruntime-node-${ORT_VERSION}.tgz")" = "$ORT_INTEGRITY" && \
    test "$(integrity "/tmp/sherpa-onnx-node-${SHERPA_VERSION}.tgz")" = "$SHERPA_INTEGRITY" && \
    test "$(integrity "/tmp/${SHERPA_LIB}-${SHERPA_VERSION}.tgz")" = "$SHERPA_LIB_INTEGRITY"; \
    cd /app && npm install --omit=dev --no-save --no-audit --no-fund --ignore-scripts=false "sharp@${SHARP_VERSION}" "/tmp/onnxruntime-node-${ORT_VERSION}.tgz" "/tmp/sherpa-onnx-node-${SHERPA_VERSION}.tgz" "/tmp/${SHERPA_LIB}-${SHERPA_VERSION}.tgz"; \
    find node_modules/onnxruntime-node/bin -type f \( -path '*/darwin/*' -o -path '*/win32/*' -o -name '*cuda*' -o -name '*tensorrt*' \) -delete; \
    find node_modules/onnxruntime-node/bin -type d -path "*/linux/*" ! -name "$keep" -prune -exec rm -rf {} +; \
    find node_modules/onnxruntime-node/bin -type d -empty -delete; \
    test -f "$(find node_modules/onnxruntime-node/bin -name libonnxruntime.so.1 | head -n1)"; \
    test -f "node_modules/${SHERPA_LIB}/sherpa-onnx.node"; \
    node -e "const p = require('/app/node_modules/.package-lock.json').packages['node_modules/${SHERPA_LIB}']; if (!p || !String(p.resolved).startsWith('file:')) { console.error('the sherpa-onnx library was not installed from the checked tarball'); process.exit(1); }"; \
    npm cache clean --force; \
    rm -rf /tmp/ocr.lock /tmp/asr.lock /tmp/*.tgz package.json package-lock.json
COPY --from=ocrmodels /out/models /opt/ocr/models
COPY --from=asrmodels /out/models /opt/asr/models
COPY --from=ompbin /out/omp /opt/omp/omp
# dist/ is the host bundle, the console views and assets, and the chat server's SQL migrations;
# apps/web/dist is the web app, found beside dist/ (served at /app/).
COPY --from=build /repo/dist ./dist
COPY --from=build /repo/apps/web/dist ./apps/web/dist

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    PIKVM_DATA_DIR=/data \
    OMP_BIN=/opt/omp/omp \
    PIKVM_OCR_MODELS=/opt/ocr/models \
    PIKVM_ASR_MODELS=/opt/asr/models \
    ORT_DISABLE_TELEMETRY=1

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
