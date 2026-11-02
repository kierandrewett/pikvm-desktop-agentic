.PHONY: package agent-runtime web-bundle

# The self-contained Python runtime the app ships with: a standalone CPython
# with the agent and its core dependencies installed into it. Roughly 430MB and
# reproducible from agent/uv.lock, so it is gitignored and built here rather
# than committed.
agent-runtime:
	node scripts/build-agent-runtime.mjs

package: agent-runtime
	yarn build
	node_modules/.bin/electron-packager dist pikvm-desktop \
		--platform=linux \
		--arch=x64 \
		--out=builds \
		--overwrite \
		--no-asar \
		--executable-name=pikvm-desktop \
		--icon=src/assets/icon
	node scripts/copy-runtime-deps.mjs
	node scripts/make-rpm.mjs

# Docker build context for the headless web host (deploy/web/Dockerfile):
# the server bundle, the console views and the shared workspace components.
# Electron's main bundle and the preloads stay out; nothing here loads them.
web-bundle:
	yarn build
	rm -rf builds/web
	mkdir -p builds/web/dist
	cp dist/web-server.js dist/package.json builds/web/dist/
	cp -r dist/views dist/assets builds/web/dist/
	find builds/web/dist/views -name '*.map' -delete
	cp -r agent/pikvm_agent/harness_ui builds/web/harness_ui
	cp deploy/web/Dockerfile builds/web/Dockerfile
	# Readable by the container's node user whatever umask this ran under.
	chmod -R a+rX builds/web
