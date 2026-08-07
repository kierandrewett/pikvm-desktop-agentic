.PHONY: package agent-runtime

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
