#!/usr/bin/env python3
"""Capture a Word document over a PiKVM video stream at high resolution.

Two capture modes:

  scan  (default) -- High-resolution "scanner". Set Word zoom to *Page Width*
        so each page fills the window width (~4x the resolution of One-Page
        zoom). The tool scrolls the document continuously with the mouse
        wheel, registers consecutive frames with sub-pixel phase correlation,
        and stitches every frame into one tall image of the whole document.
        That image is split back into pages at the grey inter-page gaps. Text
        and embedded figures come through far sharper, so OCR is much better.

  paged -- Legacy behaviour. Set Word zoom to "One Page", the tool captures one
        page, presses Page Down, repeats until the page stops changing.

Setup in Word before running (scan mode):
  1. Switch to light mode (View > Switch Modes, or a non-dark Office theme) --
     OCR and figure capture need a white page.
  2. Auto-hide the Ribbon / go full-screen to maximise the editing area.
  3. Set zoom to *Page Width* (View > Page Width) so a page fills the width.
  4. Turn on Focus assist / Do Not Disturb so notification toasts don't pop in.
  5. Click into the document and put the caret at the very top (Ctrl+Home).

Both modes then OCR each page (Tesseract) and build a searchable PDF.
"""

import argparse
import getpass
import io
import os
import sys
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
import urllib3
from PIL import Image, ImageFilter, ImageOps

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
# A full-document scan stitches into a very tall image; allow it.
Image.MAX_IMAGE_PIXELS = None

ENV_PATH = Path(__file__).resolve().parent / ".env"


def load_env(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def save_env(path: Path, data: dict[str, str]) -> None:
    body = "\n".join(f'{k}="{v}"' for k, v in data.items()) + "\n"
    path.write_text(body, encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def page_signature(img: Image.Image, size: int = 256) -> np.ndarray:
    """Downsampled grayscale signature for fuzzy equality between crops."""
    g = img.convert("L").resize((size, size), Image.BILINEAR)
    return np.asarray(g, dtype=np.int16)


def signature_diff(a: np.ndarray, b: np.ndarray) -> float:
    """Mean absolute pixel difference, normalised to 0..1."""
    return float(np.abs(a - b).mean()) / 255.0


def derive_title(text: str, word_count: int = 10) -> str:
    """First ~N OCR words, sanitised for use as filename + PDF /Title."""
    words = text.split()[:word_count]
    raw = " ".join(words)
    cleaned = "".join(c if (c.isalnum() or c in " -_") else " " for c in raw)
    cleaned = " ".join(cleaned.split())
    return cleaned[:80].strip()


def prompt_credentials(host: str, current_user: str) -> tuple[str, str]:
    print(f"\nAuthentication required for {host}.")
    user = input(f"  Username [{current_user}]: ").strip() or current_user
    password = getpass.getpass("  Password: ")
    return user, password


# --------------------------------------------------------------------------
# OCR
# --------------------------------------------------------------------------

def enhance_for_ocr(img: Image.Image, target_width: int = 2400) -> Image.Image:
    """Upscale + contrast-stretch + sharpen so Tesseract sees crisp glyphs.

    Resolution is the single biggest OCR lever, so small pages are scaled up to
    ~300dpi-equivalent. Colour is preserved (figures stay in the PDF); Tesseract
    binarises internally so colour input is fine.
    """
    w, h = img.size
    if w < target_width:
        scale = target_width / w
        img = img.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    img = ImageOps.autocontrast(img.convert("RGB"), cutoff=1)
    img = img.filter(ImageFilter.UnsharpMask(radius=1.4, percent=130, threshold=2))
    # Set a sensible DPI so the searchable PDF lays out at roughly A4 size.
    dpi = max(150, round(img.size[0] / 8.27))
    img.info["dpi"] = (dpi, dpi)
    return img


def _ocr_page(
    img: Image.Image,
    txt_path: Path,
    pdf_path: Path | None,
    lang: str,
) -> Path:
    """OCR one page; writes a .txt and optionally a searchable per-page .pdf."""
    import pytesseract  # imported lazily so OCR is optional

    prepped = enhance_for_ocr(img)
    config = "--oem 1 --psm 3 -c preserve_interword_spaces=1"
    text = pytesseract.image_to_string(prepped, lang=lang, config=config)
    txt_path.write_text(text, encoding="utf-8")
    if pdf_path is not None:
        pdf_bytes = pytesseract.image_to_pdf_or_hocr(
            prepped, lang=lang, extension="pdf", config=config
        )
        pdf_path.write_bytes(pdf_bytes)
    return txt_path


# --------------------------------------------------------------------------
# Page geometry / image registration
# --------------------------------------------------------------------------

def _longest_run(mask: np.ndarray, threshold: float = 0.5) -> tuple[int, int]:
    """Longest contiguous run of indices where mask >= threshold."""
    flags = mask >= threshold
    best = (0, -1)
    cur_start = None
    for i, f in enumerate(flags):
        if f and cur_start is None:
            cur_start = i
        elif not f and cur_start is not None:
            if i - 1 - cur_start > best[1] - best[0]:
                best = (cur_start, i - 1)
            cur_start = None
    if cur_start is not None and len(flags) - 1 - cur_start > best[1] - best[0]:
        best = (cur_start, len(flags) - 1)
    if best[1] < best[0]:
        raise RuntimeError(
            "No page-like region found. In scan mode the page must be a light "
            "(white) sheet -- switch Word out of dark mode and set zoom to "
            "Page Width, or pass --bbox x0,y0,x1,y1 to crop manually."
        )
    return best


def detect_page_xband(img: Image.Image) -> tuple[int, int]:
    """Find the page's horizontal extent (a tall band of mostly-white columns)."""
    arr = np.array(img.convert("RGB"))
    white = (arr[:, :, 0] > 235) & (arr[:, :, 1] > 235) & (arr[:, :, 2] > 235)
    col_score = white.mean(axis=0)
    x0, x1 = _longest_run(col_score, threshold=0.4)
    return x0, x1 + 1


def detect_page_bbox(img: Image.Image) -> tuple[int, int, int, int]:
    """Find the full white page rectangle (used by paged mode)."""
    x0, x1 = detect_page_xband(img)
    arr = np.array(img.convert("RGB"))
    white = (arr[:, :, 0] > 240) & (arr[:, :, 1] > 240) & (arr[:, :, 2] > 240)
    row_score = white[:, x0:x1].mean(axis=1)
    page_rows = np.where(row_score >= 0.3)[0]
    if len(page_rows) == 0:
        raise RuntimeError("Found page columns but no page rows.")
    return (x0, int(page_rows[0]), x1, int(page_rows[-1]) + 1)


def vertical_offset(prev: Image.Image, cur: Image.Image) -> tuple[float, float]:
    """Sub-pixel (dy, dx) to align `cur` onto `prev` via phase correlation.

    Positive dy means the document content scrolled up by that many pixels
    between the two frames. Registration uses the central column band so a
    stray notification toast at the screen edge can't skew the result.
    """
    from skimage.registration import phase_cross_correlation

    a = np.asarray(prev.convert("L"), dtype=np.float32)
    b = np.asarray(cur.convert("L"), dtype=np.float32)
    w = a.shape[1]
    lo, hi = int(w * 0.15), int(w * 0.85)
    a = a[:, lo:hi]
    b = b[:, lo:hi]
    shift, _, _ = phase_cross_correlation(a, b, upsample_factor=4)
    return float(shift[0]), float(shift[1])


def split_pages(
    tall: Image.Image,
    gap_white_max: float = 0.06,
    gap_min_px: int = 12,
    min_page_px: int = 400,
) -> list[Image.Image]:
    """Split a stitched full-document image into per-page images.

    In Word's print layout each page is a white sheet separated by a grey gap.
    A page keeps white left/right margins even where a full-width figure sits,
    so 'this row has almost no white anywhere' uniquely marks an inter-page gap
    and won't be fooled by dark figures inside a page.
    """
    arr = np.array(tall.convert("RGB"))
    h, w, _ = arr.shape
    inset = max(2, int(w * 0.04))
    core = arr[:, inset : w - inset]
    white = (core[:, :, 0] > 235) & (core[:, :, 1] > 235) & (core[:, :, 2] > 235)
    row_white = white.mean(axis=1)

    is_gap = row_white < gap_white_max
    sep = np.zeros(h, dtype=bool)
    start = None
    for i, f in enumerate(is_gap):
        if f and start is None:
            start = i
        elif not f and start is not None:
            if i - start >= gap_min_px:
                sep[start:i] = True
            start = None
    if start is not None and h - start >= gap_min_px:
        sep[start:h] = True

    pages: list[Image.Image] = []
    start = None
    for i in range(h):
        if not sep[i] and start is None:
            start = i
        elif sep[i] and start is not None:
            if i - start >= min_page_px:
                pages.append(tall.crop((0, start, w, i)))
            start = None
    if start is not None and h - start >= min_page_px:
        pages.append(tall.crop((0, start, w, h)))
    return pages


class PiKVM:
    def __init__(self, host: str, user: str, password: str, scheme: str = "https"):
        self.host = host
        self.base = f"{scheme}://{host}"
        self.user = user
        self.password = password
        self.session = requests.Session()
        self.session.verify = False
        self._apply_auth()

    def _apply_auth(self) -> None:
        self.session.headers.update(
            {"X-KVMD-User": self.user, "X-KVMD-Passwd": self.password}
        )

    def set_credentials(self, user: str, password: str) -> None:
        self.user = user
        self.password = password
        self._apply_auth()

    def snapshot(self) -> Image.Image:
        r = self.session.get(f"{self.base}/api/streamer/snapshot", timeout=15)
        r.raise_for_status()
        return Image.open(io.BytesIO(r.content)).copy()

    def _send(self, key: str, state: bool) -> None:
        r = self.session.post(
            f"{self.base}/api/hid/events/send_key",
            params={"key": key, "state": "true" if state else "false"},
            timeout=5,
        )
        r.raise_for_status()

    def press(self, key: str, hold_ms: int = 60) -> None:
        self._send(key, True)
        time.sleep(hold_ms / 1000)
        self._send(key, False)

    def chord(self, *keys: str, hold_ms: int = 80) -> None:
        """Press keys in order, hold, then release in reverse order."""
        pressed: list[str] = []
        try:
            for k in keys:
                self._send(k, True)
                pressed.append(k)
                time.sleep(0.04)
            time.sleep(hold_ms / 1000)
        finally:
            for k in reversed(pressed):
                try:
                    self._send(k, False)
                except Exception:
                    pass
                time.sleep(0.04)

    # --- mouse ---------------------------------------------------------
    def move_to(self, to_x: int, to_y: int) -> None:
        """Absolute mouse move; coords span -32768..32767, (0,0) is centre."""
        r = self.session.post(
            f"{self.base}/api/hid/events/send_mouse_move",
            params={"to_x": to_x, "to_y": to_y},
            timeout=5,
        )
        r.raise_for_status()

    def click(self, button: str = "left") -> None:
        for state in ("true", "false"):
            r = self.session.post(
                f"{self.base}/api/hid/events/send_mouse_button",
                params={"button": button, "state": state},
                timeout=5,
            )
            r.raise_for_status()
            time.sleep(0.04)

    def wheel(self, delta_y: int, delta_x: int = 0) -> None:
        r = self.session.post(
            f"{self.base}/api/hid/events/send_mouse_wheel",
            params={"delta_x": delta_x, "delta_y": delta_y},
            timeout=5,
        )
        r.raise_for_status()

    def scroll_down(self, notches: int, gap: float = 0.12) -> None:
        """Scroll down by `notches` wheel clicks, one at a time.

        The HID gadget silently drops large single wheel events (delta_y >= ~10)
        and coalesces rapid-fire ones, so notches are sent individually and
        spaced out -- the only combination that scrolls reliably.
        """
        for _ in range(int(notches)):
            self.wheel(-1)
            time.sleep(gap)


def snapshot_with_auth_retry(kvm: PiKVM, env_extras: dict[str, str]) -> Image.Image:
    """Fetch a snapshot; on 401/403, prompt for new creds and persist to .env."""
    while True:
        try:
            return kvm.snapshot()
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else None
            if status not in (401, 403):
                raise
            print(f"PiKVM returned {status} for the snapshot endpoint.")
            user, password = prompt_credentials(kvm.host, kvm.user)
            kvm.set_credentials(user, password)
            save_env(
                ENV_PATH,
                {
                    **env_extras,
                    "PIKVM_USER": user,
                    "PIKVM_PASSWORD": password,
                },
            )
            print(f"Saved credentials to {ENV_PATH}\n")


def parse_bbox(s: str) -> tuple[int, int, int, int]:
    parts = [int(p) for p in s.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("--bbox must be x0,y0,x1,y1")
    return tuple(parts)  # type: ignore[return-value]


# --------------------------------------------------------------------------
# scan mode: scroll the whole document and stitch every frame together
# --------------------------------------------------------------------------

def scan_document(
    kvm: PiKVM,
    env_extras: dict[str, str],
    manual_x: tuple[int, int] | None,
    crop_top: int,
    crop_bottom: int,
    overlap: float,
    calib_notches: int,
    settle: float,
    min_shift: float,
    stop_after: int,
    max_steps: int,
) -> Image.Image:
    """Scroll from the caret to the document end, stitching into one tall image.

    Returns the stitched image of the page column band (the whole document body
    top-to-bottom). Assumes Word is at Page-Width zoom with the caret at the top.
    """

    def home() -> Image.Image:
        kvm.chord("ControlLeft", "Home")
        time.sleep(max(settle * 2, 1.5))
        return snapshot_with_auth_retry(kvm, env_extras)

    # Detect the page band on the first page after Ctrl+Home: the title page is
    # mostly white, so the white-column run spans the whole page width. Detecting
    # on whatever happened to be on screen can fragment on tables/figures.
    kvm.move_to(0, 0)
    time.sleep(0.2)
    top_frame = home()
    if manual_x is not None:
        x0, x1 = manual_x
        print(f"Using manual page columns: x={x0}-{x1}")
    else:
        x0, x1 = detect_page_xband(top_frame)
        print(f"Detected page columns: x={x0}-{x1} ({x1-x0}px wide)")

    def content_crop(img: Image.Image) -> Image.Image:
        h = img.height
        return img.crop((x0, crop_top, x1, max(crop_top + 1, h - crop_bottom)))

    content_h = content_crop(top_frame).height

    def measure(a: Image.Image, b: Image.Image) -> float:
        """Downward shift (px) from a to b, de-aliased into [0, content_h)."""
        dy, _ = vertical_offset(a, b)
        # phase correlation reports shifts modulo the frame height in
        # [-h/2, h/2); a downward scroll past half the frame comes back
        # negative, so add the height back to recover the true offset.
        if dy < -1.0:
            dy += content_h
        return dy

    def grab() -> Image.Image:
        """Snapshot, waiting until the screen stops changing (fully rendered).

        Defeats stale/mid-render frames: a real scroll never reads as zero just
        because the video lagged, so content is never silently dropped.
        """
        prev_sig = None
        last = content_crop(snapshot_with_auth_retry(kvm, env_extras))
        for _ in range(12):
            sig = page_signature(last)
            if prev_sig is not None and signature_diff(sig, prev_sig) < 0.002:
                return last
            prev_sig = sig
            time.sleep(0.12)
            last = content_crop(snapshot_with_auth_retry(kvm, env_extras))
        return last

    # --- calibrate pixels-per-notch so steps leave the requested overlap ---
    # already centred and at the top from page-band detection above
    cal_a = grab()
    kvm.scroll_down(calib_notches)
    cal_b = grab()
    px_per_notch = abs(measure(cal_a, cal_b)) / calib_notches
    if px_per_notch < 0.5:
        raise RuntimeError(
            "Scrolling did not move the document (px/notch ~ 0). Make sure the "
            "Word window is focused and the caret/mouse is over the page."
        )
    # Cap the step below half the frame so registration never aliases.
    step_px = min(content_h * (1.0 - overlap), content_h * 0.45)
    notches = max(1, round(step_px / px_per_notch))
    expected = notches * px_per_notch
    print(
        f"Calibrated: {px_per_notch:.1f}px/notch, content {content_h}px tall; "
        f"scrolling {notches} notch(es) (~{expected:.0f}px, "
        f"{100*(1-expected/content_h):.0f}% overlap) per step."
    )

    # --- continuous scroll + stitch ---------------------------------------
    home()
    prev = grab()
    strips: list[tuple[float, Image.Image]] = [(0.0, prev)]
    cum = 0.0
    no_progress = 0

    # The reference frame always advances to the latest capture, so every
    # registration is a single small step (overlap never compounds) and the
    # cumulative offset is just the sum of detected per-frame movements. A
    # dropped scroll then contributes a clean zero instead of desyncing.
    for step in range(1, max_steps + 1):
        kvm.move_to(0, 0)  # re-centre so the jiggler can't park us off the page
        kvm.scroll_down(notches)
        cur = grab()
        dy = measure(prev, cur)
        prev = cur

        if dy < min_shift:
            no_progress += 1
            print(f"  [{step:03d}] no scroll ({no_progress}/{stop_after})")
            if no_progress >= stop_after:
                print("Reached document end.")
                break
            continue
        no_progress = 0

        if dy >= content_h * 0.97:
            print(f"  [{step:03d}] overlap lost ({dy:.0f}px); using {expected:.0f}px")
            dy = expected

        cum += dy
        strips.append((cum, cur))
        print(f"  [{step:03d}] +{dy:.0f}px  (total {cum:.0f}px, {len(strips)} strips)")
    else:
        print(f"Hit --max-steps={max_steps} before detecting the end.")

    # --- compose the tall canvas ------------------------------------------
    strip_w, strip_h = strips[0][1].size
    total_h = int(round(cum)) + strip_h
    canvas = Image.new("RGB", (strip_w, total_h), (255, 255, 255))
    for off, strip in strips:
        canvas.paste(strip, (0, int(round(off))))
    print(f"Stitched canvas: {strip_w}x{total_h}px from {len(strips)} frames.")
    return canvas


# --------------------------------------------------------------------------
# shared output tail: OCR each page, combine text, build searchable PDF
# --------------------------------------------------------------------------

def process_pages(pages: list[Image.Image], args, out: Path) -> int:
    saved = len(pages)
    for n, page in enumerate(pages, 1):
        page.save(out / f"page_{n:03d}.png")
    print(f"Saved {saved} page image(s) to {out}/")

    if not args.ocr:
        return 0

    ocr_pool = ThreadPoolExecutor(max_workers=args.ocr_workers, thread_name_prefix="ocr")
    ocr_jobs: list[tuple[int, Future[Path]]] = []
    for n, page in enumerate(pages, 1):
        txt_path = out / f"page_{n:03d}.txt"
        pdf_path = out / f"page_{n:03d}.pdf" if args.pdf else None
        ocr_jobs.append(
            (n, ocr_pool.submit(_ocr_page, page.copy(), txt_path, pdf_path, args.ocr_lang))
        )

    print(f"Running OCR on {len(ocr_jobs)} page(s)...")
    ocr_pool.shutdown(wait=True)
    failed = 0
    for n, fut in ocr_jobs:
        exc = fut.exception()
        if exc is not None:
            failed += 1
            print(f"  page {n:03d} OCR failed: {exc}", file=sys.stderr)

    if args.combine_text and saved > 0:
        combined = out / "all.txt"
        with combined.open("w", encoding="utf-8") as f:
            for n in range(1, saved + 1):
                txt = out / f"page_{n:03d}.txt"
                if txt.exists():
                    f.write(f"--- page {n} ---\n")
                    f.write(txt.read_text(encoding="utf-8"))
                    f.write("\n")
        print(f"Wrote combined transcript: {combined}")

    if args.pdf and saved > 0:
        from pypdf import PdfWriter

        writer = PdfWriter()
        merged = 0
        for n in range(1, saved + 1):
            pdf_path = out / f"page_{n:03d}.pdf"
            if pdf_path.exists():
                writer.append(str(pdf_path))
                merged += 1
        if merged:
            title = ""
            page1_txt = out / "page_001.txt"
            if page1_txt.exists():
                title = derive_title(page1_txt.read_text(encoding="utf-8"))
            pdf_name = args.pdf_name or (f"{title}.pdf" if title else "document.pdf")
            if title:
                writer.add_metadata({"/Title": title})
            doc_path = out / pdf_name
            with doc_path.open("wb") as f:
                writer.write(f)
            label = f"'{title}'" if title else "(no title)"
            print(f"Wrote searchable PDF: {doc_path} ({merged} pages, title {label})")
            if not args.keep_intermediates and failed == 0:
                removed = 0
                for n in range(1, saved + 1):
                    for suffix in (".png", ".pdf", ".txt"):
                        p = out / f"page_{n:03d}{suffix}"
                        if p.exists():
                            p.unlink()
                            removed += 1
                all_txt = out / "all.txt"
                if all_txt.exists():
                    all_txt.unlink()
                    removed += 1
                print(f"Cleaned up {removed} intermediate file(s).")
        else:
            print("No per-page PDFs found; skipping merge.", file=sys.stderr)
    return 5 if failed else 0


def run_paged(kvm: PiKVM, args, out: Path, env_extras: dict[str, str], first: Image.Image,
              bbox: tuple[int, int, int, int]) -> int:
    """Legacy one-page-per-PageDown capture, collecting pages then processing."""
    if args.rewind:
        sig_a = page_signature(first.crop(bbox))
        kvm.press("PageDown")
        time.sleep(args.delay)
        probe = snapshot_with_auth_retry(kvm, env_extras)
        sig_b = page_signature(probe.crop(bbox))
        if signature_diff(sig_a, sig_b) < args.similarity:
            print("Doc looks like it's at the bottom -- sending Ctrl+Home...")
            kvm.chord("ControlLeft", "Home")
            time.sleep(max(args.delay * 2, 2.0))
            first = snapshot_with_auth_retry(kvm, env_extras)
        else:
            print("Doc is not at the bottom; reverting probe with PageUp...")
            kvm.press("PageUp")
            time.sleep(args.delay)
            first = snapshot_with_auth_retry(kvm, env_extras)

    pages: list[Image.Image] = []
    last_sig: np.ndarray | None = None
    dup_count = 0
    img = first
    for i in range(1, args.max_pages + 1):
        if i > 1:
            img = snapshot_with_auth_retry(kvm, env_extras)
        page = img.crop(bbox)
        sig = page_signature(page)
        diff = signature_diff(sig, last_sig) if last_sig is not None else 1.0
        if last_sig is not None and diff < args.similarity:
            dup_count += 1
            print(f"  [{i:03d}] no change ({dup_count}/{args.stop_after}, diff={diff:.5f})")
            if dup_count >= args.stop_after:
                print(f"\nReached bottom. {len(pages)} pages captured.")
                break
        else:
            pages.append(page.copy())
            print(f"  [{i:03d}] captured page {len(pages)} (diff={diff:.4f})")
            last_sig = sig
            dup_count = 1
        kvm.press("PageDown")
        time.sleep(args.delay)
    else:
        print(f"\nHit --max-pages={args.max_pages} without detecting bottom.")
    return process_pages(pages, args, out)


def main() -> int:
    env = load_env(ENV_PATH)
    p = argparse.ArgumentParser(
        description="Screenshot a Word document via PiKVM at high resolution.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--mode", choices=("scan", "paged"), default="scan",
                   help="scan: scroll+stitch at Page-Width zoom (high-res); "
                        "paged: one page per Page Down at One-Page zoom")
    p.add_argument("--host", default=env.get("PIKVM_HOST", "pikvm"))
    p.add_argument("--user", default=env.get("PIKVM_USER", "admin"))
    p.add_argument("--password", default=env.get("PIKVM_PASSWORD", "admin"))
    p.add_argument("--out", default="pages", help="Output directory")
    p.add_argument("--http", action="store_true", help="Use http:// instead of https://")
    p.add_argument("--no-confirm", action="store_true", help="Skip the readiness prompt")
    p.add_argument("--bbox", type=parse_bbox,
                   help="Manual page region x0,y0,x1,y1 (skip auto-detect); "
                        "in scan mode only x0/x1 are used")

    # scan-mode knobs
    p.add_argument("--overlap", type=float, default=0.65,
                   help="[scan] fraction of frame height kept as overlap between steps; "
                        "higher = smaller, more reliable steps (slower)")
    p.add_argument("--calib-notches", type=int, default=3,
                   help="[scan] wheel notches used to calibrate scroll distance")
    p.add_argument("--settle", type=float, default=0.6,
                   help="[scan] seconds to wait after each scroll before snapshot")
    p.add_argument("--crop-top", type=int, default=28,
                   help="[scan] pixels trimmed off the top (title bar)")
    p.add_argument("--crop-bottom", type=int, default=72,
                   help="[scan] pixels trimmed off the bottom (taskbar)")
    p.add_argument("--min-shift", type=float, default=4.0,
                   help="[scan] px below which a step counts as 'no scroll'")
    p.add_argument("--max-steps", type=int, default=2000, help="[scan] safety ceiling")
    p.add_argument("--save-stitch", action="store_true",
                   help="[scan] also write the full stitched image (stitch.png)")

    # paged-mode knobs
    p.add_argument("--delay", type=float, default=1.5,
                   help="[paged] seconds to wait after Page Down")
    p.add_argument("--max-pages", type=int, default=500, help="[paged] safety ceiling")
    p.add_argument("--rewind", action=argparse.BooleanOptionalAction, default=True,
                   help="[paged] Ctrl+Home first if the doc is already at the bottom")
    p.add_argument("--similarity", type=float, default=0.005,
                   help="[paged] max mean pixel diff to treat two crops as identical")

    # shared stop/OCR knobs
    p.add_argument("--stop-after", type=int, default=8,
                   help="consecutive no-progress steps that mean 'end of document' "
                        "(scan: set above the largest blank run so empty page "
                        "areas don't look like the end)")
    p.add_argument("--ocr", action=argparse.BooleanOptionalAction, default=True,
                   help="OCR each page with Tesseract; writes page_NNN.txt")
    p.add_argument("--ocr-workers", type=int, default=4)
    p.add_argument("--ocr-lang", default="eng")
    p.add_argument("--combine-text", action=argparse.BooleanOptionalAction, default=True,
                   help="Write all.txt with every page joined in order")
    p.add_argument("--pdf", action=argparse.BooleanOptionalAction, default=True,
                   help="Build a searchable document.pdf from pages + OCR text")
    p.add_argument("--pdf-name", default=None)
    p.add_argument("--keep-intermediates", action="store_true",
                   help="Keep per-page PNG/PDF/TXT after merging the final PDF")
    args = p.parse_args()

    if args.pdf and not args.ocr:
        print("--pdf requires OCR; enabling --ocr.", file=sys.stderr)
        args.ocr = True
    if args.ocr:
        try:
            import pytesseract  # noqa: F401
        except ImportError:
            print("--ocr requires pytesseract: pip install pytesseract", file=sys.stderr)
            return 4
    if args.pdf:
        try:
            import pypdf  # noqa: F401
        except ImportError:
            print("--pdf requires pypdf: pip install pypdf", file=sys.stderr)
            return 4

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    kvm = PiKVM(args.host, args.user, args.password, scheme="http" if args.http else "https")

    if not args.no_confirm:
        if args.mode == "scan":
            print(
                "Before continuing, in Word on the target machine:\n"
                "  - Switch to light mode (View > Switch Modes / non-dark theme).\n"
                "  - Auto-hide the Ribbon / go full-screen.\n"
                "  - Set zoom to 'Page Width' (View > Page Width).\n"
                "  - Turn on Focus assist / Do Not Disturb (no toast popups).\n"
                "  - Click into the document; caret at the very top (Ctrl+Home).\n"
            )
        else:
            print(
                "Before continuing, in Word on the target machine:\n"
                "  - Full-screen, zoom 'One Page', caret at the top (Ctrl+Home).\n"
            )
        try:
            input("Press Enter when ready (Ctrl+C to abort)... ")
        except (EOFError, KeyboardInterrupt):
            print()
            return 1

    print(f"Fetching initial frame from {kvm.base}/api/streamer/snapshot ...")
    env_extras = {"PIKVM_HOST": args.host}
    try:
        first = snapshot_with_auth_retry(kvm, env_extras)
    except requests.HTTPError as e:
        print(f"Snapshot failed: {e}", file=sys.stderr)
        return 2

    try:
        if args.mode == "scan":
            manual_x = (args.bbox[0], args.bbox[2]) if args.bbox else None
            canvas = scan_document(
                kvm, env_extras, manual_x, args.crop_top, args.crop_bottom,
                args.overlap, args.calib_notches, args.settle, args.min_shift,
                args.stop_after, args.max_steps,
            )
            if args.save_stitch:
                canvas.save(out / "stitch.png")
                print(f"Wrote {out/'stitch.png'}")
            pages = split_pages(canvas)
            print(f"Split into {len(pages)} page(s).")
            if not pages:
                print("No pages detected in the stitched image.", file=sys.stderr)
                return 6
            return process_pages(pages, args, out)
        else:
            bbox = args.bbox if args.bbox else detect_page_bbox(first)
            print(f"Page region: {bbox}")
            return run_paged(kvm, args, out, env_extras, first, bbox)
    except requests.HTTPError as e:
        print(f"HID/snapshot request failed: {e}", file=sys.stderr)
        return 3
    except KeyboardInterrupt:
        print("\nInterrupted.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
