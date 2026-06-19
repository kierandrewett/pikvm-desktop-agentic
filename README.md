# pikvm-desktop

PiKVM desktop client with an integrated AI agent (Pi harness + MCP), plus a
web/mobile client served from the same server.

## Web / mobile access

The control server reverse-proxies the PiKVM target, so any browser (including a
phone) can use the Pi's own UI through it, with the agent bolted on. PiKVM
credentials stay on the server; a client only needs the server address and an
access token.

How it fits together:

- `/_agent/*` is our surface (agent API, MCP at `/_agent/mcp` and `/mcp`, the UI
  bundle). Everything else is proxied to the Pi (its UI, the MJPEG stream, the HID
  WebSocket, login). The proxy injects the PiKVM auth on every request.
- The agent UI is injected into proxied pages as a same-origin iframe behind a
  floating button, so its styling stays isolated from the Pi UI. It is a docked
  panel on desktop and a full-screen sheet on mobile.
- Touch: one finger is PiKVM input, two fingers pinch-zoom and pan the view,
  double-tap resets. On desktop browsers ctrl/cmd + wheel zooms.

To turn it on (in the desktop app: Settings -> Server):

1. Set an access token.
2. Enable "Allow access from the LAN", then restart the app (you cannot rebind a
   live listener).
3. On another device on the same network, open `http://<this-machine-ip>:25650`,
   enter the token, and tap the floating button for the agent.

The local desktop app is always allowed without a token (loopback is trusted).
The token only gates other devices.

## Build and run

```
yarn install
yarn build
yarn start          # desktop app (also runs the server)
yarn smoke:proxy    # proxy + auth smoke test (no Pi needed; uses a mock)
```

The agent API moved from `/api/*` to `/_agent/api/*` because PiKVM owns `/api/*`
and we now proxy it. `/mcp` is kept at the root for existing MCP clients.

## Architecture notes

- The desktop app hosts the server in-process and renders the Pi directly for its
  own view (no self-proxying). Remote clients use the proxy. An optional
  "desktop-via-proxy" mode is possible but not enabled, since it would route
  localhost through itself for no functional gain.
- See `TODO.md` for the migration phases.
