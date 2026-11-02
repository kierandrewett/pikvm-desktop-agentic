# The agent sidecar for the headless web host: the machine-control daemon and the
# chat harness (agent/), plus the claude and codex CLIs the harness signs in
# through. No GUI, no vision stack: the daemon's default OCR is the tesseract
# binary, and the optional ML extras stay out.
#
# Built from the staged context `make agent-bundle` writes to builds/agent/, not
# from the repo: it carries agent/pyproject.toml, agent/uv.lock and the package,
# so the image is reproducible from the lock and the repo's frontend and test
# trees stay out of it.

# ---- the provider CLIs -------------------------------------------------------
# node comes along because the CLIs are node programs. Pinned, so a rebuild does
# not change what the harness shells out to; bump deliberately.
FROM node:22-bookworm-slim AS cli
ARG CLAUDE_CODE_VERSION=2.1.316
ARG CODEX_VERSION=0.166.0
RUN npm install --global --prefix /opt/cli --no-fund --no-audit \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "@openai/codex@${CODEX_VERSION}" \
    && /opt/cli/bin/claude --version \
    && /opt/cli/bin/codex --version

# ---- the agent's locked environment -------------------------------------------
FROM python:3.12-slim-bookworm AS venv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
RUN pip install --no-cache-dir uv==0.12.3
WORKDIR /src
# Dependencies first, so editing the agent does not reinstall them.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY pikvm_agent ./pikvm_agent
RUN uv sync --frozen --no-dev --no-editable

# ---- the image -----------------------------------------------------------------
FROM python:3.12-slim-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep tesseract-ocr tesseract-ocr-eng tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid agent --home-dir /data/home --no-create-home agent \
    && mkdir -p /data \
    && chown agent:agent /data

COPY --from=venv /opt/venv /opt/venv
COPY --from=cli /usr/local/bin/node /usr/local/bin/node
COPY --from=cli /opt/cli /opt/cli
COPY entrypoint.sh /usr/local/bin/pikvm-agent-entrypoint
RUN chmod 0755 /usr/local/bin/pikvm-agent-entrypoint

ENV PATH=/opt/venv/bin:/opt/cli/bin:/usr/local/bin:/usr/bin:/bin \
    PIKVM_AGENT_DATA=/data \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Config, provider-keys.json (0600), run state and both CLIs' sign-ins live here.
VOLUME ["/data"]
USER agent
WORKDIR /data
EXPOSE 47616

# The harness answers /api/health without a credential. Loopback inside the
# container, because that is the only place it is certain to be bound.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD python -c "import os,sys,urllib.request as u; p=os.environ.get('PIKVM_HARNESS_LISTEN','0.0.0.0:47616').rsplit(':',1)[1]; sys.exit(0 if u.urlopen(f'http://127.0.0.1:{p}/api/health',timeout=4).status==200 else 1)"

ENTRYPOINT ["tini", "--", "pikvm-agent-entrypoint"]
