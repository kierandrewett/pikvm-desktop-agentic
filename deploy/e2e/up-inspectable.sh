#!/bin/sh
# The image for apps/web/e2e/chat.e2e.mjs (podman only). That suite reads the agent's environment, command line and files to
# prove no secret reaches them, so they must be readable by the user running it. Under rootless podman's default mapping they
# belong to a sub-uid; `--userns=keep-id:uid=1000,gid=1000` runs the image's user (E2E_UID, 1000 by default, as on bsociety) as THIS user instead, and /data
# is a host directory (label=disable, as in compose.yml: Fedora's SELinux refuses a bind mount otherwise). Everything else is as deploy/e2e/compose.yml: read-only root, tmpfs /tmp, no capability.
#
#   deploy/e2e/up-inspectable.sh up      # starts fake-kvmd, fake-model (compose project E2E_PROJECT, default pikvm-e2e) and the image
#   deploy/e2e/up-inspectable.sh down
#
# Prints the environment the browser suites need (E2E_WEB, E2E_KVMD, E2E_MODEL, E2E_MODEL_URL, E2E_HOST_PID, E2E_DATA, and for the screen
# watch E2E_CONTAINER, E2E_PUSH, E2E_PUSH_AUDIENCE, E2E_OR, E2E_OR_URL). E2E_UID (default 1000, the uid of /config/apps/kvm on bsociety)
# is the user the image runs as; E2E_ENV_FILE adds `-e` variables to the kvm container (the watch run's pacing).
set -eu
cd "$(dirname "$0")/../.."
IMAGE=${KVM_IMAGE:-pikvm-kvm:local}
export KVM_HOST_PORT=${KVM_HOST_PORT:-18080} FAKE_KVMD_PORT=${FAKE_KVMD_PORT:-14510} FAKE_MODEL_PORT=${FAKE_MODEL_PORT:-19090} FAKE_PUSH_PORT=${FAKE_PUSH_PORT:-14720} FAKE_OPENROUTER_PORT=${FAKE_OPENROUTER_PORT:-14730}
UID_=${E2E_UID:-1000}
P=${E2E_PROJECT:-pikvm-e2e}   # a second run beside the first needs its own project, ports (KVM_HOST_PORT, FAKE_*_PORT) and E2E_DATA
DATA=${E2E_DATA:-$HOME/.cache/pikvm-e2e/image-data}
compose() { podman compose -p $P -f deploy/e2e/compose.yml "$@"; }
case "${1:-up}" in
up)
    rm -rf "$DATA"; mkdir -p "$DATA"
    compose up -d fake-kvmd fake-model fake-push fake-openrouter >&2
    podman rm -f ${P}-kvm >/dev/null 2>&1 || true
    podman run -d --name ${P}-kvm --network ${P}_kvm-internal --network-alias kvm \
        --userns=keep-id:uid=$UID_,gid=$UID_ --user $UID_:$UID_ ${E2E_ENV_FILE:+--env-file $E2E_ENV_FILE} --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --security-opt label=disable \
        -e PIKVM_URL=http://fake-kvmd:4510 -e PIKVM_USER=admin -e PIKVM_PASSWORD=anything -e PIKVM_AUTH=proxy -e PORT=8080 \
        -p "127.0.0.1:$KVM_HOST_PORT:8080" -v "$DATA:/data" "$IMAGE" >&2
    for _ in $(seq 60); do curl -fsS -o /dev/null "http://127.0.0.1:$KVM_HOST_PORT/app/manifest.webmanifest" 2>/dev/null && break; sleep 1; done
    echo "E2E_WEB=http://127.0.0.1:$KVM_HOST_PORT"
    echo "E2E_KVMD=http://127.0.0.1:$FAKE_KVMD_PORT"
    echo "E2E_MODEL=http://127.0.0.1:$FAKE_MODEL_PORT"
    echo "E2E_MODEL_URL=http://fake-model:9000/v1"
    echo "E2E_HOST_PID=$(podman inspect -f '{{.State.Pid}}' ${P}-kvm)"
    echo "E2E_DATA=$DATA"
    echo "E2E_CONTAINER=${P}-kvm"
    echo "E2E_PUSH=http://127.0.0.1:$FAKE_PUSH_PORT"
    echo "E2E_PUSH_AUDIENCE=http://fake-push:14720"
    echo "E2E_OR=http://127.0.0.1:$FAKE_OPENROUTER_PORT"
    echo "E2E_OR_URL=http://fake-openrouter:14730/api/v1"
    ;;
down)
    podman rm -f ${P}-kvm >/dev/null 2>&1 || true
    compose down -v >&2
    ;;
*) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
