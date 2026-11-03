.PHONY: package icons agent-runtime web-bundle agent-bundle

# The self-contained Python runtime the app ships with: a standalone CPython
# with the agent and its core dependencies installed into it. Roughly 430MB and
# reproducible from agent/uv.lock, so it is gitignored and built here rather
# than committed.
agent-runtime:
	node scripts/build-agent-runtime.mjs

# Build and package for this machine's platform: the Electron tree, then Linux packages with pkgsmith
# (rpm, deb, Arch, AppImage, Flatpak; PKGSMITH names the binary, default: pkgsmith on PATH) or the
# macOS and Windows installers with electron-builder (dmg, zip; nsis, msi, zip), into
# builds/packages/<platform>-<arch>/. Other platforms: node scripts/package.mjs --platform win32
# --tree-only makes the tree; the packages come from running this on that platform (see .github/workflows).
package: agent-runtime
	node scripts/package.mjs

# Regenerate packaging/icons from src/assets/icon.png (needs ImageMagick; the outputs are committed).
icons:
	node scripts/make-icons.mjs

# Docker build context for the headless web host (deploy/web/Dockerfile):
# the server bundle, the console views, the web app build and the shared
# workspace components.
# Electron's main bundle and the preloads stay out; nothing here loads them.
web-bundle:
	yarn build
	yarn workspace @pikvm/web build
	rm -rf builds/web
	mkdir -p builds/web/dist
	cp dist/web-server.js dist/package.json builds/web/dist/
	cp -r dist/views dist/assets builds/web/dist/
	find builds/web/dist/views -name '*.map' -delete
	cp -r agent/pikvm_agent/harness_ui builds/web/harness_ui
	mkdir -p builds/web/apps/web
	cp -r apps/web/dist builds/web/apps/web/dist
	cp deploy/web/Dockerfile builds/web/Dockerfile
	# Readable by the container's node user whatever umask this ran under.
	chmod -R a+rX builds/web

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
