#!/bin/sh
# The image for apps/web/e2e/chat.e2e.mjs (podman only). That suite reads the agent's environment, command line and files to
# prove no secret reaches them, so they must be readable by the user running it. Under rootless podman's default mapping they
# belong to a sub-uid; `--userns=keep-id:uid=10001,gid=10001` runs the image's own user (10001) as THIS user instead, and /data
# is a host directory (label=disable, as in compose.yml: Fedora's SELinux refuses a bind mount otherwise). Everything else is as deploy/e2e/compose.yml: read-only root, tmpfs /tmp, no capability.
#
#   deploy/e2e/up-inspectable.sh up      # starts fake-kvmd, fake-model (compose project pikvm-e2e) and the image
#   deploy/e2e/up-inspectable.sh down
#
# Prints the environment chat.e2e.mjs needs (E2E_WEB, E2E_KVMD, E2E_MODEL, E2E_MODEL_URL, E2E_HOST_PID, E2E_DATA).
set -eu
cd "$(dirname "$0")/../.."
IMAGE=${KVM_IMAGE:-pikvm-kvm:local}
export KVM_HOST_PORT=${KVM_HOST_PORT:-18080} FAKE_KVMD_PORT=${FAKE_KVMD_PORT:-14510} FAKE_MODEL_PORT=${FAKE_MODEL_PORT:-19090}
DATA=${E2E_DATA:-$HOME/.cache/pikvm-e2e/image-data}
compose() { podman compose -p pikvm-e2e -f deploy/e2e/compose.yml "$@"; }
case "${1:-up}" in
up)
    rm -rf "$DATA"; mkdir -p "$DATA"
    compose up -d fake-kvmd fake-model >&2
    podman rm -f pikvm-e2e-kvm >/dev/null 2>&1 || true
    podman run -d --name pikvm-e2e-kvm --network pikvm-e2e_kvm-internal --network-alias kvm \
        --userns=keep-id:uid=10001,gid=10001 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --security-opt label=disable \
        -e PIKVM_URL=http://fake-kvmd:4510 -e PIKVM_USER=admin -e PIKVM_PASSWORD=anything -e PIKVM_AUTH=proxy -e PORT=8080 \
        -p "127.0.0.1:$KVM_HOST_PORT:8080" -v "$DATA:/data" "$IMAGE" >&2
    echo "E2E_WEB=http://127.0.0.1:$KVM_HOST_PORT"
    echo "E2E_KVMD=http://127.0.0.1:$FAKE_KVMD_PORT"
    echo "E2E_MODEL=http://127.0.0.1:$FAKE_MODEL_PORT"
    echo "E2E_MODEL_URL=http://fake-model:9000/v1"
    echo "E2E_HOST_PID=$(podman inspect -f '{{.State.Pid}}' pikvm-e2e-kvm)"
    echo "E2E_DATA=$DATA"
    ;;
down)
    podman rm -f pikvm-e2e-kvm >/dev/null 2>&1 || true
    compose down -v >&2
    ;;
*) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
