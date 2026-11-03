.PHONY: package icons image

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
# The commit the web app reports as its build (Settings > About); the image has no .git to ask.
BUILD_ID ?= $(shell git rev-parse --short=8 HEAD 2>/dev/null)
image:
	$(IMAGE_TOOL) build $(IMAGE_FLAGS) --build-arg PIKVM_BUILD_ID=$(BUILD_ID) -f deploy/Dockerfile -t $(IMAGE) .
