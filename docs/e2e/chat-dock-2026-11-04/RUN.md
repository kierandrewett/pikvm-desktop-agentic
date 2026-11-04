# Chat dock e2e, 2026-11-04 (not green)

Command:

    PUPPETEER_CORE=/home/kieran/dev/sidekick/node_modules \
    SHARP_MODULES=/home/kieran/.cache/pikvm-e2e/sharp/node_modules \
    CHROME=/usr/bin/google-chrome OMP_BIN=$(which omp) \
    node apps/web/e2e/chat-dock.e2e.mjs --out docs/e2e/chat-dock-2026-11-04 --doc /tmp/dock.md

Environment: Linux, Node 22.22.2, google-chrome, dist/ built with `yarn build` and `yarn workspace @pikvm/web build`.

Result:

* FAIL phone new chat: composer docked 12px above the nav bar (composer ends 632, bar starts 644). Same failure with the
  chat-web changes reverted, so it predates them.
* PASS greeting centred, composer width, composer above the keyboard.
* The run then times out at the "send a message" step (chat-dock.e2e.mjs line 175). The new desktop assertions
  (centred composer, floating + menu) come after that step and did not run.

The desktop checks were measured by hand over the Electron debugging port instead: composer centre y=604 of 1118, the
menu is position: fixed and sits 4px below the composer at 820, 1100 and 1500px wide.
