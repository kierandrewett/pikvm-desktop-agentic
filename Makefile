.PHONY: package icons image agent-bundle

# Build and package for this machine's platform: the Electron tree (with omp's binary, fetched and
# checked against deploy/omp.lock), then Linux packages with pkgsmith
# (rpm, deb, Arch, AppImage, Flatpak; PKGSMITH names the binary, default: pkgsmith on PATH) or the
# macOS and Windows installers with electron-builder (dmg, zip; nsis, msi, zip), into
# builds/packages/<platform>-<arch>/. Other platforms: node scripts/package.mjs --platform win32
# --tree-only makes the tree; the packages come from running this on that platform (see .github/workflows).
package:
	node scripts/package.mjs

# Regenerate packaging/icons from src/assets/icon.png (needs ImageMagick; the outputs are committed).
icons:
	node scripts/make-icons.mjs

# The image of the headless web host and its chat agent: one Dockerfile (deploy/Dockerfile) that builds
# from the repo root and fetches omp's binary against deploy/omp.lock. IMAGE_TOOL picks podman or docker.
IMAGE_TOOL ?= podman
IMAGE ?= pikvm-kvm:local
# podman's default OCI format drops the Dockerfile's HEALTHCHECK; docker's format keeps it.
IMAGE_FLAGS ?= $(if $(filter podman,$(IMAGE_TOOL)),--format docker)
image:
	$(IMAGE_TOOL) build $(IMAGE_FLAGS) -f deploy/Dockerfile -t $(IMAGE) .

# Docker build context for the agent sidecar (deploy/agent/Dockerfile): the agent package
# and its lock. The standalone UI's sources, tests and caches stay out.
agent-bundle:
	rm -rf builds/agent
	mkdir -p builds/agent
	cp agent/pyproject.toml agent/uv.lock agent/README.md builds/agent/
	cp -r agent/pikvm_agent builds/agent/pikvm_agent
	find builds/agent -name __pycache__ -type d -prune -exec rm -rf {} +
	cp deploy/agent/Dockerfile deploy/agent/entrypoint.sh builds/agent/
	chmod -R a+rX builds/agent
