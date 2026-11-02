# @pikvm/chat-ui

The agent conversation workspace: thread, composer, tool and approval cards, model picker, run
controls, provider sheets, diagnostics and the harness API client. One implementation, two hosts:

- `apps/web` renders `ChatWorkspace` at `/app/chat` (yarn workspace).
- `agent/frontend` is a thin host (npm, own lockfile) that builds the harness's standalone UI into
  `agent/pikvm_agent/harness_ui`. Its Vite config resolves this package's bare imports from its own
  `node_modules` and runs these tests too, so both dependency trees are proven.

```tsx
<ChatWorkspace apiBase="/app/harness" managedToken="desktop-managed" compact={isPhone} insets="host" />
```

- `apiBase`: where the harness API is mounted (omit for same-origin `/api`).
- `managedToken`: the host owns sign-in; never prompts, never stores, no Disconnect.
- `compact`: phone layout (sheets for pickers, task list behind a header button, 44px targets,
  composer docked above the soft keyboard, approval dock, long-press message actions).
- `insets`: `"host"` when the shell already clears the notch and home indicator.

Styles: the host defines the nine base tokens (`--background --foreground --card --muted-foreground
--secondary --accent --border --primary --primary-foreground`), imports Tailwind, `tw-animate-css`
and `tw-shimmer`, then `src/styles/tokens.css` (derives the shadcn names) and `src/styles/chat.css`,
and adds `@source` for this package. See `apps/web/src/styles.css`.

`@pikvm/chat-ui/testing` exports a fake harness and the jsdom stubs the workspace needs.
Dependencies are pinned to the versions the npm lockfile resolved (see `resolutions` in the root
`package.json`): newer `@assistant-ui/tap` breaks the external-store runtime.
