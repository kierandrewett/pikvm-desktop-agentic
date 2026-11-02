# The headless web host (src/web-server.ts): console + PiKVM proxy, no Electron.
#
# Built from the staged context `make web-bundle` writes to builds/web/, not
# from the repo: the bundle is already self-contained (esbuild inlines ws and
# axios), so the image needs Node and the files, not the desktop toolchain.
FROM node:22-alpine

WORKDIR /app
COPY dist ./dist
# The console's shared button/dialog components (window.pikvmShared), served at
# /app/workspace/ from this path relative to dist/.
COPY harness_ui ./agent/pikvm_agent/harness_ui

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    PIKVM_DATA_DIR=/data

# Readable by the unprivileged user whatever umask the context was built with:
# a 077 build once shipped files only root could open, and node exited EACCES.
RUN mkdir -p /data && chown node:node /data && chmod -R a+rX /app
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/app/login || exit 1

CMD ["node", "dist/web-server.js"]
