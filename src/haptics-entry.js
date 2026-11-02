// Browser-bundle entry for `web-haptics` (haptics.lochie.me) — bundled by
// scripts/build.mjs into dist/views/haptics.js and dynamically imported by the
// console (`/app/haptics.js`). The console is a static, un-bundled file, so it
// can't `import "web-haptics"` directly; this thin ESM re-export gives it a single
// served module to pull in. Android uses navigator.vibrate; iOS rides the Taptic
// engine via the library's hidden <input switch> trick.
export { WebHaptics } from "web-haptics";
