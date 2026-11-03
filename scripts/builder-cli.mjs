// Where electron-builder's command-line entry is, so scripts/package.mjs can start it with Node and an
// argument array. Through `yarn` on Windows it went through a shell (yarn is a .cmd shim there), which
// split "builds\PiKVM Desktop-win32-x64" at the space.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function builderCli() {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve("electron-builder/package.json");
    const manifest = require("electron-builder/package.json");
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin["electron-builder"];
    return join(dirname(manifestPath), bin);
}
