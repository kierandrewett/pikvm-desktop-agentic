# Vendored files in `src/views/`

Two files here are third-party and are **not ours to edit**. They carried their
upstream licence headers and nothing else — no version, no source, no date, no
note on whether they had been patched — so a year from now there would have been
no way to tell which release this is or how to move to a newer one without
diffing 3,000 lines by eye.

Recorded rather than stamped into the files themselves, deliberately: a pristine
copy can be diffed straight against upstream, and a header we added would show
up as a difference in every one of those diffs forever.

| file | what it is | lines |
|---|---|---|
| `janus.js` | The Janus WebRTC gateway's browser client, from janus-gateway (Meetecho, MIT). Loaded dynamically by `webrtc.js` via `import("/_agent/janus.js")`. | 3208 |
| `adapter.js` | webrtc-adapter (The WebRTC project authors, BSD), the browser-shim bundle janus.js expects to find. Vendored only because janus.js needs it. | 3364 |

## Provenance, and what is not known

Both were vendored on 2026-06-22 and **neither has been modified since** —
`git log` shows exactly one commit touching each, the one that added it:

    janus.js    c6df15b  wip: web console, live sync, OCR-verified typing, …
    adapter.js  5daccf3  fix(webrtc): vendor webrtc-adapter as adapter.js …

Upstream **version numbers are not recorded and could not be recovered from the
files** — neither carries a version constant, and the only in-file clue is a
reference to `janus-gateway/issues/1670` in a comment. Stated plainly rather than
guessed at: if you are updating either, treat the current copy as an unknown
release and read the upstream changelog from the beginning.

`webrtc.js` notes that this path mirrors the one PiKVM's own UI uses, and is
"ported from PiKVM's stream_janus.js", so the likeliest origin is the copy
shipped on a PiKVM rather than a janus-gateway release tarball. That is an
inference from the comment, not a verified fact.

## Checksums

So a future update is a deliberate act with a visible before and after:

    janus.js    sha256 1fc9c5617c68c0d4…
    adapter.js  sha256 900b24c690774ea0…

Full values: `sha256sum src/views/janus.js src/views/adapter.js`.

## Updating

1. Fetch the new upstream file and diff it against the current one *before*
   replacing, so you can see whether anything here silently depended on old
   behaviour.
2. Replace it whole. Do not hand-patch — a patched vendored file with no record
   of the patch is the situation this document exists to prevent.
3. Re-run the checksums above and update this table in the same commit.
4. `webrtc.js` is OURS and wraps janus.js; check it still lines up. In
   particular it passes an audio track's `capture` through to janus.js, which
   puts it straight into `constraints.audio` for `getUserMedia` — that is how
   the pinned microphone reaches the capture, and it is the kind of internal
   detail an upstream bump can quietly change.
