# File renderer integration

`FileRenderer` renders file content, not page headers or panel controls. It uses the same Markdown component as chat messages. PDF, spreadsheet and DOCX libraries load only when the matching file opens.

```tsx
import { FileRenderer } from "../render";

<FileRenderer
    source={{ name: item.name, size: item.size, url: item.url, downloadUrl: item.downloadUrl }}
    toolbar="floating"
    onStatus={setStatus}
/>;
```

The Files `Item` contract has no MIME field. The example uses its declared fields. The renderer detects the format from the name and, when needed, the first bytes. Other hosts can supply `mimeType` when their source contract declares it.

For a host-owned toolbar, use `toolbar={{ slot: toolbarElement }}`. Keep the host container at `min-height: 0` with a defined height. `toolbar="none"` removes controls for read-only embeds. Files uses a scrollable control row below its existing header. This keeps format controls reachable in a narrow pane without moving navigation, download or close actions.

URL sources must point to a same-origin file endpoint. Do not pass an external URL or an HTML navigation endpoint. HTML uses an opaque-origin sandbox. Scripts are off by default. The user can enable isolated scripts for that preview only.

## Failure cases

Review and E2E evidence must cover:

- A missing file, forbidden file or failed download.
- A corrupt PDF, DOCX, spreadsheet or JSON document.
- An empty file and an oversized preview.
- A source change while the previous download is pending.
- The same URL with a changed name, MIME type or size.
- A failed module download followed by retry.
- An unknown file whose byte detection fails, then succeeds on retry.
- UTF-8 text whose byte size exceeds the limit despite a smaller character count.
- A malicious HTML or DOCX file with script, event handlers or external loads.
- A large spreadsheet and PDF with bounded visible rows/pages and cleanup on close.
- Clipboard access denied by the browser.
- A narrow panel, mobile width, keyboard navigation and reduced motion.

Existing isolated renderer evidence scripts are `e2e/render/shots.ts` and `e2e/render/perf.ts`. They do not prove integration in the Files page or thread panel. `e2e/browser/ambient-files.test.ts` opens Markdown, CSV, PDF, DOCX, image and empty files from the Files page at desktop and phone widths. It checks shared controls and retained host actions. The thread owner must verify the side-panel path separately.
