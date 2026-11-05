# Signing a desktop app in with the browser (end to end)

Result: 13 of 13 checks passed.

| Check | Result | Observed |
| --- | --- | --- |
| the app answers an address on the server to open in the browser | pass | http://127.0.0.1:8098/app/auth/device |
| a browser with no session is first sent to the host's own sign-in | pass | http://127.0.0.1:8098/app/login |
| after signing in it shows the consent page | pass | Allow this app to use this server? |
| Allow sends the browser back to the app, which says it is signed in | pass | PiKVM Desktop  Signed in. You can close this tab and go back to PiKVM Desktop. |
| the app has the server saved | pass | {"state":"done","entry":{"id":"375ae00f920c1a7d","name":"127.0.0.1:8098","origin":"http://127.0.0.1:8098","tokenSet":true,"active":false,"state":"ok"}} |
| the saved credential is a device token, not the access token | pass | pkd_9ceb |
| the device token opens the app API | pass | HTTP 200 |
| and it never sets a cookie | pass | null |
| a device token is not accepted as a cookie | pass | HTTP 401 |
| a device cannot list the other devices | pass | HTTP 403 |
| a made-up code gets nothing | pass | HTTP 400 |
| Settings > Account lists the signed-in app | pass | named |
| Revoke takes the list entry away and the token stops working | pass | HTTP 401 |

## How this run was made

```sh
TOKEN=<access token> KVM_WEB=http://127.0.0.1:8098 PUPPETEER_CORE=/home/kieran/dev/sidekick/node_modules CHROME=/usr/bin/google-chrome \
    node apps/web/e2e/device-sign-in.e2e.mjs
```

- Repository commit: `0800b9fc` (host built with `yarn workspace @pikvm/web build && yarn build`).
- Node v22.22.2. The desktop side is the real `src/server/sync` module bundled with esbuild; the host is `dist/web-server.js` with `PIKVM_ACCESS_TOKEN` set and a scratch data directory.
- Not covered: the Electron window, a real identity provider, a phone.
