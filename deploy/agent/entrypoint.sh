#!/usr/bin/env bash
# The agent sidecar for the web host: the machine-control daemon and the chat
# harness, started the way the desktop app starts them (src/main.ts,
# src/harness-manager.ts), configured from the environment instead of by an app.
#
#   PIKVM_URL, PIKVM_USER, PIKVM_PASSWORD   the same PiKVM the web host proxies.
#   PIKVM_HARNESS_TOKEN                     the operator capability the web host
#                                           holds (PIKVM_HARNESS_TOKEN there too).
#   PIKVM_HARNESS_ALLOWED_ORIGINS           where the app is served from, e.g.
#                                           https://kvm.example.com. Approvals
#                                           are accepted only from these.
#   PIKVM_AGENT_DATA                        the data volume (default /data).
#
# Every other credential (the daemon's two capabilities, the harness's agent and
# observer tokens) is made here, per start, and never leaves this container.
set -euo pipefail

DATA="${PIKVM_AGENT_DATA:-/data}"
LISTEN="${PIKVM_HARNESS_LISTEN:-0.0.0.0:47616}"
DAEMON_PORT=47615

fail() {
    echo "[agent] $*" >&2
    exit 2
}

[ -n "${PIKVM_URL:-}" ] || fail "PIKVM_URL is required (the PiKVM the web host proxies)"
[ -n "${PIKVM_PASSWORD:-}" ] || fail "PIKVM_PASSWORD is required"
operator_token="${PIKVM_HARNESS_TOKEN:-}"
[ "${#operator_token}" -ge 32 ] ||
    fail "PIKVM_HARNESS_TOKEN is required, 32+ characters (the web host's PIKVM_HARNESS_TOKEN)"
[ -n "${PIKVM_HARNESS_ALLOWED_ORIGINS:-}" ] ||
    fail "PIKVM_HARNESS_ALLOWED_ORIGINS is required, e.g. https://kvm.example.com"

# The daemon reads the PiKVM from these names (agent/pikvm_agent/config.py).
export PIKVM_BASE_URL="${PIKVM_URL%/}"
export PIKVM_USER="${PIKVM_USER:-admin}"
# The web host does not verify the Pi's certificate either: it is self-signed.
export PIKVM_VERIFY_TLS="${PIKVM_VERIFY_TLS:-0}"

# CLI homes live on the volume, so a sign-in survives the container.
export HOME="$DATA/home"
export CODEX_HOME="$HOME/.codex"
export CLAUDE_CONFIG_DIR="$HOME/.claude"
CONFIG_DIR="$DATA/config"
mkdir -p "$HOME" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$CONFIG_DIR"
chmod 700 "$DATA" "$HOME" "$CONFIG_DIR" 2>/dev/null || true

# Created once; after that the operator's providers live in it, so it is never
# rewritten. Provider keys are kept beside it in provider-keys.json (0600).
CONFIG="$CONFIG_DIR/harness.yaml"
if [ ! -f "$CONFIG" ]; then
    echo "[agent] creating the harness config at $CONFIG"
    pikvm-agent harness init --out "$CONFIG" --oauth-clis auto --listen "$LISTEN"
fi

secret() { python -c 'import secrets; print(secrets.token_urlsafe(32))'; }
export PIKVM_AGENT_DAEMON_TOKEN="$(secret)"
export PIKVM_AGENT_HARNESS_TOKEN="$(secret)"
export PIKVM_HARNESS_AGENT_TOKEN="$(secret)"
export PIKVM_HARNESS_OBSERVER_TOKEN="$(secret)"
export PIKVM_AGENT_DAEMON="http://127.0.0.1:$DAEMON_PORT"
# Read by `harness serve` as --allowed-origins / --allow-remote-bind.
export PIKVM_HARNESS_ALLOW_REMOTE_BIND=1

pids=()
stop() {
    trap - TERM INT
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
}
trap 'stop; exit 143' TERM INT

pikvm-agent daemon --host 127.0.0.1 --port "$DAEMON_PORT" &
pids+=($!)

# The harness is told where the daemon is, so it must not start first.
for _ in $(seq 1 60); do
    if python - <<PY 2>/dev/null
import urllib.request
urllib.request.urlopen("http://127.0.0.1:$DAEMON_PORT/healthz", timeout=2).read()
PY
    then break; fi
    kill -0 "${pids[0]}" 2>/dev/null || fail "the machine-control daemon exited before it was ready"
    sleep 1
done

pikvm-agent harness serve --config "$CONFIG" --listen "$LISTEN" &
pids+=($!)

# Either one ending takes the container down, so the restart policy brings both back.
status=0
wait -n || status=$?
echo "[agent] a process exited (status $status); stopping" >&2
stop
exit "$status"
