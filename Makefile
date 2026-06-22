.PHONY: package

package:
	yarn build
	node_modules/.bin/electron-packager dist pikvm-desktop \
		--platform=linux \
		--arch=x64 \
		--out=builds \
		--overwrite \
		--executable-name=pikvm-desktop \
		--icon=src/assets/icon
	node scripts/make-rpm.mjs
