// Build the RPM via the electron-installer-redhat API so we can pass a custom
// desktop template (StartupWMClass) — the CLI doesn't expose it. Run after
// electron-packager has produced builds/pikvm-desktop-linux-x64.
import installer from "electron-installer-redhat";
import { resolve } from "path";

const root = resolve(import.meta.dirname, "..");

await installer({
    src: resolve(root, "builds/pikvm-desktop-linux-x64/"),
    dest: resolve(root, "builds/rpm/"),
    arch: "x86_64",
    name: "pikvm-desktop",
    productName: "PiKVM Desktop",
    genericName: "Remote Desktop",
    bin: "pikvm-desktop",
    icon: resolve(root, "src/assets/icon.png"),
    desktopTemplate: resolve(root, "build/desktop.ejs"),
});

console.log("RPM built (with StartupWMClass).");
