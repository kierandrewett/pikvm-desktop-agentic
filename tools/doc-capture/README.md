# Document capture (high-quality "scanner")

`capture.py` scans a document open on the PiKVM target by scrolling it top-to-bottom
over the video stream, registering consecutive frames with sub-pixel phase
correlation, stitching them into one tall image, splitting that back into pages at
the grey inter-page gaps, and running OCR — producing far sharper text + figures
than a single screenshot. It can emit a combined transcript (`all.txt`), per-page
images (`page_NNN.png`), and a searchable PDF.

It is **vendored** into this repo and exposed to the agent as the MCP `capture_document`
tool (`src/mcp-server.ts` → `captureDocument` dep, wired in `src/main.ts` /
`src/server-main.ts` via `src/doc-capture.ts`). The wrapper passes the live PiKVM
host/credentials, runs with `--no-confirm --keep-intermediates`, pauses our mouse
jiggler for the duration, and returns the transcript + artifact paths.

## Runtime dependencies (install once on whatever host runs the MCP server)

```
python3 -m pip install -r tools/doc-capture/requirements.txt
# plus the Tesseract OCR engine binary, e.g.:  sudo dnf install tesseract   (or apt install tesseract-ocr)
```

Set the interpreter via `PIKVM_DOCCAPTURE_PYTHON` (default `python3`) if you use a venv.

## Word prep before capturing (scan mode)

Light theme · auto-hide ribbon / full-screen · zoom = **Page Width** · Do Not Disturb
(no toast popups) · click into the doc and **Ctrl+Home** to the top.

Source: adapted from `~/dev/pikvm-ss-doc-tool`.
