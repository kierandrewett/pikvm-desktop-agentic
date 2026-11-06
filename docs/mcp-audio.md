# Record target audio over MCP

Call the `listen` tool on the [MCP endpoint](deploy-web.md#mcp-server-any-agent-outside-the-app):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "listen",
    "arguments": { "duration_ms": 5000 }
  }
}
```

The reply contains a text duration and an MCP audio block. The audio block has base64-encoded WAV data and MIME type `audio/wav`. The recording is stereo, 48 kHz, 16-bit PCM. The host does not save recordings to disk.

| Argument | Type and accepted values | Default | Effect |
| --- | --- | --- | --- |
| `duration_ms` | Integer, 100 to 30000 | 5000 | Maximum recording duration in milliseconds |

The PiKVM must support audio through its Janus streamer. The host needs network access to its WebSocket and WebRTC media ports. Unsupported audio, connection failures and capture timeouts return a failed tool result. Cancellation closes the recording session.

## Existing audio and microphone sessions

Each recording uses a separate Janus session and handle. It requests audio reception only, with microphone and camera disabled. Cleanup destroys only that session. It does not change browser audio settings, capture a local microphone, or send sound to the target.

A real Chromium session with an active audio receiver and a synthetic, silent microphone stayed connected while two server listeners captured audio. Incoming and outgoing audio packet counts continued to increase. This verifies concurrent transport, not physical microphone quality or a real mobile device.

## Client support

The MCP client must accept audio content. This tool does not provide transcription or text-to-speech. A text-only model cannot hear the recording merely because the tool returned it.

## Repeat the real-device smoke check

Use a host with access to the PiKVM. Supply credentials through its existing environment, not command arguments:

```sh
yarn exec tsx scripts/audio-smoke.ts
```

The command requires the same PiKVM URL, user and password environment variables as the web host. It calls the real MCP handler and Desk, validates a one-second WAV response, prints only format metadata, and closes the Desk. It does not save audio or change approval settings.
