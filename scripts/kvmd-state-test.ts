// Smoke test for the KVMD /api/ws state reducer (src/pikvm-control.ts). Pure logic:
// exercises mergeKvmdEvent (merge-not-replace, partial hid deltas, unknown/garbage
// events) and keymapToLayout. No socket, no Electron.
//   esbuild scripts/kvmd-state-test.ts --bundle --platform=node --format=cjs \
//     --outfile=dist/kvmd-state-test.cjs && node dist/kvmd-state-test.cjs

import { compensateCapsLock, keymapToLayout, mergeKvmdEvent, type KvmdState } from "../src/pikvm-control";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
    if (cond) console.log(`  ok   ${name}`);
    else {
        failed++;
        console.log(`  FAIL ${name}`, extra ?? "");
    }
}

console.log("kvmd-state smoke test");

// hid_keymaps: the Pi's configured layout is exposed.
{
    const s = mergeKvmdEvent({}, "hid_keymaps", { keymaps: { default: "en-gb", available: ["en-us", "en-gb"] } });
    check("keymaps: default extracted", s.keymaps?.default === "en-gb", s.keymaps);
    check("keymaps: available carried", (s.keymaps?.available ?? []).includes("en-us"));
}

// hid: a partial delta merges into the cache (does not drop earlier fields).
{
    let s: KvmdState = mergeKvmdEvent({}, "hid", {
        online: true,
        keyboard: { online: true, leds: { caps: false, num: false, scroll: false } },
        mouse: { absolute: true, outputs: { active: "usb", available: ["usb", "usb_rel"] } },
    });
    check("hid: caps led parsed", s.hid?.keyboard?.leds?.caps === false);
    check("hid: mouse absolute parsed", s.hid?.mouse?.absolute === true);
    // A partial delta toggling caps must NOT wipe the mouse/outputs we already cached.
    s = mergeKvmdEvent(s, "hid", { keyboard: { leds: { caps: true } } });
    check("hid: partial delta updates caps", s.hid?.keyboard?.leds?.caps === true);
    check("hid: partial delta keeps keyboard.online", s.hid?.keyboard?.online === true, s.hid?.keyboard);
    check("hid: partial delta keeps mouse outputs", s.hid?.mouse?.outputs?.active === "usb", s.hid?.mouse);
}

// streamer: native resolution + online flag.
{
    const s = mergeKvmdEvent({}, "streamer", { source: { online: true, resolution: { width: 1920, height: 1080 } }, encoder: { quality: 80 } });
    check("streamer: resolution parsed", s.streamer?.source?.resolution?.width === 1920 && s.streamer?.source?.resolution?.height === 1080);
    check("streamer: online + quality parsed", s.streamer?.source?.online === true && s.streamer?.encoder?.quality === 80);
}

// ocr + loop.
{
    let s = mergeKvmdEvent({}, "ocr", { enabled: true, langs: { default: ["eng"], available: ["eng", "osd"] } });
    check("ocr: langs parsed", (s.ocr?.langs?.available ?? []).includes("osd"));
    s = mergeKvmdEvent(s, "loop", { version: { major: 4, minor: 150 } });
    check("loop: marks state ready", s.ready === true);
    check("loop: keeps earlier ocr", (s.ocr?.langs?.available ?? []).includes("osd"));
}

// Robustness: unknown event + non-object event are total/no-throw.
{
    const before: KvmdState = mergeKvmdEvent({}, "hid_keymaps", { keymaps: { default: "en-us" } });
    const after = mergeKvmdEvent(before, "atx", { leds: { power: true } }); // unmodelled event
    check("unknown event: state unchanged", after.keymaps?.default === "en-us" && after.hid === undefined);
    // A garbage 'hid' payload (not an object) must not throw or corrupt the cache.
    const g = mergeKvmdEvent(before, "hid", "not-an-object");
    check("garbage hid payload: no throw, no spurious hid", g.hid !== undefined ? Object.keys(g.hid).length === 0 : true);
}

// keymapToLayout: known maps; unknown → undefined (keep current layout, don't force).
{
    check("keymap→layout: en-gb → uk", keymapToLayout("en-gb") === "uk");
    check("keymap→layout: en-us → us", keymapToLayout("en-us") === "us");
    check("keymap→layout: en-gb variant → uk", keymapToLayout("en-gb-extd") === "uk");
    check("keymap→layout: unknown (de) → undefined", keymapToLayout("de") === undefined);
    check("keymap→layout: empty → undefined", keymapToLayout(undefined) === undefined);
}

// compensateCapsLock: invert Shift for letters when Caps Lock is on (the "wINDOWS aPP"
// bug), leave digits/symbols + the no-caps case alone.
{
    type S = { code: string; shift: boolean };
    // "Wi" = Shift+KeyW (W) then KeyI (i). Under Caps Lock both must flip.
    const win = (): S[] => [
        { code: "KeyW", shift: true },
        { code: "KeyI", shift: false },
    ];
    const off = compensateCapsLock(win(), false);
    check("caps off: strokes unchanged", off[0]!.shift === true && off[1]!.shift === false);
    const on = compensateCapsLock(win(), true);
    check("caps on: W's Shift dropped (→ lowercase-key = uppercase under caps)", on[0]!.shift === false);
    check("caps on: i gains Shift (→ uppercase-key = lowercase under caps)", on[1]!.shift === true);
    // Digits/symbols are NOT affected by Caps Lock.
    const sym = compensateCapsLock([{ code: "Digit2", shift: true }, { code: "Quote", shift: false }], true);
    check("caps on: symbol/digit Shift untouched", sym[0]!.shift === true && sym[1]!.shift === false);
}

if (failed) {
    console.error(`\n${failed} check(s) FAILED`);
    process.exit(1);
}
console.log("\nall checks passed");
