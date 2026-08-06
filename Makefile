.PHONY: package

package:
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
