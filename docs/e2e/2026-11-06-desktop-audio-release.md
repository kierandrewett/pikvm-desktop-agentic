# Desktop audio release check, 6 November 2026

## Build and runtime

Version: 1.15.13. The Linux x64 Electron tree was built with:

```sh
yarn package --platform linux --arch x64 --tree-only
```

The packaged executable, not the source development server, was started with an isolated profile:

```sh
env XDG_CONFIG_HOME="$HOME/.cache/pk-e2e/audio/release-desktop-profile" \
    PIKVM_CONTROL_PORT=25813 PIKVM_BIND_HOST=127.0.0.1 \
    builds/pikvm-desktop-linux-x64/pikvm-desktop \
    --ozone-platform=headless --no-sandbox --disable-gpu \
    --remote-debugging-port=29813
```

It reached Electron ready, started its own backend on port 25813, loaded the app, and found the packaged agent binary. The smoke process was stopped after verification. The sandbox override was for this isolated test only; it is not a packaging change.

## Recording through the desktop

A local fixture supplied a fake kvmd control socket and a Janus-compatible signalling endpoint. Real WebRTC carried an Opus-encoded 440 Hz tone. The fixture updated only the isolated desktop profile's target, then called the packaged app's MCP endpoint on port 25813.

The recording crossed the packaged MCP handler, Desk, WebRTC receiver and packaged Opus WASM decoder. The fixture did not import or invoke the recording implementation directly. It checked the WAV format, non-silent sample energy and destruction of the recording's Janus session.

| Measurement | Result |
| --- | --- |
| MIME type | `audio/wav` |
| Duration | 1000 ms |
| WAV bytes | 192044 |
| Sample RMS | 8459.90 |
| Recording session destroyed | Yes |

Machine-local evidence is saved in `~/.cache/pk-e2e/audio/desktop-1.15.13.json`. The bundled fixture remains in `~/.cache/pk-e2e/audio/desktop-smoke.mjs`. With the packaged app running as above, repeat it from the repository root:

```sh
cp ~/.cache/pk-e2e/audio/desktop-smoke.mjs node_modules/.audio-release-smoke.mjs
node node_modules/.audio-release-smoke.mjs
rm node_modules/.audio-release-smoke.mjs
```

## Regression gates

All four type checks passed. Root tests passed 745 with one skipped; web passed 688; chat web passed 33; chat server passed 75. The production build and Linux x64 desktop tree build passed.

## Limits

This tests the packaged Linux desktop with a controlled audio source. It does not verify macOS or Windows runtime behaviour, physical microphone quality, mobile devices, or model support for audio content. Executor catalogue refresh remains separate.
