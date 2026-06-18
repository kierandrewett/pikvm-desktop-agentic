.PHONY: package

package:
	yarn build
	electron-packager dist pikvm-desktop \
		--platform=linux \
		--arch=x64 \
		--out=builds \
		--overwrite \
		--executable-name=pikvm-desktop \
		--icon=src/assets/icon
	electron-installer-redhat \
		--src builds/pikvm-desktop-linux-x64/ \
		--dest builds/rpm/ \
		--arch x86_64 \
		--name pikvm-desktop \
		--productName "PiKVM Desktop" \
		--bin pikvm-desktop \
		--icon src/assets/icon.png
