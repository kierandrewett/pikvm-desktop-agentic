# ModelBrowser review

The primitive uses the existing menu surface, row controls and settings tokens. It does not fetch models or change policy.

## Interaction contract

- Search matches the model name, identifier, vendor, provider and family.
- Vendor is the default group. A host can control grouping.
- Arrow keys move through model rows. Enter opens details or selects a model.
- Space changes the host's primary control, or selects a row when no primary control exists.
- Row controls keep their own keyboard behaviour. The grid does not intercept their keys.
- The detail pane uses a separate column in wide containers and a drill-in view in narrow containers.
- Empty, loading and error states remain inside the browser surface.

## Failure cases for browser verification

- A long catalogue renders every row instead of a bounded virtual window.
- Search or filters leave an active descendant that does not exist in the document.
- Scrolling removes the highlighted row while the grid still refers to it.
- A host switch receives Space twice because the grid also handles the key.
- A selected row reports a different selection state to assistive technology.
- Changing density leaves row offsets at their old height.
- A query change displays a hover card for a different row at the same index.
- A bulk action rejects without feedback, or runs twice during one pending action.
- A destructive bulk action does not ask for confirmation.
- A selected model disappears from the catalogue but remains in the bulk count.
- A narrow detail view does not receive focus, or Back does not return focus to the grid.
- Empty, error or loading content overflows the container at phone width.

## Application verification cases

- The provider detail page omits configured models or displays a different provider's models.
- The default-model dialog saves a label instead of the model identifier, or loses the value after reload.
- The admin feature detail saves a broad rule instead of an exact model override.
- The saved feature override does not change the resolved feature state in `/api/models`.
- A provider page shows per-model switches that do not write the declared `disabledModels` field, or a turned-off
  model still reaches the model picker or a chat (covered by e2e/api/providers-mcp.test.ts and
  e2e/browser/providers-mcp.ts).
- A picker host shows the vendor/provider switch or an empty rail where grouping is not the point (settings picker).

## Verification scope

The deterministic development harness is `apps/web/dev/model-browser.html`. It supports provider controls, policy controls and a picker host. Harness browser checks are isolated component checks, not complete application E2E checks.

Run `bun e2e/browser/model-browser.ts` from the repository root when the serial browser slot is available. The script checks the real Settings provider pages, desktop and phone default-model persistence, and admin model-feature persistence through `/api/models`. It then checks the deterministic component hosts. It saves the command, environment, result, measurements, screenshots and server log under `e2e/artifacts/model-browser/<timestamp>/`.

The script uses a private account and server data directory. It does not change the development account. Its Vite server has a private dependency cache and no file watching. Process-group cleanup covers Vite, the server and Chrome. The fake model server stops in the same cleanup phase.

Pending coverage outside this script includes hover-card identity after filtering, selected identifiers removed from a live catalogue, and broader Settings layout checks. A passing script does not establish screen-reader compatibility or a production-build result.
