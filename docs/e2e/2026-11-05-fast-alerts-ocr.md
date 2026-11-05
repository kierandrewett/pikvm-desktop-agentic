# OCR engine benchmark for fast alerts (2026-11-05)

Which engine reads a toast on the host. The fast path is: zone diff, crop, **local OCR**, text rules, push. Target from the brief: OCR at most 800 ms for a zone crop, nothing from the screen leaving the host.

## What was run

- Script: `apps/web/e2e/watch-ocr-bench.mjs`; fixtures: `apps/web/e2e/watch-ocr-fixtures.mjs` (14 images from `watch-fast-frames.mjs`). Each fixture is a 1920 x 1080 desktop (dark editor, or a white document full of text) with one toast at 100% scale, drawn in **Open Sans** 11/12/14 px (Segoe UI is not available here; Open Sans has nearly its widths): Outlook mail (light and dark card), Teams chat (light and dark), a Teams call with Accept and Decline, a generic Windows Update toast, a one-line "Slack: Ping". JPEG quality 85, as the Pi serves.
- Three inputs per fixture: the **zone crop** (730 x 486, the whole default zone, taskbar clock included), the **tight crop** (the cells the zone diff says changed, plus two cells of margin: about 420 x 200; this is what the host reads) and the **whole frame**.
- Per engine and input: 14 fixtures x (1 cold + 3 to 5 warm) reads. **Median / p95 / max** are of the warm reads. **Word accuracy**: the share of the toast's words returned as separate words (case and punctuation ignored). **Words found**: the share found anywhere in the text once spaces are ignored (PP-OCR runs small words together: "Areyoufree"; the notification still carries them). **+RSS**: growth of the benchmark process (the tesseract binary's own memory is in its child, not counted).
- Engines: `tess-psm11` and `tess-psm6`: the `tesseract` binary 5.x, `eng`, one thread (`OMP_THREAD_LIMIT=1`), one process per read; `tess-psm11-x2`: the same on the image upscaled 2x by sharp first; `tessjs`: tesseract.js 7 (WASM), warm worker; `paddle-x1` / `paddle-x2`: PP-OCRv4 mobile detector and recogniser through onnxruntime-node, with the pipeline in `src/server/watch/ocr-paddle.ts`, input at 1x or upscaled 2x, 2 threads. `@gutenye/ocr-node` (a wrapper over the same models and onnxruntime) was tried first and crashed on this Node inside its OpenCV.js WASM, so the pipeline is the host's own (sharp for pixels, connected components for the boxes, CTC greedy decode).

## Where

- **bsociety**, in a throwaway `node:22-bookworm-slim` container (tesseract 5.3.0 from Debian): Intel Xeon E5-2680 v4 @ 2.40 GHz, 56 threads, **load average 14 to 15 during the run** (it is a busy machine, which is the point). Table 1.
- The **workstation** (this development machine, idle): tables 2 and 3. Different CPU; shown for comparison only.

## Table 1: bsociety (the target machine)

| engine | input | init ms | cold ms | median ms | p95 ms | max ms | word accuracy | words found | +RSS MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tess-psm11 | crop | 0 | 269 | 430 | 569 | 640 | 53.0% | 55.3% | -1 |
| tess-psm11 | tight | 0 | 241 | 238 | 288 | 302 | 76.2% | 79.0% | -1 |
| tess-psm11 | frame | 0 | 2063 | 2970 | 3147 | 3257 | 66.1% | 68.7% | 0 |
| tess-psm6 | crop | 0 | 253 | 447 | 541 | 557 | 59.9% | 62.1% | 1 |
| tess-psm6 | tight | 0 | 223 | 222 | 277 | 284 | 90.5% | 90.5% | 1 |
| tess-psm6 | frame | 0 | 1714 | 2990 | 3101 | 3189 | 74.1% | 78.0% | 1 |
| tess-psm11-x2 | crop | 0 | 531 | 817 | 1031 | 1039 | 55.4% | 56.0% | 24 |
| tess-psm11-x2 | tight | 0 | 369 | 382 | 445 | 459 | 82.1% | 83.3% | 22 |
| tess-psm11-x2 | frame | 0 | 4063 | 5540 | 5813 | 6018 | 62.8% | 64.5% | 68 |
| tessjs | crop | 372 | 229 | 438 | 549 | 570 | 53.0% | 55.3% | 102 |
| tessjs | tight | 372 | 107 | 105 | 159 | 161 | 75.7% | 78.4% | 107 |
| tessjs | frame | 372 | 2967 | 4302 | 4558 | 4641 | 64.2% | 66.2% | 173 |
| **paddle-x1** | crop | 677 | 386 | **771** | 981 | 1163 | 80.6% | **100.0%** | 61 |
| **paddle-x1** | **tight** | 677 | 218 | **165** | 245 | 257 | 87.2% | **100.0%** | 48 |
| paddle-x1 | frame | 677 | 2292 | 4120 | 4961 | 4984 | 57.3% | 91.7% | 266 |
| paddle-x2 | crop | 372 | 804 | 1227 | 1452 | 1533 | 73.7% | 100.0% | 150 |
| paddle-x2 | tight | 372 | 360 | 294 | 426 | 431 | 79.1% | 100.0% | 164 |
| paddle-x2 | frame | 372 | 2426 | 4043 | 4875 | 5084 | 57.3% | 91.7% | 214 |

## Table 2: workstation, tesseract variants (3 warm runs)

| engine | input | median ms | p95 ms | word accuracy |
| --- | --- | --- | --- | --- |
| tess-psm11 | crop / tight / frame | 203 / 102 / 1358 | 233 / 122 / 1392 | 52.4% / 76.8% / 66.6% |
| tess-psm6 | crop / tight / frame | 206 / 93 / 1345 | 225 / 111 / 1502 | 43.7% / 88.8% / 64.9% |
| tess-psm11-x2 | crop / tight / frame | 362 / 148 / 2416 | 405 / 175 / 2513 | 55.4% / 82.6% / 62.3% |
| tessjs | crop / tight / frame | 233 / 55 / 2158 | 274 / 82 / 2212 | 53.0% / 75.7% / 64.2% |

## Table 3: workstation, PP-OCRv4 (5 warm runs, crop and tight only)

| engine | input | init ms | cold ms | median ms | p95 ms | word accuracy | words found | +RSS MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| paddle-x1 | crop | 308 | 165 | 344 | 388 | 80.6% | 100.0% | 243 |
| paddle-x1 | tight | 308 | 104 | 68 | 104 | 87.2% | 100.0% | 240 |
| paddle-x1.5 | crop / tight | 173 | 291 / 117 | 476 / 89 | 540 / 122 | 70.7% / 71.3% | 100.0% | 232 |
| paddle-x2 | crop / tight | 199 | 391 / 154 | 558 / 115 | 619 / 166 | 73.7% / 79.1% | 100.0% | 143 / 157 |
| tess-psm6 | crop / tight | 0 | 128 / 115 | 224 / 112 | 245 / 132 | 43.7% / 88.8% | 46.4% / 89.4% | 0 |

## What it says

- **Chosen: PP-OCRv4 mobile through onnxruntime-node, at 1x, on the tight crop.** On the Xeon, with the machine at load 14, it reads the tight crop in **165 ms median (p95 245, max 257)**, the zone crop in 771 ms median (p95 981: over 800 ms at the tail), and finds **every word** of every fixture on both. That meets the 800 ms target for the crop the host actually reads. Reading the whole zone instead would not reliably meet it, which is the reason the host crops to the cells that changed.
- **Why not tesseract.** Faster on the tight crop (222 ms on the Xeon is no better than PP-OCR's 165 ms, and 5 to 6 times slower on the zone crop than on the tight one), but it fails on light text on a dark card: on the zone crop the Teams dark toast read as nothing at all (0%), and the best tesseract setting (psm 6, tight) found 90.5% of the words with junk lines. PP-OCR found 100% on dark and light, tight and zone. tesseract.js (WASM) is as accurate as the binary and 2x faster on the tight crop, but no better than PP-OCR, and needs the language data at runtime.
- **Weakness of the chosen engine:** it runs small words together in 12 px text ("Areyoufree at12:30forthe quarterlyreview"). The sender, the subject and the call line were always read correctly; only the long preview line of a mail is affected. Upscaling (x1.5, x2) did not help and costs more. "Word accuracy" is the strict score for that reason; "words found" is what a notification needs.
- **A whole frame** takes 4.1 s on the Xeon with PP-OCR (2.3 s the first time) and finds 91.7% of the words (57% as separate words). It is used only by the whole-screen path when there is no OpenRouter key, in a separate process, with a 20 s limit. It is not a fast-path operation.
- **Memory:** the OCR worker holds the models and onnxruntime: about 50 to 270 MB growth in the benchmark process, in a process of its own.
- **In the image's own constraints** (`docker run --read-only --network none --user 10001:10001 --cap-drop ALL`, the runtime stage of `deploy/Dockerfile` with the OCR layer, on bsociety at load 13 to 14, benchmark as above): PP-OCR tight crop median **180 ms** (p95 304, max 337), zone crop median **905 ms** (p95 1080); initialisation 440 ms. It works with no network and a read-only root.
- **Image size:** the runtime stage with the OCR layer (onnxruntime-node pruned to this architecture's CPU library, 46 MB; the models, 15 MB; the host's `ocr-worker.js`) measured **349 MB against 269 MB without it: +80 MB uncompressed**, built and measured on bsociety with the runtime stage's own RUN lines (a stand-in Dockerfile made from them; the full image was not built).

## What was not measured

- The real Xeon without other load (it is busy: numbers include contention) and an arm64 host.
- Real Segoe UI toasts from a real Windows PC. The fixtures are drawn: Open Sans, flat cards, no acrylic transparency, no rounded-corner anti-aliasing beyond what librsvg draws. Real toasts may read better or worse.
- Other languages and scales: 100% display scale only; the models read Chinese and English, the fixtures are English.
- Tesseract's traineddata variants (`best`, `fast` were not compared; the Debian package's `eng`).

## Licences

PP-OCRv4 (PaddleOCR): Apache-2.0, as ONNX through the npm package `@gutenye/ocr-models` 1.4.2 (MIT); onnxruntime-node 1.31.1: MIT. Both are pinned by hash in `deploy/ocr.lock`, fetched at image build by `scripts/fetch-ocr.mjs`, never at runtime.
